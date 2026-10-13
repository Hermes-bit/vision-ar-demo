// Vision AR — démo web mobile (installable sur l'écran d'accueil).
// Écrans repris de l'appli Android (phone/ui/Screens.kt) ; itinéraires calculés
// sur le téléphone par js/routing.js, copie fidèle du moteur du serveur.
import {arOpen, closeAR, currentHeading, openAR} from "./ar.js";
import {bindAuth, currentSession, logout, resetForm, screenLogin, screenSignup, screenWelcome} from "./auth.js";
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
const C = {route: "#00AECC", routeCase: "#00495A", alt: "#6B7C8F", primary: "#007489", unknown: "#5C6B7A", step: "#0F2537"};
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
  screen: !currentSession() ? "welcome" : saved ? "route" : "profile",
  mobilities: new Set(saved?.mobilities || ["manual_wheelchair"]), maxSlope: saved?.maxSlope ?? null, steps: saved?.steps ?? false,
  voice: store.get("va-voice", true), haptics: store.get("va-haptics", true), origin: {...MAIRIE}, dest: null, pick: "dest", query: "", places: [],
  routes: [], selected: 0, message: null, loading: false, nav: null, blocking: true, hud: false, hc: false,
};
let net = null;
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
const HAPTIC = {left: [160, 140, 160], right: [160, 140, 160, 140, 160], uturn: [70, 60, 70, 60, 70, 60, 70, 60, 70], arrive: [700], tick: [40]};
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
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · relief © IGN'}).addTo(map);
// Mention des sources fixée en haut à droite : elle ne suit plus le panneau quand on le fait glisser
map.attributionControl.setPosition("topright");
const layers = {pois: L.layerGroup(), reports: L.layerGroup().addTo(map),
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
function useMyPosition() {
  if (!navigator.geolocation) return toast("La localisation n'est pas disponible sur cet appareil.");
  toast("Recherche de votre position…");
  navigator.geolocation.getCurrentPosition(pos => {
    const p = {lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Ma position"};
    try {
      nearestNode(net, p.lat, p.lon);
    } catch {
      return toast("Vous êtes hors de la zone couverte (Gennevilliers) : le départ reste fixé sur le plan. " +
                   "Le guidage ne fonctionne que sur place, à Gennevilliers.", 6000);
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
           said: new Set(), off: 0, back: 0, dHist: [], offRoute: false, away: false, gap: 0, gapAlong: 0, arrived: false};
  requestWakeLock();
  const first = route.steps[0];
  say(`${first.text}. ${short(route.length_m)}, environ ${Math.ceil(route.length_m / speed() / 60)} minutes.`, true);
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
    if (!n.said.has("arrive")) { n.said.add("arrive"); n.arrived = true; say("Vous êtes arrivé.", true); buzz("arrive"); }
    return;
  }
  const i = st.idx + 1, alerts = st.next.alerts.length ? `. Attention : ${st.next.alerts.join(", ")}` : "";
  const side = turnSide(st.next.maneuver);
  if (st.toManeuver <= 60 && st.toManeuver > 20 && !n.said.has(`${i}-far`)) {
    n.said.add(`${i}-far`);
    say(`${st.spoken}${alerts}`);
    if (side) buzz(side);
  } else if (st.toManeuver <= 15 && !n.said.has(`${i}-now`)) {
    n.said.add(`${i}-now`); n.said.add(`${i}-far`);
    say(st.next.text, true);
    if (side) buzz(side);
  }
}
function moveTo(pos) {
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
function reroute(from, title, manual = false) {
  const n = S.nav;
  if (!manual && Date.now() - n.lastReroute < 10000) return;      // pas plus d'un recalcul automatique toutes les 10 s
  n.lastReroute = Date.now();
  n.off = 0;
  try {
    const res = computeRoutes(net, {origin: from, destination: S.dest, profile: profileJson(), compare_shortest: false}, reports());
    say(manual ? "Itinéraire recalculé depuis votre position." : "Vous vous êtes écarté de l'itinéraire. Nouvel itinéraire.", true);
    if (!manual) buzz("uturn");
    startNav(res.routes[0], true);
    S.routes = res.routes; S.selected = 0;
    S.nav.rerouted = {at: Date.now(), title};
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
    n.gpsProblem = `Vous êtes à ${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} km de Gennevilliers. ` +
      "Le guidage ne fonctionne que sur place, dans la zone couverte.";
    return renderNavLive();
  }
  // point le plus proche du tracé, sans revenir loin en arrière
  const g = n.route.geometry;
  let best = null;
  for (let i = 1; i < g.length; i++) {
    if (n.cum[i] < n.pos - 60) continue;
    const pr = project(p, g[i - 1], g[i]);
    if (!best || pr.d < best.d) best = {d: pr.d, along: n.cum[i - 1] + pr.t * (n.cum[i] - n.cum[i - 1])};
  }
  // Écart toléré : 20 m, plus si le GPS est imprécis (45 m au plus)
  const limit = Math.min(45, Math.max(20, 1.5 * acc));
  // Mauvaise rue prise à un carrefour : l'écart grandit à chaque mesure -> on n'attend pas les 20 m
  const h = n.dHist = [...n.dHist.slice(-3), best?.d ?? 0];
  const leaving = acc <= 15 && h.length === 4 && h[3] > 12 && h[1] > h[0] + 1.5 && h[2] > h[1] + 1.5 && h[3] > h[2] + 1.5;
  n.gap = best?.d ?? 0;
  n.gapAlong = best?.along ?? n.pos;
  // « À l'écart de l'itinéraire » (intérieur, cour) seulement si l'écart dépasse nettement l'erreur du GPS,
  // avec une marge pour ne pas basculer sans cesse : en ville le GPS se trompe souvent de 5 à 15 m.
  const enter = Math.max(15, 1.5 * acc), exit = Math.max(9, acc);
  n.away = n.away ? n.gap > exit : n.gap > enter;
  // Au départ (bâtiment, cour, parking), on guide jusqu'à l'itinéraire au lieu de le recalculer, jusqu'à 60 m
  const joining = n.pos < 5 && best && best.d <= 60;
  if (best && (best.d <= limit || joining) && !leaving) {
    n.off = 0; n.offRoute = false;
    if (n.away && n.pos < 5 && !n.said.has("join")) {          // départ depuis un bâtiment, une cour…
      n.said.add("join");
      say(`Rejoignez l'itinéraire, à ${Math.round(n.gap)} mètres. Suivez les pointillés.`, true);
    }
    if (best.along < n.pos - 12 && acc <= 25) {          // on remonte l'itinéraire à l'envers
      if (++n.back >= 3) { n.back = 0; n.pos = best.along; wrongWay(); }
    } else n.back = 0;
    return moveTo(Math.max(n.pos, best.along));
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
function steer() {
  const n = S.nav;
  if (!n || n.arrived || !S.haptics || S.screen !== "nav") return;
  const heading = currentHeading();
  if (heading === null || !n.real || Date.now() - n.real.at > 15000) return;
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
  return `<header class="hero">
    <div class="brand"><img src="icons/icon-192.png" alt="" width="40" height="40"><span class="grow">Vision AR</span>
      <button class="btn soft small" id="logout" aria-label="Se déconnecter">${icon("log-out")} Déconnexion</button></div>
    ${currentSession() ? `<p class="hello">Bonjour ${esc(currentSession().name.split(" ")[0])}&nbsp;!</p>` : ""}
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
    <div class="set-row static">${icon("map-pin")}<span class="grow">Ville</span><span class="set-val">Gennevilliers</span></div>
    ${sess ? `<div class="set-row static">${icon("user-round")}<span class="grow">Compte</span><span class="set-val">Bonjour ${esc(sess.name.split(" ")[0])}&nbsp;!</span></div>` : ""}
    ${row("setProfile", mob?.[2] || "accessibility", "Mon profil de mobilité", esc(mob?.[1] || ""))}
  </section>
  <section class="card"><h3>${icon("navigation")} Guidage</h3>
    ${sw("setVoice", "volume-2", "Consignes à la voix", S.voice)}
    ${sw("setHaptics", "vibrate", "Vibrations de direction", S.haptics)}
    ${row("testHaptics", "vibrate", "Tester la vibration", "", false)}
    ${hapticsNote() ? `<p class="fine">${icon("info")} ${esc(hapticsNote())}</p>` : ""}
  </section>
  <section class="card"><h3>${icon("glasses")} Apparence</h3><div class="themes">${themeCards("data-theme-pick")}</div></section>
  <section class="card"><h3>${icon("triangle-alert")} Mes signalements</h3>
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
      <p>La recherche d'adresse interroge le service public de la Géoplateforme (IGN) avec le texte saisi.</p>`)}
    ${info("file-text", "Conditions d'utilisation", `<p>Vision AR est une démonstration. Les itinéraires sont indicatifs : restez attentif à
      l'environnement, aux traversées et aux obstacles non signalés. Les données d'accessibilité peuvent être incomplètes.</p>`)}
    ${info("database", "Sources de données", `<p>Réseau piéton et lieux : © les contributeurs d'OpenStreetMap (licence ODbL).<br>
      Relief et pentes : © IGN (Géoplateforme, altimétrie).<br>Recherche d'adresse : Géoplateforme IGN.<br>
      Fond de carte : © OpenStreetMap.</p>`)}
    ${info("scale", "Mentions légales", `<p>Vision AR — Geomessen Burkina Faso.<br>Icônes : Lucide (licence ISC). Police : Atkinson Hyperlegible
      (licence SIL OFL).</p>`)}
  </section>
  <p class="fine set-version">Vision AR version ${APP_VERSION} · Geomessen Burkina Faso</p>`;
}
function screenRoute() {
  const chosen = S.routes[S.selected];
  return `<div class="sheet-head">
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
      <label class="search grow">${icon("search")}<input type="text" id="q" placeholder="Adresse ou lieu à Gennevilliers"
        value="${esc(S.query)}" autocomplete="off" enterkeyhint="search" aria-label="Destination"></label></div>
  </div>
  ${S.places.length ? `<div class="places">${S.places.map((p, i) => `<button class="place" data-place="${i}">
      ${icon(p.type === "poi" ? "map-pin" : "map")}<span class="grow">${esc(p.label)}<small>${p.type === "poi" ? "Lieu" : "Adresse"}</small></span>
      ${icon("chevron-right")}</button>`).join("")}</div>` : ""}
  <div class="pick"><span>${icon("map-pin")} Toucher le plan pour placer</span>
    <div class="seg"><button data-pick="origin" class="${S.pick === "origin" ? "on" : ""}">le départ</button>
      <button data-pick="dest" class="${S.pick === "dest" ? "on" : ""}">l'arrivée</button></div></div>
  ${S.dest ? `<div class="routes-head"><h3>${icon("route")} Choisissez votre itinéraire</h3>
    <button class="close-btn" id="closeRoutes" aria-label="Fermer le choix d'itinéraire">${icon("x")}<span>Fermer</span></button></div>` : ""}
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
    mobility: primary(), voice: S.voice, theme: S.theme, haptics: S.haptics, hapticsNote: hapticsNote(),
    gpsInfo: S.nav.gpsInfo, gpsProblem: S.nav.gpsProblem, gpsStatus: S.nav.gpsStatus},
  reroute: () => manualReroute(),
  nativeFix: (lat, lon, acc) => onGps({coords: {latitude: lat, longitude: lon, accuracy: acc}}, true),
  setHaptics: on => { S.haptics = on; store.set("va-haptics", on); if (on) buzz("left"); },
  toggleVoice: () => { S.voice = !S.voice; store.set("va-voice", S.voice); if (!S.voice) window.speechSynthesis?.cancel(); },
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
  document.body.className = authScreen ? "full auth-screen" : S.screen === "profile" || S.screen === "settings" ? "full" : nav ? "nav-ar" : "sheet";
  $("panel").innerHTML = nav ? "" : authScreen ? authScreen() : {profile: screenProfile, route: screenRoute, settings: screenSettings}[S.screen]();
  if (authScreen) bindAuth($("panel"), authCtx); else bind();
  renderHud();
  syncLayers();
  if (net) { drawRoutes(); drawReports(); }
  if (nav && !arOpen()) openAR(navApi);                 // dans le geste de l'usager : caméra et boussole autorisées
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

// ---- Retour / avancer : gestes, boutons et bouton « retour » du navigateur ----------------------
// Nos gestes et boutons reviennent en arrière directement : l'appli ne peut jamais être quittée
// par erreur. L'historique ne garde qu'une étape « sentinelle » : le bouton retour d'Android ou
// le geste retour de Safari reviennent alors d'un écran dans l'appli au lieu de la fermer.
let guarded = false;
function syncGuard() {
  if (!["profile", "welcome"].includes(S.screen) && !guarded) {
    try { history.pushState({va: true}, ""); guarded = true; } catch { /* sans historique */ }
  }
}
window.addEventListener("popstate", () => { guarded = false; stepBack(); syncGuard(); });
function back() { stepBack(); }
function stepBack() {
  if (S.screen === "signup") { resetForm(); return go("login"); }
  if (S.screen === "login") { resetForm(); return go("welcome"); }
  if (S.screen === "welcome") return;
  if (S.hud) { S.hud = false; renderHud(); return; }
  if (S.screen === "nav") return confirmQuit();
  if (S.screen === "route" && S.dest) return closeRoutes();
  if (S.screen === "route") return go("profile");
  if (S.screen === "settings") return go("route");
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
  if (swipe?.on && Math.abs(swipe.dx) >= SWIPE_MIN) {
    if (navigator.vibrate) navigator.vibrate(15);
    swipe.dx > 0 ? back() : forward();
  }
  swipe = null;
  swipeHint.hidden = true;
});
document.addEventListener("touchcancel", () => { swipe = null; swipeHint.hidden = true; });
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
  on("closeRoutes", "onclick", back);
  on("install", "onclick", async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); });
  on("toProfile", "onclick", () => go("profile"));
  on("gpsHere", "onclick", useMyPosition);
  on("q", "oninput", e => { S.query = e.target.value; search(S.query); });
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
