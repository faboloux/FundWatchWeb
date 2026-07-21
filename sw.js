/* 估值宝 Service Worker：仅缓存同源静态资源，跨域数据接口交给网络。 */
var CACHE = 'fundwatch_v1';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return; // 跨域（东方财富/腾讯）直接走网络
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (resp) {
          if (resp && resp.status === 200) c.put(e.request, resp.clone());
          return resp;
        }).catch(function () { return hit; });
      });
    })
  );
});
