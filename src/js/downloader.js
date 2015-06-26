/* global storage, yandex, chrome, utils */
'use strict';

var downloader = {
    TYPE: Object.freeze({
        TRACK: 'track',
        ALBUM: 'album',
        PLAYLIST: 'playlist',
        COVER: 'cover'
    }),
    STATUS: Object.freeze({
        WAITING: 'waiting',
        LOADING: 'loading',
        FINISHED: 'finished',
        INTERRUPTED: 'interrupted'
    }),
    downloads: [],
    activeThreadCount: 0
};

downloader.getWaitingEntity = function () {
    for (var i = 0; i < downloader.downloads.length; i++) {
        var entity = downloader.downloads[i];
        if (!entity) {
            continue; // эту загрузку удалили
        }
        if (entity.type === downloader.TYPE.ALBUM || entity.type === downloader.TYPE.PLAYLIST) {
            for (var j = 0; j < entity.tracks.length; j++) {
                if (entity.tracks[j].status === downloader.STATUS.WAITING) {
                    return entity.tracks[j];
                }
            }
        } else if (entity.type === downloader.TYPE.TRACK || entity.type === downloader.TYPE.COVER) {
            if (entity.status === downloader.STATUS.WAITING) {
                return entity;
            }
        }
    }
    return undefined;
};

downloader.runAllThreads = function () {
    for (var i = 0; i < storage.current.downloadThreadCount; i++) {
        downloader.download();
    }
};

downloader.download = function () {
    if (downloader.activeThreadCount >= storage.current.downloadThreadCount) {
        return; // достигнуто максимальное количество потоков загрузки
    }
    var entity = downloader.getWaitingEntity();
    if (!entity) { // в очереди нет загрузок
        return;
    }
    entity.status = downloader.STATUS.LOADING;
    downloader.activeThreadCount++;

    if (entity.type === downloader.TYPE.TRACK) {
        var track = entity.track;
        var savePath = storage.current.trackNameMask.replace('#НАЗВАНИЕ#', entity.title);
        savePath = savePath.replace('#ИСПОЛНИТЕЛИ#', entity.artists);
        if (storage.current.shouldNumberLists && entity.namePrefix) {
            savePath = entity.namePrefix + ' ' + savePath;
        }
        savePath = utils.clearPath(savePath) + '.mp3';
        if (entity.saveDir) {
            savePath = entity.saveDir + '/' + savePath;
        }

        yandex.getTrackUrl(track.storageDir, function (url) {
            var xhr = utils.ajax(url, 'arraybuffer', function (arrayBuffer) {
                var frames = {
                    TIT2: entity.title, // Title/songname/content description
                    TPE1: entity.artists, // Lead performer(s)/Soloist(s)
                    TALB: track.albums[0].title, // Album/Movie/Show title
                    TYER: track.albums[0].year, // Year
                    TCON: track.albums[0].genre // Content type
                };
                //if (entity.type === downloader.TYPE.ALBUM_TRACK) {
                // todo: ставить не порядковый номер, а из альбома
                //frames.TRCK = entity.namePrefix; // Track number/Position in set
                //}
                var localUrl = utils.addId3Tag(arrayBuffer, frames);

                chrome.downloads.download({
                    url: localUrl,
                    filename: savePath,
                    saveAs: false
                }, function (downloadId) {
                    entity.browserDownloadId = downloadId;
                });
            }, function (error) {
                entity.status = downloader.STATUS.INTERRUPTED;
                console.error(error);
                downloader.activeThreadCount--;
                downloader.download();
            }, function (event) {
                entity.loadedBytes = event.loaded;
            });
            entity.xhr = xhr;
        }, function (error) {
            entity.status = downloader.STATUS.INTERRUPTED;
            console.error(error);
            downloader.activeThreadCount--;
            downloader.download();
        });
    } else if (entity.type === downloader.TYPE.COVER) {
        chrome.downloads.download({
            url: entity.url,
            filename: entity.filename,
            saveAs: false
        }, function (downloadId) {
            entity.browserDownloadId = downloadId;
        });
    }
};

downloader.downloadTrack = function (trackId) {
    yandex.getTrack(trackId, function (track) {
        var entity = {
            type: downloader.TYPE.TRACK,
            status: downloader.STATUS.WAITING,
            index: downloader.downloads.length,
            track: track,
            artists: utils.parseArtists(track.artists),
            title: track.title,
            loadedBytes: 0
        };
        if (track.version) {
            entity.title += ' (' + track.version + ')';
        }
        downloader.downloads.push(entity);
        downloader.download();
    }, function (error) {
        console.error(error);
    });
};

downloader.downloadAlbum = function (albumId, discographyArtist) {
    yandex.getAlbum(albumId, function (album) {
        if (!album.volumes.length) {
            console.error('Пустой альбом. album.id:' + album.id);
            return;
        }
        var albumEntity = {
            type: downloader.TYPE.ALBUM,
            duration: 0,
            size: 0,
            artists: utils.parseArtists(album.artists),
            title: album.title,
            tracks: []
        };

        if (album.version) {
            albumEntity.title += ' (' + album.version + ')';
        }
        var saveDir = utils.clearPath(albumEntity.artists + ' - ' + albumEntity.title);
        if (discographyArtist) {
            saveDir = utils.clearPath(discographyArtist) + '/' + saveDir;
        }

        if (storage.current.shouldDownloadCover && album.coverUri) {
            downloader.downloads.push({
                type: downloader.TYPE.COVER,
                status: downloader.STATUS.WAITING,
                index: downloader.downloads.length,
                url: 'https://' + album.coverUri.replace('%%', storage.current.albumCoverSize),
                filename: saveDir + '/cover.jpg'
            });
            downloader.download();
        }
        albumEntity.index = downloader.downloads.length;

        for (var i = 0; i < album.volumes.length; i++) {
            for (var j = 0; j < album.volumes[i].length; j++) {
                var track = album.volumes[i][j];
                if (track.error) { // todo: проверить, если ли сейчас такое поле
                    console.error('Ошибка: ' + track.error + '. trackId: ' + track.id);
                    continue;
                }
                var saveCdDir = saveDir;
                if (album.volumes.length > 1) {
                    // пример: https://music.yandex.ru/album/2490723
                    saveCdDir += '/CD' + (i + 1);
                }
                albumEntity.size += track.fileSize;
                albumEntity.duration += track.durationMs;
                var trackEntity = {
                    type: downloader.TYPE.TRACK,
                    status: downloader.STATUS.WAITING,
                    track: track,
                    artists: utils.parseArtists(track.artists),
                    title: track.title,
                    loadedBytes: 0,
                    saveDir: saveCdDir,
                    namePrefix: utils.addExtraZeros(j + 1, album.volumes[i].length)
                };
                if (track.version) {
                    trackEntity.title += ' (' + track.version + ')';
                }
                albumEntity.tracks.push(trackEntity);
            }
        }
        downloader.downloads.push(albumEntity);
        downloader.runAllThreads();
    }, function (error) {
        console.error(error);
    });
};

downloader.downloadPlaylist = function (username, playlistId) {
    yandex.getPlaylist(username, playlistId, function (playlist) {
        if (!playlist.tracks.length) {
            console.error('Пустой плейлист. username: ' + username + ', playlistId: ' + playlistId);
            return;
        }
        var playlistEntity = {
            type: downloader.TYPE.PLAYLIST,
            index: downloader.downloads.length,
            duration: 0,
            size: 0,
            title: playlist.title,
            tracks: []
        };

        for (var i = 0; i < playlist.tracks.length; i++) {
            var track = playlist.tracks[i];
            if (track.error) {
                console.error('Ошибка: ' + track.error + '. trackId: ' + track.id);
                continue;
            }
            playlistEntity.size += track.fileSize;
            playlistEntity.duration += track.durationMs;
            var trackEntity = {
                type: downloader.TYPE.TRACK,
                status: downloader.STATUS.WAITING,
                track: track,
                artists: utils.parseArtists(track.artists),
                title: track.title,
                loadedBytes: 0,
                saveDir: utils.clearPath(playlist.title),
                namePrefix: utils.addExtraZeros(i + 1, playlist.tracks.length)
            };
            if (track.version) {
                trackEntity.title += ' (' + track.version + ')';
            }
            playlistEntity.tracks.push(trackEntity);
        }
        downloader.downloads.push(playlistEntity);
        downloader.runAllThreads();
    }, function (error) {
        console.error(error);
    });
};
