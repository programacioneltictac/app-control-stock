const CACHE_NAME = 'stock-app-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/control.html',
  '/productos.json',
  '/sounds/beep-success.mp3',
  '/sounds/beep-error.mp3'
];

// Instalar: cachear assets estaticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activar: limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network first para API, cache first para assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: solo network (no cachear datos dinamicos)
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/save') ||
      url.pathname.startsWith('/delete') ||
      url.pathname.startsWith('/records') ||
      url.pathname.startsWith('/export') ||
      url.pathname.startsWith('/clear-session')) {
    return;
  }

  // Assets estaticos: network first, fallback a cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
