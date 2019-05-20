# google-drive-torrent

Download torrents to your Google Drive directly

## Installation

1. Register this project as a client on the [Google API Console](http://console.developers.google.com). Enable the google+ API and the Google drive API. Make Credentials for it by going to Credentials and press "Help Me Choose." For "where will you be calling the API from?" Choose web server and then click user data.
   Replace the fields in `data/driveCredentials.json` with your registered `clientId` and `clientSecret`.  

   * You may also need to set the environmental variable `DRIVE_REDIRECT_URI` to be `[insert your host origin here]/login-callback` if you are running the project on a remote server.

2. Run `npm install` then `npm start`. Enjoy!
