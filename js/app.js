// Vision AR — démo web mobile (installable sur l'écran d'accueil).
// Écrans repris de l'appli Android (phone/ui/Screens.kt) ; itinéraires calculés
// sur le téléphone par js/routing.js, copie fidèle du moteur du serveur.
import {arOpen, closeAR, openAR} from "./ar.js";
import {icon} from "./icons.js";
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
const SLOPE = [[2, "#1F8A70", "≤ 2 %"], [5, "#A86F00", "2 à 5 %"], [8, "#D9480F", "5 à 8 %"], [Infinity, "#7B2D8E", "> 8 %"]];
const C = {route: "#12B5C3", routeCase: "#063B4A", alt: "#6B7C8F", primary: "#0B5E78", unknown: "#5C6B7A", step: "#0F2537"};
const MAIRIE = {label: "Mairie de Gennevilliers", lat: 48.925459, lon: 2.294045};
const GEOCODER = "https://data.geopf.fr/geocodage/search/";

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
  screen: saved ? "route" : "profile",
  mobilities: new Set(saved?.mobilities || ["manual_wheelchair"]), maxSlope: saved?.maxSlope ?? null, steps: saved?.steps ?? false,
  voice: store.get("va-voice", true), origin: {...MAIRIE}, dest: null, pick: "dest", query: "", places: [],
  routes: [], selected: 0, message: null, loading: false, nav: null, blocking: true, hud: false, hc: false,
};
let net = null;
let installPrompt = null;
let syncLayers = () => {};

// ---- Thème : « verre » (clair, ruban lumineux) ou « neon » (sombre, repères flottants) ----------
S.theme = store.get("va-theme", matchMedia("(prefers-color-scheme: dark)").matches ? "neon" : "verre");
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = S.theme === "neon" ? "#061019" : "#E9EEF5";
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
  if (S.voice && "speechSynthesis" in window) {
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    speechSynthesis.speak(u);
  }
  if (navigator.vibrate) navigator.vibrate(urgent ? [200, 100, 200] : 120);
}
function toast(text, ms = 3500) {
  const t = $("toast");
  t.innerHTML = `${icon("info")}<span>${esc(text)}</span>`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- Carte ---------------------------------------------------------------------------------
const map = L.map("map", {zoomControl: false, preferCanvas: true}).setView([MAIRIE.lat, MAIRIE.lon], 16);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · relief © IGN'}).addTo(map);
const layers = {net: L.layerGroup(), pois: L.layerGroup(), reports: L.layerGroup().addTo(map),
  routes: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map)};

function slopeColor(e) {
  if (e.has_step) return C.step;
  if (e.slope_pct === null) return C.unknown;
  return SLOPE.find(([max]) => Math.abs(e.slope_pct) <= max)[1];
}
function edgePopup(e) {
  const src = {dem: "relief IGN", osm: "OpenStreetMap", survey: "relevé terrain"}[e.slope_source] || "";
  const line = (ic, label, value) => `<div class="pp-row">${icon(ic)}<span>${label}</span><b>${value}</b></div>`;
  return `<div class="pp"><div class="pp-title">${esc(e.name) || KIND_LABEL[e.kind] || e.kind}</div>
    ${line("ruler", "Longueur", `${fmt1(e.length_m)} m`)}
    ${line("mountain", "Pente", e.slope_pct === null ? "inconnue" : `${e.slope_pct > 0 ? "+" : ""}${fmt1(e.slope_pct)} %`)}
    ${src ? `<div class="pp-src">source : ${src}</div>` : ""}
    ${e.has_step ? line("stairs", "Marche", "oui") : ""}
    ${e.is_crossing ? line("accessibility", "Bordures", e.kerb_lowered === null ? "inconnues" : e.kerb_lowered ? "abaissées" : "hautes") +
                      line("volume-2", "Feu sonore", e.sound_signal === null ? "inconnu" : e.sound_signal ? "oui" : "non") : ""}</div>`;
}
const pin = (ic, cls) => L.divIcon({className: "", html: `<div class="pin ${cls}">${icon(ic)}</div>`,
  iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36]});
function drawNetwork() {
  for (const e of net.edges)
    L.polyline(e.shape, {color: slopeColor(e), weight: e.is_crossing ? 5 : 4, opacity: .9, lineCap: "round",
      dashArray: e.has_step ? "1 7" : e.slope_pct === null ? "5 6" : null}).bindPopup(() => edgePopup(e)).addTo(layers.net);
  for (const [kind, lat, lon, name, status] of net.pois) {
    if (!POI[kind]) continue;
    L.marker([lat, lon], {icon: pin(POI[kind][0], "pin-poi"), title: POI[kind][1]})
      .bindPopup(`<div class="pp"><div class="pp-title">${POI[kind][1]}</div>${name ? esc(name) : ""}${
        kind === "elevator" ? `<div class="pp-src">État : ${{ok: "en service", out_of_order: "en panne"}[status] || "inconnu"}</div>` : ""}</div>`)
      .addTo(layers.pois);
  }
  L.geoJSON(net.zone.boundary, {style: {color: C.primary, weight: 2, fill: false, dashArray: "6 8", opacity: .7}, interactive: false}).addTo(map);
  const legend = L.control({position: "bottomleft"});
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "legend");
    d.innerHTML = `<b>Pente</b>${SLOPE.map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}
      <span><i class="dash" style="--c:${C.unknown}"></i>inconnue</span><span><i class="dots" style="--c:${C.step}"></i>marche</span>`;
    return d;
  };
  legend.addTo(map);
  syncLayers = () => {
    const show = map.getZoom() >= 16 && S.screen !== "nav";
    for (const l of [layers.net, layers.pois]) show ? l.addTo(map) : l.remove();
    document.body.classList.toggle("zoomed-out", !show);
  };
  map.on("zoomend", syncLayers);
  syncLayers();
}
function drawReports() {
  layers.reports.clearLayers();
  for (const r of reports()) {
    const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1);
    L.marker([r.lat, r.lon], {icon: pin(k[2], "pin-report"), title: k[1]})
      .bindPopup(`<div class="pp"><div class="pp-title">${k[1]}${r.blocking ? " — bloquant" : ""}</div>
        <div class="pp-src">Signalé sur ce téléphone · expire le ${new Date(r.expires).toLocaleString("fr-FR", {dateStyle: "short", timeStyle: "short"})}</div></div>`)
      .addTo(layers.reports);
  }
}
function drawRoutes() {
  drawRealPosition();
  layers.routes.clearLayers();
  layers.marks.clearLayers();
  const sel = S.nav?.route || S.routes[S.selected];
  const nav = S.screen === "nav";
  for (const r of S.routes) if (r !== sel) {
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
  if (sel) {
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
  const stops = [[47, 128, 237], [18, 181, 195], [61, 220, 151]], n = Math.min(30, ll.length - 1), out = [];
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
  if (S.pick === "origin") S.origin = p;
  else { S.dest = p; S.query = p.label; S.places = []; }
  computeRoute();
});

// ---- Itinéraire ---------------------------------------------------------------------------
function computeRoute() {
  S.routes = []; S.message = null;
  if (S.dest) {
    try {
      S.routes = computeRoutes(net, {origin: S.origin, destination: S.dest, profile: profileJson(), compare_shortest: true}, reports()).routes;
      S.selected = 0;
      map.fitBounds(L.latLngBounds(S.routes[0].geometry.map(p => [p.lat, p.lon])), {paddingTopLeft: [24, 24], paddingBottomRight: [24, 24]});
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      S.message = e.message;
    }
  }
  render();
}
function useMyPosition() {
  if (!navigator.geolocation) return toast("La localisation n'est pas disponible sur cet appareil.");
  toast("Recherche de votre position…");
  navigator.geolocation.getCurrentPosition(pos => {
    const p = {lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position"};
    try {
      nearestNode(net, p.lat, p.lon);
    } catch {
      return toast("Vous êtes hors de la zone couverte (Gennevilliers) : le départ reste fixé sur le plan. " +
                   "Le mode « GPS réel » ne marchera que sur place ; utilisez la simulation.", 6000);
    }
    S.origin = p;
    map.setView([p.lat, p.lon], 17);
    computeRoute();
  }, () => toast("Position refusée ou indisponible."), {enableHighAccuracy: true, timeout: 15000});
}
let searchTimer = null;
function search(q) {
  clearTimeout(searchTimer);
  if (q.trim().length < 3) { S.places = []; return renderKeepFocus(); }
  searchTimer = setTimeout(async () => {
    try {
      const url = `${GEOCODER}?${new URLSearchParams({q, limit: 6, index: "address,poi", lat: S.origin.lat, lon: S.origin.lon})}`;
      const data = await fetch(url).then(r => r.json());
      S.places = (data.features || []).map(f => {
        const p = f.properties, [lon, lat] = f.geometry.coordinates;
        const label = p.label || [p.toponym, (p.city || [])[0]].filter(Boolean).join(", ");
        return {label, lat, lon, type: p._type};
      }).filter((p, i, all) => all.findIndex(o => o.label === p.label && haversineM(o.lat, o.lon, p.lat, p.lon) < 150) === i);
    } catch {
      S.places = [];
      toast("Recherche d'adresse impossible (hors ligne ?) : touchez le plan pour choisir l'arrivée.");
    }
    renderKeepFocus();
  }, 350);
}

// ---- Guidage : simulation ou GPS --------------------------------------------------------
function project(p, a, b) {           // projection d'un point sur un segment, en mètres (plan local)
  const k = Math.cos(p.lat * Math.PI / 180), m = 111320;
  const ax = (a.lon - p.lon) * k * m, ay = (a.lat - p.lat) * m, bx = (b.lon - p.lon) * k * m, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
  return {t, d: Math.hypot(ax + t * dx, ay + t * dy)};
}
function startNav(route) {
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
  stopNav();
  S.nav = {route, cum, total: cum.at(-1), stepAt, pos: 0, here: {...g[0]}, mode: S.nav?.mode || "sim", factor: S.nav?.factor || 5,
           timer: null, watch: null, said: new Set(), off: 0, arrived: false};
  requestWakeLock();
  const first = route.steps[0];
  say(`${first.text}. ${short(route.length_m)}, environ ${Math.ceil(route.length_m / speed() / 60)} minutes.`, true);
}
function stopNav() {
  if (!S.nav) return;
  clearInterval(S.nav.timer);
  if (S.nav.watch !== null) navigator.geolocation.clearWatch(S.nav.watch);
  S.nav.timer = null; S.nav.watch = null;
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
  const arrived = n.arrived || n.pos >= n.total - 3;
  const next = arrived ? steps.at(-1) : steps[idx + 1];
  const toManeuver = arrived ? 0 : Math.max(0, n.stepAt[idx + 1] - n.pos);
  const lower = next.text.charAt(0).toLowerCase() + next.text.slice(1);
  const spoken = arrived ? "Vous êtes arrivé" : toManeuver < 15 ? next.text : `Dans ${short(toManeuver)}, ${lower}`;
  return {idx, next, toManeuver, remaining: Math.max(0, n.total - n.pos), arrived, spoken};
}
function announce() {
  const n = S.nav, st = navState();
  if (st.arrived) {
    if (!n.said.has("arrive")) { n.said.add("arrive"); n.arrived = true; say("Vous êtes arrivé.", true); setSim(false); }
    return;
  }
  const i = st.idx + 1, alerts = st.next.alerts.length ? `. Attention : ${st.next.alerts.join(", ")}` : "";
  if (st.toManeuver <= 60 && st.toManeuver > 20 && !n.said.has(`${i}-far`)) {
    n.said.add(`${i}-far`);
    say(`${st.spoken}${alerts}`);
  } else if (st.toManeuver <= 15 && !n.said.has(`${i}-now`)) {
    n.said.add(`${i}-now`); n.said.add(`${i}-far`);
    say(st.next.text, true);
  }
}
function moveTo(pos) {
  S.nav.pos = Math.min(S.nav.total, Math.max(0, pos));
  S.nav.here = posAt(S.nav.pos);
  announce();
  renderNavLive();
}
function setSim(on) {
  const n = S.nav;
  clearInterval(n.timer);
  n.timer = null;
  if (on && !n.arrived) n.timer = setInterval(() => moveTo(n.pos + speed() * n.factor * 0.25), 250);
  renderNavLive();
}
function setMode(mode) {
  const n = S.nav;
  setSim(false);
  if (n.watch !== null) { navigator.geolocation.clearWatch(n.watch); n.watch = null; }
  n.mode = mode;
  drawRealPosition();
  if (mode === "gps") {
    if (!navigator.geolocation) { toast("Pas de GPS sur cet appareil."); n.mode = "sim"; return render(); }
    n.gpsInfo = "Recherche de votre position… (autorisez la localisation si le téléphone le demande)";
    n.gpsProblem = null;
    n.watch = navigator.geolocation.watchPosition(onGps, onGpsError, {enableHighAccuracy: true, maximumAge: 1000, timeout: 20000});
  }
  render();
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
function onGps(pos) {
  const n = S.nav, p = {lat: pos.coords.latitude, lon: pos.coords.longitude}, acc = pos.coords.accuracy;
  n.real = {...p, acc};
  n.gpsInfo = acc > 30 ? `Signal GPS faible (± ${Math.round(acc)} m)` : `GPS ± ${Math.round(acc)} m`;
  drawRealPosition();
  // Hors de la zone couverte : on le dit clairement, sans tenter de recalcul impossible
  try {
    nearestNode(net, p.lat, p.lon);
    n.gpsProblem = null;
  } catch {
    const km = haversineM(p.lat, p.lon, MAIRIE.lat, MAIRIE.lon) / 1000;
    n.gpsProblem = `Vous êtes à ${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} km de Gennevilliers. ` +
      "Le mode GPS réel ne guide que sur place, dans la zone couverte. Ailleurs, utilisez la simulation (avec la vue Caméra si vous voulez).";
    return renderNavLive();
  }
  // point le plus proche du tracé, sans revenir loin en arrière
  const g = n.route.geometry;
  let best = null;
  for (let i = 1; i < g.length; i++) {
    if (n.cum[i] < n.pos - 40) continue;
    const pr = project(p, g[i - 1], g[i]);
    if (!best || pr.d < best.d) best = {d: pr.d, along: n.cum[i - 1] + pr.t * (n.cum[i] - n.cum[i - 1])};
  }
  if (best && best.d <= 30) { n.off = 0; return moveTo(Math.max(n.pos, best.along)); }
  n.gpsInfo += ` — à ${Math.round(best?.d ?? 0)} m de l'itinéraire`;
  map.panTo([p.lat, p.lon]);
  renderNavLive();
  if (acc <= 40 && ++n.off >= 3) {                       // vraiment hors du tracé : nouveau calcul
    n.off = 0;
    try {
      const res = computeRoutes(net, {origin: p, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
      say("Nouvel itinéraire.", true);
      startNav(res.routes[0]);
      S.routes = res.routes; S.selected = 0;
      S.nav.rerouted = {at: Date.now(), title: "Hors de l'itinéraire"};
      setMode("gps");
    } catch (e) {
      n.gpsInfo = e instanceof RoutingError ? e.message : String(e);
      renderNavLive();
    }
  }
}
let realMarker = null;
function drawRealPosition() {
  const r = S.nav?.real;
  if (!r || S.nav.mode !== "gps") { realMarker?.remove(); realMarker = null; return; }
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
  return `<header class="hero">
    <div class="brand"><img src="icons/icon-192.png" alt="" width="40" height="40"><span>Vision AR</span></div>
    <h1>Comment vous déplacez-vous&nbsp;?</h1>
    <p class="lead">Choisissez un ou plusieurs profils : l'itinéraire s'adapte à vos besoins.</p></header>
  <div class="tiles" role="group" aria-label="Profils de mobilité">
    ${MOB.map(([m, l, ic]) => `<button class="tile ${S.mobilities.has(m) ? "on" : ""}" data-mob="${m}" aria-pressed="${S.mobilities.has(m)}">
      <span class="tile-ic">${icon(ic)}</span><span class="tile-label">${l}</span><span class="tile-check">${icon("check")}</span></button>`).join("")}
  </div>
  <section class="card">
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
  <p class="fine">${icon("shield-check")} Démonstration sur Gennevilliers. Itinéraires calculés sur ce téléphone, aucune donnée personnelle envoyée.
    Réseau © OpenStreetMap (ODbL), pentes © IGN.</p>`;
}
function screenRoute() {
  const chosen = S.routes[S.selected];
  return `<div class="handle" aria-hidden="true"></div>
  <div class="row"><h2 class="grow">Où allez-vous&nbsp;?</h2>
    <button class="icon-btn" id="toProfile" aria-label="Mon profil">${icon(MOB.find(m => m[0] === primary())?.[2] || "user-round")}</button></div>
  <div class="trip">
    <div class="trip-row"><span class="trip-dot start" aria-hidden="true"></span>
      <div class="grow"><small>Départ</small><b>${esc(S.origin.label)}</b></div>
      <button class="icon-btn" id="gpsHere" aria-label="Partir de ma position">${icon("locate-fixed")}</button></div>
    <div class="trip-line" aria-hidden="true"></div>
    <div class="trip-row"><span class="trip-dot end" aria-hidden="true"></span>
      <label class="search grow">${icon("search")}<input type="text" id="q" placeholder="Adresse ou lieu à Gennevilliers"
        value="${esc(S.query)}" autocomplete="off" enterkeyhint="search" aria-label="Destination"></label></div>
  </div>
  ${S.places.length ? `<div class="places">${S.places.map((p, i) => `<button class="place" data-place="${i}">
      ${icon(p.type === "poi" ? "map-pin" : "map")}<span class="grow">${esc(p.label)}<small>${p.type === "poi" ? "Lieu" : "Adresse"}</small></span>
      ${icon("chevron-right")}</button>`).join("")}</div>` : ""}
  <div class="pick"><span>${icon("map-pin")} Toucher le plan pour placer</span>
    <div class="seg"><button data-pick="origin" class="${S.pick === "origin" ? "on" : ""}">le départ</button>
      <button data-pick="dest" class="${S.pick === "dest" ? "on" : ""}">l'arrivée</button></div></div>
  ${S.message ? `<div class="msg warn">${icon("circle-alert")}<span>${esc(S.message)}</span></div>` : ""}
  ${S.routes.map((r, i) => routeCard(r, i)).join("")}
  ${S.routes.length ? `<button class="btn primary" id="start" ${chosen?.accessible ? "" : "disabled"}>${icon("navigation")} Démarrer le guidage</button>` : ""}`;
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
  return `<div class="rcard ${i === S.selected ? "sel" : ""}" data-route="${i}" role="button" tabindex="0"
      aria-label="${esc(r.label)}, ${min} minutes, ${short(r.length_m)}${r.accessible ? "" : ", non praticable"}${i === S.selected ? ", sélectionné" : ""}">
    <div class="rc-head"><div class="grow"><b>${esc(r.label)}</b>${badge}</div><div class="rc-time"><b>${min}</b> min</div></div>
    <div class="rc-meta">
      <span>${icon("route")} ${short(r.length_m)}</span>
      <span class="${r.steps_count ? "bad" : "good"}">${icon("stairs")} ${r.steps_count ? r.steps_count + " marche(s)" : "aucune marche"}</span>
      <span class="${r.max_slope_pct > 5 ? "bad" : "good"}">${icon("mountain")} pente max ${fmt1(r.max_slope_pct)} %</span></div>
    ${notes.length ? `<div class="tags">${notes.join("")}</div>` : ""}</div>`;
}
// Commandes et état exposés à l'écran de guidage en réalité augmentée (js/ar.js)
const navApi = {
  map,
  state: () => S.nav && {nav: S.nav, st: navState(), posAt, net, dest: S.dest, reports: reports(), speed: speed(),
    mobility: primary(), mode: S.nav.mode, factor: S.nav.factor, playing: !!S.nav.timer, voice: S.voice, theme: S.theme,
    gpsInfo: S.nav.gpsInfo, gpsProblem: S.nav.gpsProblem},
  togglePlay: () => setSim(!S.nav.timer),
  pause: () => setSim(false),
  setMode: m => setMode(m),
  setFactor: f => { S.nav.factor = f; setSim(!!S.nav.timer); },
  rewind: () => { S.nav.arrived = false; S.nav.said.clear(); moveTo(0); },
  toggleVoice: () => { S.voice = !S.voice; store.set("va-voice", S.voice); if (!S.voice) speechSynthesis?.cancel(); },
  openHud: () => { S.hud = true; renderHud(); },
  setTheme,
  report: (kind, blocking) => doReport(kind, blocking),
  stop: () => { stopNav(); S.nav = null; wakeLock?.release?.(); closeAR(); go("route"); },
};
// Signalement : enregistré sur ce téléphone ; s'il bloque, nouvel itinéraire depuis la position
function doReport(kind, blocking) {
  // On signale ce qu'on a devant soi : l'obstacle est placé 10 m plus loin sur l'itinéraire.
  // (À sa propre position, il bloquerait les trottoirs autour de soi et aucun détour ne serait possible.)
  const here = S.nav.here, at = posAt(Math.min(S.nav.total, S.nav.pos + 10));
  addReport(kind, blocking, at);
  let msg = "Merci, obstacle enregistré sur ce téléphone.";
  if (blocking) {
    try {
      const res = computeRoutes(net, {origin: here, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
      startNav(res.routes[0]);
      S.routes = res.routes; S.selected = 0;
      S.nav.rerouted = {at: Date.now(), title: kind === "elevator_out" ? "Ascenseur en panne" : "Trottoir bloqué"};
      if (S.nav.mode === "gps") setMode("gps");
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
  document.body.className = S.screen === "profile" ? "full" : nav ? "nav-ar" : "";
  $("panel").innerHTML = nav ? "" : {profile: screenProfile, route: screenRoute}[S.screen]();
  bind();
  renderHud();
  syncLayers();
  if (net) { drawRoutes(); drawReports(); }
  if (nav && !arOpen()) openAR(navApi);                 // dans le geste de l'usager : caméra et boussole autorisées
  setTimeout(() => map.invalidateSize(), 0);
}
function renderKeepFocus() {
  const q = $("q"), pos = q?.selectionStart;
  render();
  const q2 = $("q");
  if (q2 && q) { q2.focus(); q2.setSelectionRange(pos, pos); }
}
function renderNavLive() {
  renderHud();
  if (S.nav?.marker) S.nav.marker.setLatLng([S.nav.here.lat, S.nav.here.lon]);
  if (S.screen === "nav" && S.nav) map.panTo([S.nav.here.lat, S.nav.here.lon], {animate: false});
}
function go(screen) { S.screen = screen; S.message = null; render(); }
function saveProfile() { store.set("va-profile", {mobilities: [...S.mobilities], maxSlope: S.maxSlope, steps: S.steps}); }

function bind() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e[ev] = fn; };
  const all = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  all("[data-mob]", b => b.onclick = () => { const m = b.dataset.mob; S.mobilities.has(m) ? S.mobilities.delete(m) : S.mobilities.add(m); render(); });
  all("[data-theme-pick]", b => b.onclick = () => { setTheme(b.dataset.themePick); render(); });
  on("slope", "oninput", e => { S.maxSlope = +e.target.value; $("slopeLbl").textContent = `${S.maxSlope} %`; });
  on("steps", "onchange", e => { S.steps = e.target.checked; });
  on("voice", "onchange", e => { S.voice = e.target.checked; store.set("va-voice", S.voice); });
  on("cont", "onclick", () => { saveProfile(); go("route"); computeRoute(); });
  on("install", "onclick", async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); });
  on("toProfile", "onclick", () => go("profile"));
  on("gpsHere", "onclick", useMyPosition);
  on("q", "oninput", e => { S.query = e.target.value; search(S.query); });
  all("[data-place]", p => p.onclick = () => { S.dest = S.places[+p.dataset.place]; S.query = S.dest.label; S.places = []; computeRoute(); });
  all("[data-pick]", b => b.onclick = () => { S.pick = b.dataset.pick; render(); });
  all("[data-route]", c => c.onclick = () => { S.selected = +c.dataset.route; render(); });
  on("start", "onclick", () => {
    startNav(S.routes[S.selected]);
    go("nav");
    map.setView([S.nav.here.lat, S.nav.here.lon], 17, {animate: false});
  });
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
$("panel").innerHTML = `<h2>Vision AR</h2><p>Chargement du plan de Gennevilliers…</p>`;
fetch("data/gennevilliers.json").then(r => r.json()).then(data => {
  net = loadNetwork(data);
  drawNetwork();
  render();
  if (S.screen === "route") computeRoute();
}).catch(err => {
  $("panel").innerHTML = `<h2>Vision AR</h2><div class="msg">Impossible de charger le plan : ${esc(err.message)}</div>`;
});

// Accès pour les tests automatiques uniquement (adresse terminée par ?debug)
if (new URLSearchParams(location.search).has("debug"))
  window.__va = {S, posAt, navState, moveTo, get net() { return net; }, addReport, reports, navApi};
