/* 登山HUD service worker v3 — シェル: ネット優先 / 地理院タイル: キャッシュ優先+保存 */
var CACHE = 'tozan-hud-v3';
var TILES = 'thud-tiles-v1';
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(['./', './index.html']); })
    ['catch'](function(){}).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== TILES; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
function networkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (!settled && hit) { settled = true; resolve(hit); }
      });
    }, 4000);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); })['catch'](function(){});
      }
      if (!settled) { settled = true; resolve(res); }
    }, function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (!settled) { settled = true; resolve(hit || Response.error()); }
      });
    });
  });
}
function tileCacheFirst(req) {   // タイルは不変: キャッシュ→ネット(取得時に保存=回廊先読みが効く)
  return caches.open(TILES).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      });
    });
  });
}
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.hostname === 'cyberjapandata.gsi.go.jp') { e.respondWith(tileCacheFirst(e.request)); return; }
  if (url.hostname.indexOf('open-meteo') >= 0) return;
  var isShell = e.request.mode === 'navigate' || url.pathname.slice(-1) === '/' ||
                url.pathname.slice(-10) === 'index.html';
  if (isShell) { e.respondWith(networkFirst(e.request)); return; }
  e.respondWith(caches.match(e.request).then(function (h) { return h || fetch(e.request); }));
});
