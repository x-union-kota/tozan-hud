/* 登山HUD service worker v2
 * 方針: ネットワーク優先(4秒でキャッシュへフォールバック)。
 * オンラインなら常に最新版、圏外・山中ではキャッシュから即起動。
 * 取得成功のたびにキャッシュを更新するので手動のバージョン管理は不要。 */
var CACHE = 'tozan-hud-v2';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(['./', './index.html']); })
      ['catch'](function () {})                    // 初回precache失敗でも稼働は継続
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {              // 山中の微弱電波で待たされない
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (!settled && hit) { settled = true; resolve(hit); }
      });
    }, 4000);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); })['catch'](function () {});
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

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  var isShell = e.request.mode === 'navigate' ||
                url.pathname.slice(-1) === '/' ||
                url.pathname.slice(-10) === 'index.html' ||
                url.pathname.slice(-9) === 'spike.html';
  if (isShell) { e.respondWith(networkFirst(e.request)); return; }
  if (url.hostname.indexOf('open-meteo') >= 0) return;  // APIは素通し(アプリ側でキャッシュ)
  e.respondWith(
    caches.match(e.request).then(function (hit) { return hit || fetch(e.request); })
  );
});
