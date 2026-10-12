// Service worker : l'appli et le plan de Gennevilliers fonctionnent hors ligne.
// Changer VERSION à chaque publication pour que les téléphones prennent la mise à jour.
const VERSION = "vision-ar-v2";
const MAX_TILES = 600;
const APP = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/app.js", "js/routing.js",
  "data/gennevilliers.json", "vendor/leaflet/leaflet.min.js", "vendor/leaflet/leaflet.min.css",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("vision-ar-") && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin) {
    // Fichiers de l'appli : le cache d'abord (démarrage instantané, hors ligne)
    e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request)));
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
