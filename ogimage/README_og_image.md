# Whistler OG Image — Backend Setup

## 1. Install
npm install canvas sharp

## 2. Files to copy into the server
```
web/          → serve as Express static folder
ogimage/      → place next to server.js (cd ogimage && npm install)
```


## 3. Add these two Express routes
```js
const { generatePostOGImage, generateMomentOGImage, prewarmPost, prewarmMoment } = require('./ogimage/ogImage');
const LOGO = path.join(__dirname, 'ogimage/Whistlerlogo.png');

app.get('/og/post/:id.jpg', async (req, res) => {
  const post = await db.posts.findById(req.params.id);
  const { buf, cacheKey } = await generatePostOGImage({
    title: post.title, description: post.description,
    imageUrl: post.imageUrl, logoPath: LOGO,
  });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
  res.send(buf);
});

app.get('/og/moment/:id.jpg', async (req, res) => {
  const moment = await db.moments.findById(req.params.id);
  const { buf } = await generateMomentOGImage({
    title: moment.title, description: moment.description,
    imageUrl: moment.imageUrl, logoPath: LOGO,
  });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
  res.send(buf);
});
```

## 4. Serve the HTML templates — fill in these variables

**postopenGraph.html**
| Variable | Value |
|---|---|
| `${postTitle}` | Post title |
| `${description}` | Post description |
| `${ogImage}` | `https://app.thewhistlerapp.com/og/post/${id}.jpg` |
| `${pageUrl}` | `https://app.thewhistlerapp.com/CommunityPostDetails/${id}` |
| `${postId}` | Post ID (used in the deep link) |

**momentopenGraph.html**
| Variable | Value |
|---|---|
| `${post}` | Moment title |
| `${description}` | Moment description |
| `${ogImage}` | `https://app.thewhistlerapp.com/og/moment/${id}.jpg` |
| `${pageUrl}` | `https://app.thewhistlerapp.com/MomentDetails/${id}` |
| `${momentId}` | Moment ID (used in the deep link) |


## 5. Pre-warm on post save (so first share is instant)
```js
// In your create/update handlers — no await, runs in background
prewarmPost({ title, description, imageUrl, logoPath: LOGO });
prewarmMoment({ title, description, imageUrl, logoPath: LOGO });
```

## Route order
Place OG routes **before** any catch-all `app.get('*', ...)`.
