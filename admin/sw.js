/* ============================================================
   Packet — Service worker (PWA installability)
   ------------------------------------------------------------
   Why this exists:
   Chrome (Android + desktop) will only offer the real "Install
   app" experience — and open the app standalone — when the site
   registers a service worker that has a *real* fetch handler.
   A manifest + icons alone are NOT enough on Android.

   Strategy: NETWORK-FIRST.
   The installed app must always show the live site, so every
   deploy appears instantly. We go to the network first and only
   fall back to a cached copy when the device is offline. This
   keeps "the installed app IS the live site" true — no stale
   versions, no app store.

   HISTORY: an earlier AXRIK kit shipped WITHOUT a fetch handler,
   which silently broke installability on Android. This network-first
   handler is the fix — keep it. (See .axrik-patterns/blueprint-pwa-install.md)
   ============================================================ */

const CACHE = 'packet-admin-runtime-v1';

// Take control immediately on install.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Clean up old caches and start controlling open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first with an offline fallback (this is the required fetch handler).
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GETs; let everything else pass through untouched.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Stash a copy so the app still opens if the device goes offline.
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Last resort for a navigation while offline: serve the app root.
      if (req.mode === 'navigate') {
        const home = await caches.match('./');
        if (home) return home;
      }
      throw err;
    }
  })());
});
