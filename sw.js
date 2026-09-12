// Service Worker：PWA 离线缓存
//
// 策略：同源静态资源 stale-while-revalidate（先给缓存秒开，后台顺手更新），
// 离线时全部回落到缓存，保证断网也能打开首页。
// Supabase / CDN / Google Fonts 等跨域请求一律不缓存，直连网络（学习数据必须实时）。
//
// 【重要】每次修改部署任何 js/css/html 后，把下面 CACHE 版本号 +1，
// 否则用户端会继续用旧缓存，新代码不生效。
const CACHE = 'jlptready-v8';

const CORE = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/db.js',
  'js/achievements.js',
  'js/newwords.js',
  'js/review.js',
  'js/exam.js',
  'js/wrongbook.js',
  'js/search.js',
  'js/stats.js',
  'js/checkin.js',
  'js/share.js',
  'js/home.js',
  'js/router.js',
  'js/app.js',
  'icon-192x192.png',
  'icon-512x512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

// 激活时清掉旧版本缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;            // 写请求直连网络
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // Supabase / CDN / 字体不缓存

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetching = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit); // 离线且缓存也没有时返回 undefined，浏览器报离线
      return hit || fetching;
    })
  );
});
