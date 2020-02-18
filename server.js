"use strict";


const driveCredentials = require('./data/driveCredentials.json');

const DRIVE_CLIENT_ID = driveCredentials.clientId;
const DRIVE_CLIENT_SECRET = driveCredentials.clientSecret;
const DRIVE_REDIRECT_URI = process.env.DRIVE_REDIRECT_URI || 'http://localhost:3000/login-callback';
const DRIVE_RETURN_FIELDS = 'id,name,webViewLink';
const DRIVE_TORRENT_DIR = 'My torrents';

const isProduction = process.env.NODE_ENV == 'production';

const torrentClients = {}; // {userId: Webtorrent client}
const sockets = {}; // {userId: socket}

const parseTorrent = require('parse-torrent');
const WebTorrent = require('webtorrent');

const {google} = require('googleapis');
const express = require('express');
const helmet = require('helmet');
const forceHttps = require('express-force-https');
const bodyParser = require('body-parser');
const fileUpload = require('express-fileupload');
const path = require('path');
const util = require('util');
const os = require('os');
const locks = require('locks');
const _ = require('lodash');
const zip = require('express-zip');
const driveIO = require('google-drive-io');
const app = express();

const server = require('http').createServer(app);
const io = require('socket.io')(server);
const ios = require('socket.io-express-session');
const session = require('express-session')({
    secret: 'google-drive-torrent',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {httpOnly: true, maxAge: 3600000}
});

app.set('port', (process.env.PORT || 3000));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(express.static(path.join(__dirname, 'views')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(fileUpload());
app.use(helmet());
app.use(session);

if (isProduction) {
    app.use(forceHttps);
}

io.use(ios(session));
io.on('connection', (socket) => {
    const session = socket.handshake.session;
    if ('user' in session) {
        const user = session.user;
        sockets[user.id] = socket;

        // send updates every second
        const updateInterval = 1000;
        sendUpdate(user, socket);
        const updateTask = setInterval(() => sendUpdate(user, socket), updateInterval);

        // stop updates when user disconnects
        socket.on('disconnect', () => clearInterval(updateTask));
    }
});

/* PART I: Routes for views */
app.get('/', (req, res) => {
    loggedIn(req)? res.redirect('/dashboard'): res.redirect('/home');
});

app.get('/home', (req, res) => {
   unlessLoggedIn(req, res, () => {
        const options = {};
        if ('error' in req.query) {
            options.error = req.query.error;
        }
        res.render('index.pug', options);
   });
});


app.get('/dashboard', (req, res) => {
    ifLoggedIn(req, res, () => {
        const user = req.session.user;
        const driveUrl = req.session.driveUrl;
        res.render('dashboard.pug', {
            name: user.names[0].displayName,
            firstName: user.names[0].givenName,
            pic: user.photos[0].url,
            driveUrl: driveUrl
        });
    });
});

/* PART II: Routes for authentication */
// Login to Google
app.get('/login', (req, res) => {
    unlessLoggedIn(req, res, () => {
        const url = newOAuth2Client().generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: [
                'https://www.googleapis.com/auth/plus.me',
                'https://www.googleapis.com/auth/drive',
                'profile'
            ]
        });
        res.redirect(url);
    });
});

// Accept authorisation code from Google
app.get('/login-callback', (req, res) => {
    unlessLoggedIn(req, res, () => {
        // Redirect to home page and display error message if authentication failure
        if ('error' in req.query) {
            console.error(`Login error: ${req.query.error}`);
            return res.redirect(`/error`);
        }

        // Otherwise proceed, get tokens and save auth client and user details
        const code = req.query.code;
        const oAuth2Client = newOAuth2Client();
        oAuth2Client.getToken(code, (err, tokens) => {
            if (err) {
                console.error(`OAuth2 failed: ${err}`);
                return res.redirect(`/error`);
            }

            // store access and refresh tokens in session
            req.session.tokens = tokens;
            oAuth2Client.setCredentials(tokens);
            console.log(`Obtained tokens: ${JSON.stringify(tokens)}`);

            google.people('v1').people.get({
                auth: oAuth2Client,
                resourceName: 'people/me',
                personFields: 'names,photos,metadata'
            }, (err, data) => {
                if (err) {
                    console.error(`Failed to get user details: ${err}`);
                    return res.redirect(`/error`);
                }
                const user = data.data
                user.id = user.metadata.sources[0].id
                req.session.user = user;
                console.log(`Obtained user: ${JSON.stringify(user)}`);

                driveIO.createFolderIfNotExists(DRIVE_TORRENT_DIR, DRIVE_RETURN_FIELDS, oAuth2Client, (err, folder) => {
                    if (err) {
                        console.error(`Failed to create google drive folder: ${err}`);
                        return res.redirect(`/error`);
                    }
                    req.session.driveUrl = folder.webViewLink;
                    return res.redirect('/dashboard');
                });
            });
        });
    });
});


app.get('/logout', (req, res) => {
    ifLoggedIn(req, res, () => {
        delete req.session.oAuth2Client;
        delete req.session.user;
        res.redirect(`/home`);
    });
})


/* PART III: Routes for torrent interaction */
app.post('/add-torrent', (req, res) => {
    ifLoggedIn(req, res, () => {
        // extract torrent from post request
        let torrentId = null;
        if ('files' in req && 'torrent' in req.files) {
            torrentId = req.files.torrent.data;
        } else if ('body' in req && 'magnet' in req.body) {
            torrentId = req.body.magnet;
        } else {
            return res.status(500).json({message: 'Invalid request in parse-torrent'});
        }

        const user = req.session.user;
        const oAuth2Client = newOAuth2Client(req.session.tokens);        
        const torrent = addTorrentForUser(torrentId, user, (err, torrent) => {
            if (err) {
                return res.status(500).json({message: err.message});
            }
            console.log(`Added torrent: ${util.inspect(torrent.files)}`);
            const torrentFiles = {
                infoHash: torrent.infoHash,
                files: getFileInfos(torrent)
            };
            return res.json(torrentFiles);
        });

        const socket = getSocketForUser(user);

        // Add callback handlers so that files get uploaded to google drive once ready
        torrent.once('ready', () => {
            console.log(`Torrent ${torrent.infoHash} is ready`);
            attachCompleteHandler(torrent, oAuth2Client, socket);
        });

        torrent.on('warning', (err) => {
            console.warn('Torrent on warning: ' + err);
            socket.emit('torrent-warning', {
                message: err.message
            });
        });

        torrent.on('error', (err) => {
            torrent.error = err.message;                       // Attach error onto torrent (hack!)
            const info = getTorrentInfo(torrent);
            socket.emit('torrent-error', info);
            socket.emit('torrent-update', info);
            console.error('Torrent on error: ' + err);
        });

        torrent.on('download', (bytes) => {
            /*console.log(`${torrent.infoHash} downloaded ${torrent.downloaded / 1024} kB \
                         (${torrent.progress * 100}%) @ ${torrent.downloadSpeed / 1024} kB/s. \
                         ETA: ${torrent.timeRemaining / 1000} sec`);*/
        });
    });
});

app.post('/update-torrent', (req, res) => {
    ifLoggedIn(req, res, () => {
        const user = req.session.user;
        const infoHash = req.body.infoHash;
        const selectedFiles = req.body.selectedFiles; // array of booleans

        const torrent = getTorrentForUser(infoHash, user);

        // deselect files based on user choice
        for (let i = 0; i < torrent.files.length; i++) {
            const file = torrent.files[i];
            const oldSelection = file.selected;
            const newSelection = selectedFiles[i] == 'true'; // somehow selectedFiles are received as strings, need to parse

            if (!oldSelection && newSelection) {
                // file selected
                file.select();
                file.selected = true; // attach to file object (hack!) to retrieve later
                console.log(`Selected file: ${file.name} for user ${user.id}`);
            }

            if (oldSelection && !newSelection) {
                // file deselected
                file.deselect();
                file.selected = false; // attach to file object (hack!) to retrieve later
                console.log(`Deselected file: ${file.name} for user ${user.id}`);
            }
        }
        res.end();
    });
});

app.post('/delete-torrent', (req, res) => {
    ifLoggedIn(req, res, () => {
        const user = req.session.user;
        const infoHash = req.body.infoHash;

        const client = torrentClients[user.id];
        if (!client) {
            return res.status(500).json({message: 'Client not found for user'});
        }
        client.remove(infoHash, (err) => {
            if (err) {
                return res.status(500).json({message: err.message});
            }
            console.log(`Deleted torrent: ${infoHash}`);
            return res.end();
        });
    });
});

app.get('/get-torrents', (req, res) => {
    ifLoggedIn(req, res, () => {
        const user = req.session.user;
        const client = torrentClients[user.id];
        if (!client) {
            // return empty array if client is not yet initialised
            res.json([]); return;
        }
        const torrentsInfo = getTorrentsInfo(client.torrents);
        res.json(torrentsInfo);
    });
});

app.get('/download/:infoHash', (req, res) => {
    ifLoggedIn(req, res, () => {
        const user = req.session.user;
        const infoHash = req.params.infoHash;
        const torrent = getTorrentForUser(infoHash, user);
        const files  = getSelectedFiles(torrent);

        const targets = files.map((file) => {
            return {name: file.name, path: path.join(torrent.path, file.path)};
        });
        res.zip(targets, `${torrent.name}.zip`);
    });
});

app.get('*', (req, res) => {
    res.render('error.pug');
});

server.listen(app.get('port'), () => {
    console.log('Node app is running on port', app.get('port'));
});


/* Helper functions */
const loggedIn = (req) => {
    return 'tokens' in req.session && 'user' in req.session;
}

const ifLoggedIn = (req, res, callback, otherwise) => {
    if (!otherwise) {
        otherwise = () => {
            res.redirect('/home')
        };
    }
    loggedIn(req)? callback(): otherwise();
}

const unlessLoggedIn = (req, res, callback, otherwise) => {
    if (!otherwise) {
        otherwise = () => {
            res.redirect('/dashboard');
        };
    }
    loggedIn(req)? otherwise(): callback();
}


const newOAuth2Client = (tokens) => {
    const oAuth2Client = new google.auth.OAuth2(
        DRIVE_CLIENT_ID,
        DRIVE_CLIENT_SECRET,
        DRIVE_REDIRECT_URI
    );
    if (tokens) {
        oAuth2Client.setCredentials(tokens);
    }
    return oAuth2Client;
}

/**
 * Adds a new torrent for the user (creating a new Webtorrent Client if neccessary),
 *  returns the added torrent and invokes callback(err, torrent).
 * @param  torrent anything Webtorrent identifies as a torrent (infoHash/magnetURI/.torrent etc)
 * @param  user Google Plus API user object
 * @param  callback(err, torrent)
 * @return reference to Webtorrent torrent object
 */
const addTorrentForUser = (torrent, user, callback) => {
    const client = (user.id in torrentClients)? torrentClients[user.id]: new WebTorrent();
    torrentClients[user.id] = client;

    try {
        const parsedTorrent = parseTorrent(torrent);
        const infoHash = parsedTorrent.infoHash;
        console.log(`Parsed infohash: ${infoHash}`);

        // Catch error in case client.add() later fails
        const callbackWithError = (err) => {
            callback(err);
        }

        const saveToPath = path.join(os.tmpdir(), user.id, infoHash)
        const torrentHandle = client.add(torrent, {
            path: saveToPath
        }, (torrent) => {
            torrentHandle.removeListener('error', callbackWithError);

            // Attach boolean to file (hack!), by default all files are selected
            for (var i = 0; i < torrent.files.length; i++) {
                torrent.files[i].selected = true;
            }
            callback(null, torrent);
        });

        torrentHandle.once('error', callbackWithError);

        return torrentHandle;

    } catch (err) {
        callback(err);
    }
}

const getTorrentForUser = (torrent, user) => {
    const client = torrentClients[user.id];
    return client.get(torrent);
}

const getSocketForUser = (user) => {
    return sockets[user.id];
}

const getFileInfos = (torrent) => {
    return torrent.files.map((f) => {
            return {
                name: f.name,
                length: f.length,
                downloaded: f.downloaded,
                selected: f.selected
            }
        });
}

const getTorrentInfo = (torrent) => {
    return getTorrentsInfo([torrent]);
}

const getTorrentsInfo = (torrents) => {
    return torrents.map((torrent) => {
        const files = getSelectedFiles(torrent);
        const received = _.sumBy(files, (file) => file.downloaded);
        const size = _.sumBy(files, (file) => file.length);
        const progress = Math.min(received / size, 1);

        return {
            infoHash: torrent.infoHash,
            magnetURI: torrent.magnetURI,
            name: torrent.name,
            files: getFileInfos(torrent),
            received: received,
            size: size,
            progress: progress,
            timeRemaining: torrent.timeRemaining,
            downloaded: torrent.downloaded,
            downloadSpeed: torrent.downloadSpeed,
            uploaded: torrent.uploaded,
            uploadSpeed: torrent.uploadSpeed,
            ratio: torrent.ratio,
            numPeers: torrent.numPeers,
            error: torrent.error,
            driveUrl: torrent.driveUrl
        }
    });
}

const getSelectedFiles = (torrent) => {
    return torrent.files.filter((file) => file.selected);
}

const torrentIsDone = (torrent) => {
    return _.every(getSelectedFiles(torrent), file => file.done);
}

const attachCompleteHandler = (torrent, auth, socket) => {
    const mutex = locks.createMutex(); // prevent race condition during google drive operations

    torrent.files.forEach((file) => {
        file.on('done', () => {
            // Update torrent as success if all files have completed
            const torrentFolderPath = path.join(DRIVE_TORRENT_DIR, torrent.name);
            if (torrentIsDone(torrent)) {
                mutex.lock(() => {
                    driveIO.createFolderIfNotExists(torrentFolderPath, DRIVE_RETURN_FIELDS, auth, (err, torrentFolder) => {
                        mutex.unlock();
                        if (err) {
                            console.error(err);
                            torrent.error = err.message;
                            socket.emit('torrent-error', getTorrentInfo(torrent));
                        }
                        torrent.driveUrl = torrentFolder.webViewLink;
                        socket.emit('torrent-success', getTorrentInfo(torrent));
                        console.log(`Created torrent folder on google drive: ${torrent.name}`);
                    });
                });
            }
            if (file.selected) {
                const uploadPath = path.join(torrentFolderPath, file.path);
                const filePath = path.join(torrent.path, file.path);
                mutex.lock(() => {
                    driveIO.uploadFileIfNotExists(filePath, uploadPath, DRIVE_RETURN_FIELDS, auth, (err, uploaded) => {
                        mutex.unlock();
                        if (err) {
                            console.error(err);
                            torrent.error = err.message;
                            socket.emit('torrent-error', getTorrentInfo(torrent));
                        }
                        socket.emit('torrent-update', getTorrentInfo(torrent));
                        console.log(`File uploaded to google drive: ${uploadPath}, with id: ${uploaded.id}`);
                    });
                });          
            }
        });
    });
}

const sendUpdate = (user, socket) => {
    const client = torrentClients[user.id];
    if (!client) {
        return socket.emit('all-torrents', []);
    }
    socket.emit('all-torrents', getTorrentsInfo(client.torrents));
}
