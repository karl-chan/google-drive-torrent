# google-drive-torrent

Download torrents to your Google Drive directly

## Installation

1. Register this project as a client on the [Google API Console](http://console.developers.google.com)
2. Enable the **People API** and **Google Drive API** from the Google API Console.
3. Add `http://localhost` as an "Authorised JavaScript origin" and `http://localhost/login-callback` as an "Authorised redirect URI" in the Google API Console. Replace `localhost` with your host origin if you are running the project on a remote server.
4. Replace the fields in `data/driveCredentials.json` with your registered `clientId` and `clientSecret`.
5. If you are running the project on a remote server, set the environmental variable `DRIVE_REDIRECT_URI=[insert your host origin here]/login-callback`.
6. Run `npm start`. Enjoy!
