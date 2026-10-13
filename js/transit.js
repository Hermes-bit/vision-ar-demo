// Transports en commun et recherche de lieux sans connaître l'adresse.
//
// - Arrêts de bus, stations de tram et de métro, gares RER / train (data/transit.json, OSM) : nom, lignes,
//   accessibilité en fauteuil, entrées des stations (le guidage mène à l'entrée la plus proche).
// - Recherche : « métro Les Agnettes », « pharmacie », « boulangerie Péri », « commerces rue Louis Calmel » :
//   mots de catégorie + nom + rue, sans accents, avec tolérance aux fautes de frappe.
import {haversineM} from "./routing.js";

export const MODE = {
  bus: {label: "Arrêt de bus", short: "Bus", icon: "bus", color: "#1864AB", badge: ""},
  tram: {label: "Station de tramway", short: "Tram", icon: "tram-front", color: "#0C8599", badge: "T"},
  metro: {label: "Station de métro", short: "Métro", icon: "train-front", color: "#364FC7", badge: "M"},
  rer: {label: "Gare RER", short: "RER", icon: "train-front", color: "#C92A2A", badge: "RER"},
  train: {label: "Gare", short: "Train", icon: "train-front", color: "#6741D9", badge: ""},
};
// Catégories de lieux (mêmes icônes que la vue caméra)
export const PLACE_INFO = {
  cafe: ["coffee", "Café"], restaurant: ["utensils", "Restaurant"], fast_food: ["sandwich", "Restauration rapide"],
  bar: ["beer", "Bar"], bakery: ["croissant", "Boulangerie"], food: ["shopping-basket", "Alimentation"],
  shop: ["shopping-bag", "Commerce"], clothes: ["shirt", "Vêtements"], hairdresser: ["scissors", "Coiffeur"],
  health_shop: ["heart-pulse", "Santé"], pharmacy: ["pill", "Pharmacie"], doctor: ["stethoscope", "Médecin"],
  hospital: ["hospital", "Hôpital"], bank: ["landmark", "Banque"], post_office: ["mail", "La Poste"],
  townhall: ["landmark", "Mairie"], library: ["book-open", "Médiathèque"], school: ["graduation-cap", "École"],
  police: ["shield", "Police"], worship: ["church", "Lieu de culte"], culture: ["drama", "Culture"],
  social: ["users", "Services sociaux"], market: ["store", "Marché"], hotel: ["bed", "Hôtel"],
  park: ["trees", "Parc"], sport: ["dumbbell", "Sport"],
};
const TRANSPORT_PLACES = new Set(["bus_stop", "tram", "train", "metro"]);   // déjà couverts par transit.json
const SHOPS = ["shop", "clothes", "bakery", "food", "health_shop", "hairdresser", "pharmacy", "cafe", "restaurant", "fast_food", "bar"];
const WHEEL = {yes: "Accessible en fauteuil", limited: "Accès partiel en fauteuil", no: "Non accessible en fauteuil"};
export const wheelText = w => WHEEL[w] || "Accessibilité en fauteuil inconnue";

export function loadTransit(data) {
  return (data.stops || []).map(([mode, lat, lon, name, lines, wheelchair, entrances]) => ({
    mode, lat, lon, name, wheelchair, lines: lines.map(([ref, colour]) => ({ref, colour})),
    entrances: entrances.map(([la, lo, label, w]) => ({lat: la, lon: lo, label, wheelchair: w})),
  }));
}

/** Point où guider : l'entrée de la station la plus proche de `from` (sinon l'arrêt lui-même). */
export function stopTarget(stop, from) {
  if (!stop.entrances.length || !from) return {lat: stop.lat, lon: stop.lon, entrance: null};
  const e = stop.entrances.reduce((a, b) => haversineM(from.lat, from.lon, a.lat, a.lon) <= haversineM(from.lat, from.lon, b.lat, b.lon) ? a : b);
  return {lat: e.lat, lon: e.lon, entrance: e};
}
export const linesText = stop => stop.lines.length
  ? `${stop.lines.length > 1 ? "lignes" : "ligne"} ${stop.lines.map(l => l.ref).join(", ")}` : "";

// ---- Recherche --------------------------------------------------------------------------------------------
export const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "et", "sur", "en", "pres", "proche", "vers"]);
const KEYWORDS = [
  [["metro", "metros"], {modes: ["metro"]}], [["rer"], {modes: ["rer"]}],
  [["gare", "gares", "train", "trains", "transilien", "sncf"], {modes: ["rer", "train"]}],
  [["tram", "tramway", "trams"], {modes: ["tram"]}], [["bus", "arret", "arrets", "abribus"], {modes: ["bus"]}],
  [["station", "stations"], {modes: ["metro", "tram", "rer", "train"]}],
  [["boulangerie", "boulangeries", "patisserie", "boulanger"], {cats: ["bakery"]}],
  [["pharmacie", "pharmacies"], {cats: ["pharmacy"]}], [["cafe", "cafes"], {cats: ["cafe"]}],
  [["restaurant", "restaurants", "resto", "restos"], {cats: ["restaurant", "fast_food"]}], [["bar", "bars"], {cats: ["bar"]}],
  [["banque", "banques", "distributeur"], {cats: ["bank"]}], [["poste"], {cats: ["post_office"]}], [["mairie"], {cats: ["townhall"]}],
  [["medecin", "medecins", "docteur", "cabinet"], {cats: ["doctor"]}], [["hopital", "clinique"], {cats: ["hospital"]}],
  [["ecole", "ecoles", "college", "lycee", "creche"], {cats: ["school"]}], [["police", "commissariat"], {cats: ["police"]}],
  [["supermarche", "epicerie", "alimentation", "superette"], {cats: ["food"]}], [["coiffeur", "coiffure", "coiffeurs"], {cats: ["hairdresser"]}],
  [["vetements", "habits"], {cats: ["clothes"]}], [["parc", "parcs", "jardin"], {cats: ["park"]}],
  [["sport", "gymnase", "piscine", "stade"], {cats: ["sport"]}], [["bibliotheque", "mediatheque"], {cats: ["library"]}],
  [["marche"], {cats: ["market"]}], [["hotel", "hotels"], {cats: ["hotel"]}], [["eglise", "mosquee", "temple", "synagogue"], {cats: ["worship"]}],
  [["commerce", "commerces", "magasin", "magasins", "boutique", "boutiques"], {cats: SHOPS}],
];
const STREET = new Set(["rue", "avenue", "av", "boulevard", "bd", "place", "allee", "allees", "impasse", "chemin", "quai", "passage", "route", "square", "sente", "cours"]);

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}
// Un mot cherché correspond à un mot du lieu : début de mot, ou 1 à 2 fautes de frappe selon sa longueur
const wordMatch = (q, t) => t.startsWith(q) || (q.length >= 4 && lev(q, t.slice(0, q.length)) <= (q.length >= 7 ? 2 : 1)) ||
  (q.length >= 4 && lev(q, t) <= (q.length >= 7 ? 2 : 1));
const allMatch = (qs, text) => { const ts = norm(text).split(" "); return qs.every(q => ts.some(t => wordMatch(q, t))); };

/** Analyse « métro les agnettes » -> {modes, cats, words, street}. */
export function parseQuery(q) {
  const words = norm(q).split(" ").filter(Boolean);
  let modes = null, cats = null, street = null;
  const rest = [], catWords = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (STREET.has(w) && i < words.length - 1) {                // « rue Louis Calmel » : la fin de la requête est la rue
      street = words.slice(i + 1).filter(x => !STOP.has(x));
      break;
    }
    const k = KEYWORDS.find(([keys]) => keys.includes(w));
    if (k) {
      if (k[1].modes) modes = [...new Set([...(modes || []), ...k[1].modes])];
      if (k[1].cats) { cats = [...new Set([...(cats || []), ...k[1].cats])]; catWords.push(w); }
      continue;
    }
    if (!STOP.has(w)) rest.push(w);
  }
  // « bus mairie », « tram parc » : un mode de transport est donné, l'autre mot fait partie du nom de l'arrêt
  if (modes && cats) return {modes, cats: null, words: [...rest, ...catWords], street};
  return {modes, cats, words: rest, street};
}

/** Rue la plus proche (40 m au plus) d'un point : sert à « commerces rue … » et à afficher l'adresse. */
export function makeStreetFinder(net) {
  const cache = new Map();
  const named = net.edges.filter(e => e.name && e.shape?.length);
  return (lat, lon) => {
    const key = `${lat},${lon}`;
    if (cache.has(key)) return cache.get(key);
    const k = Math.cos(lat * Math.PI / 180) * 111320, m = 111320;
    let best = null, bd = 40;
    for (const e of named) {
      for (let i = 1; i < e.shape.length; i++) {
        const [a, b] = [e.shape[i - 1], e.shape[i]];
        const ax = (a[1] - lon) * k, ay = (a[0] - lat) * m, bx = (b[1] - lon) * k, by = (b[0] - lat) * m;
        if (Math.min(Math.abs(ax), Math.abs(bx)) > bd + 200 || Math.min(Math.abs(ay), Math.abs(by)) > bd + 200) continue;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < bd) { bd = d; best = e.name; }
      }
    }
    cache.set(key, best);
    return best;
  };
}

/**
 * Lieux et arrêts correspondant à la requête, triés par pertinence puis par distance.
 * Résultat : {label, sub, lat, lon, type: "poi", kind, icon, color, dist, stop?}
 */
export function searchPlaces(q, {places, stops, streetOf, from, limit = 8}) {
  const {modes, cats, words, street} = parseQuery(q);
  if (!words.length && !modes && !cats && !street) return [];
  const out = [];
  const consider = (item, name, extra) => {
    let score = 1;
    if (words.length) {
      if (!allMatch(words, `${name} ${extra}`)) return;
      score = allMatch(words, name) ? 3 : 2;
    }
    let rue = null;
    if (street) {
      rue = streetOf(item.lat, item.lon);
      if (!rue || !allMatch(street, rue)) return;
    }
    out.push({...item, score, rue, dist: from ? haversineM(from.lat, from.lon, item.lat, item.lon) : 0});
  };
  if (!cats || modes) for (const s of stops) {
    if (modes && !modes.includes(s.mode)) continue;
    const m = MODE[s.mode] || MODE.bus, t = stopTarget(s, from), lines = linesText(s);
    consider({label: `${m.short} ${s.name}`, kind: s.mode, icon: m.icon, color: m.color, lat: t.lat, lon: t.lon, type: "poi", stop: s,
              typeLabel: `${m.label}${lines ? " · " + lines : ""}${t.entrance ? " · entrée la plus proche" : ""}`}, s.name, `${m.short} ${lines}`);
  }
  if (!modes || cats) for (const [cat, lat, lon, name] of places) {
    if (TRANSPORT_PLACES.has(cat) || !PLACE_INFO[cat]) continue;
    if (cats && !cats.includes(cat)) continue;
    if (!name && words.length) continue;
    const [ic, label] = PLACE_INFO[cat];
    consider({label: name || label, kind: cat, icon: ic, color: "#007489", lat, lon, type: "poi", typeLabel: label}, name || "", label);
  }
  out.sort((a, b) => b.score - a.score || a.dist - b.dist);
  // un arrêt a souvent deux quais (un par sens) : un seul résultat, le quai le plus proche
  const seen = new Set();
  return out.filter(r => { const k = `${r.kind}|${r.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit).map(r => ({...r, rue: r.rue ?? streetOf(r.lat, r.lon)}));
}
