// Service worker : l'appli et le plan de Gennevilliers fonctionnent hors ligne.
// Changer VERSION à chaque publication (le cache hors ligne est alors renouvelé).
const VERSION = "vision-ar-v49";
const MAX_TILES = 600;
const APP = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/app.js", "js/routing.js", "js/ar.js", "js/icons.js", "js/auth.js", "js/stickers.js",
  "img/geomessen.png", "img/stickers/salut.webp", "img/stickers/zero-marche.webp", "img/stickers/je-te-guide.webp", "img/stickers/ca-vibre.webp", "img/stickers/pente-douce.webp", "img/stickers/obstacle-signale.webp", "img/stickers/bien-arrive.webp", "img/stickers/vision-ar.webp", "img/stickers/bordure-abaissee.webp", "img/stickers/on-y-va.webp", "img/stickers/lis-sans-son.webp", "img/stickers/merci.webp", "img/geomessen-blanc.png", "img/auth-bg.jpg", "img/accueil.jpg",
  "fonts/atkinson-hyperlegible-400.woff2", "fonts/atkinson-hyperlegible-700.woff2", "icons/maskable-512.png",
  "data/gennevilliers.json", "data/transit.json", "js/transit.js", "js/obstacles.js", "js/zones.js", "data/ouaga2000.json", "data/ouaga2000.transit.json", "vendor/leaflet/leaflet.min.js", "vendor/leaflet/leaflet.min.css",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
];

self.addEventListener("install", e => {
  // cache: "reload" : ignorer le cache HTTP du navigateur (GitHub Pages autorise 10 min)
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("vision-ar-") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin && url.pathname.includes("/icons/")) return;   // icônes : jamais interceptées (écran d'accueil iOS)
  if (url.origin === location.origin) {
    // Fichiers de l'appli : le réseau d'abord (toujours la dernière version), le cache hors ligne
    e.respondWith(fetch(e.request, {cache: "no-cache"}).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch: true})));
  } else if (url.hostname.endsWith("tile.openstreetmap.org")) {
    // Fond de carte : le réseau d'abord, le cache des tuiles déjà vues en secours
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION + "-tiles").then(async c => {
        await c.put(e.request, copy);
        const keys = await c.keys();                 // au plus MAX_TILES tuiles gardées
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await c.delete(k);
      });
      return res;
    }).catch(() => caches.match(e.request)));
  }
  // Recherche d'adresse (IGN) : toujours en ligne, pas de cache
});
