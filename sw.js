/* Forecaster Light — service worker (offline app shell).
   Same-origin GETs are served cache-first with stale-while-revalidate.
   Cross-origin requests (VIZ node RPC, Chart.js CDN) always go to the network. */
// BUMP this on every release — the SW only re-installs (and purges the stale shell) when this
// string changes, so an unchanged name leaves clients on the old cache-first app.js.
var CACHE = 'forecaster-light-v12';
var ASSETS = [
  './', 'index.html', 'styles.css', 'i18n.js', 'app.js', 'viz.min.js', 'manifest.json',
  'logo.png', 'logo-text.svg', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
  'favicon-96x96.png', 'android-icon-192x192.png', 'apple-icon-180x180.png'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS).catch(function(){}); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){ return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); })); })
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;                        // never cache RPC POSTs
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;         // node RPC + CDN pass straight to network
  e.respondWith((async function(){
    var cache = await caches.open(CACHE);
    var cached = await cache.match(req);
    if(cached){                                           // stale-while-revalidate
      fetch(req).then(function(res){ if(res && res.status===200) cache.put(req, res.clone()); }).catch(function(){});
      return cached;
    }
    try{ var res = await fetch(req); if(res && res.status===200) cache.put(req, res.clone()); return res; }
    catch(err){ return cached || Response.error(); }
  })());
});
