// Vision AR — démo web mobile (installable sur l'écran d'accueil).
// Écrans repris de l'appli Android (phone/ui/Screens.kt) ; itinéraires calculés
// sur le téléphone par js/routing.js, copie fidèle du moteur du serveur.
import {arOpen, closeAR, currentHeading, openAR} from "./ar.js";
import {MODE, linesText, loadTransit, makeStreetFinder, searchPlaces, stopTarget, wheelText} from "./transit.js";
import {clearSamples, exportZip, listSamples} from "./obstacles.js";
import {ZONES, zoneLabel} from "./zones.js";
import {bindAuth, currentSession, logout, resetForm, screenLogin, screenSignup, screenWelcome} from "./auth.js";
import {icon} from "./icons.js";
import {sticker, stickerPop} from "./stickers.js";
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
const ZONE_ID = (() => { try { const z = JSON.parse(localStorage.getItem("va-zone")); return ZONES[z] ? z : "gennevilliers"; } catch { return "gennevilliers"; } })();
const ZONE = ZONES[ZONE_ID];
const MAIRIE = ZONE.start;                                   // point de départ par défaut de la zone
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
  voice: store.get("va-voice", true), haptics: store.get("va-haptics", true), stopsVoice: store.get("va-stops-voice", false), detect: store.get("va-detect", false), detectDebug: store.get("va-detect-debug", false),
  dataConsent: store.get("va-data-consent", false), autoLowConf: store.get("va-auto-lowconf", false), origin: {...MAIRIE}, dest: null, pick: "dest", query: "", places: [],
  routes: [], selected: 0, message: null, loading: false, nav: null, blocking: true, hud: false, hc: false,
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
function profileJson() {
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
}

// ---- Voix et vibrations ---------------------------------------------------------------
function say(text, urgent = false) {
  if (window.VisionARNative) { if (S.voice) window.VisionARNative.speak(text, urgent); return; }   // appli Android : voix du téléphone
  if (S.voice && "speechSynthesis" in window) {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    speechSynthesis.speak(u);
  }
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
          url: IGN_WMTS("ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg"), maxZoom: 19, attribution: "Photos © IGN · réseau © OpenStreetMap"},
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
  store.set("va-basemap", S.basemap);
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
  // l'iPhone et Android lisent ces liens au moment d'ajouter l'appli à l'écran d'accueil
  document.querySelector('link[rel="manifest"]').href = (S.logo === "vert" ? "manifest.webmanifest" : `manifest-${S.logo}.webmanifest`) + "?v=3";
  document.querySelectorAll('link[rel="apple-touch-icon"], link[rel="icon"]').forEach(l => {
    l.href = logoDir() + l.getAttribute("href").split("/").pop();
  });
}
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
setBasemap(store.get("va-basemap", "osm"));
const layers = {progress: L.layerGroup().addTo(map), transit: L.layerGroup().addTo(map), pois: L.layerGroup(), reports: L.layerGroup().addTo(map),
  routes: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map)};

const pin = (ic, cls) => L.divIcon({className: "", html: `<div class="pin ${cls}">${icon(ic)}</div>`,
  iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36]});
function drawNetwork() {
  // Le réseau piéton et ses pentes servent au calcul des itinéraires (base de données) : ils ne sont plus dessinés
  for (const [kind, lat, lon, name, status] of net.pois) {
    if (!POI[kind]) continue;
    L.marker([lat, lon], {icon: pin(POI[kind][0], "pin-poi"), title: POI[kind][1]})
      .bindPopup(`<div class="pp"><div class="pp-title">${POI[kind][1]}</div>${name ? esc(name) : ""}${
        kind === "elevator" ? `<div class="pp-src">État : ${{ok: "en service", out_of_order: "en panne"}[status] || "inconnu"}</div>` : ""}</div>`)
      .addTo(layers.pois);
  }
  L.geoJSON(net.zone.boundary, {style: {color: C.primary, weight: 2, fill: false, dashArray: "6 8", opacity: .7}, interactive: false}).addTo(map);
  syncLayers = () => {
    const show = map.getZoom() >= 16 && S.screen !== "nav";
    show ? layers.pois.addTo(map) : layers.pois.remove();
    document.body.classList.toggle("zoomed-out", !show);
  };
  map.on("zoomend", syncLayers);
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
const chipInk = hex => {                                   // texte lisible sur la couleur de la ligne
  const c = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!c) return "#fff";
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#0F2537" : "#fff";
};
const whereAmI = () => {
  const n = S.nav;
  if (n) return n.real && Date.now() - n.real.at < 15000 ? n.real : n.here;
  return S.origin;
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
  if (S.screen === "nav" && S.nav) {                       // en cours de guidage : nouvel itinéraire vers l'arrêt
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
    const b = map.getBounds(), c = map.getCenter();
    list = transit.filter(st => b.contains([st.lat, st.lon])).map(st => [st, haversineM(c.lat, c.lng, st.lat, st.lon)]);
    list.sort((a, b2) => a[1] - b2[1]); list = list.slice(0, 30);
  }
  for (const [st] of list)
    L.marker([st.lat, st.lon], {icon: transitIcon(st.mode), title: `${(MODE[st.mode] || MODE.bus).label} ${st.name}`, keyboard: true})
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
  drawRealPosition();
  layers.routes.clearLayers();
  layers.marks.clearLayers();
  const sel = S.nav?.route || S.routes[S.selected];
  const nav = S.screen === "nav";
  layers.progress.clearLayers();
  if (nav && S.nav) { progressAt = 0; drawProgress(true); }
  for (const r of S.routes) if (r !== sel && !nav) {
    const ll = r.geometry.map(p => [p.lat, p.lon]);
    L.polyline(ll, nav ? {color: "#E8457C", weight: 5, opacity: .9, lineCap: "round"}
                       : {color: C.alt, weight: 5, opacity: .85, dashArray: "1 9", lineCap: "round"}).addTo(layers.routes);
    if (nav && sel) {
      const diff = Math.round((r.duration_s - sel.duration_s) / 60);
      const label = `${diff >= 0 ? "+" : "−"} ${Math.abs(diff)} min${r.accessible ? "" : " · non accessible"}`;
      L.marker(ll[Math.floor(ll.length / 2)], {icon: L.divIcon({className: "", html: `<div class="alt-tag">${label}</div>`, iconSize: null}),
        interactive: false}).addTo(layers.routes);
    }
  }
  if (sel && !nav) {
    const ll = sel.geometry.map(p => [p.lat, p.lon]);
    L.polyline(ll, {color: C.routeCase, weight: nav ? 10 : 11, opacity: nav ? .35 : .9, lineCap: "round", lineJoin: "round"}).addTo(layers.routes);
    if (nav) gradientLine(ll).forEach(l => l.addTo(layers.routes));
    else L.polyline(ll, {color: C.route, weight: 6, opacity: 1, lineCap: "round", lineJoin: "round"}).addTo(layers.routes);
  }
  if (!S.nav) L.marker([S.origin.lat, S.origin.lon], {icon: L.divIcon({className: "", html: '<div class="start-dot"></div>', iconSize: [24, 24]}),
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
map.on("click", e => {
  if (S.screen !== "route") return;
  const p = {lat: e.latlng.lat, lon: e.latlng.lng, label: "Point choisi sur le plan"};
  if (S.pick === "origin") { S.origin = p; computeRoute(); }
  else chooseDest(p);
});

// ---- Itinéraire ---------------------------------------------------------------------------
function computeRoute() {
  S.routes = []; S.message = null;
  if (S.dest) {
    try {
      S.routes = computeRoutes(net, {origin: S.origin, destination: S.dest, profile: profileJson(), compare_shortest: true}, reports()).routes;
      S.selected = 0;
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      S.message = e.message;
    }
  }
  render();
  if (S.routes.length) requestAnimationFrame(fitRoute);
}
// L'itinéraire est cadré dans la partie du plan que le panneau ne couvre pas (après son affichage)
function fitRoute() {
  const r = S.routes[S.selected] || S.routes[0];
  if (!r || S.screen !== "route") return;
  const panelTop = $("panel").getBoundingClientRect().top;
  const under = !sideLayout() && panelTop > 0 && panelTop < innerHeight ? innerHeight - panelTop : 0;
  map.fitBounds(L.latLngBounds(r.geometry.map(p => [p.lat, p.lon])), {paddingTopLeft: [24, 84], paddingBottomRight: [24, under + 24]});
}
// Au premier affichage de la recherche : si la localisation est déjà autorisée et qu'on est à Gennevilliers,
// le départ est « Ma position » au lieu de la Mairie (aucune demande d'autorisation surprise)
let autoOriginDone = false;
async function autoOrigin() {
  if (autoOriginDone || !net || !navigator.geolocation || S.origin.label !== MAIRIE.label) return;
  autoOriginDone = true;
  try {
    const perm = await navigator.permissions?.query({name: "geolocation"});
    if (perm?.state !== "granted") return;
  } catch { return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const p = {lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position"};
    try { nearestNode(net, p.lat, p.lon); } catch { return; }          // hors zone : on garde la Mairie
    if (S.origin.label !== MAIRIE.label) return;                      // l'usager a déjà choisi entre-temps
    S.origin = p;
    if (S.screen === "route") { render(); if (S.dest) computeRoute(); }
  }, () => {}, {enableHighAccuracy: true, timeout: 10000, maximumAge: 30000});
}
function useMyPosition() {
  if (!navigator.geolocation) return toast("La localisation n'est pas disponible sur cet appareil.");
  toast("Recherche de votre position…");
  navigator.geolocation.getCurrentPosition(pos => {
    const p = {lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position"};
    try {
      nearestNode(net, p.lat, p.lon);
    } catch {
      return toast(`Vous êtes hors de la zone couverte (${zoneLabel(ZONE)}) : le départ reste fixé sur le plan. ` +
                   "Le guidage ne fonctionne que sur place. Changez de ville dans les Paramètres si besoin.", 6000);
    }
    S.origin = p;
    map.setView([p.lat, p.lon], 17);
    computeRoute();
  }, () => toast("Position refusée ou indisponible."), {enableHighAccuracy: true, timeout: 15000});
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
      if (S.query !== q) return;                            // la saisie a changé entre-temps
      const addr = (data.features || []).map(f => {
        const p = f.properties, [lon, lat] = f.geometry.coordinates;
        const type = ZONE.france ? p._type : (p.name && p.osm_key !== "highway" && p.osm_key !== "place" ? "poi" : "address");
        const label = ZONE.france ? p.label || [p.toponym, (p.city || [])[0]].filter(Boolean).join(", ")
          : [p.name || [p.housenumber, p.street].filter(Boolean).join(" "), p.district || p.city].filter(Boolean).join(", ");
        return {label, lat, lon, type, sub: `${type === "poi" ? "Lieu" : "Adresse"} · ${short(haversineM(S.origin.lat, S.origin.lon, lat, lon))}`};
      }).filter(a => a.label).filter(a => haversineM(S.origin.lat, S.origin.lon, a.lat, a.lon) < 15000);   // pas de « Calmels-et-le-Viala » à 550 km
      S.places = [...local, ...addr].filter((p, i, all) => all.findIndex(o => norm2(o.label) === norm2(p.label) && haversineM(o.lat, o.lon, p.lat, p.lon) < 150) === i).slice(0, 10);
    } catch {
      if (!local.length) toast("Recherche d'adresse impossible (hors ligne ?) : touchez le plan pour choisir l'arrivée.");
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
           phase: "approach", approachDist: 0, quietStart: keepGps};
  requestWakeLock();
}
// Le trajet commence : on est au point de départ (ou sur le tout début de l'itinéraire)
function beginRoute(along) {
  const n = S.nav, first = n.route.steps[0];
  n.phase = "route"; n.away = false; n.approachDist = 0;
  if (!n.quietStart) {
    say(`Vous êtes au point de départ, le trajet commence. ${first.text}. ${short(n.route.length_m)}, environ ${Math.ceil(n.route.length_m / speed() / 60)} minutes.`, true);
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
  const near = !fresh || haversineM(r.lat, r.lon, end.lat, end.lon) <= Math.max(10, Math.min(r.acc, 25));
  const arrived = n.arrived || (n.phase !== "approach" && n.pos >= n.total - 3 && near);
  const next = arrived ? steps.at(-1) : steps[idx + 1];
  const toManeuver = arrived ? 0 : Math.max(0, n.stepAt[idx + 1] - n.pos);
  const lower = next.text.charAt(0).toLowerCase() + next.text.slice(1);
  const spoken = arrived ? "Vous êtes arrivé" : toManeuver < 15 ? next.text : `Dans ${short(toManeuver)}, ${lower}`;
  return {idx, next, toManeuver, remaining: Math.max(0, n.total - n.pos) + (n.phase === "approach" ? n.approachDist : 0), arrived, spoken};
}
function announce() {
  const n = S.nav, st = navState();
  if (st.arrived) {
    if (!n.said.has("arrive")) {
      n.said.add("arrive"); n.arrived = true;
      const end = n.route.geometry.at(-1), d = S.dest ? haversineM(end.lat, end.lon, S.dest.lat, S.dest.lon) : 0;
      say(d > 15 ? `Vous êtes arrivé au bout de l'itinéraire. Votre destination est à ${Math.round(d)} mètres.` : "Vous êtes arrivé.", true);
      buzz("arrive");
    }
    return;
  }
  if (n.phase === "approach") return;
  const i = st.idx + 1, alerts = st.next.alerts.length ? `. Attention : ${st.next.alerts.join(", ")}` : "";
  const side = turnSide(st.next.maneuver);
  if (st.toManeuver <= 60 && st.toManeuver > 20 && !n.said.has(`${i}-far`)) {
    n.said.add(`${i}-far`);
    say(`${st.spoken}${alerts}`);
    if (side) buzz(side);
  } else if (st.toManeuver <= 15 && !n.said.has(`${i}-now`)) {
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
    if (fromStart) { S.nav.fromHere = true; S.nav.quietStart = false; S.origin = {lat: from.lat, lon: from.lon, label: "Ma position"}; }
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
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  n.gpsProblem = err.code === 1
    ? `La localisation est refusée. ${ios ? "Réglages → Confidentialité → Service de localisation → Safari (ou Vision AR) → « Lorsque l'app est active »"
                                         : "Paramètres du navigateur → Autorisations du site → Position → Autoriser"}, puis réessayez.`
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
      say(`Rejoignez l'itinéraire, à ${Math.round(dStart)} mètres. Suivez les pointillés.`, true);
    }
    return renderNavLive();
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
    return moveTo(Math.max(n.pos, acc > 25 ? Math.min(best.along, n.pos + 15) : best.along));
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
function drawRealPosition() {
  const r = S.nav?.real;
  if (!r) { realMarker?.remove(); realMarker = null; return; }
  if (!realMarker) realMarker = L.layerGroup().addTo(map);
  realMarker.clearLayers();
  L.circle([r.lat, r.lon], {radius: r.acc, color: "#C2410C", weight: 1, fillColor: "#F59E0B", fillOpacity: .15, interactive: false}).addTo(realMarker);
  L.circleMarker([r.lat, r.lon], {radius: 8, color: "#fff", weight: 3, fillColor: "#C2410C", fillOpacity: 1})
    .bindTooltip("Ma position GPS").addTo(realMarker);
}
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
    ${currentSession() ? `<p class="hello">Bonjour ${esc(currentSession().name.split(" ")[0])}&nbsp;!</p>` : ""}
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
const APP_VERSION = "22";
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
    ${sess ? `<div class="set-row static">${icon("user-round")}<span class="grow">Compte</span><span class="set-val">Bonjour ${esc(sess.name.split(" ")[0])}&nbsp;!</span></div>` : ""}
    ${row("setProfile", mob?.[2] || "accessibility", "Mon profil de mobilité", esc(mob?.[1] || ""))}
  </section>
  <section class="card stk-host">${sticker(S.voice ? "ca-vibre" : "lis-sans-son", "stk-card")}<h3>${icon("navigation")} Guidage</h3>
    ${sw("setVoice", "volume-2", "Consignes à la voix", S.voice)}
    ${sw("setHaptics", "vibrate", "Vibrations de direction", S.haptics)}
    ${row("testHaptics", "vibrate", "Tester la vibration", "", false)}
    ${sw("setStopsVoice", "bus", "Annoncer les arrêts de transport proches", S.stopsVoice)}
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
    <p class="fine">${icon("info")} Télécharge un modèle de 6 Mo à la première utilisation. Reconnaît déjà : vélos, deux-roues, voitures,
      bancs, bornes, horodateurs, bacs à plantes, tables et chaises de terrasse. Pas encore : potelets, poubelles, travaux, trous, marches
      (modèle dédié en préparation, grâce aux images collectées ci-dessous).</p>
    ${sw("setDetectDebug", "square-dashed", "Mode test : encadrer tout ce qui est détecté", S.detectDebug)}
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
  <p class="fine set-version">Vision AR version ${APP_VERSION} · Geomessen Burkina Faso</p>`;
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
  const chosen = S.routes[S.selected];
  return `<div class="sheet-head">
    ${S.dest ? "" : sticker("on-y-va", "stk-sheet")}
    <button class="handle" id="sheetHandle" aria-expanded="${!sheetCollapsed}"
      aria-label="${sheetCollapsed ? "Agrandir le panneau" : "Réduire le panneau pour voir le plan"}"></button>
    <div class="row"><h2 class="grow">Où allez-vous&nbsp;?</h2>
      <button class="icon-btn" id="toProfile" aria-label="Mon profil">${icon(MOB.find(m => m[0] === primary())?.[2] || "user-round")}</button></div>
  </div>
  <div class="trip">
    <div class="trip-row"><span class="trip-dot start" aria-hidden="true"></span>
      <div class="grow"><small>Départ</small><b>${esc(S.origin.label)}</b></div>
      <button class="icon-btn" id="gpsHere" aria-label="Partir de ma position">${icon("locate-fixed")}</button></div>
    <div class="trip-line" aria-hidden="true"></div>
    <div class="trip-row"><span class="trip-dot end" aria-hidden="true"></span>
      <label class="search grow">${icon("search")}<input type="search" id="q" placeholder="Adresse, lieu, station, commerce…"
        value="${esc(S.query)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Destination">
        <button type="button" class="search-clear" id="qClear" aria-label="Effacer la saisie" ${S.query ? "" : "hidden"}>${icon("x")}</button></label></div>
  </div>
  <div id="placesBox" class="places-box">${placesHtml()}</div>
  <div class="pick"><span>${icon("map-pin")} Toucher le plan pour placer</span>
    <div class="seg"><button data-pick="origin" class="${S.pick === "origin" ? "on" : ""}">le départ</button>
      <button data-pick="dest" class="${S.pick === "dest" ? "on" : ""}">l'arrivée</button></div></div>
  ${S.dest ? `<div class="routes-head"><h3>${icon("route")} Choisissez votre itinéraire</h3></div>` : ""}
  ${S.message ? `<div class="msg warn">${icon("circle-alert")}<span>${esc(S.message)}</span></div>` : ""}
  ${S.routes.map((r, i) => routeCard(r, i)).join("")}
  ${S.routes.length ? `<button class="btn primary" id="start" ${chosen?.accessible ? "" : "disabled"}>${icon("navigation")} Démarrer le guidage</button>` : ""}`;
}
// Liste des résultats de recherche : mise à jour seule pendant la frappe (le champ n'est jamais reconstruit,
// sinon le clavier perd des lettres et l'appui long sur « effacer » s'arrête à chaque caractère)
function placesHtml() {
  return S.places.length ? `<div class="places">${S.places.map((p, i) => `<button class="place" data-place="${i}">
      <span class="place-ic" ${p.color ? `style="color:${p.color}"` : ""}>${icon(p.icon || (p.type === "poi" ? "map-pin" : "map"))}</span><span class="grow">${esc(p.label)}<small>${esc(p.sub || (p.type === "poi" ? "Lieu" : "Adresse"))}</small></span>
      ${icon("chevron-right")}</button>`).join("")}</div>` : "";
}
function renderPlaces() {
  const box = $("placesBox");
  if (!box) return;
  box.innerHTML = placesHtml();
  box.querySelectorAll("[data-place]").forEach(p => p.onclick = () => chooseDest(S.places[+p.dataset.place]));
  layoutSheet();
}
function routeCard(r, i) {
  const min = Math.ceil(r.duration_s / 60);
  const incomplete = r.warnings.includes("données incomplètes");
  const badge = !r.accessible ? `<span class="badge danger">${icon("ban")} Non praticable</span>`
    : i === 0 ? `<span class="badge ok">${icon("accessibility")} Recommandé</span>` : "";
  const notes = r.accessible
    ? r.warnings.filter(w => w !== "marche" && w !== "données incomplètes").map(w => `<span class="tag">${esc(w)}</span>`)
      .concat(incomplete ? [`<span class="tag warn">${icon("info")} données à confirmer</span>`] : [])
    : r.blocking_issues.map(w => `<span class="tag danger">${icon("triangle-alert")} ${esc(w)}</span>`);
  const stk = i === 0 && r.accessible ? (!r.steps_count ? "zero-marche" : r.max_slope_pct <= 5 ? "pente-douce" : "") : "";
  return `<div class="rcard ${i === S.selected ? "sel" : ""} ${stk ? "stk-host" : ""}" data-route="${i}" role="button" tabindex="0"
      aria-label="${esc(r.label)}, ${min} minutes, ${short(r.length_m)}${r.accessible ? "" : ", non praticable"}${i === S.selected ? ", sélectionné" : ""}">
    <div class="rc-head"><div class="grow"><b>${esc(r.label)}</b>${badge}</div><div class="rc-time"><b>${min}</b> min</div></div>
    <div class="rc-meta">
      <span>${icon("route")} ${short(r.length_m)}</span>
      <span class="${r.steps_count ? "bad" : "good"}">${icon("stairs")} ${r.steps_count ? r.steps_count + " marche(s)" : "aucune marche"}</span>
      ${net && r.edge_ids.every(id => net.edges[id]?.slope_pct === null)
        ? `<span>${icon("mountain")} pente à vérifier</span>`
        : `<span class="${r.max_slope_pct > 5 ? "bad" : "good"}">${icon("mountain")} pente max ${fmt1(r.max_slope_pct)} %</span>`}</div>
    ${notes.length ? `<div class="tags">${notes.join("")}</div>` : ""}${stk ? sticker(stk, "stk-route") : ""}</div>`;
}
// Commandes et état exposés à l'écran de guidage en réalité augmentée (js/ar.js)
const navApi = {
  map,
  state: () => S.nav && {nav: S.nav, st: navState(), posAt, net, dest: S.dest, reports: reports(), speed: speed(),
    mobility: primary(), voice: S.voice, theme: S.theme, haptics: S.haptics, hapticsNote: hapticsNote(),
    detect: S.detect, detectDebug: S.detectDebug, dataConsent: S.dataConsent, autoLowConf: S.autoLowConf,
    gpsInfo: S.nav.gpsInfo, gpsProblem: S.nav.gpsProblem, gpsStatus: S.nav.gpsStatus},
  reroute: () => manualReroute(),
  setOption: (key, value) => { S[key] = value; store.set(OPTION_KEYS[key], value); },
  obstacleAlert: text => { say(text, true); buzz("obstacle"); },
  nativeFix: (lat, lon, acc) => onGps({coords: {latitude: lat, longitude: lon, accuracy: acc}}, true),
  setHaptics: on => { S.haptics = on; store.set("va-haptics", on); if (on) buzz("left"); },
  toggleVoice: () => { S.voice = !S.voice; store.set("va-voice", S.voice); if (!S.voice) window.speechSynthesis?.cancel(); },
  openHud: () => { S.hud = true; renderHud(); },
  setTheme,
  report: (kind, blocking) => doReport(kind, blocking),
  stop: () => stopGuidance(),
};
function stopGuidance() {
  for (const step of [() => stopNav(), () => { S.nav = null; }, () => window.speechSynthesis?.cancel(),
                      () => wakeLock?.release?.(), () => closeAR(), () => layers.progress.clearLayers(), () => go("route")]) {
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
// Signalement : enregistré sur ce téléphone ; s'il bloque, nouvel itinéraire depuis la position
function doReport(kind, blocking) {
  // On signale ce qu'on a devant soi : l'obstacle est placé 10 m plus loin sur l'itinéraire.
  // (À sa propre position, il bloquerait les trottoirs autour de soi et aucun détour ne serait possible.)
  const here = S.nav.here, at = posAt(Math.min(S.nav.total, S.nav.pos + 10));
  addReport(kind, blocking, at);
  let msg = "Merci, obstacle enregistré sur ce téléphone.";
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

function render() {
  const nav = S.screen === "nav";
  const authScreen = AUTH_SCREENS[S.screen];
  document.body.className = authScreen ? "full auth-screen" : ["profile", "settings", "zones"].includes(S.screen) ? "full" : nav ? "nav-ar" : "sheet";
  $("panel").innerHTML = nav ? "" : authScreen ? authScreen() : {profile: screenProfile, route: screenRoute, settings: screenSettings, zones: screenZones}[S.screen]();
  if (authScreen) bindAuth($("panel"), authCtx); else bind();
  renderHud();
  syncLayers();
  if (net) { drawRoutes(); drawReports(); }
  if (nav && !arOpen()) openAR(navApi);                 // dans le geste de l'usager : caméra et boussole autorisées
  refreshTransit(true);
  let mc = $("mapClose");
  if (S.screen === "route" && S.dest) {
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
  syncGuard();
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
    toast(`Bienvenue ${currentSession()?.name.split(" ")[0] || ""} !`);
  },
};
function renderNavLive() {
  renderHud();
  const n = S.nav;
  if (!n) return;
  const shown = (n.phase === "approach" || n.away || n.offRoute) && n.real ? n.real : n.here;   // N°15 : pas accroché pendant l'approche
  n.marker?.setLatLng([shown.lat, shown.lon]);
  if (S.screen === "nav") { map.panTo([shown.lat, shown.lon], {animate: false}); drawProgress(); refreshTransit(); announceStops(); }
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
  if (S.screen === "signup") { resetForm(); return go("login"); }
  if (S.screen === "login") { resetForm(); return go("welcome"); }
  if (S.screen === "welcome") return;
  if (S.hud) { S.hud = false; renderHud(); return; }
  if (S.screen === "nav") return confirmQuit();
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
  if (S.screen === "route" && S.routes[S.selected]?.accessible) return startGuidance();
  if (S.screen === "route") toast(S.routes.length ? "Cet itinéraire n'est pas praticable : choisissez-en un autre." : "Choisissez d'abord une destination.");
}
function closeRoutes() {
  Object.assign(S, {dest: null, routes: [], query: "", places: [], message: null});
  map.setView([S.origin.lat, S.origin.lon], 16);
  render();
}
function chooseDest(place) {
  sheetCollapsed = false;                                 // les itinéraires doivent se voir
  S.dest = place; S.query = place.label; S.places = [];
  computeRoute();
}
function startGuidance() {
  startNav(S.routes[S.selected]);
  say("Guidage lancé. Recherche de votre position.", true);
  stickerPop("je-te-guide");
  startGps();
  go("nav");
  map.setView([S.nav.here.lat, S.nav.here.lon], 17, {animate: false});
}
// Confirmation avant de quitter un guidage par un geste (on ne l'arrête jamais par mégarde)
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
  const onPanel = !!e.target.closest("#panel") && !e.target.closest("input, .seg, .tile, .switch");
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
  on("gpsHere", "onclick", useMyPosition);
  on("q", "oninput", e => { S.query = e.target.value; $("qClear").hidden = !S.query; search(S.query); });
  // la croix efface tout d'un coup ; mousedown empêché : le champ garde le clavier ouvert
  on("qClear", "onmousedown", e => e.preventDefault());
  on("qClear", "onclick", () => { const q = $("q"); q.value = ""; S.query = ""; $("qClear").hidden = true; search(""); q.focus(); });
  on("q", "onfocus", () => { if (sheetCollapsed) setSheet(false); });
  on("sheetHandle", "onkeydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet(!sheetCollapsed); } });
  all("[data-place]", p => p.onclick = () => chooseDest(S.places[+p.dataset.place]));
  all("[data-pick]", b => b.onclick = () => { S.pick = b.dataset.pick; render(); });
  all("[data-route]", c => c.onclick = () => { S.selected = +c.dataset.route; render(); });
  on("start", "onclick", startGuidance);
  // Paramètres
  on("settingsBack", "onclick", () => go("route"));
  on("setProfile", "onclick", () => go("profile"));
  on("setVoice", "onchange", e => { S.voice = e.target.checked; store.set("va-voice", S.voice); });
  on("setHaptics", "onchange", e => { navApi.setHaptics(e.target.checked); render(); });
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
  setTimeout(() => { l.classList.add("done"); setTimeout(() => l.remove(), 500); }, Math.max(0, 1200 - (performance.now() - loaderStart)));
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
  window.__va = {S, posAt, navState, moveTo, chooseDest, get net() { return net; }, get transit() { return transit; }, addReport, reports, navApi};
