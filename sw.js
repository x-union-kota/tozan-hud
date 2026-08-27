/* 登山HUD service worker — 圏外でもアプリを起動可能にする(キャッシュファースト) */
var CACHE = 'tozan-hud-v1';
var SHELL = ['./', './index.html'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  // 天気API等の動的リクエストはネット直行、シェルのみキャッシュ優先
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request);
    })['catch'](function () { return caches.match('./index.html'); })
  );
});
