// Bump this version on every deploy to bust stale caches.
const CACHE_NAME = 'bridgecam-pwa-v9'
const ASSETS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/src/app.js',
  '/src/camera.js',
  '/src/connection.js',
  '/src/receiver.js',
  '/manifest.json'
]

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (ev) => {
  // Never intercept non-GET requests (e.g., POST /create-room) or cross-origin requests
  if (ev.request.method !== 'GET') return
  const url = new URL(ev.request.url)
  if (url.origin !== self.location.origin) return

  const isCodeOrDoc =
    ev.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css')

  if (isCodeOrDoc) {
    // Network-first so code and HTML updates land immediately
    ev.respondWith(
      fetch(ev.request, { cache: 'no-cache' })
        .then(resp => {
          if (resp && resp.ok) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then(c => c.put(ev.request, clone))
          }
          return resp
        })
        .catch(() => caches.match(ev.request))
    )
  } else {
    // Cache-first for icons/manifest
    ev.respondWith(
      caches.match(ev.request).then(r => r || fetch(ev.request))
    )
  }
})
