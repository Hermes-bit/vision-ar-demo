// Service worker : l'appli et le plan de Gennevilliers fonctionnent hors ligne.
// Changer VERSION à chaque publication (le cache hors ligne est alors renouvelé).
const VERSION = "vision-ar-v60";
// Cartes et bibliothèques gardées pour le hors-ligne : un cache à part, qui SURVIT aux mises à jour de l'appli
// (avant, chaque nouvelle version effaçait les cartes déjà téléchargées)
const MAP_CACHE = "vision-ar-cartes", MAX_MAP = 4000;
// Fichiers qui ne changent jamais (versions figées, tuiles datées) : le cache d'abord, le réseau sinon
const STATIC_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "tfhub.dev", "www.kaggle.com"];
const APP = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/app.js", "js/routing.js", "js/ar.js", "js/icons.js", "js/auth.js", "js/stickers.js", "js/indoor.js", "js/beacons.js", "vendor/js-aruco2/cv.js", "vendor/js-aruco2/aruco.js", "vendor/js-aruco2/dictionaries/aruco_4x4_1000.js", "data/indoor.json", "img/indoor/demo-rdc.svg", "img/indoor/demo-etage1.svg",
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
    .then(keys => Promise.all(keys.filter(k => k.startsWith("vision-ar-") && k !== VERSION && k !== MAP_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let trimming = null;
function keepMap(request, response) {
  caches.open(MAP_CACHE).then(async c => {
    await c.put(request, response);
    // au plus MAX_MAP fichiers gardés ; les plus anciens partent d'abord (vérifié au plus une fois par minute)
    if (trimming) return;
    trimming = setTimeout(async () => {
      const keys = await c.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MAP))) await c.delete(k);
      trimming = null;
    }, 60000);
  });
}

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
  } else if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname === "tiles.openfreemap.org") {
    // Fonds de carte (tuiles, styles, polices, pictogrammes) : le réseau d'abord, la copie gardée hors connexion
    e.respondWith(fetch(e.request).then(res => { if (res.ok) keepMap(e.request, res.clone()); return res; })
      .catch(() => caches.match(e.request, {cacheName: MAP_CACHE})));
  } else if (STATIC_HOSTS.includes(url.hostname)) {
    // Bibliothèques à version figée (fond vectoriel, détecteur d'obstacles) : la copie gardée d'abord
    e.respondWith(caches.match(e.request, {cacheName: MAP_CACHE}).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === "opaque") keepMap(e.request, res.clone());
      return res;
    })));
  }
  // Recherche d'adresse (IGN) : toujours en ligne, pas de cache
});
