// Service worker : l'appli et le plan de Gennevilliers fonctionnent hors ligne.
// Changer VERSION à chaque publication (le cache hors ligne est alors renouvelé).
// Trois sites partagent l'adresse hermes-bit.github.io (donc le même stockage sur un téléphone) : la version de
// TEST (/vision-ar-demo/), la version STABLE (/vision-ar/) et la version de PRÉSENTATION pour les recruteurs
// (/vision-ar-presentation/), publiées par scripts/publier_stable.py. Chacun a ses propres caches et n'efface que les siens.
const SITE = new URL(self.location.href).pathname.split("/")[1] || "";
const PREFIX = {"vision-ar": "va-stable-", "vision-ar-presentation": "va-pres-"}[SITE] || "vision-ar-";
const VERSION = PREFIX + "v91";
// Cartes et bibliothèques gardées pour le hors-ligne : un cache à part, qui SURVIT aux mises à jour de l'appli
// (avant, chaque nouvelle version effaçait les cartes déjà téléchargées)
const MAP_CACHE = PREFIX + "cartes", MAX_MAP = 4000;
// Détecteur d'obstacles (models/*.onnx, 11 Mo) : cache à part, gardé d'une version à l'autre ; mis à jour
// seulement si le fichier publié change (requête conditionnelle : quelques octets si rien n'a bougé)
const MODEL_CACHE = PREFIX + "modeles";
// Fichiers qui ne changent jamais (versions figées, tuiles datées) : le cache d'abord, le réseau sinon
const STATIC_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com", "tfhub.dev", "www.kaggle.com"];
const APP = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "js/app.js", "js/routing.js", "js/ar.js", "js/icons.js", "js/auth.js", "js/stickers.js", "js/arrival.js", "js/corridor.js", "js/speech.js", "js/features.js", "js/yolo.js", "js/detector-worker.js", "js/categories.js", "js/origin.js", "data/gennevilliers.acces.json",
  "img/geomessen.png", "img/vision-ar-logo.png", "img/stickers/salut.webp", "img/stickers/zero-marche.webp", "img/stickers/je-te-guide.webp", "img/stickers/ca-vibre.webp", "img/stickers/pente-douce.webp", "img/stickers/obstacle-signale.webp", "img/stickers/bien-arrive.webp", "img/stickers/vision-ar.webp", "img/stickers/bordure-abaissee.webp", "img/stickers/on-y-va.webp", "img/stickers/lis-sans-son.webp", "img/stickers/merci.webp", "img/geomessen-blanc.png", "img/auth-bg.jpg", "img/accueil.jpg",
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
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX + "v") && k !== VERSION).map(k => caches.delete(k))))
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
  if (url.origin === location.origin && url.pathname.includes("/models/")) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(MODEL_CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, {cacheName: MODEL_CACHE})));
  } else if (url.origin === location.origin) {
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
