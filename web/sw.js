/* Nudge service worker: offline shell + "Share → Nudge" target. */
const CACHE = 'nudge-shell-v1';
const SHELL = ['./nudge.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const APP = new URL('./nudge.html', self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('nudge-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Share → Nudge": keep the shared file/text for the page, then open the app.
  if (req.method === 'POST' && url.pathname.endsWith('/nudge.html') && url.searchParams.has('share')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const c = await caches.open('nudge-share');
        await c.delete('file'); await c.delete('text');
        const file = form.get('media');
        if (file && typeof file !== 'string' && file.size) {
          await c.put('file', new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
        }
        const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter((v) => typeof v === 'string' && v).join('\n');
        if (text) await c.put('text', new Response(text));
      } catch (_) { /* fall through: just open the app */ }
      return Response.redirect(APP + '?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Open the app: network first (fresh versions), cache when offline.
  if (req.mode === 'navigate' && url.pathname.endsWith('/nudge.html')) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(APP, copy)); return res; })
        .catch(() => caches.match(APP))
    );
    return;
  }

  // Static files of the app shell: cache first.
  if (SHELL.some((p) => new URL(p, self.registration.scope).href === req.url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});
