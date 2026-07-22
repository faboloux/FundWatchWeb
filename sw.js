/* 估值宝 Service Worker：同源静态资源“网络优先”（保证代码及时更新），离线回落缓存；跨域数据接口直接走网络。 */
var CACHE = 'fundwatch_v21';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return; // 跨域（新浪/东方财富/腾讯）直接走网络
  // HTML/导航请求：永远取最新，不缓存（避免 index.html 旧引用）
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(function (resp) { return resp; }).catch(function () {
        return caches.open(CACHE).then(function (c) { return c.match(e.request); });
      })
    );
    return;
  }
  // 其余静态资源：网络优先，成功即更新缓存；失败（离线）时回落缓存
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.status === 200) {
        var clone = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, clone); });
      }
      return resp;
    }).catch(function () {
      return caches.open(CACHE).then(function (c) { return c.match(e.request); });
    })
  );
});
