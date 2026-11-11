const SHELL = 'shell-v12', DATA = 'data-v2';
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/manifest.webmanifest', '/style.css', '/desk.html', '/tip.html', '/check.html', '/advertise.html', '/logo-review.png', '/logo-roundup.png']))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (/^\/api\/(feed|utility|alerts|map|lead|roads|fares|facilities|boards|venues|menu)/.test(u.pathname) || u.pathname.endsWith('.geojson')) {          // feed: network first, last copy when offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(DATA).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
  } else if (!u.pathname.startsWith('/api/') && !u.pathname.startsWith('/q/') && !u.pathname.startsWith('/media/')) {
    e.respondWith(caches.match(e.request).then(r => {                // show saved copy at once, refresh it in the background
      const f = fetch(e.request).then(n => { const c = n.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return n; }).catch(() => r);
      return r || f; }));
  }
});
