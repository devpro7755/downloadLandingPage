HOW TO FIX "Cannot GET /CommunityDetails/159"
==============================================

Problem:
  When a user without the app installed opens a share link like
  https://app.thewhistlerapp.com/CommunityDetails/159
  the backend returns a raw Express 404 error.

Fix:
  Add a catch-all route AFTER all your API routes in the Express server
  that serves download.html for any unmatched path.

Example (Express / Node.js):
------------------------------
  const path = require('path');

  // ... all your existing API routes above this ...

  // Catch-all: serve the app download page
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'download.html'));
  });

Example (Express with static folder):
--------------------------------------
  app.use(express.static(path.join(__dirname, 'web')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'download.html'));
  });

Important:
  - Place the catch-all AFTER all your existing /api/... routes
  - The download.html page auto-detects iOS vs Android
  - On iOS it shows the App Store button
  - On Android it shows the Play Store button
  - It also shows an "Open in app" link using the whistler:// deep link scheme

Routes handled by the catch-all (users without app):
  /CommunityDetails/:id
  /CommunityPostDetails/:id
  /MomentDetails/:id
  /CategoryMoments/:id
  /community/moments
  (and any other future share paths)
