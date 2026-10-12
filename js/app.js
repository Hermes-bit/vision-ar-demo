// Vision AR — démo web mobile (installable sur l'écran d'accueil).
// Écrans repris de l'appli Android (phone/ui/Screens.kt) ; itinéraires calculés
// sur le téléphone par js/routing.js, copie fidèle du moteur du serveur.
import {openAR} from "./ar.js";
import {computeRoutes, loadNetwork, nearestNode, RoutingError, SNAP_MAX_DISTANCE_M, haversineM, resolveProfile} from "./routing.js";

const MOB = [["manual_wheelchair", "Fauteuil roulant manuel"], ["electric_wheelchair", "Fauteuil électrique"],
  ["cane_or_walker", "Canne ou déambulateur"], ["low_vision", "Je suis malvoyant(e)"], ["hard_of_hearing", "Je suis malentendant(e)"]];
const PRIORITY = ["manual_wheelchair", "electric_wheelchair", "cane_or_walker", "low_vision", "hard_of_hearing"];
const REPORT_KINDS = [["works", "Travaux"], ["step", "Marche"], ["street_furniture", "Mobilier urbain"],
  ["narrow_sidewalk", "Trottoir étroit"], ["elevator_out", "Ascenseur en panne"], ["parked_vehicle", "Véhicule garé"], ["other", "Autre"]];
// Durées de vie : identiques à app/reports.py et à la table va_report_kind_info
const REPORT_TTL_H = {parked_vehicle: 2, street_furniture: 72, other: 48};
const ARROW = {left: "←", slight_left: "↖", right: "→", slight_right: "↗", uturn: "↶", arrive: "●"};
const VERB = {left: "À GAUCHE", slight_left: "SERREZ À GAUCHE", right: "À DROITE", slight_right: "SERREZ À DROITE", uturn: "DEMI-TOUR"};
const POI = {elevator: ["🛗", "Ascenseur"], accessible_toilet: ["🚻", "Toilettes accessibles"], disabled_parking: ["♿", "Place PMR"],
  accessible_entrance: ["🚪", "Entrée accessible"], ramp: ["↗", "Rampe"], audio_beacon: ["🔊", "Balise sonore"]};
const KIND_LABEL = {sidewalk: "Trottoir", crossing: "Passage piéton", footway: "Chemin piéton", street: "Rue",
  path: "Sentier", steps: "Escalier", pedestrian: "Voie piétonne", elevator: "Ascenseur", ramp: "Rampe"};
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
  t.textContent = text;
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
  if (e.has_step) return "#7B2CBF";
  if (e.slope_pct === null) return "#9a9a9a";
  const s = Math.abs(e.slope_pct);
  return s <= 2 ? "#1a9850" : s <= 5 ? "#c5b000" : s <= 8 ? "#f46d43" : "#d73027";
}
function edgePopup(e) {
  const src = {dem: "relief IGN", osm: "OSM", survey: "relevé terrain"}[e.slope_source] || "";
  return `<b>${esc(e.name) || KIND_LABEL[e.kind] || e.kind}</b><br>${fmt1(e.length_m)} m · pente ${
    e.slope_pct === null ? "inconnue" : (e.slope_pct > 0 ? "+" : "") + fmt1(e.slope_pct) + " %"}${src ? ` <small>(${src})</small>` : ""}
    ${e.has_step ? "<br>Marche(s)" : ""}${e.is_crossing ? `<br>Bordures : ${e.kerb_lowered === null ? "inconnues" : e.kerb_lowered ? "abaissées" : "hautes"}
    · feu sonore : ${e.sound_signal === null ? "?" : e.sound_signal ? "oui" : "non"}` : ""}`;
}
function drawNetwork() {
  for (const e of net.edges)
    L.polyline(e.shape, {color: slopeColor(e), weight: e.is_crossing ? 4 : 3, opacity: .8,
      dashArray: e.slope_pct === null && !e.has_step ? "4 4" : null}).bindPopup(() => edgePopup(e)).addTo(layers.net);
  for (const [kind, lat, lon, name, status] of net.pois) {
    if (!POI[kind]) continue;
    L.marker([lat, lon], {icon: L.divIcon({className: "poi", html: POI[kind][0], iconSize: [20, 20]})})
      .bindPopup(`<b>${POI[kind][1]}</b>${name ? "<br>" + esc(name) : ""}${kind === "elevator" ? `<br>État : ${{ok: "en service", out_of_order: "en panne"}[status] || "inconnu"}` : ""}`)
      .addTo(layers.pois);
  }
  L.geoJSON(net.zone.boundary, {style: {color: "#1F4FD1", weight: 2, fill: false, dashArray: "6 6"}, interactive: false}).addTo(map);
  const legend = L.control({position: "bottomleft"});
  legend.onAdd = () => {
    const d = L.DomUtil.create("div", "legend");
    d.innerHTML = `<i style="background:#1a9850"></i>≤2 % <i style="background:#c5b000"></i>≤5 % <i style="background:#f46d43"></i>≤8 %<br>
      <i style="background:#d73027"></i>&gt;8 % <i style="background:#9a9a9a"></i>inconnue <i style="background:#7B2CBF"></i>marche`;
    return d;
  };
  legend.addTo(map);
  const sync = () => {
    const show = map.getZoom() >= 16;
    for (const l of [layers.net, layers.pois]) show ? l.addTo(map) : l.remove();
  };
  map.on("zoomend", sync);
  sync();
}
function drawReports() {
  layers.reports.clearLayers();
  for (const r of reports())
    L.marker([r.lat, r.lon], {icon: L.divIcon({className: "poi", html: "⚠️", iconSize: [22, 22]})})
      .bindPopup(`<b>${REPORT_KINDS.find(k => k[0] === r.kind)?.[1]}</b>${r.blocking ? " (bloquant)" : ""}<br>Expire le ${new Date(r.expires).toLocaleString("fr-FR")}`)
      .addTo(layers.reports);
}
function drawRoutes() {
  drawRealPosition();
  layers.routes.clearLayers();
  layers.marks.clearLayers();
  const sel = S.nav?.route || S.routes[S.selected];
  for (const r of S.routes) if (r !== sel)
    L.polyline(r.geometry.map(p => [p.lat, p.lon]), {color: "#B3261E", weight: 5, opacity: .6, dashArray: "2 8"}).addTo(layers.routes);
  if (sel) L.polyline(sel.geometry.map(p => [p.lat, p.lon]), {color: "#1F4FD1", weight: 8, opacity: .9}).addTo(layers.routes);
  if (!S.nav) {
    L.circleMarker([S.origin.lat, S.origin.lon], {radius: 10, color: "#fff", weight: 3, fillColor: "#0B5A36", fillOpacity: 1})
      .bindTooltip("Départ").addTo(layers.marks);
  }
  if (S.dest) L.circleMarker([S.dest.lat, S.dest.lon], {radius: 10, color: "#fff", weight: 3, fillColor: "#B3261E", fillOpacity: 1})
    .bindTooltip("Arrivée").addTo(layers.marks);
  if (S.nav) {
    S.nav.marker = L.marker([S.nav.here.lat, S.nav.here.lon], {icon: L.divIcon({className: "", html: '<div class="me"></div>', iconSize: [22, 22]})})
      .addTo(layers.marks);
  }
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
      "Le mode GPS réel ne guide que sur place, dans la zone couverte. Ailleurs, utilisez la simulation (avec la vue caméra 📷 si vous voulez).";
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
  L.circle([r.lat, r.lon], {radius: r.acc, color: "#E07A00", weight: 1, fillColor: "#FFB020", fillOpacity: .15, interactive: false}).addTo(realMarker);
  L.circleMarker([r.lat, r.lon], {radius: 8, color: "#fff", weight: 3, fillColor: "#E07A00", fillOpacity: 1})
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
  return `<h2>Comment vous déplacez-vous ?</h2><p>Plusieurs choix possibles.</p>
  ${MOB.map(([m, l]) => `<button class="chip-sel ${S.mobilities.has(m) ? "on" : ""}" data-mob="${m}">${l}</button>`).join("")}
  <div class="card"><b class="t">Mes limites</b>
    <p id="slopeLbl">${S.maxSlope == null ? "Pente maximale : réglage du profil" : `Pente maximale : ${S.maxSlope} %`}</p>
    <input type="range" min="2" max="12" step="1" value="${S.maxSlope ?? 5}" id="slope" aria-label="Pente maximale en pour cent">
    <div class="row"><span class="grow">J'accepte quelques marches</span><input type="checkbox" class="switch" id="steps" ${S.steps ? "checked" : ""} aria-label="J'accepte quelques marches"></div>
    <div class="row"><span class="grow">Consignes à la voix</span><input type="checkbox" class="switch" id="voice" ${S.voice ? "checked" : ""} aria-label="Consignes à la voix"></div>
  </div>
  <button class="big" id="cont">Continuer</button>
  ${standalone ? "" : installPrompt ? `<button class="outl full" id="install">📲 Installer sur l'écran d'accueil</button>`
    : `<p class="muted">📲 Pour l'installer : ${ios ? "bouton Partager ⎋ puis « Sur l'écran d'accueil »" : "menu ⋮ du navigateur puis « Ajouter à l'écran d'accueil »"}.</p>`}
  <p class="muted">Démonstration sur Gennevilliers : réseau OpenStreetMap (ODbL), pentes calculées depuis le relief IGN.
    Les itinéraires sont calculés sur ce téléphone ; les signalements y restent aussi.</p>`;
}
function screenRoute() {
  const chosen = S.routes[S.selected];
  return `<div class="row"><h2 class="grow">Où allez-vous ?</h2><button class="outl small" id="toProfile">Profil</button></div>
  <div class="row"><span class="grow muted">Départ : <b>${esc(S.origin.label)}</b></span><button class="outl small" id="gpsHere">📍 Ma position</button></div>
  <input type="text" id="q" placeholder="Adresse ou lieu à Gennevilliers" value="${esc(S.query)}" autocomplete="off" enterkeyhint="search">
  ${S.places.map((p, i) => `<div class="place" data-place="${i}">${esc(p.label)}<small>${p.type === "poi" ? "lieu" : "adresse"}</small></div>`).join("")}
  <div><p class="muted" style="margin-bottom:6px">Toucher le plan pour placer :</p>
    <div class="seg"><button data-pick="origin" class="${S.pick === "origin" ? "on" : ""}">le départ</button><button data-pick="dest" class="${S.pick === "dest" ? "on" : ""}">l'arrivée</button></div></div>
  ${S.message ? `<div class="msg">${esc(S.message)}</div>` : ""}
  ${S.routes.map((r, i) => routeCard(r, i)).join("")}
  ${S.routes.length ? `<button class="big" id="start" ${chosen?.accessible ? "" : "disabled"}>Démarrer le guidage</button>` : ""}`;
}
function routeCard(r, i) {
  const min = Math.ceil(r.duration_s / 60);
  const tags = r.accessible
    ? [`<span class="tag ${r.steps_count === 0 ? "ok" : "ko"}">${r.steps_count === 0 ? "0 marche" : r.steps_count + " marche(s)"}</span>`,
       `<span class="tag ${r.max_slope_pct <= 5 ? "ok" : "ko"}">Pente max ${fmt1(r.max_slope_pct)} %</span>`,
       ...r.warnings.filter(w => w !== "marche").map(w => `<span class="tag ko">${esc(w)}</span>`)]
    : r.blocking_issues.map(w => `<span class="tag ko">${esc(w)}</span>`);
  return `<div class="rcard ${i === S.selected ? "sel" : ""}" data-route="${i}" role="button"
      aria-label="${esc(r.label)}, ${min} minutes, ${short(r.length_m)}${r.accessible ? "" : ", non praticable"}">
    <div class="row"><b class="grow" style="font-size:18px">${esc(r.label)}</b><b style="font-size:22px">${min} min</b></div>
    <div class="tags">${tags.join("")}</div><div class="muted">${short(r.length_m)} · ${r.steps.length - 1} consignes</div></div>`;
}
function screenNav() {
  const n = S.nav, st = navState(), mins = Math.ceil(st.remaining / speed() / 60);
  return `<div class="row"><div class="stats grow"><div>${short(st.remaining)}<span>restants</span></div><div>${mins} min<span>à ${fmt1(speed() * 3.6)} km/h</span></div></div>
      <button class="outl small" id="arBtn" aria-label="Vue caméra">📷</button>
      <button class="outl small" id="hudBtn" aria-label="Vue lunettes">👓</button>
      <button class="outl small" id="voiceBtn" aria-label="${S.voice ? "Couper la voix" : "Activer la voix"}">${S.voice ? "🔊" : "🔇"}</button></div>
    <div class="seg"><button data-mode="sim" class="${n.mode === "sim" ? "on" : ""}">Simulation</button><button data-mode="gps" class="${n.mode === "gps" ? "on" : ""}">GPS réel</button></div>
    ${n.mode === "sim" ? `<div class="row"><button class="outl small grow" id="play">${n.timer ? "⏸ Pause" : n.arrived ? "Arrivé" : "▶ Marcher"}</button>
        <div class="seg grow">${[1, 5, 20].map(f => `<button data-speed="${f}" class="${n.factor === f ? "on" : ""}">×${f}</button>`).join("")}</div>
        <button class="outl small" id="rewind" aria-label="Recommencer">↺</button></div>`
      : n.gpsProblem ? `<div class="msg">📍 ${esc(n.gpsProblem)}</div>
          <div class="actions"><button class="outl small" data-mode="sim">Revenir à la simulation</button>
          ${n.real ? `<button class="outl small" id="showMe">Voir ma position</button>` : ""}</div>`
      : `<p class="muted">${esc(n.gpsInfo || "")} — marchez, les consignes suivent votre position.</p>`}
    ${S.message ? `<div class="msg">${esc(S.message)}</div>` : ""}
    <div class="actions"><button class="outl" id="toReport">⚠ Signaler</button>
      <button class="big dark" id="stop">Arrêter</button></div>`;
}
function screenReport() {
  return `<h2>Signaler un obstacle</h2><p>Le signalement est placé à votre position actuelle.</p>
  <div class="row"><span class="grow" style="font-size:17px">Je ne peux pas passer</span><input type="checkbox" class="switch" id="blk" ${S.blocking ? "checked" : ""}></div>
  ${REPORT_KINDS.map(([k, l]) => `<button class="outl full" data-report="${k}">${l}</button>`).join("")}
  ${S.message ? `<div class="msg">${esc(S.message)}</div>` : ""}
  <button class="big" id="back">Retour au guidage</button>`;
}
function navCard() {
  let el = document.querySelector(".navcard");
  if (S.screen !== "nav") { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.className = "navcard";
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
    sizes.observe(el);
  }
  const st = navState();
  el.innerHTML = `<span class="arr" aria-hidden="true">${ARROW[st.next.maneuver] || "↑"}</span>
    <div><div class="d">${st.arrived ? "Vous êtes arrivé" : short(st.toManeuver)}</div><div class="s">${esc(st.spoken)}</div>
    ${!st.arrived && st.next.alerts.length ? `<span class="alert">⚠ ${esc(st.next.alerts.join(" · "))}</span>` : ""}</div>`;
}
function renderHud() {
  const h = $("hud");
  h.hidden = !S.hud || !S.nav;
  if (h.hidden) return;
  const st = navState(), m = st.next.maneuver, r = S.nav.route, acc = S.hc ? "var(--yellow)" : "var(--cyan)";
  let body;
  if (st.arrived) body = `<div class="big" style="color:${acc}">Vous êtes arrivé</div><div></div>`;
  else if (S.hc) body = `<div class="main"><span class="arr" style="color:var(--yellow)">${ARROW[m] || "↑"}</span>
      <div><div class="verb" style="color:var(--yellow)">${VERB[m] || "TOUT DROIT"}</div><div class="dist">${short(st.toManeuver)}</div></div></div>`;
  else body = `<div class="main"><span class="arr" style="color:var(--cyan)">${ARROW[m] || "↑"}</span>
      <div><div class="dist" style="color:var(--cyan)">${short(st.toManeuver)}</div><div class="street">${esc(st.next.street)}</div></div></div>`;
  if (!st.arrived) body += st.next.alerts.length && st.toManeuver < 60
    ? `<div class="alert">⚠ ${esc(st.next.alerts[0])}<span>${esc(st.next.alerts.slice(1).join(", ") || st.next.street)}</span></div>`
    : S.hc ? "<div></div>" : `<div class="chips"><i>${r.steps_count === 0 ? "0 marche" : r.steps_count + " marche(s)"}</i><i>pente ${fmt1(r.max_slope_pct)} %</i>
        <span style="font-size:22px">${Math.ceil(st.remaining / speed() / 60)} min</span></div>`;
  h.innerHTML = body + `<div class="close">Vue lunettes (le noir est transparent) · toucher : fermer · appui long : contraste</div>`;
}

function render() {
  document.body.className = S.screen === "profile" || S.screen === "report" ? "full" : S.screen === "nav" ? "nav" : "";
  $("panel").innerHTML = {profile: screenProfile, route: screenRoute, nav: screenNav, report: screenReport}[S.screen]();
  bind();
  navCard();
  renderHud();
  if (net) { drawRoutes(); drawReports(); }
  setTimeout(() => map.invalidateSize(), 0);
}
function renderKeepFocus() {
  const q = $("q"), pos = q?.selectionStart;
  render();
  const q2 = $("q");
  if (q2 && q) { q2.focus(); q2.setSelectionRange(pos, pos); }
}
function renderNavLive() {
  if (S.screen === "nav") { $("panel").innerHTML = screenNav(); bind(); navCard(); }
  renderHud();
  if (S.nav?.marker) S.nav.marker.setLatLng([S.nav.here.lat, S.nav.here.lon]);
  if (S.screen === "nav" && S.nav) followPosition();
}
// Partie de la carte réellement visible : ni sous le bandeau bleu, ni sous le panneau
function visiblePadding() {
  const css = getComputedStyle(document.documentElement);
  const px = name => parseFloat(css.getPropertyValue(name)) || 0;
  const side = matchMedia("(orientation: landscape) and (max-height: 600px), (min-width: 768px) and (min-height: 601px)").matches;
  return {paddingTopLeft: [24, px("--card-h") + 24], paddingBottomRight: [24, (side ? 0 : px("--panel-h")) + 24]};
}
function followPosition() {
  map.panInside([S.nav.here.lat, S.nav.here.lon], {...visiblePadding(), animate: true});
}
// Mesure en continu la hauteur du panneau et du bandeau (rotation, clavier, contenu)
const sizes = new ResizeObserver(() => {
  const root = document.documentElement.style;
  root.setProperty("--panel-h", `${S.screen === "nav" ? $("panel").offsetHeight : 0}px`);
  const card = document.querySelector(".navcard");
  root.setProperty("--card-h", `${card ? card.offsetTop + card.offsetHeight : 0}px`);
  map.invalidateSize();
});
sizes.observe($("panel"));
sizes.observe($("map"));

function go(screen) { S.screen = screen; S.message = null; render(); }
function saveProfile() { store.set("va-profile", {mobilities: [...S.mobilities], maxSlope: S.maxSlope, steps: S.steps}); }

function bind() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e[ev] = fn; };
  const all = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  all("[data-mob]", b => b.onclick = () => { const m = b.dataset.mob; S.mobilities.has(m) ? S.mobilities.delete(m) : S.mobilities.add(m); render(); });
  on("slope", "oninput", e => { S.maxSlope = +e.target.value; $("slopeLbl").textContent = `Pente maximale : ${S.maxSlope} %`; });
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
    map.setView([S.nav.here.lat, S.nav.here.lon], 18, {animate: false});
    requestAnimationFrame(followPosition);
  });
  all("[data-mode]", b => b.onclick = () => setMode(b.dataset.mode));
  all("[data-speed]", b => b.onclick = () => { S.nav.factor = +b.dataset.speed; setSim(!!S.nav.timer); });
  on("play", "onclick", () => setSim(!S.nav.timer));
  on("showMe", "onclick", () => map.setView([S.nav.real.lat, S.nav.real.lon], 15));
  on("rewind", "onclick", () => { S.nav.arrived = false; S.nav.said.clear(); moveTo(0); });
  on("hudBtn", "onclick", () => { S.hud = true; renderHud(); });
  on("arBtn", "onclick", () => openAR({
    state: () => S.nav && {nav: S.nav, st: navState(), posAt, net, dest: S.dest, reports: reports(), speed: speed(),
                           mobility: primary(), mode: S.nav.mode, playing: !!S.nav.timer},
    togglePlay: () => setSim(!S.nav.timer),
    toast,
  }));
  on("voiceBtn", "onclick", () => { S.voice = !S.voice; store.set("va-voice", S.voice); if (!S.voice) speechSynthesis?.cancel(); renderNavLive(); });
  on("toReport", "onclick", () => { setSim(false); go("report"); });
  on("stop", "onclick", () => { stopNav(); S.nav = null; wakeLock?.release?.(); go("route"); });
  on("blk", "onchange", e => { S.blocking = e.target.checked; });
  all("[data-report]", b => b.onclick = () => {
    const at = S.nav.here;
    addReport(b.dataset.report, S.blocking, at);
    S.message = "Merci, obstacle enregistré sur ce téléphone.";
    if (S.blocking) {
      try {
        const res = computeRoutes(net, {origin: at, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
        startNav(res.routes[0]);
        S.nav.rerouted = {at: Date.now(), title: b.dataset.report === "elevator_out" ? "Ascenseur en panne" : "Trottoir bloqué"};
        if (S.nav.mode === "gps") setMode("gps");          // relance le suivi GPS sur le nouveau tracé
        S.message += " Itinéraire recalculé depuis votre position.";
      } catch (e) {
        S.message += " " + (e instanceof RoutingError ? e.message : e);
      }
    }
    render();
  });
  on("back", "onclick", () => go("nav"));
}

// Vue lunettes : toucher pour fermer, appui long pour le contraste élevé
let pressTimer = null;
$("hud").addEventListener("pointerdown", () => { pressTimer = setTimeout(() => { pressTimer = null; S.hc = !S.hc; renderHud(); }, 600); });
$("hud").addEventListener("pointerup", () => { if (pressTimer) { clearTimeout(pressTimer); S.hud = false; renderHud(); } });

window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (S.screen === "profile") render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.nav) requestWakeLock(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

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
  window.__va = {S, posAt, navState, moveTo, get net() { return net; }, addReport, reports};
