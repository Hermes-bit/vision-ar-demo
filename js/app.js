// Vision AR — démo web mobile (installable sur l'écran d'accueil).
// Écrans repris de l'appli Android (phone/ui/Screens.kt) ; itinéraires calculés
// sur le téléphone par js/routing.js, copie fidèle du moteur du serveur.
import {arOpen, closeAR, currentHeading, openAR} from "./ar.js";
import {MODE, linesText, loadTransit, makeStreetFinder, searchPlaces, stopTarget, wheelText} from "./transit.js";
import {clearSamples, exportZip, listSamples} from "./obstacles.js";
import {ZONES, zoneLabel} from "./zones.js";
import {bindAuth, configureAuth, currentSession, isGuest, logout, resetForm, screenLogin, screenSignup, screenWelcome} from "./auth.js";
import {icon} from "./icons.js";
import {CONSIGNE, DANGER, INFO, makeSpeech} from "./speech.js";
import {FEATURES} from "./features.js";
import {sticker, stickerPop} from "./stickers.js";
import {arrivalFiche, arrivalSpeech, entranceFor, erpList, loadAcces} from "./arrival.js";
import {entranceAccess, erpCategory} from "./categories.js";
import {ORIGIN_RULES, decideOrigin, distM, originValid} from "./origin.js";
import {labelPoints, minutes, walkingChoices} from "./compare.js";
import {startCompass} from "./compass.js";
import {computeRoutes, loadNetwork, nearestNode, RoutingError, SNAP_MAX_DISTANCE_M, haversineM, resolveProfile} from "./routing.js";

const MOB = [["manual_wheelchair", "Fauteuil roulant manuel", "accessibility"], ["electric_wheelchair", "Fauteuil électrique", "wheelchair-electric"],
  ["cane_or_walker", "Canne ou déambulateur", "cane"], ["low_vision", "Malvoyance", "eye-off"], ["hard_of_hearing", "Malentendance", "ear-off"]];
const PRIORITY = ["manual_wheelchair", "electric_wheelchair", "cane_or_walker", "low_vision", "hard_of_hearing"];
const REPORT_KINDS = [["works", "Travaux", "construction"], ["step", "Marche", "stairs"], ["street_furniture", "Mobilier urbain", "lamp-floor"],
  ["narrow_sidewalk", "Trottoir étroit", "narrow"], ["elevator_out", "Ascenseur en panne", "elevator"], ["parked_vehicle", "Véhicule garé", "car"],
  ["other", "Autre obstacle", "circle-alert"]];
// Durées de vie : identiques à app/reports.py et à la table va_report_kind_info
const REPORT_TTL_H = {parked_vehicle: 2, street_furniture: 72, other: 48};
const MAN_ICON = {left: "corner-up-left", right: "corner-up-right", slight_left: "arrow-up-left", slight_right: "arrow-up-right",
  uturn: "uturn", straight: "arrow-up", depart: "navigation", arrive: "flag"};
const VERB = {left: "À GAUCHE", slight_left: "SERREZ À GAUCHE", right: "À DROITE", slight_right: "SERREZ À DROITE", uturn: "DEMI-TOUR"};
const POI = {elevator: ["elevator", "Ascenseur"], accessible_toilet: ["toilet", "Toilettes accessibles"], disabled_parking: ["square-parking", "Place PMR"],
  accessible_entrance: ["door-open", "Entrée accessible"], ramp: ["arrow-up-right", "Rampe"], audio_beacon: ["volume-2", "Balise sonore"]};
const KIND_LABEL = {sidewalk: "Trottoir", crossing: "Passage piéton", footway: "Chemin piéton", street: "Rue",
  path: "Sentier", steps: "Escalier", pedestrian: "Voie piétonne", elevator: "Ascenseur", ramp: "Rampe"};
// Pentes sur la carte : teintes distinguables par les daltoniens, contraste >= 3:1 sur le fond OSM
const C = {route: "#00AECC", routeCase: "#00495A", alt: "#6B7C8F", primary: "#007489", unknown: "#5C6B7A", step: "#0F2537"};
// Ville / quartier choisi dans les Paramètres (js/zones.js)
// Site : test (/vision-ar-demo/ et ordinateur), stable (/vision-ar/) ou présentation pour les recruteurs
// (/vision-ar-presentation/ : découverte sans compte, départ à la Mairie sans GPS, guidage simulé)
const APP_CHANNEL = {"vision-ar": "stable", "vision-ar-presentation": "presentation"}[location.pathname.split("/")[1]] || "test";
const PRESENTATION = APP_CHANNEL === "presentation";
configureAuth({presentation: PRESENTATION});
const ZONE_ID = (() => { try { const z = JSON.parse(localStorage.getItem("va-zone")); return ZONES[z] ? z : "gennevilliers"; } catch { return "gennevilliers"; } })();
const ZONE = ZONES[ZONE_ID];
const MAIRIE = ZONE.start;                                   // centre de la zone (plan à l'ouverture ; départ de la présentation)
// Pas de départ tant que la position n'est pas connue (plus de départ fixé à la Mairie) : lat/lon gardent le
// centre de la zone pour le plan, « none » dit qu'aucun trajet ne doit partir de là
const NO_ORIGIN = () => ({lat: MAIRIE.lat, lon: MAIRIE.lon, label: "", none: true});
const GEOCODER = "https://data.geopf.fr/geocodage/search/";       // France (IGN)
const PHOTON = "https://photon.komoot.io/api/";                    // ailleurs (OpenStreetMap)

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const fmt1 = x => x.toFixed(1).replace(".", ",");
const short = m => m < 1000 ? `${Math.max(0, Math.round(m / 5) * 5)} m` : `${fmt1(m / 1000)} km`;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
};

const saved = store.get("va-profile", null);
const S = {
  screen: !currentSession() ? "welcome" : saved ? "route" : "profile",
  mobilities: new Set(saved?.mobilities || ["manual_wheelchair"]), maxSlope: saved?.maxSlope ?? null, steps: saved?.steps ?? false,
  voice: store.get("va-voice", true), haptics: store.get("va-haptics", true), stopsVoice: store.get("va-stops-voice", false), detect: store.get("va-detect", true), detectDebug: store.get("va-detect-debug", false),
  dataConsent: store.get("va-data-consent", false), autoLowConf: store.get("va-auto-lowconf", false), origin: PRESENTATION ? {...MAIRIE} : NO_ORIGIN(), dest: null, query: "", places: [],
  // départ : la position actuelle, demandée dès l'ouverture de la recherche ; searchFor « origin » quand on modifie
  // le départ (présentation : départ à la Mairie, la visite se fait de n'importe où, sans demande de localisation)
  originMode: PRESENTATION ? "manual" : "gps", originNeedsFix: !PRESENTATION, searchFor: "dest", oquery: "",
  simulate: store.get("va-simulate", PRESENTATION),
  // Alertes de proximité (5 à 10 m), portée des étiquettes de lieux dans la caméra, économie de batterie
  alertDist: store.get("va-alert-dist", 8), placesRange: store.get("va-places-range", 50), eco: store.get("va-eco", true), audioOnly: store.get("va-audio-only", false),
  routes: [], selected: 0, message: null, loading: false, nav: null, blocking: true, hud: false, hc: false, tripMob: null,
  logo: ["vert", "soleil", "nuit", "pastille"].includes(store.get("va-logo", "vert")) ? store.get("va-logo", "vert") : "vert",
};
let net = null, transit = [], streetOf = () => null;
let installPrompt = null;
let syncLayers = () => {};

// ---- Thème : « verre » (clair, ruban lumineux) ou « neon » (sombre, repères flottants) ----------
S.theme = store.get("va-theme", matchMedia("(prefers-color-scheme: dark)").matches ? "neon" : "verre");
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = S.theme === "neon" ? "#061019" : "#E8F4F8";
}
function setTheme(t) {
  S.theme = t;
  store.set("va-theme", t);
  applyTheme();
}
applyTheme();
const THEME_CHOICES = [["verre", "Verre", "Clair, ruban lumineux"], ["neon", "Néon", "Sombre, repères flottants"]];
const themeCards = attr => THEME_CHOICES.map(([v, l, d]) => `<button class="theme-card ${S.theme === v ? "on" : ""}" ${attr}="${v}">
  <span class="preview pv-${v}"><i></i><i></i><i></i></span><b>${l}</b><small>${d}</small></button>`).join("");

// ---- Profil -> requête (core/UserProfile.kt) --------------------------------------
const primary = () => PRIORITY.find(m => S.mobilities.has(m)) || "pedestrian";
// Profil du trajet : « Mon profil » (réglé dans Profil) ou, le temps d'une recherche, un autre profil choisi sous
// les itinéraires (S.tripMob : jamais enregistré, oublié à la fermeture du choix d'itinéraire)
const TRIP_MOBS = [["pedestrian", "À pied", "footprints"], ["manual_wheelchair", "Fauteuil", "accessibility"],
  ["cane_or_walker", "Canne", "cane"], ["low_vision", "Malvoyance", "eye-off"]];
const tripMobility = () => S.tripMob || primary();
const tripMobilities = () => S.tripMob ? new Set([S.tripMob]) : S.mobilities;
function profileJson() {
  if (S.tripMob) return {mobility: S.tripMob};
  const p = {mobility: primary(), steps_allowed: S.steps};
  if (S.maxSlope != null) p.max_slope_pct = S.maxSlope;
  if (S.mobilities.has("low_vision")) p.prefers_sound_signals = true;
  return p;
}
const speed = () => resolveProfile(profileJson()).speed_m_s;

// ---- Signalements (gardés sur ce téléphone) ----------------------------------------
function reports() {
  const now = Date.now();
  const list = store.get("va-reports", []).filter(r => r.expires > now);
  store.set("va-reports", list);
  return list;
}
function addReport(kind, blocking, at) {
  const now = Date.now();
  const r = {id: now, kind, blocking, lat: at.lat, lon: at.lon, created: now, expires: now + (REPORT_TTL_H[kind] ?? 336) * 3600e3};
  store.set("va-reports", [...reports(), r]);
  return r;
}

// ---- Voix et vibrations ---------------------------------------------------------------
// Annonces par ordre d'urgence (js/speech.js) : un danger coupe une info, une consigne attend la fin d'un
// danger, rien n'est répété ni rattrapé en retard. `level` : DANGER, CONSIGNE, INFO (true = CONSIGNE, false = INFO).
const speech = makeSpeech({
  speak(text, onEnd) {
    let done = false;
    const fin = () => { if (!done) { done = true; onEnd(); } };
    setTimeout(fin, 1500 + text.length * 90);              // filet : sur iPhone, la fin de lecture n'est pas toujours signalée
    if (window.VisionARNative) { window.VisionARNative.speak(text, true); return; }   // appli Android : voix du téléphone
    if (!("speechSynthesis" in window)) return fin();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR"; u.onend = fin; u.onerror = fin;
    speechSynthesis.speak(u);
  },
  cancel() { if (!window.VisionARNative) window.speechSynthesis?.cancel(); },
});
// iPhone : Safari ne parle qu'après une première lecture lancée PENDANT un appui de l'usager. Appelé dans
// le geste « Démarrer le guidage » : une phrase vide et muette débloque la voix pour tout le trajet.
function unlockVoice() {
  if (window.VisionARNative || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel(); speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0; u.lang = "fr-FR";
    speechSynthesis.speak(u);
    speechSynthesis.getVoices();                          // charge la liste des voix (française) en avance
  } catch { /* pas de synthèse vocale : l'écran et les vibrations restent */ }
}
function say(text, level = false) {
  if (!S.voice) return;
  speech.say(text, level === true ? CONSIGNE : level === false ? INFO : level);
}
// Vibrations de direction : le nombre d'impulsions dit où aller (même code sur Android et sur iPhone)
//   2 = à gauche, 3 = à droite, 5 rapides = mauvais sens / demi-tour, 1 longue = arrivé
const HAPTIC = {left: [160, 140, 160], right: [160, 140, 160, 140, 160], uturn: [70, 60, 70, 60, 70, 60, 70, 60, 70], arrive: [700], tick: [40],
  obstacle: [450, 120, 120]};
const IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let iosSwitch = null;
function iosTap() {
  // Safari (iPhone) n'a pas navigator.vibrate ; depuis iOS 18, basculer un interrupteur natif
  // produit un petit « tic » du moteur haptique. Au mieux : rien n'est garanti hors d'un geste de l'usager.
  if (!iosSwitch) {
    iosSwitch = document.createElement("label");
    iosSwitch.setAttribute("aria-hidden", "true");
    iosSwitch.style.cssText = "position:fixed;left:-200px;top:0;width:1px;height:1px;overflow:hidden;opacity:0";
    iosSwitch.innerHTML = '<input type="checkbox" switch tabindex="-1">';
    document.body.append(iosSwitch);
  }
  iosSwitch.click();
}
function buzz(kind) {
  const pattern = HAPTIC[kind];
  if (!S.haptics || !pattern) return;
  if (window.VisionARNative) { window.VisionARNative.vibrate(JSON.stringify(pattern)); return; }
  if (navigator.vibrate) { navigator.vibrate(pattern); return; }
  if (!IOS) return;
  iosTap();
  let t = Math.max(pattern[0], 120);
  pattern.forEach((ms, i) => { if (i % 2 === 0 && i > 0) setTimeout(iosTap, t); if (i > 0) t += Math.max(ms, 120); });
}
const hapticsNote = () => window.VisionARNative || navigator.vibrate ? "" : IOS
  ? "Sur iPhone, Safari ne donne pas accès au vibreur : de petits « tics » sont tentés (iOS 18 et plus), sans garantie. La voix reste le repère principal."
  : "Ce navigateur ne permet pas les vibrations.";
const turnSide = m => m === "left" || m === "slight_left" ? "left" : m === "right" || m === "slight_right" ? "right" : m === "uturn" ? "uturn" : null;
function toast(text, ms = 3500) {
  const t = $("toast");
  t.innerHTML = `${icon("info")}<span>${esc(text)}</span>`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- Carte ---------------------------------------------------------------------------------
const map = L.map("map", {zoomControl: false, preferCanvas: true}).setView([MAIRIE.lat, MAIRIE.lon], 16);
// Fonds de carte au choix (Paramètres). Google Maps et Plans d'Apple ne sont pas proposés : leurs conditions
// imposent leurs propres kits (clé payante / compte développeur) et interdisent de reprendre leurs tuiles ici.
const IGN_WMTS = layer => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const BASEMAPS = {
  osm: {label: "OpenStreetMap", sub: "Plan détaillé : trottoirs, passages piétons, commerces",
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: OSM_ATTR + (ZONE.france ? " · relief © IGN" : "")},
  ign: {label: "Plan IGN", sub: "Carte officielle française, lisible et sobre",
        url: IGN_WMTS("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png"), maxZoom: 19, attribution: "© IGN · réseau © OpenStreetMap"},
  ortho: {label: "Photos aériennes", sub: "Vue du ciel (IGN), comme le mode satellite",
          url: IGN_WMTS("ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg"), maxZoom: 19, attribution: "Photos © IGN · réseau © OpenStreetMap", bg: "#5B6450"},
  // Fonds vectoriels OpenFreeMap : gratuits, sans clé ni limite ; affichés par MapLibre, chargé seulement si choisi
  liberty: {label: "Style Plans", sub: "Clair et coloré, proche de Plans (Apple) et de Google Maps",
            style: "https://tiles.openfreemap.org/styles/liberty", attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ${OSM_ATTR}`},
  positron: {label: "Épuré", sub: "Très sobre, gris clair : l'itinéraire ressort bien",
             style: "https://tiles.openfreemap.org/styles/positron", attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> · © OpenMapTiles · ${OSM_ATTR}`},
};
const MAPLIBRE = ["https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.js",
                  "https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js"];
let maplibreLoading = null;
function loadMaplibre() {
  const load = src => new Promise((ok, ko) => {
    const el = document.createElement("script");
    el.src = src; el.crossOrigin = "anonymous"; el.onload = ok; el.onerror = () => ko(new Error(src));
    document.head.append(el);
  });
  if (!maplibreLoading) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.css";
    document.head.append(css);
    maplibreLoading = load(MAPLIBRE[0]).then(() => load(MAPLIBRE[1])).catch(e => { maplibreLoading = null; throw e; });
  }
  return maplibreLoading;
}
const basemapAvailable = k => ZONE.france || !["ign", "ortho"].includes(k);
let baseLayer = null, basemapRequest = 0;
async function setBasemap(key) {
  if (key === "voyager") key = "liberty";                 // ancien fond CARTO (clé désormais exigée)
  if (!basemapAvailable(key)) key = "osm";               // fonds IGN : France seulement
  const b = BASEMAPS[key] || BASEMAPS.osm, request = ++basemapRequest;
  S.basemap = BASEMAPS[key] ? key : "osm";
  store.set("va-basemap2", S.basemap);
  let layer;
  if (b.style) {
    try { await loadMaplibre(); } catch { toast("Ce fond de carte ne peut pas se charger (connexion ?) : retour au plan OpenStreetMap."); return setBasemap("osm"); }
    if (request !== basemapRequest) return;               // un autre fond a été choisi entre-temps
    // padding : marge dessinée autour de l'écran, pour qu'un glissement rapide ne découvre pas de bord vide
    layer = L.maplibreGL({style: b.style, interactive: false, padding: 0.25, updateInterval: 16});  // mention fournie par le style lui-même
  } else {
    // keepBuffer : quelques tuiles d'avance autour de l'écran, pour que la carte qui suit vos pas ne montre pas de trou
    layer = L.tileLayer(b.url, {maxZoom: b.maxZoom, subdomains: b.subdomains || "abc", keepBuffer: 4, updateWhenIdle: false,
      attribution: b.attribution});
  }
  baseLayer?.remove();
  // la mention des sources repart de zéro (le fond vectoriel ajoute la sienne et ne la retire pas en partant)
  const ctl = map.attributionControl;
  for (const k of Object.keys(ctl._attributions || {})) delete ctl._attributions[k];
  ctl._update?.();
  baseLayer = layer.addTo(map);
  baseLayer.bringToBack?.();
  // Sous le fond de carte, la couleur du fond de carte : un instant de retard au dessin (zoom, déplacement rapide,
  // tuile qui arrive) ne laisse plus voir de bande sombre, seulement la teinte de la carte
  $("map").style.background = b.bg || "#F2EFE9";
}
// Le plugin MapLibre agrandit son conteneur quand la carte change de taille, mais pas le dessin lui-même :
// sans ceci, le fond vectoriel garde la taille du plan réduit (40 % de l'écran) et le reste reste vide.
map.on("resize", () => {
  const gl = baseLayer?.getMaplibreMap?.();
  if (!gl) return;
  baseLayer._resizeContainer();
  gl.resize();
  baseLayer._update();
});
// La carte change de taille sans prévenir (barre de Safari qui se replie, rotation, panneau) : on suit
// la taille réelle du cadre pour que Leaflet charge toujours tout l'écran.
let mapResizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(mapResizeFrame);
  mapResizeFrame = requestAnimationFrame(() => map.invalidateSize());
}).observe(document.getElementById("map"));
// Logo de l'appli (écran d'accueil) : dossier icons/logos/<nom>/ ; « vert » = icônes par défaut à la racine de icons/
const LOGOS = {vert: "Vert", soleil: "Soleil", nuit: "Nuit", pastille: "Pastille"};
const logoDir = (k = S.logo) => k === "vert" ? "icons/" : `icons/logos/${k}/`;
function setLogo(k) {
  S.logo = LOGOS[k] ? k : "vert";
  store.set("va-logo", S.logo);
  const manifest = document.querySelector('link[rel="manifest"]');          // absent sur iPhone (voir index.html)
  if (manifest) manifest.href = (S.logo === "vert" ? "manifest.webmanifest" : `manifest-${S.logo}.webmanifest`) + "?v=3";
  document.querySelector('link[rel="icon"]').href = `${logoDir()}favicon-32.png?v=3`;
  embedLogo();
}
// L'icône d'écran d'accueil est intégrée à la page (data:) : l'appli lit elle-même le fichier, ce qui marche
// là où le téléchargement fait par l'iPhone au moment de l'ajout échoue
async function embedLogo() {
  const link = $("touchIcon"), logo = S.logo;
  if (!link) return;
  try {
    const blob = await fetch(`${logoDir(logo)}apple-touch-icon.png?v=3`).then(r => r.blob());
    const data = await new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ko; fr.readAsDataURL(blob); });
    if (S.logo !== logo) return;                          // un autre logo a été choisi entre-temps
    link.href = data;
    try { logo === "vert" ? localStorage.removeItem("va-logo-icon") : localStorage.setItem("va-logo-icon", data); } catch { /* navigation privée */ }
  } catch { /* hors ligne : on réessaiera au prochain lancement */ }
}
if (S.logo !== "vert") embedLogo();                     // copie intégrée remise à jour à chaque lancement
// Mention des sources (exigée par les licences des fonds) : recopiée dans une bande fixe en bas de l'écran,
// toujours lisible par-dessus le panneau. Celle de Leaflet ne sert plus qu'à la mini-carte du guidage caméra.
map.attributionControl.setPosition("topright");
const credits = document.createElement("div");
credits.id = "mapCredits";
credits.className = "map-credits";
document.body.append(credits);
new MutationObserver(() => { credits.innerHTML = map.attributionControl.getContainer().innerHTML; })
  .observe(map.attributionControl.getContainer(), {childList: true, subtree: true, characterData: true});
// après le déplacement de la mention (sinon Leaflet compte deux fois la source du premier fond)
// « Style Plans » par défaut ; nouvelle clé : les choix « OpenStreetMap » enregistrés automatiquement avant ne comptent plus
setBasemap(store.get("va-basemap2", "liberty"));
const layers = {progress: L.layerGroup().addTo(map), transit: L.layerGroup().addTo(map), pois: L.layerGroup(), reports: L.layerGroup().addTo(map),
  routes: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map)};

const pin = (ic, cls) => L.divIcon({className: "", html: `<div class="pin ${cls}">${icon(ic)}</div>`,
  iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36]});
// ---- Repères de la carte : équipements d'accessibilité et établissements -----------------------------------
// Équipements (entrées accessibles, toilettes, ascenseurs, places PMR…) : carré bleu, comme la signalétique PMR.
// Établissements (Acceslibre) : rond à la couleur de leur famille, pictogramme de leur activité (js/categories.js)
// et pastille d'accessibilité de l'entrée (✓ plain-pied, ! marches). Pour rester lisible :
//  - zoom 16 : les établissements sont de simples points de couleur ; zoom 17 et plus : leurs pictogrammes ;
//  - deux repères qui se chevauchent : le moins important devient un point (il reprend sa place en zoomant) ;
//  - itinéraire affiché : la carte se met au service du trajet. Établissements masqués, seuls les équipements
//    à moins de 30 m du trajet restent (en petit), et seulement les arrêts sur le trajet ou à ses extrémités.
const poiItems = [];                                         // {m, lat, lon, kind: "infra" | "erp", rank, mode, icons}
const mkIcon = (html, size) => L.divIcon({className: "", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2 - 2]});
function addPoi(m, lat, lon, kind, rank, icons) {
  poiItems.push({m, lat, lon, kind, rank, icons, mode: null});
  poiItems.sort((x, y) => x.rank - y.rank);
}
function drawErps() {
  const list = erpList();
  if (!list.length) return setTimeout(drawErps, 1500);        // fiches pas encore chargées
  for (const [name, activity, lat, lon, f = {}] of list) {
    const c = erpCategory(activity), acc = entranceAccess(f);
    const info = [acc === "ok" ? "Entrée de plain-pied" : acc === "steps" ? "Entrée avec marche(s)" : "Accès de l'entrée non renseigné",
      f.entree_largeur_mini ? `porte de ${Math.round(f.entree_largeur_mini)} cm` : "", f.sanitaires_adaptes ? "toilettes adaptées" : ""].filter(Boolean);
    const badge = acc ? `<b class="mk-acc ${acc}">${acc === "ok" ? icon("check") : "!"}</b>` : "";
    const icons = {full: mkIcon(`<div class="mk mk-erp" style="--c:${c.color}">${icon(c.icon)}${badge}</div>`, 30),
      dot: mkIcon(`<div class="mk-dot" style="--c:${c.color}"></div>`, 12)};
    const m = L.marker([lat, lon], {icon: icons.full, title: `${name} · ${activity}`, riseOnHover: true})
      .bindPopup(() => { const fr = whereAmI(); return guidePopup(name, `<div class="pp-type" style="color:${c.color}">${icon(c.icon)} ${esc(activity)}</div>
        <div class="pp-src">${esc(info.join(" · "))}</div>`, fr ? haversineM(fr.lat, fr.lon, lat, lon) : null); }, {maxWidth: 290})
      .on("popupopen", ev => { ev.popup.getElement().querySelector(".pp-guide").onclick = () => guideToPoint(name, lat, lon); });
    addPoi(m, lat, lon, "erp", acc === "ok" ? 1 : 2, icons);
  }
  schedulePoi();
}
// Le trajet passe-t-il à moins de maxM mètres de ce point ? (réponse gardée tant que le trajet ne change pas)
const nearCache = new WeakMap();
function nearRoute(route, key, lat, lon, maxM) {
  let c = nearCache.get(route);
  if (!c) nearCache.set(route, c = new Map());
  if (!c.has(key)) {
    const g = route.geometry, k = Math.cos(lat * Math.PI / 180) * 111320;
    let best = Infinity;
    for (let i = 1; i < g.length && best > maxM; i++) {
      const ax = (g[i - 1].lon - lon) * k, ay = (g[i - 1].lat - lat) * 111320, bx = (g[i].lon - lon) * k, by = (g[i].lat - lat) * 111320;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    c.set(key, best <= maxM);
  }
  return c.get(key);
}
const shownRoute = () => S.screen !== "route" || !S.dest ? null : S.nav ? S.nav.route : S.routes.length ? S.routes[S.selected] || S.routes[0] : null;
let poiFrame = 0;
function schedulePoi() { cancelAnimationFrame(poiFrame); poiFrame = requestAnimationFrame(updatePoiMarkers); }
function updatePoiMarkers() {
  // (itinéraire affiché : les équipements du trajet restent visibles dès le zoom 14, la vue d'ensemble du trajet)
  const z = map.getZoom(), route = shownRoute(), show = z >= (route ? 14 : 16) && S.screen !== "nav";
  document.body.classList.toggle("zoomed-out", !show);
  if (!show) { layers.pois.remove(); return; }
  layers.pois.addTo(map);
  const view = map.getBounds().pad(0.15), taken = [];
  for (const p of poiItems) {
    let mode = "hidden";
    if (route) mode = p.kind === "infra" && nearRoute(route, p, p.lat, p.lon, 30) ? "mini" : "hidden";
    else if (view.contains([p.lat, p.lon])) {
      if (p.kind === "erp" && z < 17) mode = "dot";
      else {
        const pt = map.latLngToContainerPoint([p.lat, p.lon]);
        if (taken.some(q => Math.abs(q.x - pt.x) < 28 && Math.abs(q.y - pt.y) < 28)) mode = p.kind === "erp" ? "dot" : "full";
        else { mode = "full"; taken.push(pt); }
      }
    }
    if (p.mode === mode) continue;
    if (mode === "hidden") layers.pois.removeLayer(p.m);
    else {
      p.m.setIcon(p.icons[mode]);
      p.m.setZIndexOffset(mode === "dot" ? -200 : p.kind === "infra" ? 300 : 100);
      if (!p.mode || p.mode === "hidden") layers.pois.addLayer(p.m);
    }
    p.mode = mode;
  }
}
map.on("zoomend moveend", () => schedulePoi());
function drawNetwork() {
  // Le réseau piéton et ses pentes servent au calcul des itinéraires (base de données) : ils ne sont plus dessinés
  for (const [kind, lat, lon, name, status] of net.pois) {
    if (!POI[kind]) continue;
    const label = name ? `${POI[kind][1]} · ${name}` : POI[kind][1];
    const icons = {full: mkIcon(`<div class="mk mk-infra">${icon(POI[kind][0])}</div>`, 30),
      mini: mkIcon(`<div class="mk mk-infra mk-mini">${icon(POI[kind][0])}</div>`, 22)};
    const m = L.marker([lat, lon], {icon: icons.full, title: label, riseOnHover: true})
      .bindPopup(() => { const f = whereAmI(); return guidePopup(POI[kind][1], `<div class="pp-type" style="color:#1D5FAF">${icon(POI[kind][0])} Équipement d'accessibilité</div>${name ? esc(name) : ""}${
        kind === "elevator" ? `<div class="pp-src">État : ${{ok: "en service", out_of_order: "en panne"}[status] || "inconnu"}</div>` : ""}`,
        f ? haversineM(f.lat, f.lon, lat, lon) : null); }, {maxWidth: 290})
      .on("popupopen", e => { e.popup.getElement().querySelector(".pp-guide").onclick = () => guideToPoint(label, lat, lon); });
    addPoi(m, lat, lon, "infra", 0, icons);
  }
  drawErps();
  L.geoJSON(net.zone.boundary, {style: {color: C.primary, weight: 2, fill: false, dashArray: "6 8", opacity: .7}, interactive: false}).addTo(map);
  syncLayers = schedulePoi;                                // (appelé à chaque affichage : écran, itinéraire)
  syncLayers();
}
// L'obstacle n'est plus là (ou signalé par erreur) : on le retire, et l'itinéraire est recalculé sans lui
// ---- Transports en commun (N°3, N°13) --------------------------------------------------------------
// Sur le plan de recherche : les arrêts de la partie visible (30 au plus, à partir du zoom 15).
// Pendant le guidage : seulement ceux à moins de 200 m, 8 au plus, qui apparaissent et disparaissent en marchant.
const transitIcon = mode => {
  const m = MODE[mode] || MODE.bus;
  return L.divIcon({className: "", html: `<div class="pin pin-transit" style="background:${m.color}">${icon(m.icon)}</div>${m.badge ? `<b class="pin-badge" style="background:${m.color}">${m.badge}</b>` : ""}`,
    iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36]});
};
const transitMini = mode => {
  const m = MODE[mode] || MODE.bus;
  return L.divIcon({className: "", html: `<div class="mk mk-mini mk-transit" style="--c:${m.color}">${icon(m.icon)}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -13]});
};
const chipInk = hex => {                                   // texte lisible sur la couleur de la ligne
  const c = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!c) return "#fff";
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#0F2537" : "#fff";
};
const whereAmI = () => {
  const n = S.nav;
  if (n) return n.real && Date.now() - n.real.at < 15000 ? n.real : n.here;
  return S.origin.none ? null : S.origin;
};
function transitPopup(st) {
  const m = MODE[st.mode] || MODE.bus, from = whereAmI(), t = stopTarget(st, from);
  const d = from ? haversineM(from.lat, from.lon, t.lat, t.lon) : null;
  return `<div class="pp"><div class="pp-title">${esc(st.name)}</div><div class="pp-type" style="color:${m.color}">${icon(m.icon)} ${m.label}</div>
    ${st.lines.length ? `<div class="pp-lines">${st.lines.map(l => `<span class="line-chip" style="background:${l.colour || m.color};color:${chipInk(l.colour || m.color)}">${esc(l.ref)}</span>`).join("")}</div>`
      : `<div class="pp-src">Lignes non renseignées</div>`}
    <div class="pp-src">${d !== null ? `${short(d)} · ` : ""}${wheelText(t.entrance?.wheelchair || st.wheelchair)}${st.entrances.length ? ` · ${st.entrances.length} entrée${st.entrances.length > 1 ? "s" : ""} (guidage vers la plus proche)` : ""}</div>
    <button class="pp-guide" type="button">${icon("navigation")} M'y guider</button></div>`;
}
function guideToStop(st) {
  const m = MODE[st.mode] || MODE.bus, from = whereAmI(), t = stopTarget(st, from);
  const dest = {label: `${m.label} ${st.name}${t.entrance?.label ? ` (entrée ${t.entrance.label})` : ""}`, lat: t.lat, lon: t.lon, type: "poi", kind: st.mode};
  map.closePopup();
  if (S.nav) {                                             // en cours de guidage (même réduit) : nouvel itinéraire vers l'arrêt
    S.dest = dest;
    return reroute({lat: from.lat, lon: from.lon}, `Vers ${st.name}`, true);
  }
  if (S.screen !== "route") go("route");
  chooseDest(dest);
}
let transitAt = 0;
function refreshTransit(force = false) {
  if (!transit.length || (!force && performance.now() - transitAt < 800)) return;
  transitAt = performance.now();
  layers.transit.clearLayers();
  let list = [];
  if (S.screen === "nav" && S.nav) {
    const c = whereAmI();
    list = transit.map(st => [st, haversineM(c.lat, c.lon, st.lat, st.lon)]).filter(([, d]) => d <= 200);
    list.sort((a, b) => a[1] - b[1]); list = list.slice(0, 8);
  } else if (S.screen === "route" && map.getZoom() >= 15) {
    // itinéraire affiché : seulement les arrêts sur le trajet (30 m) ou près du départ et de l'arrivée (150 m)
    const b = map.getBounds(), c = map.getCenter(), route = shownRoute();
    const useful = st => !route || nearRoute(route, st, st.lat, st.lon, 30) ||
      haversineM(st.lat, st.lon, S.origin.lat, S.origin.lon) < 150 || haversineM(st.lat, st.lon, S.dest.lat, S.dest.lon) < 150;
    list = transit.filter(st => b.contains([st.lat, st.lon]) && useful(st)).map(st => [st, haversineM(c.lat, c.lng, st.lat, st.lon)]);
    list.sort((a, b2) => a[1] - b2[1]); list = list.slice(0, 30);
  }
  // itinéraire affiché : arrêts en petites pastilles rondes, pour ne pas masquer le tracé
  const small = S.screen === "route" && !!shownRoute();
  for (const [st] of list)
    L.marker([st.lat, st.lon], {icon: small ? transitMini(st.mode) : transitIcon(st.mode), title: `${(MODE[st.mode] || MODE.bus).label} ${st.name}`, keyboard: true})
      .bindPopup(() => transitPopup(st), {maxWidth: 290})
      .on("popupopen", e => { e.popup.getElement().querySelector(".pp-guide").onclick = () => guideToStop(st); })
      .addTo(layers.transit);
}
map.on("moveend", () => { if (S.screen === "route") refreshTransit(); });
// Annonce vocale discrète (réglage) : « Station de métro Les Agnettes à 80 m sur votre droite »
function announceStops() {
  const n = S.nav;
  if (!S.stopsVoice || !n || n.phase !== "route" || !n.real) return;
  const c = whereAmI(), heading = currentHeading();
  n.saidStops ||= new Set();
  for (const st of transit) {
    const key = `${st.mode}:${st.name}`;
    if (n.saidStops.has(key)) continue;
    const d = haversineM(c.lat, c.lon, st.lat, st.lon);
    if (d > 80) continue;
    n.saidStops.add(key);
    let side = "";
    if (heading !== null) {
      const rel = ((bearingOf(c, st) - heading + 540) % 360) - 180;
      side = Math.abs(rel) < 30 ? " devant vous" : Math.abs(rel) > 150 ? " derrière vous" : rel > 0 ? " sur votre droite" : " sur votre gauche";
    }
    say(`${(MODE[st.mode] || MODE.bus).label} ${st.name}, à ${Math.max(5, Math.round(d / 5) * 5)} mètres${side}.`);
    break;                                                // une annonce à la fois
  }
}
function removeReport(id) {
  store.set("va-reports", reports().filter(r => r.id !== id));
  map.closePopup();
  drawReports();
  toast("Signalement retiré.");
  if (S.screen === "route" && S.dest) computeRoute();
  if (S.screen === "settings") render();
}
function drawReports() {
  layers.reports.clearLayers();
  for (const r of reports()) {
    const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1);
    L.marker([r.lat, r.lon], {icon: pin(k[2], "pin-report"), title: k[1]})
      .bindPopup(`<div class="pp"><div class="pp-title">${k[1]}${r.blocking ? " — bloquant" : ""}</div>
        <div class="pp-src">Signalé sur ce téléphone · expire le ${new Date(r.expires).toLocaleString("fr-FR", {dateStyle: "short", timeStyle: "short"})}</div>
        <button class="pp-remove" type="button">${icon("trash-2")} Retirer ce signalement</button></div>`)
      .on("popupopen", e => { e.popup.getElement().querySelector(".pp-remove").onclick = () => removeReport(r.id); })
      .addTo(layers.reports);
  }
}
function drawRoutes() {
  schedulePoi();
  setTimeout(updateHereLink, 0);
  drawRealPosition();
  layers.routes.clearLayers();
  layers.marks.clearLayers();
  const sel = S.nav?.route || S.routes[S.selected];
  const nav = S.screen === "nav";
  layers.progress.clearLayers();
  if (nav && S.nav) { progressAt = 0; drawProgress(true); }
  const choosing = !nav && !S.nav && S.screen === "route";
  for (const r of S.routes) if (r !== sel && choosing)
    L.polyline(r.geometry.map(p => [p.lat, p.lon]), {color: C.alt, weight: 5, opacity: .85, dashArray: "1 9", lineCap: "round"}).addTo(layers.routes);
  // Étiquettes sur le plan, comme Citymapper (« Rapide 12 min ») : là où les itinéraires se séparent ; toucher
  // une étiquette choisit l'itinéraire
  if (choosing && S.routes.length > 1) labelPoints(S.routes.map(r => r.geometry)).forEach((p, i) => {
    const r = S.routes[i];
    if (!p) return;
    L.marker([p.lat, p.lon], {icon: L.divIcon({className: "route-tag-host", iconSize: null, iconAnchor: [0, 0],
      html: `<div class="route-tag ${i === S.selected ? "sel" : r.accessible ? "" : "bad"}"><b>${esc(r.short)}</b><span>${minutes(r)} min</span></div>`}),
      title: `${r.label}, ${minutes(r)} minutes${r.accessible ? "" : ", non praticable"}`, zIndexOffset: i === S.selected ? 950 : 940, riseOnHover: true})
      .on("click", () => { if (S.selected !== i) { S.selected = i; render(); } }).addTo(layers.routes);
  });
  if (sel && !nav) {
    const ll = sel.geometry.map(p => [p.lat, p.lon]);
    L.polyline(ll, {color: C.routeCase, weight: nav ? 10 : 11, opacity: nav ? .35 : .9, lineCap: "round", lineJoin: "round"}).addTo(layers.routes);
    if (nav) gradientLine(ll).forEach(l => l.addTo(layers.routes));
    else L.polyline(ll, {color: C.route, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round"}).addTo(layers.routes);
    // fin du trajet -> porte : pointillés, comme Google Maps
    const e = sel.geometry.at(-1);
    if (S.dest && haversineM(e.lat, e.lon, S.dest.lat, S.dest.lon) > 12)
      L.polyline([[e.lat, e.lon], [S.dest.lat, S.dest.lon]], {color: C.route, weight: 4, dashArray: "2 9", lineCap: "round", interactive: false}).addTo(layers.routes);
  }
  const underDot = S.origin.gps && liveFix && hereMarker && distM(S.origin, liveFix) < 12;
  if (!S.nav && !underDot && !S.origin.none) L.marker([S.origin.lat, S.origin.lon], {icon: L.divIcon({className: "", html: '<div class="start-dot"></div>', iconSize: [24, 24]}),
    title: "Départ"}).addTo(layers.marks);
  if (S.dest) L.marker([S.dest.lat, S.dest.lon], {icon: pin("flag", "pin-dest"), title: "Arrivée"}).addTo(layers.marks);
  if (S.nav) {
    S.nav.marker = L.marker([S.nav.here.lat, S.nav.here.lon], {icon: L.divIcon({className: "",
      html: '<div class="puck"><i class="cone"></i><span></span></div>', iconSize: [90, 90]}), zIndexOffset: 1000}).addTo(layers.marks);
  }
}
// Ligne en dégradé (Leaflet n'en fait pas) : une succession de tronçons de teintes voisines
function gradientLine(ll) {
  const stops = [[47, 128, 237], [0, 174, 204], [61, 220, 151]], n = Math.min(30, ll.length - 1), out = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor(k * (ll.length - 1) / n), b = Math.floor((k + 1) * (ll.length - 1) / n);
    const t = k / Math.max(1, n - 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
    const c = stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f));
    out.push(L.polyline(ll.slice(a, b + 1), {color: `rgb(${c})`, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round"}));
  }
  return out;
}

// ---- Itinéraire ---------------------------------------------------------------------------
// « Le plus accessible » et, s'il fait gagner du temps, « Le plus rapide », avec la différence expliquée (js/compare.js)
const routeChoices = from => walkingChoices(computeRoutes(net, {origin: from, destination: S.dest, profile: profileJson(),
  compare_shortest: true}, reports()).routes, net, resolveProfile(profileJson()));
function computeRoute({keepView = false} = {}) {
  const was = S.routes[S.selected]?.label;
  S.routes = []; S.message = null;
  if (S.dest && !originPending() && S.origin.none) S.message = "Choisissez votre point de départ (touchez « Départ ») : votre position n'est pas disponible.";
  else if (S.dest && !originPending()) {                   // en attente d'une position sûre : pas de trajet faux
    try {
      S.routes = routeChoices(S.origin);
      const i = keepView ? S.routes.findIndex(r => r.label === was) : -1;
      S.selected = i >= 0 ? i : 0;                         // départ qui bouge : on garde l'itinéraire choisi
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      S.message = e.message;
    }
  }
  render();
  if (S.routes.length) { if (!keepView) requestAnimationFrame(fitRoute); prepareOffline(S.routes[S.selected]); }
}
// ---- Trajet disponible hors connexion ----------------------------------------------------------
// Le calcul, le guidage, le GPS et la voix marchent déjà sans réseau ; il manquait la carte. Dès qu'un
// itinéraire est choisi, on télécharge (via le service worker, qui les garde) le fond de carte le long du
// trajet et à ses abords : tuiles, style, polices, pictogrammes et bibliothèque du fond vectoriel.
const OFFLINE_MARGIN_M = 250;                          // largeur gardée de part et d'autre du trajet
const offlineReady = new Set();
const tileOf = (lat, lon, z) => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
};
function tilesAlong(geometry, zooms) {
  const out = new Set(), dLat = OFFLINE_MARGIN_M / 111320;
  for (const z of zooms) for (const p of geometry) {
    const dLon = dLat / Math.cos(p.lat * Math.PI / 180);
    const [x0, y0] = tileOf(p.lat + dLat, p.lon - dLon, z), [x1, y1] = tileOf(p.lat - dLat, p.lon + dLon, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.add(`${z}/${x}/${y}`);
  }
  return [...out];
}
async function fetchAll(urls) {
  let failed = 0;
  const queue = [...new Set(urls)];
  const worker = async () => { while (queue.length) { try { const r = await fetch(queue.shift()); if (!r.ok) failed++; } catch { failed++; } } };
  await Promise.all(Array.from({length: 6}, worker));   // 6 téléchargements à la fois
  return failed;
}
async function prepareOffline(route, announce = false) {
  if (!route || !navigator.onLine || !("serviceWorker" in navigator)) return;
  const g = route.geometry, key = `${S.basemap}|${g[0].lat},${g[0].lon}|${g.at(-1).lat},${g.at(-1).lon}`;
  if (offlineReady.has(key)) { if (announce) toast("Ce trajet est disponible hors connexion."); return; }
  try {
    const urls = [];
    // Fond vectoriel (« Style Plans », par défaut, ou « Épuré ») : c'est aussi le fond de secours hors connexion
    const style = BASEMAPS[S.basemap]?.style || BASEMAPS.liberty.style;
    urls.push(...MAPLIBRE, "https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.css");
    const st = await fetch(style).then(r => r.json());
    if (st.sprite) for (const suffix of ["", "@2x"]) urls.push(`${st.sprite}${suffix}.json`, `${st.sprite}${suffix}.png`);
    const fonts = new Set();
    for (const l of st.layers || []) { const f = l.layout?.["text-font"]; if (Array.isArray(f) && f.every(x => typeof x === "string")) fonts.add(f.join(",")); }
    if (st.glyphs) for (const f of fonts) for (const range of ["0-255", "256-511", "8192-8447"])
      urls.push(st.glyphs.replace("{fontstack}", encodeURIComponent(f)).replace("{range}", range));
    for (const src of Object.values(st.sources || {})) {
      if (src.type !== "vector") continue;
      const tj = src.url ? await fetch(src.url).then(r => r.json()) : src;
      const template = tj.tiles?.[0], maxz = Math.min(tj.maxzoom ?? 14, 14);
      if (template) for (const t of tilesAlong(g, [maxz - 2, maxz - 1, maxz])) {
        const [z, x, y] = t.split("/");
        urls.push(template.replace("{z}", z).replace("{x}", x).replace("{y}", y));
      }
    }
    // Plan OpenStreetMap choisi : ses tuiles aux niveaux 15 et 16 seulement (la charte d'OSM interdit de
    // télécharger à l'avance les niveaux 17 et plus)
    if (S.basemap === "osm") for (const t of tilesAlong(g, [15, 16])) urls.push(`https://tile.openstreetmap.org/${t}.png`);
    const failed = await fetchAll(urls);
    if (failed < urls.length * 0.1) offlineReady.add(key);
    if (announce) toast(failed < urls.length * 0.1 ? "Ce trajet est disponible hors connexion." : "Une partie de la carte n'a pas pu être gardée : le guidage marchera, la carte peut être incomplète.");
  } catch { /* hors connexion entre-temps : on réessaiera au prochain itinéraire */ }
}
// Perte et retour du réseau : on le dit clairement, et on rassure sur ce qui continue de marcher
addEventListener("offline", () => {
  toast("Hors connexion : le guidage continue sur ce téléphone. Seule la recherche d'adresse attend le réseau.", 6000);
  if (S.screen === "nav") say("Plus de réseau. Le guidage continue.", false);
});
addEventListener("online", () => toast("Connexion retrouvée."));
// L'itinéraire est cadré dans la partie du plan que le panneau ne couvre pas (après son affichage)
function fitRoute() {
  const r = S.routes[S.selected] || S.routes[0];
  if (!r || S.screen !== "route") return;
  setHeadingMode(false);                                  // le trajet se cadre nord en haut ; la carte ne suit plus le point bleu
  if (follow) { follow = false; syncMapButtons(); }
  // La carte vient souvent de changer de taille (retour du Profil, choix d'un itinéraire) : on la remet à jour
  // AVANT de cadrer. Sinon Leaflet cadrait avec son ancienne taille et une marge plus grande que la carte : zoom
  // impossible, fond de carte cassé (noir, seuls les repères restaient) et écran à moitié redessiné (vidéo du 19/10).
  map.invalidateSize({pan: false});
  const size = map.getSize(), panelTop = $("panel").getBoundingClientRect().top;
  if (size.y < 160 || size.x < 160) return;
  const under = !sideLayout() && panelTop > 0 && panelTop < innerHeight ? innerHeight - panelTop : 0;
  const bottom = Math.max(24, Math.min(under + 24, size.y - 84 - 120));     // il reste toujours 120 px de carte pour le trajet
  // ordinateur : le panneau flotte à gauche, au-dessus de la carte -> le trajet se cadre à sa droite
  const left = sideLayout() ? Math.max(24, Math.min($("panel").getBoundingClientRect().right + 24, size.x - 200)) : 24;
  // tous les itinéraires proposés restent visibles, pour les comparer
  const pts = (S.routes.length > 1 ? S.routes.flatMap(x => x.geometry) : r.geometry).map(p => [p.lat, p.lon]);
  map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [left, 84], paddingBottomRight: [24, bottom], maxZoom: 18, animate: false});
  // (sans animation de zoom : pendant l'animation, le fond vectoriel n'était redessiné qu'à la fin et l'on voyait
  // un rectangle de carte rétréci sur un fond sombre, vidéo du 19/10)
}
// Au premier affichage de la recherche : si la localisation est déjà autorisée et qu'on est à Gennevilliers,
// Départ = la position actuelle, demandée dès le premier affichage de la recherche (plus de départ fixé à la
// Mairie). Ensuite, l'usager n'a plus qu'à saisir son arrivée. Localisation refusée, introuvable ou hors de la zone :
// le départ reste vide (« Choisissez votre départ ») et aucun trajet ne part d'un faux point.
let autoOriginDone = false;
function autoOrigin() {
  if (autoOriginDone || !net || S.screen !== "route" || S.originMode !== "gps" || !S.origin.none) return;
  autoOriginDone = true;
  locateOrigin(true);                                     // sans fenêtre d'aide si l'usager refuse : le champ le dit
  setTimeout(showOrigin, 0);                              // (appelé pendant render : la ligne « Départ » est mise à jour juste après)
}
// Ligne « Départ » : Ma position, recherche en cours, ou départ à choisir (et pourquoi)
let originLost = false;
function originView() {
  if (S.origin.gps) return {text: `${icon("locate-fixed")} Ma position`, aria: "Ma position"};
  if (!S.origin.none) return {text: esc(S.origin.label), aria: S.origin.label};
  if (originPending()) return originLost
    ? {text: "Position introuvable", sub: "touchez pour choisir une adresse", aria: "Position introuvable pour l'instant", muted: true}
    : {text: `${icon("locate-fixed")} Recherche de votre position…`, aria: "Recherche de votre position", muted: true, pending: true};
  const why = geoPermission === "denied" ? "localisation refusée" : S.originMode === "out" ? "hors de la zone couverte" : "";
  return {text: "Choisissez votre départ", sub: why, aria: `Choisissez votre départ${why ? ` (${why})` : ""}`, muted: true};
}
const originRowHtml = (v = originView()) => `<span class="grow"><small>Départ${v.sub ? ` · ${esc(v.sub)}` : ""}</small>
  <b class="${v.muted ? "muted" : ""} ${v.pending ? "pending" : ""}">${v.text}</b></span>`;
// Met à jour la ligne « Départ » sans reconstruire le panneau (la saisie en cours n'est pas interrompue)
function showOrigin() {
  const b = $("editOrigin");
  if (!b) return;                                         // (saisie du départ en cours, autre écran : rien à reconstruire)
  const v = originView();
  b.querySelector(".grow").outerHTML = originRowHtml(v);
  b.setAttribute("aria-label", `Départ : ${v.aria}. Toucher pour changer`);
}
// ---- Départ « Ma position » vivant (règles : js/origin.js) ---------------------------------------------------
// Un seul suivi GPS sur l'écran de recherche : il fait bouger le point bleu « vous êtes ici » ET le départ des
// trajets. Le trajet part donc toujours d'où vous êtes, même si le premier relevé était faux, même après un
// guidage ou depuis un favori. Pendant le guidage, c'est le suivi du guidage qui prend le relais.
let hereWatch = null, hereMarker = null, hereCircle = null, hereCentered = false, hereLink = null;
let liveFix = null, wantOrigin = false, geoPermission = "unknown";
let originQuiet = true;                                      // demande automatique (lancement) : pas de fenêtre d'aide en cas de refus
let originState = {searchSince: null, best: null, lastUseAt: null};
navigator.permissions?.query?.({name: "geolocation"}).then(p => {
  geoPermission = p.state;
  p.onchange = () => { geoPermission = p.state; syncHereDot(); };
  syncHereDot();
}).catch(() => {});
const gpsOriginActive = () => S.originMode === "gps" || (S.originMode === "auto" && wantOrigin);
// En attente d'une position assez sûre pour calculer (aucun trajet affiché d'ici là : jamais depuis un faux départ)
const originPending = () => gpsOriginActive() && !!S.originNeedsFix;
function centerAbovePanel(ll, zoom = 17) {
  map.invalidateSize({pan: false});
  const box = $("panel").getBoundingClientRect(), visible = sideLayout() || box.top <= 0 ? innerHeight : box.top;
  // point placé au milieu de la zone visible (au-dessus du panneau sur téléphone, à sa droite sur ordinateur),
  // et non au milieu de l'écran (caché dessous)
  const shift = (innerHeight - visible) / 2, side = sideLayout() ? Math.min(box.right, innerWidth - 200) / 2 : 0;
  const p = map.project(L.latLng(ll), zoom).add([-side, shift]);
  map.setView(map.unproject(p, zoom), zoom, {animate: false});
}
function startHereWatch() {
  if (hereWatch !== null || !navigator.geolocation || S.screen !== "route" || S.nav) return;
  hereWatch = navigator.geolocation.watchPosition(onHereFix, onHereError, {enableHighAccuracy: true, maximumAge: 0, timeout: 30000});
}
function stopHereWatch() {
  if (hereWatch !== null) { navigator.geolocation.clearWatch(hereWatch); hereWatch = null; }
  hereMarker?.remove(); hereCircle?.remove(); hereLink?.remove(); hereMarker = hereCircle = hereLink = null;
}
// Suivi actif sur l'écran de recherche, si la localisation est autorisée ou demandée (« Ma position »)
function syncHereDot() {
  const want = S.screen === "route" && !S.nav && !document.hidden && !!navigator.geolocation;
  if (!want) return stopHereWatch();
  if (geoPermission === "granted" || gpsOriginActive() || wantHere) startHereWatch();
}
document.addEventListener("visibilitychange", () => syncHereDot());
// ---- Boutons du plan, comme Citymapper : me recentrer, orienter la carte dans ma direction ------------------
// « Me recentrer » : la carte se pose sur vous et vous suit (jusqu'à ce que vous la déplaciez du doigt).
// « Orienter » : la carte tourne pour que ce qui est devant vous soit en haut (boussole, js/compass.js), comme la
// petite carte du guidage : carte agrandie pour couvrir les coins, repères gardés droits, déplacement au doigt
// suspendu. Toucher à nouveau : nord en haut.
let follow = false, headingMode = false, compassStop = null, wantHere = false;
const herePoint = () => S.nav ? navPos() : liveFix && Date.now() - liveFix.at < 60000 ? liveFix : null;
const compassAvailable = () => typeof DeviceOrientationEvent !== "undefined" && matchMedia("(pointer: coarse)").matches;
const MAP_GESTURES = ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"];
function recenter() {
  const p = herePoint();
  follow = true;
  if (!p) {                                                // pas encore de position : on la demande, la carte s'y posera
    if (geoPermission === "denied") { follow = false; return locationHelp(); }
    wantHere = true; syncHereDot(); syncMapButtons();
    return toast("Recherche de votre position…");
  }
  if (headingMode) layoutHeading(); else centerAbovePanel([p.lat, p.lon], Math.max(map.getZoom(), 17));
  syncMapButtons();
}
map.on("dragstart", () => { if (follow) { follow = false; syncMapButtons(); } });
function setHeadingMode(on) {
  if (on === headingMode) return;
  if (on) {
    const p = herePoint();
    if (!p) return recenter();                             // la position d'abord
    headingMode = true; follow = true;
    document.body.classList.add("heading-up");
    map.closePopup();
    for (const h of MAP_GESTURES) map[h]?.disable();
    layoutHeading();
    compassStop = startCompass(h => document.documentElement.style.setProperty("--map-heading", `${h.toFixed(1)}deg`),
      () => { toast("Boussole indisponible : la carte reste le nord en haut."); setHeadingMode(false); });
  } else {
    headingMode = false;
    compassStop?.(); compassStop = null;
    document.body.classList.remove("heading-up");
    const el = $("map");
    for (const k of ["left", "top", "width", "height", "right", "bottom"]) el.style.removeProperty(k);
    document.documentElement.style.removeProperty("--map-heading");
    for (const h of MAP_GESTURES) map[h]?.enable();
    map.invalidateSize({pan: false});
    const p = herePoint();
    if (p && S.screen === "route") centerAbovePanel([p.lat, p.lon], map.getZoom());
  }
  syncMapButtons();
}
// Carte orientée : un carré centré sur la partie visible du plan (au-dessus du panneau), assez grand pour que
// les coins restent couverts quand il tourne ; vous êtes en son centre, qui est aussi le centre de rotation.
function layoutHeading() {
  const p = herePoint();
  if (!headingMode || !p) return;
  const box = $("panel").getBoundingClientRect(), side = sideLayout();
  const left = side ? Math.min(box.right, innerWidth - 200) : 0, bottom = side || box.top <= 0 ? innerHeight : Math.min(innerHeight, box.top);
  const cx = (left + innerWidth) / 2, cy = bottom / 2;
  const r = Math.max(...[[left, 0], [innerWidth, 0], [left, bottom], [innerWidth, bottom]].map(([x, y]) => Math.hypot(x - cx, y - cy))) + 8;
  Object.assign($("map").style, {left: `${cx - r}px`, top: `${cy - r}px`, width: `${2 * r}px`, height: `${2 * r}px`, right: "auto", bottom: "auto"});
  map.invalidateSize({pan: false});
  map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17), {animate: false});
}
let headingFrame = 0;
const scheduleHeadingLayout = () => { if (headingMode) { cancelAnimationFrame(headingFrame); headingFrame = requestAnimationFrame(layoutHeading); } };
function syncMapButtons() {
  let t = $("mapTools");
  if (S.screen !== "route") return t?.remove();
  if (!t) {
    t = document.createElement("div");
    t.id = "mapTools"; t.className = "map-tools";
    t.onclick = e => {
      const id = e.target.closest("button")?.id;
      if (id === "toolLocate") recenter();
      else if (id === "toolCompass") setHeadingMode(!headingMode);
    };
    document.body.append(t);
  }
  t.innerHTML = `${compassAvailable() ? `<button class="map-tool ${headingMode ? "on" : ""}" id="toolCompass" aria-pressed="${headingMode}"
      aria-label="${headingMode ? "Remettre le nord en haut" : "Orienter la carte dans ma direction"}">${icon("compass")}</button>` : ""}
    <button class="map-tool ${follow ? "on" : ""}" id="toolLocate" aria-pressed="${follow}" aria-label="Me recentrer sur ma position">${icon("locate-fixed")}</button>`;
}
function onHereFix(pos) {
  const now = Date.now(), t = Number.isFinite(pos.timestamp) && pos.timestamp <= now + 1000 ? pos.timestamp : now;
  const fix = {lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, at: t};
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
  liveFix = fix;
  geoPermission = "granted";
  const ll = [fix.lat, fix.lon], acc = Math.min(80, fix.acc || 80);
  if (!hereMarker) {
    hereCircle = L.circle(ll, {radius: acc, color: "#2F80ED", weight: 1, opacity: .4, fillColor: "#2F80ED", fillOpacity: .12, interactive: false}).addTo(map);
    hereMarker = L.marker(ll, {icon: L.divIcon({className: "", html: '<div class="here-dot"></div>', iconSize: [22, 22]}),
      interactive: false, keyboard: false, zIndexOffset: 900}).addTo(map);
  } else { hereMarker.setLatLng(ll); hereCircle.setLatLng(ll).setRadius(acc); }
  // première position, sans destination : la carte se centre sur vous, dans la partie visible au-dessus du panneau
  if (!hereCentered && !S.dest && S.screen === "route") { hereCentered = true; centerAbovePanel(ll); }
  // bouton « Me recentrer » : la carte vous suit ; carte orientée : vous restez au centre de rotation
  if (headingMode) layoutHeading();
  else if (follow && S.screen === "route") centerAbovePanel(ll, Math.max(map.getZoom(), 17));
  if (wantHere) { wantHere = false; syncMapButtons(); }
  if (gpsOriginActive()) applyOriginFix(fix);
  updateHereLink();
}
function onHereError(err) {
  if (err?.code !== 1) return;                               // relevé momentanément impossible : le suivi continue
  geoPermission = "denied";
  stopHereWatch();
  const asked = S.originMode === "gps";
  wantOrigin = false; S.originNeedsFix = false;
  if (asked) {
    if (!S.origin.gps) S.originMode = "manual";              // départ à choisir (ou adresse déjà choisie)
    if (!originQuiet) locationHelp();                        // demandée par l'usager (« Ma position ») : comment l'autoriser
  }
  if (S.screen === "route") S.dest ? computeRoute() : showOrigin();
}
function applyOriginFix(fix) {
  // plan pas encore chargé (connexion lente) : la position est gardée (liveFix) et appliquée dès qu'il l'est
  // (autoOrigin -> locateOrigin). Sans cela, « hors de la zone couverte » à tort (vu au téléphone virtuel, 25/10)
  if (!net) return;
  const now = Date.now(), cur = S.origin.gps ? S.origin : null;
  const r = decideOrigin({origin: S.originNeedsFix ? null : cur, searchSince: originState.searchSince ?? now,
    best: originState.best, lastUseAt: originState.lastUseAt}, fix, now);
  if (r.action === "confirm") { S.origin.confirmedAt = now; return; }
  if (r.action === "wait") { originState.best = r.best; originState.searchSince ??= now; return updateLocating(); }
  if (r.action !== "use") return;
  const f = r.fix;
  try { nearestNode(net, f.lat, f.lon); } catch {
    wantOrigin = false; S.originNeedsFix = false;
    if (S.originMode === "gps" && !S.origin.gps) S.originMode = "out";
    toast(`Vous êtes hors de la zone couverte (${zoneLabel(ZONE)}) : touchez « Départ » pour choisir une adresse.`, 6000);
    if (S.screen === "route") S.dest ? computeRoute() : showOrigin();
    return;
  }
  const moved = cur ? distM(cur, f) : Infinity;
  S.origin = {lat: f.lat, lon: f.lon, acc: f.acc, confirmedAt: now, label: "Ma position", gps: true};
  S.originMode = "gps"; S.originNeedsFix = false; originLost = false;
  originState = {searchSince: null, best: null, lastUseAt: now};
  if (S.screen !== "route" || S.searchFor === "origin") return;
  if (S.dest) computeRoute({keepView: moved < 60}); else showOrigin();
}
// Plus de nouvelle position depuis longtemps : on le dit (et, en départ automatique, on garde le départ affiché)
setInterval(() => {
  if (!originPending() || S.screen !== "route") return;
  const waited = Date.now() - (originState.searchSince ?? Date.now());
  // aucun relevé du tout depuis 10 s (à l'intérieur, GPS coupé) : inutile d'attendre davantage
  if (waited < 10000 || originState.best) return updateLocating();
  if (!originLost) { originLost = true; showOrigin(); }      // le suivi continue : le départ se remplira dès qu'une position arrive
  updateLocating(true);
}, 1000);
// Pointillés du point bleu jusqu'au début du trajet (comme Google Maps) : on voit toujours comment le rejoindre
function updateHereLink() {
  hereLink?.remove(); hereLink = null;
  const r = S.screen === "route" && !S.nav ? S.routes[S.selected] : null;
  if (!r || !S.origin.gps || !liveFix || !hereMarker || Date.now() - liveFix.at > 15000) return;   // (départ choisi ailleurs : pas de lien)
  const g0 = r.geometry[0];
  if (haversineM(liveFix.lat, liveFix.lon, g0.lat, g0.lon) < 6 || haversineM(liveFix.lat, liveFix.lon, g0.lat, g0.lon) > 400) return;
  hereLink = L.polyline([[liveFix.lat, liveFix.lon], [g0.lat, g0.lon]], {color: C.route, weight: 4, dashArray: "2 9",
    lineCap: "round", interactive: false}).addTo(map);
}
function locatingHtml(lost = false) {
  const b = originState.best, waited = Date.now() - (originState.searchSince ?? Date.now());
  const txt = lost ? "Position introuvable pour l'instant (à l'intérieur, le GPS capte mal). Sortez un peu, ou touchez « Départ » pour choisir une adresse."
    : b ? `Position encore imprécise (à ${Math.round(b.acc)} m près) : on attend mieux pour vous éviter un faux départ…`
    : waited > 4000 ? "Recherche de votre position… (autorisez la localisation si le téléphone le demande)" : "Recherche de votre position…";
  return `<div class="msg locating" id="locating" role="status" aria-live="polite">${icon("locate-fixed")}<span>${esc(txt)}</span></div>`;
}
function updateLocating(lost = false) {
  const el = $("locating");
  if (el) el.outerHTML = locatingHtml(lost);
}
// Départ = « Ma position ». quiet : sans message ; ifGranted : seulement si la localisation est déjà autorisée
// (au lancement de l'appli : aucune demande surprise). Au choix d'une destination, elle peut être demandée.
function locateOrigin(quiet = false, ifGranted = false) {
  const giveUp = () => { if (!S.origin.gps) { wantOrigin = false; S.originNeedsFix = false; S.originMode = "manual"; } };
  if (!navigator.geolocation) { giveUp(); if (!quiet) toast("La localisation n'est pas disponible sur cet appareil."); return; }
  if (geoPermission === "denied") {                         // refusée : on explique comment l'autoriser
    if (!ifGranted) giveUp();                               // (le départ reste à choisir ; le champ « Départ » le dit)
    if (!quiet && !ifGranted) locationHelp();
    return;
  }
  if (ifGranted && geoPermission !== "granted") return;
  if (S.originMode === "manual" && quiet) return;            // l'usager a choisi un autre départ
  originQuiet = quiet;
  wantOrigin = true;
  if (!quiet) S.originMode = "gps";
  if (!originValid(S.origin.gps ? S.origin : null, Date.now())) {
    S.originNeedsFix = true;
    originState = {searchSince: Date.now(), best: null, lastUseAt: originState.lastUseAt}; originLost = false;
  }
  startHereWatch();
  // la dernière position reçue est peut-être déjà assez bonne
  if (liveFix) applyOriginFix(liveFix);
}
let searchTimer = null;
function search(q) {
  clearTimeout(searchTimer);
  if (q.trim().length < 3) { S.places = []; return renderPlaces(); }
  searchTimer = setTimeout(async () => {
    // 1) lieux, stations, arrêts et commerces connus de l'appli (instantané, hors ligne)
    const local = net ? searchPlaces(q, {places: net.places, stops: transit, streetOf, from: S.origin}).map(r => ({
      label: r.label, lat: r.lat, lon: r.lon, type: "poi", kind: r.kind, icon: r.icon, color: r.color,
      sub: `${r.typeLabel}${r.rue ? " · " + r.rue : ""} · ${short(r.dist)}`})) : [];
    S.places = local;
    renderPlaces();
    // 2) adresses (Géoplateforme IGN en France, Photon / OpenStreetMap ailleurs), ajoutées à la suite
    try {
      const url = ZONE.france
        ? `${GEOCODER}?${new URLSearchParams({q, limit: 6, index: "address,poi", lat: S.origin.lat, lon: S.origin.lon})}`
        : `${PHOTON}?${new URLSearchParams({q, limit: 8, lang: "fr", lat: S.origin.lat, lon: S.origin.lon})}`;
      const data = await fetch(url).then(r => r.json());
      if ((S.searchFor === "origin" ? S.oquery : S.query) !== q) return;    // la saisie a changé entre-temps
      const addr = (data.features || []).map(f => {
        const p = f.properties, [lon, lat] = f.geometry.coordinates;
        const type = ZONE.france ? p._type : (p.name && p.osm_key !== "highway" && p.osm_key !== "place" ? "poi" : "address");
        const label = ZONE.france ? p.label || [p.toponym, (p.city || [])[0]].filter(Boolean).join(", ")
          : [p.name || [p.housenumber, p.street].filter(Boolean).join(" "), p.district || p.city].filter(Boolean).join(", ");
        return {label, lat, lon, type, banId: ZONE.france && p._type === "address" ? p.id : null,
          sub: `${type === "poi" ? "Lieu" : "Adresse"} · ${short(haversineM(S.origin.lat, S.origin.lon, lat, lon))}`};
      }).filter(a => a.label).filter(a => haversineM(S.origin.lat, S.origin.lon, a.lat, a.lon) < 15000);   // pas de « Calmels-et-le-Viala » à 550 km
      S.places = [...local, ...addr].filter((p, i, all) => all.findIndex(o => norm2(o.label) === norm2(p.label) && haversineM(o.lat, o.lon, p.lat, p.lon) < 150) === i).slice(0, 10);
    } catch {
      if (!local.length) toast("Recherche d'adresse impossible (hors ligne ?) : essayez le nom d'un lieu ou d'un arrêt.");
    }
    renderPlaces();
  }, 300);
}
const norm2 = t => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ---- Guidage GPS ----------------------------------------------------------------------
function project(p, a, b) {           // projection d'un point sur un segment, en mètres (plan local)
  const k = Math.cos(p.lat * Math.PI / 180), m = 111320;
  const ax = (a.lon - p.lon) * k * m, ay = (a.lat - p.lat) * m, bx = (b.lon - p.lon) * k * m, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
  return {t, d: Math.hypot(ax + t * dx, ay + t * dy)};
}
function startNav(route, keepGps = false) {
  const g = route.geometry, cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + haversineM(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon));
  // Début de chaque consigne = premier sommet du tracé à moins de 1,5 m d'elle
  // (intersections et tracés sont arrondis séparément : ~0,1 m d'écart possible)
  const stepAt = [];
  let j = 0;
  for (const s of route.steps) {
    if (s.maneuver === "arrive") { stepAt.push(cum.at(-1)); continue; }
    let k = j;
    while (k < g.length - 1 && haversineM(g[k].lat, g[k].lon, s.lat, s.lon) > 1.5) k++;
    if (k < g.length - 1) j = k;                        // trouvé ; sinon on garde la position précédente
    stepAt.push(cum[j]);
  }
  const prev = keepGps ? S.nav : null, watch = prev?.watch ?? null;    // nouveau calcul : le suivi GPS continue
  if (prev) prev.watch = null;
  stopNav();
  S.nav = {route, cum, total: cum.at(-1), stepAt, pos: 0, here: {...g[0]}, watch, real: prev?.real || null,
           gpsInfo: prev?.gpsInfo || "", gpsStatus: prev?.gpsStatus || "", lastReroute: prev?.lastReroute || 0,
           said: new Set(), off: 0, back: 0, dHist: [], offRoute: false, away: false, gap: 0, gapAlong: 0, arrived: false,
           // N°15 : « approach » tant que le point de départ n'est pas atteint ; « route » ensuite
           phase: "approach", approachDist: 0, quietStart: keepGps, startedAt: prev?.startedAt || Date.now()};
  S.nav.hazards = hazardsOn(S.nav);
  requestWakeLock();
}
// ---- Alertes de proximité ----------------------------------------------------------------------
// Chaque obstacle du trajet est annoncé une fois, à l'approche (S.alertDist mètres) : voix, vibration et
// bandeau à l'écran. Tout est calculé sur le téléphone, avec les données de la zone : ça marche sans réseau.
// Sources : les tronçons (marche, bordure haute, forte pente, passage étroit), les obstacles fixes
// ponctuels (borne, poteau… : table va_obstacle) et les signalements encore actifs.
const OBSTACLE_KINDS = {bollard: ["Borne", "circle-alert"], pole: ["Poteau", "circle-alert"], barrier: ["Barrière", "construction"],
  street_furniture: ["Mobilier urbain", "lamp-floor"], step: ["Marche", "stairs"], kerb: ["Bordure", "triangle-alert"],
  hole: ["Trou", "triangle-alert"], low_obstacle: ["Obstacle bas", "triangle-alert"], other: ["Obstacle", "circle-alert"]};
const HAZARD_NEAR_ROUTE_M = 6;                          // un obstacle ponctuel compte s'il est à moins de 6 m du tracé
const hazardAlerted = new Set();                        // déjà annoncés pendant ce trajet (recalculs compris)
// Position d'un point sur l'itinéraire : distance depuis le départ, écart au tracé, côté (gauche / droite)
function alongRoute(n, p) {
  const g = n.route.geometry;
  let best = null;
  for (let i = 1; i < g.length; i++) {
    const pr = project(p, g[i - 1], g[i]);
    if (!best || pr.d < best.d) {
      const k = Math.cos(p.lat * Math.PI / 180);
      const cross = (g[i].lon - g[i - 1].lon) * k * (p.lat - g[i - 1].lat) - (g[i].lat - g[i - 1].lat) * (p.lon - g[i - 1].lon) * k;
      best = {d: pr.d, along: n.cum[i - 1] + pr.t * (n.cum[i] - n.cum[i - 1]), side: cross > 0 ? "gauche" : "droite"};
    }
  }
  return best;
}
function hazardsOn(n) {
  const out = [], vision = resolveProfile(profileJson()).prefers_sound_signals;
  let along = 0, lastSlope = -1e9, road = null;
  for (const id of n.route.edge_ids || []) {
    const e = net.edges[id];
    if (!e) continue;
    let len = 0;
    for (let i = 1; i < e.shape.length; i++) len += haversineM(e.shape[i - 1][0], e.shape[i - 1][1], e.shape[i][0], e.shape[i][1]);
    const at = along + Math.min(1.5, len / 2);
    if (e.has_step) out.push({id: `e${id}-step`, along: at, label: "Marche", ic: "stairs"});
    // marche sur la chaussée : une seule alerte par portion continue, avec sa longueur
    if (e.beside_sidewalk) {
      if (road && along - road.end < 3) road.len += len;
      else { road = {id: `e${id}-road`, along: at, len, ic: "triangle-alert"}; out.push(road); }
      road.end = along + len;
      road.label = `Passage sur la chaussée, ${Math.max(5, Math.round(road.len / 5) * 5)} mètres`;
    }
    // traversée sans feu sonore : annoncée seulement si c'est CONFIRMÉ (à Gennevilliers, 9 traversées sur 10 n'ont
    // pas l'information : les annoncer toutes saturerait l'usager ; le résumé avant le départ les compte)
    if (vision && e.is_crossing && e.sound_signal === false)
      out.push({id: `e${id}-nosound`, along: at, label: "Traversée sans feu sonore", ic: "triangle-alert"});
    if (e.is_crossing && e.kerb_lowered === false) out.push({id: `e${id}-kerb`, along: at, label: "Bordure haute", ic: "triangle-alert"});
    if (e.width_m !== null && e.width_m < 0.9)
      out.push({id: `e${id}-narrow`, along: at, label: `Passage étroit, ${String(Math.round(e.width_m * 100) / 100).replace(".", ",")} mètre`, ic: "narrow"});
    // forte pente : annoncée au début de la côte, pas à chaque tronçon de la même côte
    if (e.slope_pct !== null && Math.abs(e.slope_pct) >= 6) {
      if (at - lastSlope > 40) out.push({id: `e${id}-slope`, along: at, label: `${e.slope_pct > 0 ? "Forte montée" : "Forte descente"}, ${Math.round(Math.abs(e.slope_pct))} pour cent`, ic: "mountain"});
      lastSlope = along + len;
    }
    along += len;
  }
  const points = [
    ...(net.obstacles || []).map(([kind, lat, lon, severity], i) => ({id: `o${i}-${lat}-${lon}`, lat, lon,
      label: (OBSTACLE_KINDS[kind] || OBSTACLE_KINDS.other)[0] + (severity === 3 ? ", infranchissable en fauteuil" : ""),
      ic: (OBSTACLE_KINDS[kind] || OBSTACLE_KINDS.other)[1]})),
    ...reports().map(r => { const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1); return {id: `r${r.id}`, lat: r.lat, lon: r.lon, label: k[1], ic: k[2]}; }),
  ];
  for (const o of points) {
    const pos = alongRoute(n, o);
    if (pos && pos.d <= HAZARD_NEAR_ROUTE_M) out.push({...o, along: pos.along, side: pos.d > 2 ? pos.side : ""});
  }
  return out.sort((a, b) => a.along - b.along);
}
function checkHazards() {
  const n = S.nav;
  if (!n?.hazards || n.phase === "approach" || n.arrived) return;
  const h = n.hazards.find(x => !hazardAlerted.has(x.id) && x.along - n.pos >= 0 && x.along - n.pos <= S.alertDist);
  if (!h) return;
  hazardAlerted.add(h.id);
  const m = Math.max(1, Math.round(h.along - n.pos)), where = h.side ? `sur votre ${h.side}` : "devant vous";
  n.hazard = {...h, dist: m, where, at: Date.now()};       // bandeau à l'écran (malentendance : le repère principal)
  say(`Attention, ${h.label.charAt(0).toLowerCase()}${h.label.slice(1)}, à ${m} mètre${m > 1 ? "s" : ""}, ${where}.`, DANGER);
  buzz("obstacle");
}
// Économie de batterie : loin du prochain virage et de tout obstacle, la vue caméra s'allège (moins d'images
// par seconde, détection d'obstacles espacée) et le GPS peut resservir une position de moins de 4 s
function ecoNow() {
  const n = S.nav;
  if (!S.eco || !n || n.phase !== "route" || n.offRoute || n.away || n.arrived) return false;
  const st = navState(), nextHazard = n.hazards?.find(h => h.along >= n.pos);
  return st.toManeuver > 120 && (!nextHazard || nextHazard.along - n.pos > 80);
}
function updateGpsMode() {
  const n = S.nav, eco = ecoNow();
  if (!n || n.watch === null || n.gpsEco === eco || Date.now() - (n.gpsModeAt || 0) < 20000) return;
  n.gpsEco = eco; n.gpsModeAt = Date.now();
  navigator.geolocation.clearWatch(n.watch);
  n.watch = navigator.geolocation.watchPosition(onGps, onGpsError, {enableHighAccuracy: true, maximumAge: eco ? 4000 : 1000, timeout: 20000});
}
// Le trajet commence : on est au point de départ (ou sur le tout début de l'itinéraire)
function beginRoute(along) {
  const n = S.nav, first = n.route.steps[0];
  n.phase = "route"; n.away = false; n.approachDist = 0;
  if (!n.quietStart) {
    const risks = risksText(routeRisks(n.route));
    say(`Vous êtes au point de départ, le trajet commence. ${first.text}. ${short(n.route.length_m)}, environ ${Math.ceil(n.route.length_m / speed() / 60)} minutes.${risks.length ? ` Attention : ${risks.join(", ")}.` : ""}`, true);
    buzz("tick");
  }
  moveTo(along);
}
function stopNav() {
  if (!S.nav) return;
  if (S.nav.watch !== null) navigator.geolocation.clearWatch(S.nav.watch);
  S.nav.watch = null;
}
function posAt(d) {
  const {route: {geometry: g}, cum} = S.nav;
  for (let i = 1; i < g.length; i++) if (d <= cum[i]) {
    const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    return {lat: g[i - 1].lat + (g[i].lat - g[i - 1].lat) * t, lon: g[i - 1].lon + (g[i].lon - g[i - 1].lon) * t};
  }
  return {...g.at(-1)};
}
function navState() {
  const n = S.nav, steps = n.route.steps;
  let idx = 0;
  for (let i = 0; i < steps.length - 1; i++) if (n.pos >= n.stepAt[i] - 0.5) idx = i;
  // Arrivée : fin de l'itinéraire ET vraie position proche de la fin (sinon un GPS en avance déclenchait trop tôt)
  const r = n.real, fresh = r && Date.now() - r.at < 15000, end = n.route.geometry.at(-1);
  // Dernier bout à pied (comme Google Maps) : le réseau s'arrête souvent avant la porte (adresse au milieu d'un
  // bâtiment, cour, allée non cartographiée). On ne dit « arrivé » qu'une fois près de l'ADRESSE ; entre la fin
  // du tracé et la porte, des pointillés et « Continuez jusqu'à l'adresse ».
  const dest = S.dest, lastLeg = dest ? haversineM(end.lat, end.lon, dest.lat, dest.lon) : 0, target = lastLeg > 12 ? dest : end;
  const toDest = fresh && dest ? haversineM(r.lat, r.lon, dest.lat, dest.lon) : lastLeg;
  const near = !fresh || haversineM(r.lat, r.lon, target.lat, target.lon) <= Math.max(10, Math.min(r.acc, lastLeg > 12 ? 20 : 25));
  const arrived = n.arrived || (n.phase !== "approach" && n.pos >= n.total - 3 && near);
  const final = !arrived && lastLeg > 12 && n.phase !== "approach" && n.pos >= n.total - 3;
  const next = arrived ? steps.at(-1) : steps[idx + 1];
  const toManeuver = arrived ? 0 : Math.max(0, n.stepAt[idx + 1] - n.pos);
  const lower = next.text.charAt(0).toLowerCase() + next.text.slice(1);
  const spoken = arrived ? "Vous êtes arrivé" : toManeuver < 15 ? next.text : `Dans ${short(toManeuver)}, ${lower}`;
  return {idx, next, toManeuver, arrived, spoken, final, toDest, lastLeg,
    remaining: Math.max(0, n.total - n.pos) + (n.phase === "approach" ? n.approachDist : 0) + (final ? toDest : lastLeg > 12 && !arrived ? lastLeg : 0)};
}
function announce() {
  const n = S.nav, st = navState();
  if (st.arrived) {
    if (!n.said.has("arrive")) {
      n.said.add("arrive"); n.arrived = true;
      const end = n.route.geometry.at(-1), d = S.dest ? haversineM(end.lat, end.lon, S.dest.lat, S.dest.lon) : 0;
      say(d > 15 ? `Vous êtes arrivé au bout de l'itinéraire. Votre destination est à ${Math.round(d)} mètres.`
        : S.dest?.viaEntrance ? "Vous êtes arrivé à l'entrée accessible." : "Vous êtes arrivé.", true);
      buzz("arrive");
      const fiche = arrivalSpeech(S.arrival);              // comment entrer (et ce qu'on trouve derrière la porte)
      if (fiche) setTimeout(() => say(fiche, INFO), 2500);
      // Le guidage s'arrête à l'entrée (pas de navigation intérieure) : GPS coupé tout de suite, écran
      // de guidage fermé après la lecture de la fiche
      if (!FEATURES.indoorNavigationEnabled) finishAtEntrance(fiche);
    }
    return;
  }
  if (n.phase === "approach") return;
  if (st.final) {
    if (!n.said.has("final")) { n.said.add("final"); say(`L'adresse est à ${Math.round(st.toDest)} mètres. Suivez les pointillés jusqu'à la porte.`, true); buzz("tick"); }
    return;
  }
  // « Données à confirmer » n'est pas un danger : pas dit à voix haute (il reste sur la fiche de l'itinéraire)
  const spokenAlerts = st.next.alerts.filter(a => a !== "Données à confirmer");
  const i = st.idx + 1, alerts = spokenAlerts.length ? `. Attention : ${spokenAlerts.join(", ")}` : "";
  const side = turnSide(st.next.maneuver);
  const arriving = st.next.maneuver === "arrive";            // l'arrivée elle-même est annoncée une seule fois, plus haut
  if (st.toManeuver <= 60 && st.toManeuver > 20 && !n.said.has(`${i}-far`)) {
    n.said.add(`${i}-far`);
    say(arriving ? `Dans ${short(st.toManeuver)}, vous arrivez${S.dest?.viaEntrance ? " à l'entrée accessible" : ""}.` : `${st.spoken}${alerts}`);
    if (side) buzz(side);
  } else if (st.toManeuver <= 15 && !arriving && !n.said.has(`${i}-now`)) {
    n.said.add(`${i}-now`); n.said.add(`${i}-far`);
    const vague = n.real && n.real.acc > 20;                  // GPS imprécis : pas de virage « au mètre près »
    say(vague ? `Bientôt, ${st.next.text.charAt(0).toLowerCase()}${st.next.text.slice(1)}` : st.next.text, true);
    if (side) buzz(side);
  }
}
function moveTo(pos) {
  if (S.nav.phase === "approach") { S.nav.phase = "route"; S.nav.away = false; }
  S.nav.pos = Math.min(S.nav.total, Math.max(0, pos));
  S.nav.here = posAt(S.nav.pos);
  announce();
  checkHazards();
  updateGpsMode();
  renderNavLive();
}
function startGps() {
  const n = S.nav;
  if (n.watch !== null) navigator.geolocation.clearWatch(n.watch);
  n.watch = null;
  if (!navigator.geolocation) { n.gpsProblem = "Ce téléphone ne donne pas sa position : le guidage ne peut pas suivre vos pas."; return; }
  n.gpsInfo = "Recherche de votre position… (autorisez la localisation si le téléphone le demande)";
  n.gpsStatus = "Recherche de votre position…";
  n.gpsProblem = null;
  n.watch = navigator.geolocation.watchPosition(onGps, onGpsError, {enableHighAccuracy: true, maximumAge: 1000, timeout: 20000});
}
// Précision du GPS en mots simples (au lieu de « GPS ± 14 m »)
function accuracyText(acc) {
  const m = Math.max(1, Math.round(acc));
  return acc <= 10 ? `Position précise (à ${m} m près)`
    : acc <= 25 ? `Position correcte (à ${m} m près)`
    : `Position approximative (à ${m} m près) : à l'intérieur ou entre les immeubles, le GPS se trompe facilement. Le guidage commence dehors, dans la rue`;
}
// Nouvel itinéraire depuis la position réelle (écart, mauvaise rue, ou demande de l'usager)
function reroute(from, title, manual = false, fromStart = false) {
  const n = S.nav;
  if (!manual && Date.now() - n.lastReroute < 10000) return;      // pas plus d'un recalcul automatique toutes les 10 s
  n.lastReroute = Date.now();
  n.off = 0;
  try {
    const res = computeRoutes(net, {origin: from, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
    say(manual || fromStart ? "Itinéraire recalculé depuis votre position." : "Vous vous êtes écarté de l'itinéraire. Nouvel itinéraire.", true);
    if (!manual && !fromStart) buzz("uturn");
    startNav(res.routes[0], true);
    S.routes = res.routes; S.selected = 0;
    if (!fromStart) S.nav.rerouted = {at: Date.now(), title};           // départ normal : pas de bandeau d'alerte
    if (fromStart) {
      S.nav.fromHere = true; S.nav.quietStart = false;
      S.origin = {lat: from.lat, lon: from.lon, acc: S.nav.real?.acc ?? 20, confirmedAt: Date.now(), label: "Ma position", gps: true};
      S.originMode = "gps";
    }
    S.nav.gpsInfo = "";
  } catch (e) {
    if (!(e instanceof RoutingError)) throw e;
    n.gpsInfo = `${e.message} Revenez vers l'itinéraire affiché.`;
    if (manual) say("Aucun autre itinéraire accessible depuis ici. Revenez vers l'itinéraire affiché.", true);
  }
  render();
}
function manualReroute() {
  const n = S.nav, r = n.real;
  if (!r || Date.now() - r.at > 30000) return toast("Votre position GPS n'est pas encore connue : patientez quelques secondes à l'extérieur.");
  reroute({lat: r.lat, lon: r.lon}, "Itinéraire recalculé", true);
}
// Mauvais sens sur l'itinéraire lui-même : on le dit (voix + 5 impulsions), au plus toutes les 15 s
function wrongWay() {
  const n = S.nav;
  if (Date.now() - (n.lastWrongWay || 0) < 15000) return;
  n.lastWrongWay = Date.now();
  say("Vous allez dans le mauvais sens. Faites demi-tour.", true);
  buzz("uturn");
}
function onGpsError(err) {
  const n = S.nav;
  if (!n) return;
  n.gpsDenied = err.code === 1;
  n.gpsProblem = err.code === 1
    ? "La localisation est refusée. Touchez ici pour l'autoriser en quelques gestes."
    : "Position introuvable pour l'instant (à l'intérieur, le GPS capte mal). Réessayez à l'extérieur.";
  n.gpsInfo = "";
  renderNavLive();
}
function onGps(pos, precise = false) {
  const n = S.nav;
  if (!n) return;
  // Appli Android : la position d'ARCore Geospatial (~1 m) prime sur le GPS tant qu'elle arrive
  if (precise) n.preciseAt = Date.now();
  else if (n.preciseAt && Date.now() - n.preciseAt < 3000) return;
  const p = {lat: pos.coords.latitude, lon: pos.coords.longitude}, acc = pos.coords.accuracy;
  n.real = {...p, acc, at: Date.now()};
  n.gpsStatus = accuracyText(acc);
  n.gpsInfo = acc > 25 ? n.gpsStatus : "";              // bandeau seulement quand la position est incertaine
  drawRealPosition();
  // Hors de la zone couverte : on le dit clairement, sans tenter de recalcul impossible
  try {
    nearestNode(net, p.lat, p.lon);
    n.gpsProblem = null;
  } catch {
    const km = haversineM(p.lat, p.lon, MAIRIE.lat, MAIRIE.lon) / 1000;
    n.gpsProblem = `Vous êtes à ${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} km de ${ZONE.name}. ` +
      "Le guidage ne fonctionne que sur place, dans la zone couverte.";
    return renderNavLive();
  }
  // Point le plus proche du tracé, sans revenir loin en arrière NI sauter loin en avant : un itinéraire qui
  // repasse près de lui-même (aller-retour sur deux trottoirs) faisait « avancer » de 100 m d'un coup (N°10)
  const g = n.route.geometry, ahead = n.pos + Math.max(60, 2 * acc);
  let best = null;
  for (let i = 1; i < g.length; i++) {
    if (n.cum[i] < n.pos - 60 || n.cum[i - 1] > ahead) continue;
    const pr = project(p, g[i - 1], g[i]);
    if (!best || pr.d < best.d) best = {d: pr.d, along: n.cum[i - 1] + pr.t * (n.cum[i] - n.cum[i - 1])};
  }
  // Écart toléré : 20 m, plus si le GPS est imprécis (45 m au plus)
  const limit = Math.min(45, Math.max(20, 1.5 * acc));
  // Mauvaise rue prise à un carrefour : l'écart grandit à chaque mesure -> on n'attend pas les 20 m
  const h = n.dHist = [...n.dHist.slice(-3), best?.d ?? 0];
  const leaving = acc <= 15 && h.length === 4 && h[3] > 12 && h[1] > h[0] + 1.5 && h[2] > h[1] + 1.5 && h[3] > h[2] + 1.5;
  // ---- N°15 : phase d'approche, jusqu'au point de départ (ou au tout début de l'itinéraire) ----
  if (n.phase === "approach") {
    // L'itinéraire part du carrefour le plus proche de votre point de départ ; depuis un bâtiment, le plus court
    // est souvent de rejoindre le trottoir juste devant, un peu plus loin sur l'itinéraire. On vise donc le point
    // de l'itinéraire le plus proche de vous, sur ses 300 premiers mètres.
    const dStart = haversineM(p.lat, p.lon, g[0].lat, g[0].lon);
    if (dStart <= Math.max(10, Math.min(acc, 15)) && acc <= 25) return beginRoute(0);
    // Pas au point de départ (départ choisi ailleurs, ou Mairie par défaut) : itinéraire recalculé depuis votre
    // vraie position, accroché au cheminement le plus proche. Rejoindre l'itinéraire prévu en coupant au plus
    // court faisait traverser une avenue n'importe où (tests du 13/10/2026). Une seule fois par départ.
    if (dStart > 15 && acc <= 30 && !n.fromHere) return reroute(p, "Départ depuis votre position", false, true);
    Object.assign(n, {approachDist: dStart, gap: dStart, gapAlong: 0, away: true, offRoute: false});
    if (!n.said.has("approach")) {
      n.said.add("approach");
      say(`Rejoignez l'itinéraire, à ${Math.round(dStart)} mètres.`, true);
    }
    return renderNavLive();
  }
  // Dernier bout à pied, de la fin du tracé jusqu'à la porte : on n'est pas « hors itinéraire » (pas de recalcul,
  // qui repartait de l'adresse elle-même) ; on suit simplement la distance jusqu'à l'adresse.
  const endPt = g.at(-1), legLen = S.dest ? haversineM(endPt.lat, endPt.lon, S.dest.lat, S.dest.lon) : 0;
  if (legLen > 12 && n.pos >= n.total - 3 && haversineM(p.lat, p.lon, S.dest.lat, S.dest.lon) <= legLen + Math.max(25, acc)) {
    Object.assign(n, {gap: 0, gapAlong: n.total, away: false, offRoute: false, off: 0});
    announce(); return renderNavLive();
  }
  n.gap = best?.d ?? 0;
  n.gapAlong = best?.along ?? n.pos;
  // « À l'écart de l'itinéraire » (intérieur, cour) seulement si l'écart dépasse nettement l'erreur du GPS,
  // avec une marge pour ne pas basculer sans cesse : en ville le GPS se trompe souvent de 5 à 15 m.
  const enter = Math.max(15, 1.5 * acc), exit = Math.max(9, acc);
  n.away = n.away ? n.gap > exit : n.gap > enter;
  if (best && best.d <= limit && !leaving) {
    n.off = 0; n.offRoute = false;
    if (best.along < n.pos - 12 && acc <= 25) {          // on remonte l'itinéraire à l'envers
      if (++n.back >= 3) { n.back = 0; n.pos = best.along; wrongWay(); }
    } else n.back = 0;
    // GPS imprécis : on n'accroche pas de force au tracé, on avance prudemment (N°4)
    const to = Math.max(n.pos, acc > 25 ? Math.min(best.along, n.pos + 15) : best.along), now = Date.now();
    // vitesse de marche estimée sur les dernières mesures (sert à avancer entre deux mesures, voir plus bas)
    if (n.lastFix && now - n.lastFix.at < 8000) {
      const v = Math.max(0, Math.min(2.5, (to - n.lastFix.along) / ((now - n.lastFix.at) / 1000)));
      n.walkSpeed = n.walkSpeed == null ? v : 0.7 * n.walkSpeed + 0.3 * v;
    }
    n.lastFix = {along: to, at: now};
    return moveTo(to);
  }
  n.offRoute = true; n.back = 0;
  n.gpsInfo = `Vous vous éloignez de l'itinéraire (${Math.round(best?.d ?? 0)} m) : nouveau calcul en cours…`;
  map.panTo([p.lat, p.lon]);
  renderNavLive();
  if (acc <= 40 && (++n.off >= 2 || leaving)) reroute(p, leaving ? "Mauvaise rue" : "Hors de l'itinéraire");
}
// Repères de direction par vibration, téléphone tenu devant soi : si l'on ne fait pas face
// au chemin (plus de 40°), 2 impulsions = tournez-vous vers la gauche, 3 = vers la droite,
// 5 = demi-tour. Au plus une fois toutes les 6 s ; les virages ont leur propre signal.
const bearingOf = (a, b) => { const k = Math.cos(a.lat * Math.PI / 180); return (Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180 / Math.PI + 360) % 360; };
function steer() {
  const n = S.nav;
  if (!n || n.arrived || S.screen !== "nav") return;
  const heading = currentHeading();
  if (heading === null || !n.real || Date.now() - n.real.at > 15000) return;
  // N°1 : à moins de 12 m du virage, déjà tourné vers la suite depuis 2 s -> manœuvre faite, consigne suivante
  if (n.phase === "route") {
    const st = navState();
    if (!st.arrived && st.toManeuver < 12 && st.next.maneuver !== "arrive") {
      const at = n.stepAt[st.idx + 1], out = bearingOf(posAt(at), posAt(Math.min(n.total, at + 12)));
      n.facing = Math.abs(((out - heading + 540) % 360) - 180) < 30 ? (n.facing || 0) + 1 : 0;
      if (n.facing >= 2) { n.facing = 0; moveTo(Math.max(n.pos, at + 1)); return; }
    } else n.facing = 0;
  }
  if (!S.haptics) return;
  if (!n.offRoute && navState().toManeuver < 15) return;
  if (Date.now() - (n.lastSteer || 0) < 6000) return;
  const from = n.offRoute || n.away ? n.real : n.here, to = posAt(Math.min(n.total, n.pos + 10));
  if (haversineM(from.lat, from.lon, to.lat, to.lon) < 3) return;
  const k = Math.cos(from.lat * Math.PI / 180);
  const bearing = Math.atan2((to.lon - from.lon) * k, to.lat - from.lat) * 180 / Math.PI;
  const diff = ((bearing - heading + 540) % 360) - 180;
  if (Math.abs(diff) < 40) return;
  n.lastSteer = Date.now();
  buzz(Math.abs(diff) > 135 ? "uturn" : diff < 0 ? "left" : "right");
}
setInterval(steer, 1000);
let realMarker = null;
// Terrain du 19/10 : deux points (bleu sur le trajet, orange GPS brut) éloignés de plusieurs mètres troublaient la
// lecture. Un seul point (le bleu) ; la précision du GPS est un cercle léger centré sur lui (dessiné par renderNavLive).
function drawRealPosition() {
  const r = S.nav?.real;
  if (!r) { realMarker?.remove(); realMarker = null; return; }
  if (!realMarker) realMarker = L.circle([r.lat, r.lon], {radius: r.acc, color: "#2F80ED", weight: 1, opacity: .35,
    fillColor: "#2F80ED", fillOpacity: .08, interactive: false}).addTo(map);
  realMarker.setRadius(Math.min(60, r.acc));
}
// Entre deux mesures GPS (souvent 1 à 3 s sur iPhone), la progression avance au rythme de la marche mesuré :
// le décompte de distance ne reste plus figé. Au plus 6 m d'avance sur la dernière mesure ; la suivante corrige.
setInterval(() => {
  const n = S.nav;
  if (!n || n.phase !== "route" || n.offRoute || n.away || n.arrived || !n.lastFix || document.hidden) return;
  const dt = (Date.now() - n.lastFix.at) / 1000, v = n.walkSpeed ?? 0;
  if (dt > 4 || v < 0.4 || v > 2.2) return;
  const target = Math.min(n.total, n.lastFix.along + Math.min(6, v * dt));
  if (target > n.pos + 0.3) moveTo(target);
}, 1000);
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* non supporté */ }
}

// ---- Écrans -----------------------------------------------------------------------------------
function screenProfile() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const sw = (id, ic, label, on) => `<label class="setting">${icon(ic)}<span class="grow">${label}</span>
      <input type="checkbox" class="switch" id="${id}" ${on ? "checked" : ""}></label>`;
  return `<header class="hero stk-host">
    <div class="brand">${profileReturn || store.get("va-profile", null) ? `<button class="icon-btn" id="profileBack" aria-label="Retour">${icon("arrow-left")}</button>` : ""}
      <img src="${logoDir()}icon-192.png" alt="" width="40" height="40"><span class="grow">Vision AR</span>
      <button class="btn soft small" id="logout" aria-label="Se déconnecter">${icon("log-out")} Déconnexion</button></div>
    ${currentSession() ? `<p class="hello">${isGuest() ? "Bienvenue&nbsp;!" : `Bonjour ${esc(currentSession().name.split(" ")[0])}&nbsp;!`}</p>` : ""}
    <h1>Comment vous déplacez-vous&nbsp;?</h1>
    <p class="lead">Choisissez un ou plusieurs profils : l'itinéraire s'adapte à vos besoins.</p>
    ${sticker("je-te-guide", "stk-corner stk-profile")}</header>
  <div class="tiles" role="group" aria-label="Profils de mobilité">
    ${MOB.map(([m, l, ic]) => `<button class="tile ${S.mobilities.has(m) ? "on" : ""}" data-mob="${m}" aria-pressed="${S.mobilities.has(m)}">
      <span class="tile-ic">${icon(ic)}</span><span class="tile-label">${l}</span><span class="tile-check">${icon("check")}</span></button>`).join("")}
  </div>
  <section class="card stk-host">${sticker("bordure-abaissee", "stk-card")}
    <h3>${icon("sliders-horizontal")} Mes réglages</h3>
    <div class="slider"><div class="row"><span class="grow">Pente maximale</span>
      <b id="slopeLbl">${S.maxSlope == null ? "selon le profil" : `${S.maxSlope} %`}</b></div>
      <input type="range" min="2" max="12" step="1" value="${S.maxSlope ?? 5}" id="slope" aria-label="Pente maximale en pour cent">
      <div class="scale"><span>2 %</span><span>12 %</span></div></div>
    ${sw("steps", "stairs", "J'accepte quelques marches", S.steps)}
    ${sw("voice", "volume-2", "Consignes à la voix", S.voice)}
  </section>
  <section class="card"><h3>${icon("glasses")} Apparence</h3><div class="themes">${themeCards("data-theme-pick")}</div></section>
  <button class="btn primary" id="cont">Continuer ${icon("chevron-right")}</button>
  ${standalone ? "" : `<div class="install">${icon("smartphone")}<div class="grow"><b>Installer l'appli</b>
      <span>${installPrompt ? "Ajoutez Vision AR à votre écran d'accueil." : ios ? "Bouton Partager, puis « Sur l'écran d'accueil »." : "Menu ⋮ du navigateur, puis « Ajouter à l'écran d'accueil »."}</span></div>
      ${installPrompt ? `<button class="btn soft small" id="install">${icon("download")} Installer</button>` : ""}</div>`}
  <p class="fine">${icon("shield-check")} Démonstration : ${esc(zoneLabel(ZONE))}. Itinéraires calculés sur ce téléphone, aucune donnée personnelle envoyée.
    Réseau © OpenStreetMap (ODbL)${ZONE.france ? ", pentes © IGN" : ""}.</p>`;
}
const OPTION_KEYS = {detect: "va-detect", detectDebug: "va-detect-debug", dataConsent: "va-data-consent", autoLowConf: "va-auto-lowconf"};
// ---- Paramètres : tout ce qui concerne l'appli, rangé au même endroit ----------------------------------
const APP_VERSION = "97";
function screenSettings() {
  const sess = currentSession(), mob = MOB.find(m => m[0] === primary());
  const row = (id, ic, label, value = "", chevron = true) => `<button class="set-row" id="${id}">${icon(ic)}<span class="grow">${label}</span>
      ${value ? `<span class="set-val">${value}</span>` : ""}${chevron ? icon("chevron-right") : ""}</button>`;
  const sw = (id, ic, label, on) => `<label class="setting">${icon(ic)}<span class="grow">${label}</span>
      <input type="checkbox" class="switch" id="${id}" ${on ? "checked" : ""}></label>`;
  const info = (ic, title, body) => `<details class="set-info"><summary>${icon(ic)}<span class="grow">${title}</span>${icon("chevron-right")}</summary>
      <div class="set-text">${body}</div></details>`;
  const mine = reports();
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return `<header class="hero">
    <div class="brand"><button class="icon-btn" id="settingsBack" aria-label="Retour">${icon("arrow-left")}</button>
      <span class="grow">Paramètres</span></div></header>
  <section class="card">
    ${row("setZone", "map-pin", "Ville", esc(zoneLabel(ZONE)))}
    ${sess ? `<div class="set-row static">${icon("user-round")}<span class="grow">Compte</span><span class="set-val">${sess.guest ? "Invité, sans compte" : `Bonjour ${esc(sess.name.split(" ")[0])}&nbsp;!`}</span></div>` : ""}
    ${row("setProfile", mob?.[2] || "accessibility", "Mon profil de mobilité", esc(mob?.[1] || ""))}
  </section>
  <section class="card stk-host">${sticker(S.voice ? "ca-vibre" : "lis-sans-son", "stk-card")}<h3>${icon("navigation")} Guidage</h3>
    ${sw("setVoice", "volume-2", "Consignes à la voix", S.voice)}
    ${sw("setHaptics", "vibrate", "Vibrations de direction", S.haptics)}
    ${row("testHaptics", "vibrate", "Tester la vibration", "", false)}
    ${sw("setStopsVoice", "bus", "Annoncer les arrêts de transport proches", S.stopsVoice)}
    <div class="slider"><div class="row"><span class="grow">Alerte des obstacles à</span><b id="alertDistLbl">${S.alertDist} m</b></div>
      <input type="range" min="5" max="10" step="1" value="${S.alertDist}" id="setAlertDist" aria-label="Distance d'alerte des obstacles, en mètres">
      <div class="scale"><span>5 m</span><span>10 m</span></div></div>
    <div class="slider"><div class="row"><span class="grow">Lieux affichés dans la caméra jusqu'à</span><b id="placesRangeLbl">${S.placesRange} m</b></div>
      <input type="range" min="20" max="130" step="10" value="${S.placesRange}" id="setPlacesRange" aria-label="Distance des lieux affichés dans la caméra, en mètres">
      <div class="scale"><span>20 m</span><span>130 m</span></div></div>
    ${sw("setEco", "battery", "Économie de batterie pendant le guidage", S.eco)}
    ${sw("setAudioOnly", "volume-2", "Mode audio seul : caméra éteinte, guidage à la voix et sur le plan (batterie)", S.audioOnly)}
    ${sw("setSimulate", "play", "Démonstration : le trajet défile tout seul, sans GPS ni caméra (pour présenter l'appli)", S.simulate)}
    ${hapticsNote() ? `<p class="fine">${icon("info")} ${esc(hapticsNote())}</p>` : ""}
  </section>
  <section class="card"><h3>${icon("glasses")} Apparence</h3><div class="themes">${themeCards("data-theme-pick")}</div></section>
  <section class="card"><h3>${icon("smartphone")} Logo sur l'écran d'accueil</h3>
    <div class="logos" role="group" aria-label="Logo de l'appli">
      ${Object.entries(LOGOS).map(([k, label]) => `<button class="logo-pick ${S.logo === k ? "on" : ""}" data-logo="${k}" aria-pressed="${S.logo === k}">
        <img src="icons/logos/${k}/apercu.png" alt="" width="64" height="64"><span>${label}</span></button>`).join("")}</div>
    <p class="fine">${icon("info")} Le logo choisi est repris quand vous ajoutez l'appli à l'écran d'accueil. Si elle y est déjà :
      supprimez l'icône, rechargez cette page, puis ajoutez-la de nouveau (${/iphone|ipad|ipod/i.test(navigator.userAgent)
        ? "bouton Partager, puis « Sur l'écran d'accueil »" : "menu ⋮, puis « Ajouter à l'écran d'accueil »"}).</p>
  </section>
  <section class="card"><h3>${icon("map")} Fond de carte</h3>
    ${Object.entries(BASEMAPS).filter(([k]) => basemapAvailable(k)).map(([k, b]) => `<button class="set-row" data-basemap="${k}" aria-pressed="${S.basemap === k}">${icon(k === "ortho" ? "camera" : "map")}
      <span class="grow">${b.label}<small>${b.sub}</small></span>${S.basemap === k ? `<span class="set-check">${icon("check")}</span>` : ""}</button>`).join("")}
    <p class="fine">${icon("info")} Le vrai fond Google Maps ou Plans (Apple, utilisé par Citymapper) demande leurs propres outils : une
      clé Google avec compte de facturation, ou un compte développeur Apple (99 €/an). « Style Plans » en est l'équivalent gratuit.</p>
  </section>
  <section class="card"><h3>${icon("scan-eye")} Obstacles vus par la caméra</h3>
    ${sw("setDetect", "scan-eye", "Détecter les obstacles (expérimental)", S.detect)}
    <p class="fine">${icon("info")} Détecteur Vision AR (11 Mo, téléchargé une fois puis gardé hors connexion, tout reste sur le téléphone).
      Reconnaît : potelets, poteaux, barrières, mobilier urbain, vélos et trottinettes, voitures sur le trottoir, travaux, piétons arrêtés.
      Seuls les obstacles devant vous, sur votre passage, sont annoncés.</p>
    ${sw("setDetectDebug", "square-dashed", "Mode test : boîtes, scores et couloir de passage (calibrage)", S.detectDebug)}
    ${sw("setConsent", "shield-check", "Contribuer à l'entraînement", S.dataConsent)}
    <p class="fine">${icon("info")} Avec votre accord, le bouton ⚠ du guidage permet d'enregistrer l'image caméra d'un obstacle manqué ou
      d'une fausse alerte, avec la position et l'heure. Visages et plaques sont floutés avant tout enregistrement ; les images restent sur ce
      téléphone tant que vous ne les exportez pas. Vous pouvez retirer votre accord et tout effacer à tout moment.</p>
    ${S.dataConsent ? sw("setAutoLow", "scan-eye", "Enregistrer aussi les détections incertaines", S.autoLowConf) : ""}
    <div class="set-row static">${icon("database")}<span class="grow">Images collectées</span><span class="set-val" id="sampleCount">…</span></div>
    ${row("exportSamples", "share-2", "Exporter les images (ZIP)", "", false)}
    ${row("clearSamples", "trash-2", "Tout effacer", "", false)}
  </section>
  <section class="card stk-host">${sticker("obstacle-signale", "stk-card")}<h3>${icon("triangle-alert")} Mes signalements</h3>
    ${mine.length ? mine.map(r => {
      const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1);
      return `<div class="set-row static">${icon(k[2])}<span class="grow">${k[1]}${r.blocking ? " — bloquant" : ""}
        <small>expire le ${new Date(r.expires).toLocaleString("fr-FR", {dateStyle: "short", timeStyle: "short"})}</small></span>
        <button class="icon-btn" data-unreport="${r.id}" aria-label="Retirer ce signalement">${icon("trash-2")}</button></div>`;
    }).join("") : `<p class="fine">Aucun signalement sur ce téléphone.</p>`}
  </section>
  <section class="card">
    ${standalone ? "" : row("setInstall", "smartphone", "Installer sur l'écran d'accueil")}
    ${row("setShare", "share-2", "Partager l'appli")}
    ${row("setLogout", "log-out", "Se déconnecter", "", false)}
  </section>
  <section class="card">
    ${info("shield-check", "Confidentialité", `<p>Vos itinéraires sont calculés sur ce téléphone. Votre compte, votre profil et vos signalements restent
      enregistrés sur ce téléphone : rien n'est envoyé à Geomessen. La position GPS ne sert qu'au guidage et n'est pas conservée.</p>
      <p>La recherche d'adresse interroge ${ZONE.france ? "le service public de la Géoplateforme (IGN)" : "le service Photon (OpenStreetMap)"} avec le texte saisi.</p>`)}
    ${info("file-text", "Conditions d'utilisation", `<p>Vision AR est une démonstration. Les itinéraires sont indicatifs : restez attentif à
      l'environnement, aux traversées et aux obstacles non signalés. Les données d'accessibilité peuvent être incomplètes.</p>`)}
    ${info("database", "Sources de données", `<p>Réseau piéton et lieux : © les contributeurs d'OpenStreetMap (licence ODbL).<br>
      ${ZONE.france ? "Relief et pentes : © IGN (Géoplateforme, altimétrie).<br>Recherche d'adresse : Géoplateforme IGN.<br>"
        : "Pentes : non disponibles (à relever sur place).<br>Recherche d'adresse : Photon (komoot), données OpenStreetMap.<br>"}
      Fond de carte : © OpenStreetMap.</p>`)}
    ${info("scale", "Mentions légales", `<p>Vision AR — Geomessen Burkina Faso.<br>Icônes : Lucide (licence ISC). Police : Atkinson Hyperlegible
      (licence SIL OFL).</p>`)}
  </section>
  ${sticker("merci", "stk-footer")}
  <p class="fine set-version">Vision AR version ${APP_VERSION}${APP_CHANNEL === "test" ? " (test)" : PRESENTATION ? " · version de présentation" : ""} · Geomessen Burkina Faso</p>
  ${APP_CHANNEL === "test" ? `<p class="fine set-version">Affichage : écran ${Math.max(screen.width, screen.height)} pt · appli ${Math.round(Math.max(innerWidth, innerHeight))} pt${navigator.standalone ? " · écran d’accueil" : ""}</p>` : ""}`;
}
function screenZones() {
  const byCountry = {};
  for (const [id, z] of Object.entries(ZONES)) (byCountry[z.country] ||= []).push([id, z]);
  return `<header class="hero">
    <div class="brand"><button class="icon-btn" id="zonesBack" aria-label="Retour">${icon("arrow-left")}</button>
      <span class="grow">Ville</span></div>
    <p class="lead">Choisissez le pays, la ville et le quartier où vous vous déplacez.</p></header>
  ${Object.entries(byCountry).map(([country, list]) => `<section class="card"><h3>${icon("globe")} ${esc(country)}</h3>
    ${list.map(([id, z]) => `<button class="set-row" data-zone="${id}" aria-pressed="${id === ZONE_ID}">${icon("map-pin")}
      <span class="grow">${esc(z.city)}${z.area ? `<small>Quartier : ${esc(z.area)}</small>` : "<small>Toute la ville</small>"}</span>
      ${id === ZONE_ID ? `<span class="set-check">${icon("check")}</span>` : icon("chevron-right")}</button>`).join("")}
  </section>`).join("")}
  <p class="fine">${icon("info")} D'autres villes et quartiers seront ajoutés au fur et à mesure de la collecte des données.</p>`;
}
function screenRoute() {
  if (S.nav) return screenTripLive();                     // guidage réduit : son panneau, pas la recherche
  const chosen = S.routes[S.selected];
  return `<div class="sheet-head">
    ${S.dest ? "" : sticker("on-y-va", "stk-sheet")}
    <button class="handle" id="sheetHandle" aria-expanded="${!sheetCollapsed}"
      aria-label="${sheetCollapsed ? "Agrandir le panneau" : "Réduire le panneau pour voir le plan"}"></button>
    <div class="row"><h2 class="grow">Où allez-vous&nbsp;?</h2>
      <button class="icon-btn" id="toProfile" aria-label="Mon profil">${icon(MOB.find(m => m[0] === primary())?.[2] || "user-round")}</button></div>
  </div>
  <div class="trip ${canSwap() ? "has-swap" : ""}">
    <div class="trip-row"><span class="trip-dot start" aria-hidden="true"></span>
      ${S.searchFor === "origin"
        ? `<label class="search grow">${icon("search")}<input type="search" id="qo" placeholder="Départ : adresse, lieu, arrêt…"
            value="${esc(S.oquery)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Point de départ">
            <button type="button" class="search-clear" id="qoCancel" aria-label="Garder le départ actuel">${icon("x")}</button></label>`
        : `<button class="trip-origin grow" id="editOrigin" aria-label="Départ : ${esc(originView().aria)}. Toucher pour changer">
            ${originRowHtml()}
            <span class="trip-edit">${icon("pencil")}</span></button>`}</div>
    <div class="trip-line" aria-hidden="true"></div>
    <div class="trip-row"><span class="trip-dot end" aria-hidden="true"></span>
      <label class="search grow">${icon("search")}<input type="search" id="q" placeholder="Adresse, lieu, station, commerce…"
        value="${esc(S.query)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Destination">
        <button type="button" class="search-clear" id="qClear" aria-label="Effacer la saisie" ${S.query ? "" : "hidden"}>${icon("x")}</button></label></div>
    ${canSwap() ? `<button class="trip-swap" id="swapTrip" aria-label="Inverser le départ et l'arrivée">${icon("arrow-up-down")}</button>` : ""}
  </div>
  <div id="placesBox" class="places-box">${placesHtml()}</div>
  ${PRESENTATION && !S.dest && S.searchFor === "dest" ? `<section class="tour-card">
    <h3>${icon("play")} Visite de démonstration</h3>
    <ol><li>Cherchez une destination à Gennevilliers («&nbsp;Picard&nbsp;», «&nbsp;Pharmacie&nbsp;», «&nbsp;Mairie&nbsp;»…) ou touchez un repère sur la carte.</li>
      <li>Comparez les itinéraires&nbsp;: le plus accessible pour votre profil est proposé en premier.</li>
      <li>Touchez «&nbsp;Démarrer le guidage&nbsp;»&nbsp;: le trajet défile tout seul, avec la voix et les alertes.</li></ol>
    <button class="btn soft small" id="tourGo">${icon("navigation")} Essayer avec un exemple</button></section>` : ""}
  ${S.searchFor === "origin" ? "" : `
  ${S.dest ? `<div class="routes-head"><h3>${icon("route")} Choisissez votre itinéraire</h3>
    <button class="btn soft small fav-toggle ${currentFavIndex() >= 0 ? "on" : ""}" id="favToggle" aria-pressed="${currentFavIndex() >= 0}">
      ${icon("star")} ${currentFavIndex() >= 0 ? "Enregistré" : "Enregistrer"}</button></div>${tripMobChips()}` : ""}
  ${S.dest && originPending() ? locatingHtml() : ""}
  ${S.message ? `<div class="msg warn">${icon("circle-alert")}<span>${esc(S.message)}</span></div>` : ""}
  ${S.routes.map((r, i) => routeCard(r, i)).join("")}
  ${doorCard()}${S.dest && S.arrival ? arrivalCard(S.arrival) : ""}${indoorButton()}
  ${S.routes.length ? `<button class="btn primary" id="start" ${chosen?.accessible ? "" : "disabled"}>${icon("navigation")} Démarrer le guidage</button>` : ""}`}`;
}
// Liste des résultats de recherche : mise à jour seule pendant la frappe (le champ n'est jamais reconstruit,
// sinon le clavier perd des lettres et l'appui long sur « effacer » s'arrête à chaque caractère)
const MY_POSITION = {label: "Ma position", sub: "Partir d'où je suis (GPS)", icon: "locate-fixed", type: "gps"};
// Fiches d'accès des établissements de la zone (« À l'arrivée », js/arrival.js), chargées une fois
loadAcces(ZONE_ID);
// Navigation intérieure (js/indoor.js) : désactivée par défaut (js/features.js). Rien n'est chargé tant que
// le drapeau est à false ; à true, bouton « Plan intérieur » près des bâtiments qui ont un plan.
let indoorBuildings = [], indoor = null;
if (FEATURES.indoorNavigationEnabled) {
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "css/indoor.css";
  document.head.append(css);
  import("./indoor.js").then(async m => { indoor = m; indoorBuildings = (await m.loadIndoor()).filter(b => b.zone === ZONE_ID); render(); });
}
const buildingNear = p => FEATURES.indoorNavigationEnabled && p && indoorBuildings.find(b => haversineM(b.lat, b.lon, p.lat, p.lon) < 80);
function openBuilding(id) {
  const b = indoorBuildings.find(x => x.id === id);
  if (b && indoor) indoor.openIndoor(b, {avoidStairs: !resolveProfile(profileJson()).steps_allowed, say: t => say(t, true)});
}
// ---- Trajets favoris (gardés sur ce téléphone, par ville) ---------------------------------------
// Départ « Ma position » enregistré comme tel : le trajet repart de là où l'on est au moment de le relancer.
const FAV_KEY = `va-favorites-${ZONE_ID}`, FAV_MAX = 12;
const favorites = () => store.get(FAV_KEY, []);
const samePlace = (a, b) => a && b && haversineM(a.lat, a.lon, b.lat, b.lon) < 30;
const favOrigin = () => S.origin.gps || S.origin.none ? {gps: true, label: "Ma position"} : {lat: S.origin.lat, lon: S.origin.lon, label: S.origin.label};
function currentFavIndex() {
  if (!S.dest) return -1;
  const o = favOrigin();
  return favorites().findIndex(f => samePlace(f.dest, S.dest) && (f.origin.gps ? o.gps : !o.gps && samePlace(f.origin, o)));
}
function toggleFavorite() {
  const list = favorites(), i = currentFavIndex();
  if (i >= 0) {
    list.splice(i, 1);
    toast("Trajet retiré des favoris.");
  } else {
    if (list.length >= FAV_MAX) return toast(`${FAV_MAX} favoris au plus : retirez-en un pour en ajouter un autre.`);
    list.unshift({id: Date.now(), origin: favOrigin(), dest: {lat: S.dest.lat, lon: S.dest.lon, label: S.dest.label}});
    toast("Trajet enregistré dans vos favoris.");
  }
  store.set(FAV_KEY, list);
  render();
}
function useFavorite(id) {
  const f = favorites().find(x => x.id === id);
  if (!f) return;
  if (f.origin.gps) {
    S.originMode = "gps";                                // « depuis Ma position » : d'où vous êtes MAINTENANT
    locateOrigin();
  } else {
    S.origin = {lat: f.origin.lat, lon: f.origin.lon, label: f.origin.label}; S.originMode = "manual";
  }
  chooseDest({...f.dest, type: "poi"});
}
function removeFavorite(id) {
  store.set(FAV_KEY, favorites().filter(x => x.id !== id));
  toast("Trajet retiré des favoris.");
  renderPlaces();
}
function favoritesHtml() {
  const list = favorites();
  return `<section class="favs" aria-labelledby="favsTitle"><h3 id="favsTitle">${icon("star")} Mes trajets favoris</h3>
    ${list.length ? `<div class="places">${list.map(f => `<div class="fav-row">
        <button class="place" data-fav="${f.id}" data-key="fav-${f.id}" aria-label="Lancer le trajet de ${esc(f.origin.label)} à ${esc(f.dest.label)}">
          <span class="place-ic">${icon("route")}</span><span class="grow">${esc(f.dest.label)}<small>depuis ${esc(f.origin.label)}</small></span>
          ${icon("chevron-right")}</button>
        <button class="fav-del" data-unfav="${f.id}" aria-label="Retirer ${esc(f.dest.label)} des favoris">${icon("trash-2")}</button></div>`).join("")}</div>`
      : `<p class="fine favs-empty">${icon("info")} Choisissez une destination, puis touchez « Enregistrer » pour retrouver ce trajet ici en un geste.</p>`}
  </section>`;
}
function bindPlaces(root) {
  root.querySelectorAll("[data-place]").forEach(p => p.onclick = () => pickPlace(+p.dataset.place));
  root.querySelectorAll("[data-fav]").forEach(b => b.onclick = () => useFavorite(+b.dataset.fav));
  root.querySelectorAll("[data-unfav]").forEach(b => b.onclick = () => removeFavorite(+b.dataset.unfav));
}
const placeList = () => S.searchFor === "origin" ? [MY_POSITION, ...S.places] : S.places;
function pickPlace(i) {
  const p = placeList()[i];
  if (p) S.searchFor === "origin" ? chooseOrigin(p) : chooseDest(p);
}
function placesHtml() {
  const list = placeList();
  if (!list.length && S.searchFor === "dest" && !S.dest && !S.query.trim()) return favoritesHtml();
  return list.length ? `<div class="places">${list.map((p, i) => `<button class="place" data-place="${i}" data-key="place-${esc(p.label)}-${esc(p.sub || "")}">
      <span class="place-ic" ${p.color ? `style="color:${p.color}"` : ""}>${icon(p.icon || (p.type === "poi" ? "map-pin" : "map"))}</span><span class="grow">${esc(p.label)}<small>${esc(p.sub || (p.type === "poi" ? "Lieu" : "Adresse"))}</small></span>
      ${icon("chevron-right")}</button>`).join("")}</div>` : "";
}
function renderPlaces() {
  const box = $("placesBox");
  if (!box) return;
  const before = new Set([...box.querySelectorAll("[data-key]")].map(el => el.dataset.key));
  box.innerHTML = placesHtml();
  for (const k of markEntering(box, before)) shownKeys.add(k);
  bindPlaces(box);
  layoutSheet();
}
function indoorButton() {
  const b = buildingNear(S.dest);
  return b ? `<button class="btn soft indoor-btn" data-indoor="${b.id}">${icon("building-2")}
    <span class="grow">Plan intérieur<small>${esc(b.name)}</small></span>${icon("chevron-right")}</button>` : "";
}
function arrivalCard(f) {
  if (!f.lines.length) return `<p class="fine arrive-none">${icon("door-open")} Pas encore d'information sur l'accès à ce lieu.</p>`;
  return `<section class="arrive-card" data-key="arrive-${esc(f.name)}" aria-labelledby="arrTitle"><div class="arrive-head"><h3 id="arrTitle">${icon("door-open")} À l'arrivée</h3>
      <button class="btn soft small" id="arrSpeak">${icon("volume-2")} Écouter</button></div>
    <ul>${f.lines.map(l => `<li class="${l.tone}">${icon(l.ic)}<span>${esc(l.text)}</span></li>`).join("")}</ul>
    <p class="fine">Sources : ${esc(f.sources.join(", "))}.</p></section>`;
}
// Ce qu'il faut savoir avant de partir : mètres sur la chaussée, traversées sans feu sonore
function routeRisks(r) {
  let road = 0, noSignal = 0;
  for (const id of r.edge_ids || []) {
    const e = net?.edges[id];
    if (!e) continue;
    if (e.beside_sidewalk) road += e.length_m;
    if (e.is_crossing && e.sound_signal !== true) noSignal++;
  }
  return {road: Math.round(road), noSignal, vision: resolveProfile(profileJson()).prefers_sound_signals};
}
function risksText(k) {
  const t = [];
  if (k.road >= 5) t.push(`${short(k.road)} sur la chaussée`);
  if (k.vision && k.noSignal) t.push(`${k.noSignal} traversée${k.noSignal > 1 ? "s" : ""} sans feu sonore connu`);
  return t;
}
function routeCard(r, i) {
  const min = Math.ceil(r.duration_s / 60);
  const incomplete = r.warnings.includes("données incomplètes");
  const badge = !r.accessible ? `<span class="badge danger">${icon("ban")} Non praticable</span>`
    : i === 0 ? `<span class="badge ok">${icon("accessibility")} Recommandé</span>${r.alsoFastest
      ? `<span class="badge fast">${icon("zap")} Aussi le plus rapide</span>` : ""}` : "";
  const notes = r.accessible
    ? risksText(routeRisks(r)).map(w => `<span class="tag warn">${icon("triangle-alert")} ${esc(w)}</span>`)
      .concat(r.warnings.filter(w => !["marche", "données incomplètes", "sur la chaussée", "traversée sans feu sonore"].includes(w)).map(w => `<span class="tag">${esc(w)}</span>`))
      .concat(incomplete ? [`<span class="tag warn">${icon("info")} données à confirmer</span>`] : [])
    : r.blocking_issues.map(w => `<span class="tag danger">${icon("triangle-alert")} ${esc(w)}</span>`);
  const stk = i === 0 && r.accessible ? (!r.steps_count ? "zero-marche" : r.max_slope_pct <= 5 ? "pente-douce" : "") : "";
  return `<div class="rcard ${i === S.selected ? "sel" : ""} ${stk ? "stk-host" : ""}" data-route="${i}" data-key="route-${esc(S.dest?.label || "")}-${esc(r.label)}" role="button" tabindex="0"
      aria-label="${esc(r.label)}, ${min} minutes, ${short(r.length_m)}${r.accessible ? "" : ", non praticable"}${i === S.selected ? ", sélectionné" : ""}">
    <div class="rc-head"><div class="grow"><b>${esc(r.label)}</b>${badge ? `<span class="badges">${badge}</span>` : ""}</div><div class="rc-time"><b>${min}</b> min</div></div>
    <div class="rc-meta">
      <span>${icon("route")} ${short(r.length_m)}</span>
      <span class="${r.steps_count ? "bad" : "good"}">${icon("stairs")} ${r.steps_count ? r.steps_count + " marche(s)" : "aucune marche"}</span>
      ${net && r.edge_ids.every(id => net.edges[id]?.slope_pct === null)
        ? `<span>${icon("mountain")} pente à vérifier</span>`
        : `<span class="${r.max_slope_pct > 5 ? "bad" : "good"}">${icon("mountain")} pente max ${fmt1(r.max_slope_pct)} %</span>`}</div>
    ${r.note ? `<p class="rc-note ${r.kind}">${icon(r.kind === "fastest" ? "zap" : "accessibility")}<span>${esc(r.note)}</span></p>` : ""}
    ${notes.length ? `<div class="tags">${notes.join("")}</div>` : ""}${stk ? sticker(stk, "stk-route") : ""}</div>`;
}
// Commandes et état exposés à l'écran de guidage en réalité augmentée (js/ar.js)
const navApi = {
  map,
  state: () => S.nav && {nav: S.nav, st: navState(), posAt, net, dest: S.dest, reports: reports(), speed: speed(),
    mobility: tripMobility(), voice: S.voice, theme: S.theme, haptics: S.haptics, hapticsNote: hapticsNote(),
    detect: S.detect, detectDebug: S.detectDebug, dataConsent: S.dataConsent, autoLowConf: S.autoLowConf,
    gpsInfo: S.nav.gpsInfo, gpsProblem: S.nav.gpsProblem, gpsDenied: S.nav.gpsDenied, gpsStatus: S.nav.gpsStatus,
    placesRange: S.placesRange, eco: ecoNow(), audioOnly: S.audioOnly, simulated: !!S.nav.simulated},
  reroute: () => manualReroute(),
  setOption: (key, value) => { S[key] = value; store.set(OPTION_KEYS[key], value); },
  locationHelp: () => locationHelp(),
  obstacleAlert: text => { say(text, DANGER); buzz("obstacle"); },
  say: (text, level = INFO) => say(text, level),
  nativeFix: (lat, lon, acc) => onGps({coords: {latitude: lat, longitude: lon, accuracy: acc}}, true),
  setHaptics: on => { S.haptics = on; store.set("va-haptics", on); if (on) buzz("left"); },
  toggleVoice: () => { S.voice = !S.voice; store.set("va-voice", S.voice); if (!S.voice) speech.clear(); },
  openHud: () => { S.hud = true; renderHud(); },
  setTheme,
  report: (kind, blocking) => doReport(kind, blocking),
  stop: () => stopGuidance(),
  minimize: () => minimizeGuidance(),
  endSoftly: () => endGuidanceSoftly(),
  stay: () => { if (S.nav) S.nav.stayed = true; },
};
// Arrivée (terrain du 20/10 : la sortie était brutale) : écran « Vous êtes arrivé » avec le résumé du trajet,
// boutons Terminer / Rester. Sans action, il se ferme seul au bout de 20 s (après la lecture de la fiche),
// en fondu, et la carte se pose doucement sur la destination.
function finishAtEntrance(fiche) {
  stopNav();
  try { wakeLock?.release?.(); } catch { /* déjà libéré */ }
  const nav = S.nav;
  nav.arrivedAt = Date.now();
  nav.autoEndAt = Date.now() + Math.max(20000, fiche ? 6000 + fiche.length * 90 : 0);
  const t = setInterval(() => {
    if (S.nav !== nav || S.screen !== "nav" || nav.stayed) return clearInterval(t);
    if (Date.now() >= nav.autoEndAt) { clearInterval(t); endGuidanceSoftly(); }
  }, 500);
}
function endGuidanceSoftly() {
  const ar = $("ar"), dest = S.dest;
  if (ar && !ar.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    ar.classList.add("leaving");                           // fondu de la vue caméra (css : #ar.leaving)
    setTimeout(() => { stopGuidance(true); if (dest) setTimeout(() => map.flyTo([dest.lat, dest.lon], 18, {duration: 1.2}), 150); }, 450);
  } else { stopGuidance(true); if (dest) map.setView([dest.lat, dest.lon], 18); }
}
// ---- Démonstration : le trajet défile tout seul ----------------------------------------------------------
// Pour présenter l'appli sans être sur place (recruteurs, salons) : positions simulées le long de l'itinéraire,
// à 4 fois la vitesse de marche du profil, puis le dernier bout à pied jusqu'à la porte. Ni GPS ni caméra (vue au
// sol quadrillée) ; consignes, voix, vibrations, alertes et écran d'arrivée fonctionnent comme sur le terrain.
const SIM_FACTOR = 4, SIM_STEP_S = 0.5;
let simTimer = null;
function startSimulation() {
  stopSimulation();
  const n = S.nav;
  if (!n) return;
  let d = 0, leg = 0;
  const feed = p => onGps({coords: {latitude: p.lat, longitude: p.lon, accuracy: 4}, timestamp: Date.now()});
  feed(n.route.geometry[0]);
  simTimer = setInterval(() => {
    if (S.nav !== n || n.arrived) return stopSimulation();
    const step = speed() * SIM_FACTOR * SIM_STEP_S;
    if (d < n.total) { d = Math.min(n.total, d + step); return feed(posAt(d)); }
    const end = n.route.geometry.at(-1), dest = S.dest, len = dest ? haversineM(end.lat, end.lon, dest.lat, dest.lon) : 0;
    if (len < 1) return feed(end);
    leg = Math.min(len, leg + step);
    feed({lat: end.lat + (dest.lat - end.lat) * leg / len, lon: end.lon + (dest.lon - end.lon) * leg / len});
  }, SIM_STEP_S * 1000);
}
function stopSimulation() { clearInterval(simTimer); simTimer = null; }
function stopGuidance(keepVoice = false) {
  stopSimulation();
  // départ « Ma position » : le prochain trajet repartira d'où vous êtes (dernière position du guidage si récente)
  const real = S.nav?.real;
  if (real && Date.now() - real.at <= ORIGIN_RULES.maxAgeMs) liveFix = {lat: real.lat, lon: real.lon, acc: real.acc, at: real.at};
  for (const step of [() => stopNav(), () => { S.nav = null; }, () => { if (!keepVoice) speech.clear(); },
                      () => wakeLock?.release?.(), () => closeAR(), () => layers.progress.clearLayers(),
                      () => { if (S.origin.gps) { S.originMode = "gps"; S.routes = []; locateOrigin(); } }, () => go("route"),
                      () => { if (S.origin.gps && S.dest && !originPending()) computeRoute(); }]) {
    try { step(); } catch (e) { console.error("Arrêt du guidage :", e); }
  }
  // Si l'écran de guidage est encore là 2 s plus tard (blocage), on le libère de force
  setTimeout(() => {
    const ar = $("ar");
    if (S.screen === "nav" || (ar && !ar.hidden)) {
      try { closeAR(); } catch { /* déjà fermé */ }
      if (ar) { ar.hidden = true; ar.innerHTML = ""; }
      S.nav = null; S.screen = "route";
      try { render(); } catch (e) { console.error(e); }
    }
  }, 2000);
}
// ---- Guidage réduit, comme Citymapper (« Trajet en cours ») -----------------------------------------------
// On peut quitter l'écran de guidage (bouton « Réduire », geste retour) sans l'arrêter : la caméra se ferme, le
// GPS, la voix et les alertes continuent. Sur le plan, une pastille « Trajet en cours » et le panneau du guidage
// permettent d'y revenir d'un geste ; on ne l'arrête que par « Arrêter » (avec confirmation).
const tripLive = () => !!S.nav && S.screen !== "nav";
const navPos = () => { const n = S.nav; return n.real && Date.now() - n.real.at < 15000 && (n.phase === "approach" || n.away || n.offRoute) ? n.real : n.here; };
function minimizeGuidance() {
  if (!S.nav || S.screen !== "nav") return;
  try { closeAR(); } catch (e) { console.error(e); }
  S.hud = false;
  sheetCollapsed = false;
  go("route");
  const p = navPos();
  requestAnimationFrame(() => centerAbovePanel([p.lat, p.lon], 16));
  toast("Le guidage continue à la voix. Touchez « Trajet en cours » pour revenir à l'écran de guidage.", 5000);
}
function resumeGuidance() {
  if (!S.nav) return;
  unlockVoice();                                          // dans le geste de l'usager (iPhone)
  setHeadingMode(false); follow = false;
  go("nav");                                              // render() rouvre la vue caméra (geste de l'usager : caméra et boussole)
  const p = navPos();
  map.setView([p.lat, p.lon], 17, {animate: false});
}
function tripTimes() {
  const st = navState(), left = st.remaining / speed();
  return {st, mins: Math.max(1, Math.ceil(left / 60)),
    eta: new Date(Date.now() + left * 1000).toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit"})};
}
const pillText = () => { const {st, mins} = tripTimes(); return st.arrived ? "Vous êtes arrivé" : `Trajet en cours · ${mins} min`; };
function liveStatsHtml() {
  const {st, mins, eta} = tripTimes();
  return st.arrived ? `<b>Vous êtes arrivé</b>` : `<b>${mins} min</b><span>arrivée ${eta}</span><span>${short(st.remaining)}</span>`;
}
function liveNextHtml() {
  const {st} = tripTimes();
  return st.arrived ? `${icon("flag")}<span>${esc(S.dest?.label || "")}</span>` : `${icon(MAN_ICON[st.next.maneuver] || "arrow-up")}<span>${esc(st.spoken)}</span>`;
}
// Panneau du bas pendant un guidage réduit (à la place de la recherche : changer de destination demande d'arrêter)
function screenTripLive() {
  const arrived = liveArrived = navState().arrived;
  return `<div class="sheet-head">
    <button class="handle" id="sheetHandle" aria-expanded="${!sheetCollapsed}"
      aria-label="${sheetCollapsed ? "Agrandir le panneau" : "Réduire le panneau pour voir le plan"}"></button>
    <div class="row"><h2 class="grow">${arrived ? "Vous êtes arrivé" : "Guidage en cours"}</h2></div>
  </div>
  <section class="live-card">
    <div class="live-dest">${icon("flag")}<span class="grow"><small>Vers</small><b>${esc(S.dest?.label || "")}</b></span></div>
    <div class="live-stats" id="liveStats">${liveStatsHtml()}</div>
    <p class="live-next" id="liveNext">${liveNextHtml()}</p>
  </section>
  ${arrived ? `<button class="btn primary" id="endLive">${icon("check")} Terminer</button>
    <button class="btn soft" id="resumeNav">${icon("navigation")} Revenir à l'écran de guidage</button>`
    : `<button class="btn primary" id="resumeNav">${icon("navigation")} Reprendre le guidage</button>
    <button class="btn soft" id="stopLive">${icon("x")} Arrêter le guidage</button>`}`;
}
// Mise à jour en direct (à chaque position) sans reconstruire le panneau
let liveArrived = false;
function updateTripLive() {
  if (!tripLive()) return;
  const arrived = navState().arrived;
  if (arrived !== liveArrived) { liveArrived = arrived; return render(); }
  const pill = $("tripPill");
  if (pill) pill.querySelector("span").textContent = pillText();
  if ($("liveStats")) $("liveStats").innerHTML = liveStatsHtml();
  if ($("liveNext")) $("liveNext").innerHTML = liveNextHtml();
}
// Signalement : enregistré sur ce téléphone ; s'il bloque, nouvel itinéraire depuis la position
function doReport(kind, blocking) {
  // On signale ce qu'on a devant soi : l'obstacle est placé 10 m plus loin sur l'itinéraire.
  // (À sa propre position, il bloquerait les trottoirs autour de soi et aucun détour ne serait possible.)
  const here = S.nav.here, at = posAt(Math.min(S.nav.total, S.nav.pos + 10));
  hazardAlerted.add(`r${addReport(kind, blocking, at).id}`);
  let msg = "Merci, obstacle enregistré sur ce téléphone.";
  S.nav.hazards = hazardsOn(S.nav);
  stickerPop("obstacle-signale");
  if (blocking) {
    try {
      const res = computeRoutes(net, {origin: here, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
      startNav(res.routes[0], true);
      S.routes = res.routes; S.selected = 0;
      S.nav.rerouted = {at: Date.now(), title: kind === "elevator_out" ? "Ascenseur en panne" : "Trottoir bloqué"};
      msg += " Itinéraire recalculé depuis votre position.";
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      msg += " Aucun détour accessible n'a été trouvé : l'itinéraire actuel est conservé, avancez prudemment.";
    }
  }
  drawRoutes(); drawReports();
  return msg;
}
function renderHud() {
  const h = $("hud");
  h.hidden = !S.hud || !S.nav;
  if (h.hidden) return;
  const st = navState(), m = st.next.maneuver, r = S.nav.route, acc = S.hc ? "var(--yellow)" : "var(--cyan)";
  let body;
  if (st.arrived) body = `<div class="big" style="color:${acc}">Vous êtes arrivé</div><div></div>`;
  else if (S.hc) body = `<div class="main"><span class="arr" style="color:var(--yellow)">${icon(MAN_ICON[m] || "arrow-up")}</span>
      <div><div class="verb" style="color:var(--yellow)">${VERB[m] || "TOUT DROIT"}</div><div class="dist">${short(st.toManeuver)}</div></div></div>`;
  else body = `<div class="main"><span class="arr" style="color:var(--cyan)">${icon(MAN_ICON[m] || "arrow-up")}</span>
      <div><div class="dist" style="color:var(--cyan)">${short(st.toManeuver)}</div><div class="street">${esc(st.next.street)}</div></div></div>`;
  if (!st.arrived) body += st.next.alerts.length && st.toManeuver < 60
    ? `<div class="alert">${icon("triangle-alert")} ${esc(st.next.alerts[0])}<span>${esc(st.next.alerts.slice(1).join(", ") || st.next.street)}</span></div>`
    : S.hc ? "<div></div>" : `<div class="chips"><i>${r.steps_count === 0 ? "0 marche" : r.steps_count + " marche(s)"}</i><i>pente ${fmt1(r.max_slope_pct)} %</i>
        <span style="font-size:22px">${Math.ceil(st.remaining / speed() / 60)} min</span></div>`;
  h.innerHTML = body + `<div class="close">Vue lunettes (le noir est transparent) · toucher : fermer · appui long : contraste</div>`;
}

// ---- render() et animations ------------------------------------------------------------------------
// #map et #panel sont créés une fois (index.html) : render() ne remplace que le CONTENU de #panel. Pour que
// ce remplacement ne rejoue pas les animations : un élément animé à l'entrée porte une clé stable (data-key) et
// ne reçoit la classe « enter » que si cette clé n'était pas à l'écran au render précédent. Le défilement de
// #panel est conservé tant qu'on reste sur le même écran ; la position du panneau (--sheet-y, sur #panel) aussi.
let shownKeys = new Set(), lastScreen = null;
function markEntering(root, before) {
  const now = new Set();
  for (const el of root.querySelectorAll("[data-key]")) {
    now.add(el.dataset.key);
    if (!before.has(el.dataset.key)) el.classList.add("enter");
  }
  return now;
}
// Changement d'écran : Paramètres, Profil et Zones arrivent en glissant depuis la droite (comme une page qu'on
// ouvre) ; au retour vers la carte, le panneau réapparaît en fondu. Rien si le téléphone réduit les animations.
const PAGE_SCREENS = ["settings", "profile", "zones"];
function pageTransition(panel, prev) {
  if (!prev || prev === S.screen || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-sheet").trim() || "cubic-bezier(.22, 1, .36, 1)";
  if (PAGE_SCREENS.includes(S.screen))
    panel.animate([{transform: "translateX(36%)", opacity: 0}, {transform: "translateX(0)", opacity: 1}], {duration: 380, easing});
  else if (PAGE_SCREENS.includes(prev) && S.screen === "route")
    panel.animate([{opacity: 0}, {opacity: 1}], {duration: 260, easing: "ease-out"});   // (transform : réservé au panneau du bas)
}
function render() {
  const nav = S.screen === "nav";
  const authScreen = AUTH_SCREENS[S.screen];
  const typing = document.body.classList.contains("typing") && document.activeElement?.id === "q";
  document.body.className = authScreen ? "full auth-screen" : ["profile", "settings", "zones"].includes(S.screen) ? "full" : nav ? "nav-ar" : typing ? "sheet typing" : "sheet";
  // Stickers déjà à l'écran : on garde les mêmes images d'un affichage à l'autre (recréées, elles disparaissaient
  // un instant le temps d'être redécodées : le sticker « clignotait » à chaque choix de profil)
  const keepStk = new Map([...$("panel").querySelectorAll("img.stk")].map(img => [img.className + img.getAttribute("src"), img]));
  const panel = $("panel"), scroll = lastScreen === S.screen ? panel.scrollTop : 0, prevScreen = lastScreen;
  panel.innerHTML = nav ? "" : authScreen ? authScreen() : {profile: screenProfile, route: screenRoute, settings: screenSettings, zones: screenZones}[S.screen]();
  shownKeys = markEntering(panel, lastScreen === S.screen ? shownKeys : new Set());
  panel.scrollTop = scroll; lastScreen = S.screen;
  pageTransition(panel, prevScreen);
  for (const img of $("panel").querySelectorAll("img.stk")) {
    const old = keepStk.get(img.className + img.getAttribute("src"));
    if (old) { img.replaceWith(old); keepStk.delete(img.className + img.getAttribute("src")); }
  }
  if (authScreen) bindAuth($("panel"), authCtx); else bind();
  renderHud();
  syncLayers();
  if (net) { drawRoutes(); drawReports(); }
  if (nav && !arOpen()) openAR(navApi);                 // dans le geste de l'usager : caméra et boussole autorisées
  refreshTransit(true);
  let mc = $("mapClose");
  if (S.screen === "route" && S.dest && !S.nav) {
    if (!mc) {
      mc = document.createElement("button");
      mc.id = "mapClose"; mc.className = "map-close";
      mc.setAttribute("aria-label", "Fermer le choix d'itinéraire");
      mc.innerHTML = `${icon("x")}<span>Fermer</span>`;
      mc.onclick = back;
      document.body.append(mc);
    }
  } else mc?.remove();
  let ms = $("mapSettings");
  if (S.screen === "route") {
    if (!ms) {
      ms = document.createElement("button");
      ms.id = "mapSettings"; ms.className = "map-settings";
      ms.setAttribute("aria-label", "Paramètres");
      ms.innerHTML = icon("settings");
      ms.onclick = () => go("settings");
      document.body.append(ms);
    }
  } else ms?.remove();
  let tp = $("tripPill");
  if (S.screen === "route" && S.nav) {                    // guidage réduit : « Trajet en cours », pour y revenir
    if (!tp) {
      tp = document.createElement("button");
      tp.id = "tripPill"; tp.className = "trip-pill";
      tp.onclick = resumeGuidance;
      document.body.append(tp);
    }
    tp.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span>${esc(pillText())}</span>${icon("chevron-right")}`;
    tp.setAttribute("aria-label", `${pillText()}. Toucher pour revenir à l'écran de guidage`);
  } else tp?.remove();
  if (headingMode && S.screen !== "route") setHeadingMode(false);
  if (S.screen === "route") autoOrigin();                // première recherche : départ = la position actuelle
  syncMapButtons();
  syncGuard();
  syncHereDot();
  layoutSheet();
  setTimeout(() => map.invalidateSize(), 0);
}

// ---- Panneau du bas : se réduit d'un geste pour laisser voir le plan ------------------------------
// Deux positions : ouvert (hauteur de son contenu) ou réduit (titre seul). On le fait glisser par
// sa poignée ou son titre ; toucher la poignée bascule de l'un à l'autre.
let sheetCollapsed = false;
const sideLayout = () => matchMedia("(orientation: landscape) and (max-height: 600px), (min-width: 768px) and (min-height: 601px)").matches;
function sheetRange() {
  const p = $("panel"), head = p.querySelector(".sheet-head");
  if (!head) return 0;
  const peek = head.offsetTop + head.offsetHeight + parseFloat(getComputedStyle(p).paddingBottom) + 4;
  return Math.max(0, p.offsetHeight - peek);             // de combien on peut le descendre
}
function layoutSheet(offset = null) {
  const p = $("panel"), root = document.documentElement.style;
  if (S.screen !== "route" || sideLayout()) { p.style.removeProperty("--sheet-y"); root.setProperty("--sheet-h", "0px"); return; }
  const max = sheetRange(), y = offset ?? (sheetCollapsed ? max : 0);
  p.style.setProperty("--sheet-y", `${Math.max(0, Math.min(max, y))}px`);
  p.classList.toggle("collapsed", offset === null && sheetCollapsed);   // abaissé : seul le titre reste visible
  root.setProperty("--sheet-h", `${Math.round(p.offsetHeight - Math.max(0, Math.min(max, y)))}px`);
  scheduleHeadingLayout();                                // carte orientée : recentrée sur la partie visible
  const h = $("sheetHandle");
  if (h) {
    h.setAttribute("aria-expanded", String(!sheetCollapsed));
    h.setAttribute("aria-label", sheetCollapsed ? "Agrandir le panneau" : "Réduire le panneau pour voir le plan");
  }
}
function setSheet(collapsed) {
  sheetCollapsed = collapsed;
  document.body.classList.remove("dragging");
  layoutSheet();
  if (S.routes.length) setTimeout(fitRoute, 320);          // recadrer une fois le panneau en place
}
let drag = null;
$("panel").addEventListener("pointerdown", e => {
  const head = e.target.closest(".sheet-head");
  if (!head || S.screen !== "route" || sideLayout() || (e.target.closest("button") && !e.target.closest("#sheetHandle"))) return;
  drag = {y: e.clientY, start: sheetCollapsed ? sheetRange() : 0, moved: 0, t: performance.now(), id: e.pointerId,
          onHandle: !!e.target.closest("#sheetHandle")};
  head.setPointerCapture?.(e.pointerId);
});
$("panel").addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.moved = e.clientY - drag.y;
  if (Math.abs(drag.moved) < 4) return;
  document.body.classList.add("dragging");
  layoutSheet(drag.start + drag.moved);
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const {moved, start, t, onHandle} = drag, max = sheetRange();
  drag = null;
  if (Math.abs(moved) < 6) {                              // simple toucher : la poignée bascule, le titre rouvre
    setSheet(onHandle ? !sheetCollapsed : false);
    return;
  }
  const speed = moved / Math.max(1, performance.now() - t);       // px/ms : un geste vif suffit
  setSheet(speed > 0.25 ? true : speed < -0.25 ? false : start + moved > max / 2);
};
$("panel").addEventListener("pointerup", endDrag);
$("panel").addEventListener("pointercancel", endDrag);
addEventListener("resize", () => layoutSheet());
// ---- Authentification (js/auth.js) ----------------------------------------------------------------
const AUTH_SCREENS = {welcome: screenWelcome, login: screenLogin, signup: screenSignup};
const authCtx = {
  go: screen => go(screen),
  toast,
  rerender: () => {                                       // garde la saisie et le focus pendant la frappe
    const id = document.activeElement?.id;
    render();
    if (id && $(id)) $(id).focus();
  },
  done: () => {                                           // connecté : profil, ou directement la recherche
    resetForm();
    const next = store.get("va-profile", null) ? "route" : "profile";
    go(next);
    if (next === "route") computeRoute();
    toast(isGuest() ? "Bienvenue ! Vous découvrez Vision AR sans compte." : `Bienvenue ${currentSession()?.name.split(" ")[0] || ""} !`);
  },
};
function renderNavLive() {
  renderHud();
  const n = S.nav;
  if (!n) return;
  const shown = (n.phase === "approach" || n.away || n.offRoute) && n.real ? n.real : n.here;   // N°15 : pas accroché pendant l'approche
  realMarker?.setLatLng?.([shown.lat, shown.lon]);         // cercle de précision autour du seul point affiché
  n.marker?.setLatLng([shown.lat, shown.lon]);
  if (S.screen === "nav") { map.panTo([shown.lat, shown.lon], {animate: false}); drawProgress(); refreshTransit(); announceStops(); }
  else if (tripLive()) { updateTripLive(); if (headingMode) layoutHeading(); else if (follow) centerAbovePanel([shown.lat, shown.lon], map.getZoom()); }
}
// N°16 : le tracé s'allume sur 30 m devant soi ; déjà parcouru = gris ; la suite reste visible, atténuée
function routeSlice(a, b) {
  const n = S.nav, g = n.route.geometry, out = [posAt(a)];
  for (let i = 0; i < g.length; i++) if (n.cum[i] > a && n.cum[i] < b) out.push(g[i]);
  out.push(posAt(b));
  return out.map(p => [p.lat, p.lon]);
}
let progressAt = 0;
function drawProgress(force = false) {
  const n = S.nav;
  if (!n || S.screen !== "nav" || (!force && performance.now() - progressAt < 700)) return;
  progressAt = performance.now();
  layers.progress.clearLayers();
  const lit = Math.min(n.total, n.pos + 30);
  if (n.pos > 0.5) L.polyline(routeSlice(0, n.pos), {color: "#8A97A6", weight: 6, opacity: .75, lineCap: "round", interactive: false}).addTo(layers.progress);
  if (lit < n.total) L.polyline(routeSlice(lit, n.total), {color: C.route, weight: 5, opacity: .35, lineCap: "round", interactive: false}).addTo(layers.progress);
  L.polyline(routeSlice(n.pos, lit), {color: C.routeCase, weight: 11, opacity: .9, lineCap: "round", interactive: false}).addTo(layers.progress);
  L.polyline(routeSlice(n.pos, lit), {color: C.route, weight: 7, opacity: 1, lineCap: "round", interactive: false}).addTo(layers.progress);
  const endPt = n.route.geometry.at(-1);
  if (S.dest && haversineM(endPt.lat, endPt.lon, S.dest.lat, S.dest.lon) > 12)   // dernier bout à pied jusqu'à l'adresse
    L.polyline([[endPt.lat, endPt.lon], [S.dest.lat, S.dest.lon]], {color: C.route, weight: 4, dashArray: "2 9", lineCap: "round", interactive: false}).addTo(layers.progress);
  if ((n.phase === "approach" || n.away) && n.real) {                // pointillés jusqu'au point de départ / à l'itinéraire
    const t = posAt(n.gapAlong ?? 0);
    L.polyline([[n.real.lat, n.real.lon], [t.lat, t.lon]], {color: C.route, weight: 4, dashArray: "2 9", lineCap: "round", interactive: false}).addTo(layers.progress);
  }
}
let profileReturn = null;
function go(screen) {
  // Profil ouvert depuis la recherche ou les Paramètres : le retour y ramène
  if (screen === "profile" && ["route", "settings"].includes(S.screen)) profileReturn = S.screen;
  else if (screen !== "profile") profileReturn = null;
  if (screen === "profile" && !S.nav) S.tripMob = null;    // on règle son profil : les trajets repartent de « Mon profil »
  S.screen = screen; S.message = null; render();
}

// ---- Retour / avancer : gestes, boutons et bouton « retour » du navigateur ----------------------
// Nos gestes et boutons reviennent en arrière directement : l'appli ne peut jamais être quittée
// par erreur. L'historique ne garde qu'une étape « sentinelle » : le bouton retour d'Android ou
// le geste retour de Safari reviennent alors d'un écran dans l'appli au lieu de la fermer.
let guarded = false;
function syncGuard() {
  if (S.screen !== "welcome" && !guarded) {
    try { history.pushState({va: true}, ""); guarded = true; } catch { /* sans historique */ }
  }
}
window.addEventListener("popstate", () => { guarded = false; hideSwipe(); stepBack(); syncGuard(); });
function back() { stepBack(); }
let lastStep = 0;
function stepBack() {
  // le geste de Safari et le nôtre peuvent arriver ensemble : un seul retour à la fois
  if (Date.now() - lastStep < 450) return;
  lastStep = Date.now();
  if (indoor?.indoorOpen()) return indoor.closeIndoor();  // plan intérieur ouvert (drapeau activé) : le retour le ferme
  if (S.screen === "signup") { resetForm(); return go("login"); }
  if (S.screen === "login") { resetForm(); return go("welcome"); }
  if (S.screen === "welcome") return;
  if (S.hud) { S.hud = false; renderHud(); return; }
  if (S.screen === "nav") return minimizeGuidance();     // le guidage continue : on y revient par « Trajet en cours »
  if (S.screen === "route" && S.nav) return resumeGuidance();
  if (S.screen === "route" && S.searchFor === "origin") return cancelOrigin();
  if (S.screen === "route" && S.dest) return closeRoutes();
  if (S.screen === "route") return go("profile");
  if (S.screen === "settings") return go("route");
  if (S.screen === "zones") return go("settings");
  if (S.screen === "profile") {
    // retour = on garde les choix faits sur l'écran, puis on revient d'où l'on venait
    if (!profileReturn && !store.get("va-profile", null)) return toast("Choisissez votre profil, puis touchez « Continuer ».");
    saveProfile();
    const to = profileReturn || "route";
    go(to);
    if (to === "route") computeRoute();
  }
}
function forward() {
  if (S.screen === "welcome") { resetForm(); return go("login"); }
  if (S.screen === "login" || S.screen === "signup") return;
  if (S.screen === "profile") { saveProfile(); go("route"); computeRoute(); return; }
  if (S.screen === "route" && S.nav) return resumeGuidance();
  if (S.screen === "route" && S.routes[S.selected]?.accessible) return startGuidance();
  if (S.screen === "route") toast(S.routes.length ? "Cet itinéraire n'est pas praticable : choisissez-en un autre." : "Choisissez d'abord une destination.");
}
function closeRoutes() {
  Object.assign(S, {dest: null, destPlace: null, routes: [], query: "", places: [], message: null, arrival: null, tripMob: null});
  map.setView([S.origin.lat, S.origin.lon], 16, {animate: false});
  render();
}
// Portes indiquées par l'usager (« Indiquer l'entrée ») : gardées sur ce téléphone, par adresse
const DOORS_KEY = "va-doors";
const doorKey = p => norm2(p.label || "").replace(/\s+/g, " ").trim();
const savedDoor = p => store.get(DOORS_KEY, {})[doorKey(p)] || null;
function chooseDest(place) {
  sheetCollapsed = false;                                 // les itinéraires doivent se voir
  place = {...place, addrLat: place.addrLat ?? place.lat, addrLon: place.addrLon ?? place.lon};
  S.destPlace = place;                                    // lieu tel que choisi (pour changer de profil ou inverser)
  // 1) porte indiquée par l'usager pour cette adresse : prioritaire
  const door = !place.gps && savedDoor(place);
  // 2) « Jusqu'à la bonne porte » : entrée accessible du bâtiment, pour les profils qui en ont besoin
  //    (fauteuil, canne) ; les autres vont à l'entrée de l'adresse (js/arrival.js)
  const needsStepFree = ["manual_wheelchair", "electric_wheelchair", "cane_or_walker"].some(m => tripMobilities().has(m));
  const {entrance: ent, note} = net && !place.gps && !door ? entranceFor(net, place) : {entrance: null, note: ""};
  const viaEntrance = needsStepFree && ent && ent.d > 8;
  // incohérence entrée / adresse : notée seulement en mode test (sinon chaque bâtiment voisin en produirait une)
  S.arrival = net && !place.gps ? arrivalFiche(net, place, viaEntrance ? ent : null, S.detectDebug ? note : "") : null;
  S.dest = door ? {...place, lat: door.lat, lon: door.lon, userDoor: true}
    : viaEntrance ? {...place, lat: ent.lat, lon: ent.lon, viaEntrance: true} : place;
  // 3) adresse française : position « entrée » de la Base Adresse Nationale (certifiée par la commune), si elle
  //    diffère du point renvoyé par la recherche
  if (!door && !viaEntrance && place.banId && navigator.onLine) banEntrance(place);
  S.query = place.label; S.places = [];
  if (S.originMode === "auto") locateOrigin(true);       // départ « Ma position » (localisation demandée si besoin)
  else if (S.originMode === "gps") locateOrigin();       // départ GPS : il doit être récent (sinon on attend)
  computeRoute();
}
async function banEntrance(place) {
  try {
    const d = await fetch(`https://plateforme.adresse.data.gouv.fr/lookup/${encodeURIComponent(place.banId)}`).then(r => r.ok ? r.json() : null);
    const pos = (d?.positions || []).find(p => p.positionType === "entrée")?.position?.coordinates;
    if (!pos || S.dest?.banId !== place.banId || S.dest.userDoor) return;
    const [lon, lat] = pos;
    if (haversineM(lat, lon, S.dest.lat, S.dest.lon) < 5) { S.dest = {...S.dest, banEntrance: true}; return render(); }
    S.dest = {...S.dest, lat, lon, banEntrance: true};
    computeRoute();
  } catch { /* hors ligne : on garde le point de la recherche */ }
}
// « La porte n'est pas là ? » : l'usager touche la carte à l'endroit de la porte ; elle est gardée sur ce
// téléphone pour cette adresse et l'itinéraire est recalculé jusqu'à elle
let pickingDoor = false;
function pickDoor() {
  if (!S.dest || pickingDoor) return;
  setHeadingMode(false);                                  // (le toucher sur la carte doit tomber au bon endroit)
  pickingDoor = true;
  document.body.classList.add("picking-door");
  toast("Touchez la carte à l'endroit exact de la porte d'entrée.", 6000);
  map.once("click", e => {
    pickingDoor = false;
    document.body.classList.remove("picking-door");
    const doors = store.get(DOORS_KEY, {});
    doors[doorKey(S.dest)] = {lat: e.latlng.lat, lon: e.latlng.lng};
    store.set(DOORS_KEY, doors);
    S.dest = {...S.dest, lat: e.latlng.lat, lon: e.latlng.lng, userDoor: true, viaEntrance: false, banEntrance: false};
    toast("Entrée enregistrée : l'itinéraire vous y mène, et vous y mènera la prochaine fois.");
    computeRoute();
  });
}
function resetDoor() {
  const doors = store.get(DOORS_KEY, {});
  delete doors[doorKey(S.dest)];
  store.set(DOORS_KEY, doors);
  chooseDest({label: S.dest.label, lat: S.dest.addrLat, lon: S.dest.addrLon, type: S.dest.type, banId: S.dest.banId, addrLat: S.dest.addrLat, addrLon: S.dest.addrLon});
}
function doorCard() {
  if (!S.dest || S.dest.gps) return "";
  const where = S.dest.userDoor ? "Entrée indiquée par vous" : S.dest.viaEntrance ? "Entrée accessible du bâtiment"
    : S.dest.banEntrance ? "Entrée officielle de l'adresse" : "Point de l'adresse";
  return `<div class="door-card">${icon("door-open")}<span class="grow"><b>${where}</b><small>${S.dest.userDoor ? "gardée sur ce téléphone" : "la porte n'est pas là ?"}</small></span>
    ${S.dest.userDoor ? `<button class="btn soft small" id="resetDoor">Réinitialiser</button>` : ""}
    <button class="btn soft small" id="pickDoor">${icon("map-pin")} ${S.dest.userDoor ? "Déplacer" : "Indiquer l'entrée"}</button></div>`;
}
// Guidage vers un repère de la carte (entrée accessible, ERP, toilettes, ascenseur…), comme pour les arrêts
function guideToPoint(label, lat, lon) {
  const from = whereAmI(), dest = {label, lat, lon, type: "poi", addrLat: lat, addrLon: lon};
  map.closePopup();
  if (S.nav) { S.dest = dest; return reroute({lat: from.lat, lon: from.lon}, `Vers ${label}`, true); }   // (même réduit)
  if (S.screen !== "route") go("route");
  chooseDest(dest);
}
const guidePopup = (title, body, d) => `<div class="pp"><div class="pp-title">${esc(title)}</div>${body}
  <div class="pp-src">${d !== null ? short(d) : ""}</div><button class="pp-guide" type="button">${icon("navigation")} M'y guider</button></div>`;
function chooseOrigin(place) {
  S.searchFor = "dest"; S.oquery = ""; S.places = [];
  if (place.type === "gps") { S.originMode = "gps"; locateOrigin(); return S.dest ? computeRoute() : render(); }
  S.origin = {lat: place.lat, lon: place.lon, label: place.label}; S.originMode = "manual";
  S.dest ? computeRoute() : render();
}
function cancelOrigin() { S.searchFor = "dest"; S.oquery = ""; S.places = []; render(); }
// Inverser départ et arrivée (comme Citymapper). « Ma position » devient l'arrivée : l'endroit où vous êtes
// maintenant. L'arrivée devient le départ, à sa porte (on ressort par là). Un deuxième appui revient au trajet
// d'origine : le lieu de départ garde sa fiche (place), pour retrouver son entrée.
const canSwap = () => !!S.dest && !S.origin.none && S.searchFor !== "origin" && !S.nav;
function swapTrip() {
  if (!canSwap()) return;
  if (originPending()) return toast("Votre position est en cours de recherche : patientez un instant.");
  const from = S.origin, door = S.dest, place = S.destPlace || S.dest;
  const fresh = liveFix && Date.now() - liveFix.at <= ORIGIN_RULES.staleMs ? liveFix : null;
  if (door.gps) {                                         // « Ma position » repart en tête : départ GPS vivant
    const at = fresh || door;
    S.origin = {lat: at.lat, lon: at.lon, acc: fresh?.acc ?? 30, confirmedAt: Date.now(), label: "Ma position", gps: true};
    S.originMode = "gps";
  } else {
    S.origin = {lat: door.lat, lon: door.lon, label: door.label, place};
    S.originMode = "manual";
  }
  const to = from.gps ? {label: "Ma position", lat: (fresh || from).lat, lon: (fresh || from).lon, type: "gps", gps: true}
    : from.place || {label: from.label, lat: from.lat, lon: from.lon, type: "poi"};
  chooseDest(to);                                         // (le profil choisi pour ce trajet est gardé)
  toast("Départ et arrivée inversés.");
}
// Profil du trajet, sous les itinéraires : « Mon profil » ou un autre, le temps de cette recherche
function tripMobChips() {
  const saved = primary(), single = S.mobilities.size <= 1;
  const opts = [["", "Mon profil", MOB.find(m => m[0] === saved)?.[2] || "user-round"], ...TRIP_MOBS.filter(([m]) => !(single && m === saved))];
  return `<div class="mob-chips" role="radiogroup" aria-label="Itinéraires calculés pour">${opts.map(([m, l, ic]) => {
    const on = (S.tripMob || "") === m;
    return `<button class="mchip ${on ? "on" : ""}" role="radio" aria-checked="${on}" data-trip-mob="${m}">${icon(ic)}<span>${l}</span></button>`;
  }).join("")}</div>`;
}
function setTripMob(m) {
  if ((S.tripMob || null) === (m || null)) return;
  S.tripMob = m || null;
  // l'entrée visée dépend du profil (entrée accessible pour un fauteuil) : la destination est choisie à nouveau
  if (S.destPlace && !S.dest?.userDoor && !S.dest?.gps) chooseDest(S.destPlace);
  else computeRoute();
}
function startGuidance() {
  unlockVoice();                                          // dans le geste de l'usager (obligatoire sur iPhone)
  // départ « Ma position » : si vous avez bougé depuis le calcul, le trajet repart d'où vous êtes
  if (S.origin.gps && liveFix && Date.now() - liveFix.at <= ORIGIN_RULES.maxAgeMs && liveFix.acc <= ORIGIN_RULES.acceptAccM
      && distM(S.origin, liveFix) > 10) {
    const label = S.routes[S.selected]?.label;
    S.origin = {lat: liveFix.lat, lon: liveFix.lon, acc: liveFix.acc, confirmedAt: Date.now(), label: "Ma position", gps: true};
    try {
      const routes = routeChoices(S.origin);
      if (routes.length) { S.routes = routes; S.selected = Math.max(0, routes.findIndex(r => r.label === label)); }
    } catch (e) { if (!(e instanceof RoutingError)) throw e; }
    if (!S.routes[S.selected]?.accessible) return render();
  }
  setHeadingMode(false); follow = false;                  // la carte part dans la vue de guidage, nord en haut
  liveArrived = false;
  hazardAlerted.clear();                                  // nouveau trajet : tous les obstacles seront annoncés
  startNav(S.routes[S.selected]);
  prepareOffline(S.routes[S.selected], true);           // carte du trajet gardée : le guidage tient sans réseau
  stickerPop("je-te-guide");
  if (S.simulate) {                                       // démonstration : positions simulées le long du trajet
    S.nav.simulated = true;
    say("Démonstration : le trajet défile tout seul, comme si vous marchiez.", true);
    go("nav");
    startSimulation();
  } else {
    say("Guidage lancé. Recherche de votre position.", true);
    startGps();
    go("nav");
  }
  map.setView([S.nav.here.lat, S.nav.here.lon], 17, {animate: false});
}
// Confirmation avant de quitter un guidage par un geste (on ne l'arrête jamais par mégarde)
// Localisation refusée : une page web n'a PAS le droit d'ouvrir les Réglages de l'iPhone (Apple le bloque hors
// des applis natives). On affiche donc le chemin exact, adapté au téléphone et à la façon dont l'appli est ouverte,
// puis « Réessayer » redemande la position.
function locationHelp() {
  if (document.querySelector(".confirm")) return;
  const ua = navigator.userAgent, ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const home = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches, android = /android/i.test(ua);
  const iosSettings = ["Ouvrez l'appli <b>Réglages</b> de l'iPhone", "<b>Confidentialité et sécurité</b> → <b>Service de localisation</b> : activé",
    "Descendez jusqu'à <b>Sites web Safari</b>", "Choisissez <b>Lorsque l'app est active</b> et activez <b>Position exacte</b>"];
  const steps = ios && !home ? ["Dans Safari, touchez <b>aA</b> (ou l'icône à gauche de l'adresse)", "<b>Réglages du site web</b> → <b>Position</b> → <b>Autoriser</b>",
      "Si « Position » n'apparaît pas : faites les réglages ci-dessous"] .concat(iosSettings)
    : ios ? iosSettings
    : android ? ["Touchez le <b>cadenas</b> (ou ⓘ) à gauche de l'adresse, en haut", "<b>Autorisations</b> → <b>Position</b> → <b>Autoriser</b>",
      "Vérifiez aussi : Paramètres du téléphone → <b>Localisation</b> activée"]
    : ["Ouvrez les <b>réglages du site</b> (icône à gauche de l'adresse)", "<b>Position</b> → <b>Autoriser</b>"];
  const el = document.createElement("div");
  el.className = "confirm";
  el.innerHTML = `<div class="confirm-box loc-help" role="alertdialog" aria-modal="true" aria-labelledby="lh">
    <h3 id="lh">${icon("map-pin")} Autoriser la localisation</h3>
    <p class="fine">Vision AR a besoin de votre position pour vous guider. Elle reste sur votre téléphone.</p>
    <ol>${steps.map(t => `<li>${t}</li>`).join("")}</ol>
    <div class="actions"><button class="btn soft" data-c="close">Fermer</button><button class="btn dark" data-c="retry">${icon("locate-fixed")} Réessayer</button></div></div>`;
  el.onclick = e => {
    const c = e.target.closest("[data-c]")?.dataset.c;
    if (!c && e.target !== el) return;
    el.remove();
    if (c !== "retry") return;
    if (S.nav) { S.nav.gpsDenied = false; S.nav.gpsProblem = null; startGps(); renderNavLive(); }
    else { geoPermission = "unknown"; S.originMode = "gps"; locateOrigin(); if (S.dest) computeRoute(); }   // réglage peut-être changé
  };
  document.body.append(el);
  el.querySelector("[data-c=retry]").focus();
}
function confirmQuit() {
  if (document.querySelector(".confirm")) return;          // une seule confirmation à la fois
  const el = document.createElement("div");
  el.className = "confirm";
  el.innerHTML = `<div class="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="cq">
    <h3 id="cq">${icon("navigation")} Quitter le guidage&nbsp;?</h3>
    <div class="actions"><button class="btn soft" data-c="stay">Continuer</button><button class="btn dark" data-c="quit">${icon("x")} Quitter</button></div></div>`;
  el.onclick = e => {
    const c = e.target.closest("[data-c]")?.dataset.c;
    if (!c && e.target !== el) return;
    el.remove();
    if (c === "quit") navApi.stop();
  };
  document.body.append(el);
  el.querySelector("[data-c=stay]").focus();
}

const SWIPE_EDGE = 30, SWIPE_MIN = 90;
let swipe = null;
const swipeHint = document.createElement("div");
swipeHint.className = "swipe-hint";
swipeHint.hidden = true;
document.body.append(swipeHint);
document.addEventListener("touchstart", e => {
  if (e.touches.length !== 1 || S.hud || document.querySelector(".confirm")) return;
  const t = e.touches[0], x = t.clientX;
  const edge = x < SWIPE_EDGE ? "left" : x > innerWidth - SWIPE_EDGE ? "right" : null;
  const onPanel = !!e.target.closest("#panel") && !e.target.closest("input, .seg, .tile, .switch, .mob-chips");
  if ((!edge && !onPanel) || e.target.closest("#ar .sheet")) return;
  swipe = {x, y: t.clientY, edge, dx: 0, on: false};
}, {passive: true});
document.addEventListener("touchmove", e => {
  if (!swipe) return;
  const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (!swipe.on) {
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }     // c'est un défilement
    if (Math.abs(dx) < 14) return;
    if ((swipe.edge === "left" && dx < 0) || (swipe.edge === "right" && dx > 0)) { swipe = null; return; }
    swipe.on = true;
  }
  swipe.dx = dx;
  if (e.cancelable) e.preventDefault();                 // le geste est à nous : ni défilement ni retour du navigateur
  const backDir = dx > 0, progress = Math.min(1, Math.abs(dx) / SWIPE_MIN);
  swipeHint.hidden = false;
  swipeHint.className = `swipe-hint ${backDir ? "left" : "right"} ${progress >= 1 ? "ready" : ""}`;
  swipeHint.style.setProperty("--p", progress.toFixed(2));
  swipeHint.innerHTML = `${icon(backDir ? "arrow-left" : "arrow-right")}<span>${backDir ? "Retour" : S.screen === "route" ? "Démarrer" : "Suivant"}</span>`;
}, {passive: false});
document.addEventListener("touchend", () => {
  const done = swipe?.on && Math.abs(swipe.dx) >= SWIPE_MIN, dir = swipe?.dx;
  hideSwipe();
  if (done) {
    if (navigator.vibrate) navigator.vibrate(15);
    dir > 0 ? back() : forward();
  }
});
// Safari peut reprendre le geste à son compte (retour du navigateur) sans prévenir : l'indice ne reste jamais affiché
function hideSwipe() { swipe = null; swipeHint.hidden = true; }
document.addEventListener("touchcancel", hideSwipe);
addEventListener("pageshow", hideSwipe);
addEventListener("blur", hideSwipe);
document.addEventListener("visibilitychange", hideSwipe);
function saveProfile() { store.set("va-profile", {mobilities: [...S.mobilities], maxSlope: S.maxSlope, steps: S.steps}); }

function bind() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e[ev] = fn; };
  const all = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  on("logout", "onclick", () => { logout(); resetForm(); Object.assign(S, {dest: null, routes: [], query: ""}); go("welcome"); });
  all("[data-mob]", b => b.onclick = () => { const m = b.dataset.mob; S.mobilities.has(m) ? S.mobilities.delete(m) : S.mobilities.add(m); render(); });
  all("[data-theme-pick]", b => b.onclick = () => { setTheme(b.dataset.themePick); render(); });
  on("slope", "oninput", e => { S.maxSlope = +e.target.value; $("slopeLbl").textContent = `${S.maxSlope} %`; });
  on("steps", "onchange", e => { S.steps = e.target.checked; });
  on("voice", "onchange", e => { S.voice = e.target.checked; store.set("va-voice", S.voice); });
  on("cont", "onclick", forward);
  on("install", "onclick", async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); });
  on("toProfile", "onclick", () => go("profile"));
  on("profileBack", "onclick", back);
  on("editOrigin", "onclick", () => { S.searchFor = "origin"; S.oquery = ""; S.places = []; render(); $("qo")?.focus(); });
  on("qo", "oninput", e => { S.oquery = e.target.value; search(S.oquery); });
  on("qoCancel", "onmousedown", e => e.preventDefault());
  on("qoCancel", "onclick", cancelOrigin);
  on("q", "oninput", e => { S.query = e.target.value; $("qClear").hidden = !S.query; search(S.query); });
  // la croix efface tout d'un coup ; mousedown empêché : le champ garde le clavier ouvert
  on("qClear", "onmousedown", e => e.preventDefault());
  on("qClear", "onclick", () => { const q = $("q"); q.value = ""; S.query = ""; $("qClear").hidden = true; search(""); q.focus(); });
  on("q", "onfocus", () => { setHeadingMode(false); document.body.classList.add("typing"); if (sheetCollapsed) setSheet(false); else layoutSheet(); });
  // (petit délai : un toucher sur une suggestion doit arriver avant que le panneau reprenne sa hauteur normale)
  on("q", "onblur", () => setTimeout(() => { if (document.activeElement?.id !== "q") { document.body.classList.remove("typing"); layoutSheet(); } }, 300));
  on("sheetHandle", "onkeydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(!sheetCollapsed); } });
  bindPlaces(document);
  on("favToggle", "onclick", toggleFavorite);
  on("arrSpeak", "onclick", () => say(arrivalSpeech(S.arrival), true));
  all("[data-route]", c => c.onclick = () => { S.selected = +c.dataset.route; render(); });
  on("swapTrip", "onclick", swapTrip);
  all("[data-trip-mob]", b => b.onclick = () => setTripMob(b.dataset.tripMob));
  on("pickDoor", "onclick", pickDoor);
  on("tourGo", "onclick", () => chooseDest({label: "Picard (surgelés), Allées Maria Casarès", lat: 48.925767, lon: 2.295317, type: "poi"}));
  on("resetDoor", "onclick", resetDoor);
  all("[data-indoor]", b => b.onclick = () => openBuilding(b.dataset.indoor));
  on("start", "onclick", startGuidance);
  on("resumeNav", "onclick", resumeGuidance);
  on("stopLive", "onclick", confirmQuit);
  on("endLive", "onclick", endGuidanceSoftly);
  // Paramètres
  on("settingsBack", "onclick", () => go("route"));
  on("setProfile", "onclick", () => go("profile"));
  on("setVoice", "onchange", e => { S.voice = e.target.checked; store.set("va-voice", S.voice); });
  on("setHaptics", "onchange", e => { navApi.setHaptics(e.target.checked); render(); });
  on("setAlertDist", "oninput", e => { S.alertDist = +e.target.value; store.set("va-alert-dist", S.alertDist); $("alertDistLbl").textContent = `${S.alertDist} m`; });
  on("setPlacesRange", "oninput", e => { S.placesRange = +e.target.value; store.set("va-places-range", S.placesRange); $("placesRangeLbl").textContent = `${S.placesRange} m`; });
  on("setEco", "onchange", e => { S.eco = e.target.checked; store.set("va-eco", S.eco); });
  on("setAudioOnly", "onchange", e => { S.audioOnly = e.target.checked; store.set("va-audio-only", S.audioOnly); });
  on("setSimulate", "onchange", e => { S.simulate = e.target.checked; store.set("va-simulate", S.simulate); });
  on("setZone", "onclick", () => go("zones"));
  on("zonesBack", "onclick", () => go("settings"));
  all("[data-zone]", b => b.onclick = () => {
    if (b.dataset.zone === ZONE_ID) return go("settings");
    store.set("va-zone", b.dataset.zone);
    location.reload();                                     // tout l'état dépend de la zone : on repart proprement
  });
  all("[data-basemap]", b => b.onclick = () => { setBasemap(b.dataset.basemap); render(); });
  all("[data-logo]", b => b.onclick = () => { setLogo(b.dataset.logo); render(); toast(`Logo « ${LOGOS[S.logo]} » choisi pour l'écran d'accueil.`); });
  on("setStopsVoice", "onchange", e => { S.stopsVoice = e.target.checked; store.set("va-stops-voice", S.stopsVoice); });
  on("setDetect", "onchange", e => navApi.setOption("detect", e.target.checked));
  on("setDetectDebug", "onchange", e => navApi.setOption("detectDebug", e.target.checked));
  on("setConsent", "onchange", e => { navApi.setOption("dataConsent", e.target.checked); if (!e.target.checked) navApi.setOption("autoLowConf", false); render(); });
  on("setAutoLow", "onchange", e => navApi.setOption("autoLowConf", e.target.checked));
  if ($("sampleCount")) listSamples().then(list => {
    const mb = list.reduce((t, x) => t + (x.blob?.size || 0), 0) / 1e6;
    if ($("sampleCount")) $("sampleCount").textContent = `${list.length} (${mb.toFixed(1).replace(".", ",")} Mo)`;
  }).catch(() => { if ($("sampleCount")) $("sampleCount").textContent = "—"; });
  on("exportSamples", "onclick", async () => {
    const list = await listSamples();
    if (!list.length) return toast("Aucune image collectée pour l'instant.");
    const blob = await exportZip(), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `vision-ar-obstacles-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  on("clearSamples", "onclick", async () => {
    if (!confirm("Effacer toutes les images collectées sur ce téléphone ?")) return;
    await clearSamples(); toast("Images effacées."); render();
  });
  on("testHaptics", "onclick", () => {
    const was = S.haptics; S.haptics = true; buzz("left"); S.haptics = was;
    toast(window.VisionARNative || navigator.vibrate ? "2 impulsions : « tournez à gauche »." :
      IOS ? "Sur iPhone, Safari ne donne pas accès au vibreur : si rien ne vibre, c'est cette limite. La voix reste disponible." :
      "Ce navigateur ne permet pas les vibrations.", 6000);
  });
  on("setInstall", "onclick", async () => {
    if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; return render(); }
    toast(IOS ? "Bouton Partager de Safari, puis « Sur l'écran d'accueil »." : "Menu ⋮ du navigateur, puis « Ajouter à l'écran d'accueil ».", 6000);
  });
  on("setShare", "onclick", async () => {
    const url = "https://hermes-bit.github.io/vision-ar-demo/";
    try {
      if (navigator.share) await navigator.share({title: "Vision AR", text: "Guidage piéton accessible — Geomessen", url});
      else { await navigator.clipboard.writeText(url); toast("Lien copié."); }
    } catch { /* partage annulé */ }
  });
  on("setLogout", "onclick", () => { logout(); resetForm(); Object.assign(S, {dest: null, routes: [], query: ""}); go("welcome"); });
  all("[data-unreport]", b => b.onclick = () => removeReport(+b.dataset.unreport));
}

// Vue lunettes : toucher pour fermer, appui long pour le contraste élevé
let pressTimer = null;
$("hud").addEventListener("pointerdown", () => { pressTimer = setTimeout(() => { pressTimer = null; S.hc = !S.hc; renderHud(); }, 600); });
$("hud").addEventListener("pointerup", () => { if (pressTimer) { clearTimeout(pressTimer); S.hud = false; renderHud(); } });

window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (S.screen === "profile") render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.nav) requestWakeLock(); });
if ("serviceWorker" in navigator) {
  // Une nouvelle version prend la main : on recharge une fois pour l'afficher (sauf pendant un guidage)
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !S.nav && !sessionStorage.getItem("va-reloaded")) { sessionStorage.setItem("va-reloaded", "1"); location.reload(); }
  });
  navigator.serviceWorker.register("sw.js", {updateViaCache: "none"}).then(r => r.update()).catch(() => {});
}

// ---- Démarrage ------------------------------------------------------------------------------
// Écran de chargement (index.html) : retiré une fois le plan prêt, après 1,2 s au moins pour voir l'animation
const loaderStart = performance.now();
function hideLoader() {
  const l = $("loader");
  if (!l) return;
  setTimeout(() => { l.classList.add("done"); appIntro(); setTimeout(() => l.remove(), 500); }, Math.max(0, 1200 - (performance.now() - loaderStart)));
}
// Ouverture de l'appli, pendant que l'écran de chargement s'efface : la carte se pose (léger zoom arrière), le
// panneau monte du bas jusqu'à sa place, puis son contenu apparaît élément par élément. Rien si le téléphone
// demande de réduire les animations. (Le panneau garde sa position habituelle : l'animation part de sous
// l'écran et revient exactement à son décalage --sheet-y.)
function appIntro() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const easing = "cubic-bezier(.22, 1, .36, 1)", panel = $("panel");
  if (getComputedStyle($("map")).visibility !== "hidden")
    $("map").animate([{opacity: 0.2, transform: "scale(1.08)"}, {opacity: 1, transform: "scale(1)"}], {duration: 1100, easing});
  const sheetY = parseFloat(panel.style.getPropertyValue("--sheet-y")) || 0;
  panel.animate([{transform: "translateY(100%)"}, {transform: `translateY(${sheetY}px)`}], {duration: 750, easing});
  [...panel.children].slice(0, 8).forEach((el, i) => el.animate(
    [{opacity: 0, transform: "translateY(16px)"}, {opacity: 1, transform: "none"}],
    {duration: 520, delay: 220 + i * 80, easing, fill: "backwards"}));
  for (const b of [$("mapSettings"), $("mapClose")]) b?.animate([{opacity: 0, transform: "scale(.6)"}, {opacity: 1, transform: "none"}],
    {duration: 450, delay: 500, easing, fill: "backwards"});
}
fetch(ZONE.data).then(r => r.json()).then(data => {
  net = loadNetwork(data);
  setTimeout(autoOrigin, 0);
  streetOf = makeStreetFinder(net);
  fetch(ZONE.transit).then(r => r.json()).then(d => { transit = loadTransit(d); refreshTransit(true); }).catch(() => {});
  drawNetwork();
  render();
  if (S.screen === "route") computeRoute();
  hideLoader();
}).catch(err => {
  hideLoader();
  $("panel").innerHTML = `<h2>Vision AR</h2><div class="msg">Impossible de charger le plan : ${esc(err.message)}</div>`;
});

// Accès pour les tests automatiques uniquement (adresse terminée par ?debug)
if (new URLSearchParams(location.search).has("debug"))
  window.__va = {S, posAt, navState, moveTo, chooseDest, get net() { return net; }, get transit() { return transit; }, addReport, reports, navApi,
    useFavorite, stopGuidance, minimize: () => minimizeGuidance(), resume: () => resumeGuidance(), recenter: () => recenter(),
    heading: on => setHeadingMode(on), get follow() { return follow; }, get headingMode() { return headingMode; },
    get liveFix() { return liveFix; }, get geoPermission() { return geoPermission; },
    resetOrigin() { stopHereWatch(); liveFix = null; wantOrigin = false; originState = {searchSince: null, best: null, lastUseAt: null};
      S.origin = PRESENTATION ? {...MAIRIE} : NO_ORIGIN(); S.originMode = PRESENTATION ? "manual" : "gps"; S.originNeedsFix = false;
      originLost = false; autoOriginDone = false; S.dest = null; S.routes = []; render(); }};
