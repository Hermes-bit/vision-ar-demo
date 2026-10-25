// Téléphone virtuel : Vision AR dans un téléphone simulé, sur ordinateur (comme le simulateur d'iPhone du Mac,
// qui n'existe pas sous Windows). L'appli chargée dans le cadre confie au simulateur son GPS, sa boussole, son
// inclinaison et sa caméra (raccordement dans index.html, adresse « ?sim »). Ses vibrations et sa voix sont
// écrites dans le journal. On peut ainsi tout essayer sans sortir : marcher le long du trajet, tourner et pencher
// le téléphone, couper ou refuser le GPS, et voir si le ruban reste posé sur la rue virtuelle.
import {loadNetwork} from "./routing.js";
import {initTests} from "./telephone-tests.js";

const $ = id => document.getElementById(id);
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const norm = a => ((a % 360) + 360) % 360, angleDiff = (a, b) => ((a - b + 540) % 360) - 180;
const store = {get: (k, d) => { try { return JSON.parse(localStorage.getItem(`telephone-${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`telephone-${k}`, JSON.stringify(v)); } catch { /* navigation privée */ } }};
// Écran en points CSS ; safe : marges de sécurité de l'iPhone (barre d'état et barre d'accueil), données à l'appli
// comme sur le vrai téléphone (elle passe dessous, plein écran) ; status : hauteur de la barre d'état d'Android (opaque)
const DEVICES = {
  iphone15: {label: "iPhone 15", w: 393, h: 852, safe: [59, 34], status: 32, radius: 55},
  iphone15max: {label: "iPhone 15 Pro Max", w: 430, h: 932, safe: [59, 34], status: 32, radius: 58},
  iphonese: {label: "iPhone SE", w: 375, h: 667, safe: [20, 0], status: 24, radius: 6, flat: true},
  pixel8: {label: "Pixel 8", w: 412, h: 915, safe: [24, 0], status: 32, radius: 40, flat: true},
};
const device = () => DEVICES[store.get("device", "iphone15")] || DEVICES.iphone15;
const SITES = {test: ["Test", "index.html"], stable: ["Stable", "../vision-ar/index.html"], presentation: ["Présentation", "../vision-ar-presentation/index.html"]};
const UA = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};
const start = store.get("pos", {lat: 48.925767, lon: 2.295317});   // 9 Allée Maria Casarès, Gennevilliers
const sim = {
  win: null, linked: false, watchers: new Map(), watchId: 0, denied: new Set(), permStatuses: [],
  lat: start.lat, lon: start.lon, acc: 6, perm: "granted", gpsOff: false, gpsNoise: false,
  heading: 90, follow: true, tilt: 20, compassNoise: false, noiseVal: 0, disturbUntil: 0,
  camera: "street", os: store.get("os", "ios"), voice: true,
  walking: false, walkD: 0, speed: 1.2, fast: false, turn: null,
};

// ---- Journal ------------------------------------------------------------------------------------------------
function log(text) {
  const li = document.createElement("li"), t = new Date().toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
  li.innerHTML = `<time>${t}</time><span></span>`;
  li.querySelector("span").textContent = text;
  $("log").prepend(li);
  while ($("log").children.length > 60) $("log").lastChild.remove();
}

// ---- Raccordement de l'appli (appelé par index.html, avant le code de l'appli) --------------------------------
window.__vaSim = w => {
  Object.assign(sim, {win: w, linked: true, watchers: new Map(), denied: new Set(), permStatuses: []});
  const nav = w.navigator;
  const define = (obj, key, get) => { try { Object.defineProperty(obj, key, {get, configurable: true}); } catch { /* lecture seule */ } };
  define(nav, "userAgent", () => UA[sim.os]);
  define(nav, "platform", () => sim.os === "ios" ? "iPhone" : "Linux armv8l");
  define(nav, "maxTouchPoints", () => 5);
  // GPS : positions données par le simulateur (une par seconde, comme un téléphone)
  const geo = nav.geolocation;
  geo.watchPosition = (ok, ko) => { const id = ++sim.watchId; sim.watchers.set(id, {ok, ko}); setTimeout(() => feed(id), 300); return id; };
  geo.getCurrentPosition = (ok, ko) => setTimeout(() => feed(0, {ok, ko}), 300);
  geo.clearWatch = id => sim.watchers.delete(id);
  const query = nav.permissions?.query?.bind(nav.permissions);
  if (nav.permissions) nav.permissions.query = d => {
    if (d?.name !== "geolocation") return query(d);
    const st = {state: sim.perm, onchange: null};
    sim.permStatuses.push(st);
    return Promise.resolve(st);
  };
  // Caméra : rue virtuelle, webcam du PC, ou refus
  if (nav.mediaDevices) nav.mediaDevices.getUserMedia = () => cameraStream(w);
  // Boussole : autorisée (iPhone : la demande d'autorisation répond oui tout de suite)
  if (w.DeviceOrientationEvent) w.DeviceOrientationEvent.requestPermission = () => Promise.resolve("granted");
  // Écran tactile (boutons réservés au téléphone, comme « Orienter la carte »)
  const mm = w.matchMedia.bind(w);
  w.matchMedia = q => /pointer:\s*coarse/.test(q) ? {matches: true, media: q, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }} : mm(q);
  // Vibrations : l'iPhone n'en a pas dans Safari ; Android les écrit dans le journal
  if (sim.os === "ios") { try { Object.defineProperty(nav, "vibrate", {value: undefined, configurable: true}); } catch { /* */ } }
  else nav.vibrate = p => { log(`📳 Vibration ${JSON.stringify(p)}`); return true; };
  // Voix : écrite dans le journal (et dite par l'ordinateur si la case est cochée)
  const sp = w.speechSynthesis;
  if (sp) {
    const speak = sp.speak.bind(sp);
    sp.speak = u => {
      log(`🔊 ${u.text}`);
      if (sim.voice) return speak(u);
      setTimeout(() => u.onend?.({}), 400 + u.text.length * 45);
    };
  }
  const st = w.document.createElement("style");
  st.id = "va-sim-safe";
  w.document.head.append(st);
  applyInsets();
  setLink(true);
};
// iPhone : l'appli passe sous la barre d'état (plein écran) ; ses marges de sécurité sont celles de l'appareil.
// Android : barre d'état opaque au-dessus de l'appli, pas de marge.
function applyInsets() {
  const d = device(), ios = sim.os === "ios", [top, bottom] = ios ? d.safe : [0, 0];
  const st = sim.win?.document?.getElementById("va-sim-safe");
  if (st) st.textContent = `:root { --safe-top: ${top}px !important; --safe-bottom: ${bottom}px !important; }`;
  $("device").classList.toggle("overlay", ios);
}
function setLink(ok, text) {
  $("link").textContent = text || (ok ? `Appli raccordée : GPS, boussole et caméra simulés (${sim.os === "ios" ? "iPhone" : "Android"})` : "Appli non raccordée");
  $("link").classList.toggle("off", !ok);
}

// ---- GPS --------------------------------------------------------------------------------------------------------
function fix() {
  let {lat, lon} = sim;
  if (sim.gpsNoise) {                                     // position qui saute, de l'ordre de la précision annoncée
    const r = sim.acc * 0.45 * Math.sqrt(-2 * Math.log(Math.random() || 1e-9)), a = Math.random() * 2 * Math.PI;
    lat += r * Math.cos(a) / 111320; lon += r * Math.sin(a) / (111320 * Math.cos(rad(lat)));
  }
  return {coords: {latitude: lat, longitude: lon, accuracy: sim.acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null},
    timestamp: Date.now()};
}
function feed(id, w = sim.watchers.get(id)) {
  if (!w) return;
  if (sim.perm === "denied") {
    if (!sim.denied.has(id)) { sim.denied.add(id); w.ko?.({code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1}); }
    return;
  }
  if (sim.gpsOff) return;
  try { w.ok(fix()); } catch (e) { console.error(e); }
}
setInterval(() => { for (const [id, w] of sim.watchers) feed(id, w); }, 1000);
function setPermission(p, quiet = false) {
  sim.perm = p; sim.denied.clear();
  $("gps-denied").checked = p === "denied";
  for (const st of sim.permStatuses) { st.state = p; try { st.onchange?.(); } catch { /* */ } }
  if (!quiet) log(p === "denied" ? "📍 Localisation refusée" : "📍 Localisation autorisée (rechargez l'appli si elle l'avait déjà refusée)");
}
function setFast(on) { sim.fast = on; $("fast").checked = on; }

// ---- Boussole et inclinaison : 60 fois par seconde, comme les capteurs du téléphone ----------------------------
const REL0 = 123;                                         // référence quelconque du gyroscope (alpha relatif)
function sendOrientation(now) {
  const w = sim.win;
  if (!w || w.closed) return;
  sim.noiseVal = 0.92 * sim.noiseVal + (sim.compassNoise ? (Math.random() * 2 - 1) * 3 : 0);
  const H = sim.heading, Hc = norm(H + sim.noiseVal + (now < sim.disturbUntil ? 50 : 0)), beta = 90 - sim.tilt;
  const send = (type, props) => { try { const e = new w.Event(type); Object.assign(e, props); w.dispatchEvent(e); } catch { /* appli en cours de chargement */ } };
  const alphaRel = norm(360 - H + REL0);
  if (sim.os === "ios") send("deviceorientation", {alpha: alphaRel, beta, gamma: 0, absolute: false, webkitCompassHeading: Hc, webkitCompassAccuracy: sim.compassNoise ? 15 : 8});
  else {
    send("deviceorientation", {alpha: alphaRel, beta, gamma: 0, absolute: false});
    send("deviceorientationabsolute", {alpha: norm(360 - Hc), beta, gamma: 0, absolute: true});
  }
}

// ---- Caméra : rue virtuelle dessinée d'après les vrais cheminements ---------------------------------------------
// Même caméra que la vue de guidage (js/ar.js) : même hauteur, même champ (68° sur le grand côté), même cap et même
// inclinaison. Si le ruban glisse sur cette rue quand on tourne ou qu'on penche le téléphone, il glissera dans la vraie.
const VW = 540, VH = 960, FOCAL = (VH / 2) / Math.tan(rad(68) / 2), NEAR = 0.25;
const cams = new Set();
let net = null, nearEdges = [], nearAt = 0;
fetch("data/gennevilliers.json").then(r => r.json()).then(d => { net = loadNetwork(d); }).catch(() => log("Plan de la rue virtuelle indisponible"));
function cameraStream(w) {
  if (sim.camera === "refused") return Promise.reject(new w.DOMException("Permission denied", "NotAllowedError"));
  if (sim.camera === "webcam") return navigator.mediaDevices.getUserMedia({video: {width: 960, height: 540}, audio: false});
  const c = document.createElement("canvas");
  c.width = VW; c.height = VH;
  const stream = c.captureStream(30);
  cams.add({c, ctx: c.getContext("2d"), track: stream.getVideoTracks()[0]});
  return Promise.resolve(stream);
}
function camHeight() {
  const S = sim.win?.__va?.S, mobs = S ? (S.tripMob ? [S.tripMob] : [...S.mobilities]) : [];
  return mobs.some(m => m.includes("wheelchair")) ? 1.05 : 1.35;     // comme PHONE_HEIGHT_M de js/ar.js
}
const STYLE = {street: ["#6A7078", 6.5], sidewalk: ["#D4D0C6", 2.4], footway: ["#D4D0C6", 2.2], pedestrian: ["#DAD5CA", 4],
  path: ["#C9C0A8", 2], plaza: ["#DAD5CA", 4], steps: ["#B49A7A", 2], crossing: ["#F4F4F2", 3]};
const ORDER = ["street", "plaza", "pedestrian", "path", "footway", "sidewalk", "steps", "crossing"];
function refreshNear() {
  if (!net || performance.now() - nearAt < 1000) return;
  nearAt = performance.now();
  const k = Math.cos(rad(sim.lat)) * 111320, R = 110;
  nearEdges = net.edges.filter(e => STYLE[e.kind] && (e.shape.length ? e.shape : [[net.nodes[e.source].lat, net.nodes[e.source].lon]])
    .some(([la, lo]) => Math.abs((la - sim.lat) * 111320) < R && Math.abs((lo - sim.lon) * k) < R))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
function drawStreet(ctx) {
  const h = camHeight(), sy = Math.sin(rad(sim.heading)), cy = Math.cos(rad(sim.heading)), sp = Math.sin(rad(sim.tilt)), cp = Math.cos(rad(sim.tilt));
  const k = Math.cos(rad(sim.lat)) * 111320;
  const enu = (la, lo) => [(lo - sim.lon) * k, (la - sim.lat) * 111320];
  const toCam = (x, y) => { const f = x * sy + y * cy, r = x * cy - y * sy; return {r, v: f * sp - h * cp, d: f * cp + h * sp}; };
  const scr = c => [VW / 2 + c.r / c.d * FOCAL, VH / 2 - c.v / c.d * FOCAL];
  const poly = (pts, fill) => {                             // polygone au sol, coupé devant l'objectif
    const c = pts.map(([x, y]) => toCam(x, y)), out = [];
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length];
      if (a.d >= NEAR) out.push(a);
      if ((a.d >= NEAR) !== (b.d >= NEAR)) { const t = (NEAR - a.d) / (b.d - a.d); out.push({r: a.r + t * (b.r - a.r), v: a.v + t * (b.v - a.v), d: NEAR}); }
    }
    if (out.length < 3) return;
    ctx.beginPath(); out.forEach((q, i) => { const [X, Y] = scr(q); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  };
  // ciel, sol
  const yh = VH / 2 - FOCAL * Math.tan(rad(sim.tilt));
  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, yh));
  sky.addColorStop(0, "#A9CBE6"); sky.addColorStop(1, "#E6EEF2");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = "#9DA596"; ctx.fillRect(0, Math.max(0, yh), VW, VH);
  // cheminements, rues, passages piétons (largeurs typiques)
  refreshNear();
  for (const e of nearEdges) {
    const [color, width] = STYLE[e.kind], half = width / 2;
    const shape = e.shape.length >= 2 ? e.shape : [[net.nodes[e.source].lat, net.nodes[e.source].lon], [net.nodes[e.target].lat, net.nodes[e.target].lon]];
    for (let i = 1; i < shape.length; i++) {
      const [ax, ay] = enu(...shape[i - 1]), [bx, by] = enu(...shape[i]), L = Math.hypot(bx - ax, by - ay);
      if (!L || Math.hypot(ax, ay) > 120) continue;
      const nx = -(by - ay) / L * half, ny = (bx - ax) / L * half, ex = (bx - ax) / L * 0.3, ey = (by - ay) / L * 0.3;
      poly([[ax - ex + nx, ay - ey + ny], [bx + ex + nx, by + ey + ny], [bx + ex - nx, by + ey - ny], [ax - ex - nx, ay - ey - ny]], color);
      if (e.kind === "crossing") for (let s = 0.4; s < L; s += 1.0) {          // bandes du passage piéton
        const sx = ax + (bx - ax) * s / L, sy2 = ay + (by - ay) * s / L, ux = (bx - ax) / L * 0.25, uy = (by - ay) / L * 0.25;
        poly([[sx - ux + nx, sy2 - uy + ny], [sx + ux + nx, sy2 + uy + ny], [sx + ux - nx, sy2 + uy - ny], [sx - ux - nx, sy2 - uy - ny]], "#5E646C");
      }
    }
  }
  // quadrillage d'un mètre au sol, accroché à un point fixe du monde (pas au téléphone) : il montre si le ruban glisse
  ctx.strokeStyle = "rgba(15,37,55,.10)"; ctx.lineWidth = 1;
  const line = (x1, y1, x2, y2) => {
    let a = toCam(x1, y1), b = toCam(x2, y2);
    if (a.d < NEAR && b.d < NEAR) return;
    if (a.d < NEAR) { const t = (NEAR - a.d) / (b.d - a.d); a = {r: a.r + t * (b.r - a.r), v: a.v + t * (b.v - a.v), d: NEAR}; }
    if (b.d < NEAR) { const t = (NEAR - b.d) / (a.d - b.d); b = {r: b.r + t * (a.r - b.r), v: b.v + t * (a.v - b.v), d: NEAR}; }
    const [X1, Y1] = scr(a), [X2, Y2] = scr(b);
    ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
  };
  const px = (sim.lon - GRID0.lon) * k, py = (sim.lat - GRID0.lat) * 111320;          // téléphone dans le repère fixe
  for (let i = -20; i <= 20; i++) {
    const gx = Math.floor(px) + i - px, gy = Math.floor(py) + i - py;               // lignes x = entier, y = entier
    line(gx, -20, gx, 20); line(-20, gy, 20, gy);
  }
}
const GRID0 = {lat: 48.92, lon: 2.29};                     // origine fixe du quadrillage (Gennevilliers)
function renderCams() {
  for (const cam of cams) {
    if (cam.track.readyState === "ended") { cams.delete(cam); continue; }
    drawStreet(cam.ctx);
  }
}

// ---- Marche le long du trajet ---------------------------------------------------------------------------------
const distM = (a, b) => Math.hypot((b.lat - a.lat) * 111320, (b.lon - a.lon) * 111320 * Math.cos(rad(a.lat)));
const bearing = (a, b) => norm(deg(Math.atan2((b.lon - a.lon) * Math.cos(rad(a.lat)), b.lat - a.lat)));
let path = null;
function currentPath() {
  const S = sim.win?.__va?.S;
  const r = S && (S.nav?.route || (S.routes?.length ? S.routes[S.selected] || S.routes[0] : null));
  if (!r) return null;
  if (path && path.key === r.geometry && path.dest === S.dest) return path;
  const pts = r.geometry.map(p => ({lat: p.lat, lon: p.lon}));
  if (S.dest && distM(pts.at(-1), S.dest) > 3) pts.push({lat: S.dest.lat, lon: S.dest.lon});   // dernier bout jusqu'à la porte
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  path = {key: r.geometry, dest: S.dest, pts, cum, total: cum.at(-1)};
  sim.walkD = nearestAlong(path).d;                        // nouvel itinéraire (recalcul) : on reprend au plus près
  return path;
}
function pointAt(p, d) {
  d = Math.max(0, Math.min(p.total, d));
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < d) i++;
  const a = p.pts[i - 1], b = p.pts[i], f = (d - p.cum[i - 1]) / Math.max(1e-9, p.cum[i] - p.cum[i - 1]);
  return {lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f};
}
function nearestAlong(p) {
  let best = {d: 0, gap: Infinity};
  for (let d = 0; d <= p.total; d += 1) { const g = distM(pointAt(p, d), sim); if (g < best.gap) best = {d, gap: g}; }
  return best;
}
function toggleWalk() {
  if (sim.walking) { sim.walking = false; return syncUi(); }
  const p = currentPath();
  if (!p) return log("Choisissez d'abord une destination dans l'appli : le téléphone marchera le long de l'itinéraire.");
  const n = nearestAlong(p);
  if (n.gap > 30) { const s = p.pts[0]; Object.assign(sim, {lat: s.lat, lon: s.lon}); sim.walkD = 0; log("Téléphone placé au départ du trajet"); }
  else sim.walkD = n.d;
  sim.walking = true; syncUi();
}
function stepWalk(dt) {
  if (!sim.walking) return;
  const p = currentPath();
  if (!p) { sim.walking = false; return syncUi(); }
  sim.walkD += sim.speed * (sim.fast ? 5 : 1) * dt;
  if (sim.walkD >= p.total) { sim.walkD = p.total; sim.walking = false; log("🏁 Bout du trajet atteint"); syncUi(); }
  Object.assign(sim, pointAt(p, sim.walkD));
  if (sim.follow && !sim.turn) {                            // on se tourne vers la suite du chemin, comme en marchant
    const target = bearing(pointAt(p, sim.walkD), pointAt(p, sim.walkD + 5)), max = (sim.fast ? 360 : 120) * dt;
    const d = angleDiff(target, sim.heading);
    sim.heading = norm(sim.heading + Math.max(-max, Math.min(max, d)));
  }
}

// ---- Carte de contrôle ----------------------------------------------------------------------------------------
const map = L.map("map", {zoomControl: true, attributionControl: false}).setView([sim.lat, sim.lon], 17);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19}).addTo(map);
const pinIcon = () => L.divIcon({className: "phone-pin", iconSize: [30, 30], iconAnchor: [15, 15],
  html: `<svg viewBox="-15 -15 30 30"><path d="M0 -14 L7 4 L0 0 L-7 4 Z" fill="#007489" transform="rotate(${sim.heading.toFixed(0)})"/>
    <circle r="6" fill="#2F80ED" stroke="#fff" stroke-width="2.5"/></svg>`});
const pin = L.marker([sim.lat, sim.lon], {icon: pinIcon(), draggable: true, zIndexOffset: 1000}).addTo(map);
const accCircle = L.circle([sim.lat, sim.lon], {radius: sim.acc, color: "#2F80ED", weight: 1, fillOpacity: .1, interactive: false}).addTo(map);
let routeLine = null, lastPinHeading = null;
pin.on("drag", e => { sim.walking = false; Object.assign(sim, {lat: e.latlng.lat, lon: e.latlng.lng}); syncUi(); });
map.on("click", e => { sim.walking = false; Object.assign(sim, {lat: e.latlng.lat, lon: e.latlng.lng}); syncUi(); });
function updateMap() {
  pin.setLatLng([sim.lat, sim.lon]); accCircle.setLatLng([sim.lat, sim.lon]).setRadius(sim.acc);
  if (lastPinHeading === null || Math.abs(angleDiff(sim.heading, lastPinHeading)) > 2) { pin.setIcon(pinIcon()); lastPinHeading = sim.heading; }
  if (sim.walking && !map.getBounds().pad(-0.2).contains([sim.lat, sim.lon])) map.panTo([sim.lat, sim.lon], {animate: false});
}
setInterval(() => {                                        // itinéraire de l'appli, dessiné sur la carte de contrôle
  const S = sim.win?.__va?.S, r = S && (S.nav?.route || S.routes?.[S.selected]);
  const ll = r ? r.geometry.map(p => [p.lat, p.lon]) : null;
  if (routeLine && (!ll || routeLine._va !== r)) { routeLine.remove(); routeLine = null; }
  if (ll && !routeLine) { routeLine = L.polyline(ll, {color: "#00AECC", weight: 5, opacity: .85}).addTo(map); routeLine._va = r; }
  store.set("pos", {lat: sim.lat, lon: sim.lon});
}, 1000);

// ---- Cadran de la boussole --------------------------------------------------------------------------------------
const dial = $("dial");
dial.querySelector(".dial-ticks").innerHTML = Array.from({length: 36}, (_, i) =>
  `<line x1="0" y1="-74" x2="0" y2="${i % 9 === 0 ? -64 : -69}" transform="rotate(${i * 10})"/>`).join("");
let dialDrag = false;
const dialAt = e => {
  const r = dial.getBoundingClientRect();
  sim.heading = norm(deg(Math.atan2(e.clientX - r.left - r.width / 2, -(e.clientY - r.top - r.height / 2))));
  setFollow(false); syncUi();
};
dial.addEventListener("pointerdown", e => { dialDrag = true; dial.setPointerCapture(e.pointerId); dialAt(e); });
dial.addEventListener("pointermove", e => { if (dialDrag) dialAt(e); });
dial.addEventListener("pointerup", () => { dialDrag = false; });
dial.addEventListener("keydown", e => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); turn(e.key === "ArrowLeft" ? -10 : 10, 150); }
});
function turn(by, ms = 500) { setFollow(false); sim.turn = {from: sim.heading, by, t0: performance.now(), ms}; }
function setFollow(on) { sim.follow = on; $("follow").checked = on; }

// ---- Boucle : capteurs à 60 images/s, caméra à 30, carte à 10 ---------------------------------------------------
let lastT = performance.now(), lastCam = 0, lastMap = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (sim.turn) {                                          // rotation animée (boutons ↺ ↻)
    const f = Math.min(1, (now - sim.turn.t0) / sim.turn.ms), e = f < .5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    sim.heading = norm(sim.turn.from + sim.turn.by * e);
    if (f >= 1) sim.turn = null;
  }
  stepWalk(dt);
  sendOrientation(now);
  if (now - lastCam > 33) { lastCam = now; renderCams(); }
  if (now - lastMap > 100) { lastMap = now; updateMap(); $("heading-out").textContent = `${Math.round(sim.heading)}°`;
    $("needle").setAttribute("transform", `rotate(${sim.heading.toFixed(1)})`); }
}
requestAnimationFrame(loop);

// ---- Panneau ----------------------------------------------------------------------------------------------------
function syncUi() {
  $("acc-out").textContent = `${sim.acc} m`;
  $("speed-out").textContent = `${sim.speed.toFixed(1).replace(".", ",")} m/s`;
  $("tilt-out").textContent = `${sim.tilt}°`;
  $("walk").textContent = sim.walking ? "⏸ Arrêter de marcher" : "▶ Marcher le long du trajet";
}
function fitDevice() {
  const d = device(), el = $("device"), stage = el.parentElement;
  el.style.setProperty("--w", `${d.w}px`); el.style.setProperty("--h", `${d.h}px`);
  el.style.setProperty("--status", `${d.status}px`); el.style.setProperty("--radius", `${d.radius}px`);
  el.classList.toggle("flat", !!d.flat);
  const narrow = innerWidth <= 900, k = Math.min(1.15, (innerHeight - 32) / (d.h + 24), narrow ? (innerWidth - 32) / (d.w + 24) : 9);
  el.style.transform = `scale(${k.toFixed(3)})`;
  stage.style.width = `${Math.round((d.w + 24) * k)}px`; stage.style.height = `${Math.round((d.h + 24) * k)}px`;
  applyInsets();
}
function loadApp() {
  const [, url] = SITES[store.get("site", "test")] || SITES.test;
  sim.linked = false; setLink(false, "Chargement de l'appli…");
  path = null; sim.walking = false; syncUi();
  $("phone").src = `${url}?debug&sim`;
}
$("phone").addEventListener("load", () => {
  if (!sim.linked) setLink(false, "Ce site n'est pas encore raccordé au téléphone virtuel (GPS, boussole et caméra non simulés) : il le sera à sa prochaine mise à jour.");
});
for (const [id, d] of Object.entries(DEVICES)) $("device-pick").add(new Option(d.label, id));
for (const [id, [label]] of Object.entries(SITES)) $("site-pick").add(new Option(label, id));
$("device-pick").value = store.get("device", "iphone15");
$("site-pick").value = store.get("site", "test");
$("os-pick").value = sim.os;
$("device-pick").onchange = e => { store.set("device", e.target.value); fitDevice(); };
$("site-pick").onchange = e => { store.set("site", e.target.value); loadApp(); };
$("os-pick").onchange = e => { sim.os = e.target.value; store.set("os", sim.os); loadApp(); };
$("reload").onclick = loadApp;
$("acc").oninput = e => { sim.acc = +e.target.value; syncUi(); };
$("speed").oninput = e => { sim.speed = +e.target.value; syncUi(); };
$("fast").onchange = e => { sim.fast = e.target.checked; };
$("walk").onclick = toggleWalk;
$("gps-noise").onchange = e => { sim.gpsNoise = e.target.checked; };
$("gps-off").onchange = e => { sim.gpsOff = e.target.checked; log(sim.gpsOff ? "📍 GPS coupé" : "📍 GPS rétabli"); };
$("gps-denied").onchange = e => setPermission(e.target.checked ? "denied" : "granted");
$("follow").onchange = e => { sim.follow = e.target.checked; };
$("turn-l").onclick = () => turn(-45);
$("turn-r").onclick = () => turn(45);
$("tilt").oninput = e => { sim.tilt = +e.target.value; syncUi(); };
$("compass-noise").onchange = e => { sim.compassNoise = e.target.checked; };
$("disturb").onclick = () => { sim.disturbUntil = performance.now() + 2000; log("🧲 Perturbation magnétique : la boussole dévie de 50° pendant 2 s"); };
document.querySelectorAll("input[name=cam]").forEach(r => r.onchange = () => { sim.camera = r.value; log(`📷 Caméra : ${r.parentElement.textContent.trim()}`); });
$("voice").onchange = e => { sim.voice = e.target.checked; };
addEventListener("resize", fitDevice);
setInterval(() => { $("clock").textContent = new Date().toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit"}); }, 10000);
$("clock").textContent = new Date().toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit"});
syncUi(); fitDevice(); loadApp();
initTests({sim, loadApp, toggleWalk, turn, setFollow, setPermission, setFast});
