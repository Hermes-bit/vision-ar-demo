// Écran de guidage en réalité augmentée : la rue filmée par la caméra arrière,
// l'itinéraire dessiné au sol, une bulle de consigne ancrée dans la rue, une
// mini-carte en dôme et une barre de commandes en verre.
//
// Deux thèmes :
//   « verre » : ruban lumineux turquoise→vert à chevrons blancs, étiquettes en verre clair ;
//   « neon »  : grands chevrons lumineux au sol, repères en goutte flottant dans la rue.
//
// Pas de reconnaissance d'image : tout vient des données (itinéraire, signalements,
// bordures, marches, pentes, équipements) placées par la position GPS, la boussole
// et l'inclinaison du téléphone. Précision : quelques mètres.
//
// Le dessin colle au sol parce que la caméra virtuelle reproduit la vraie : même hauteur
// (debout ou en fauteuil), même direction (boussole), même inclinaison et même roulis
// (vecteur de gravité), même champ de vision (calculé d'après l'image vidéo affichée).
import {haversineM} from "./routing.js";
import {icon, ICONS} from "./icons.js";
import {sticker, stickerPop} from "./stickers.js";
import {BACKEND, captureSample, detect, lastLuma, loadModel, modelReady} from "./obstacles.js";
import {CORRIDOR, DIST_CALIB, MAX_SHOWN, TRAPEZE, corridor2D, halfAt, makeTracker, nextAnnouncement} from "./corridor.js";

// Hauteur du téléphone au-dessus du trottoir, tenu devant soi
const PHONE_HEIGHT_M = {standing: 1.35, wheelchair: 1.05};
const CAMERA_LONG_FOV_DEG = 68;   // champ de la caméra arrière principale sur le grand côté de l'image (iPhone ≈ 69°, Android 65-70°)
const VFOV_DEG = 62;              // sans image vidéo (ordinateur)
const AHEAD_M = 55;               // portée des repères (obstacles, bordures, marches)
const PATH_AHEAD_M = 15;          // le ruban ne montre que les 15 m devant soi (retour terrain : au-delà, il flottait)
const PLACES_M = 50;              // portée des étiquettes de lieux, par défaut (réglable dans les Paramètres : 20 à 130 m)
const NEAR_M = 0.6;
const BEHIND_M = 4;              // le ruban part de sous les pieds
const CHEV_START_M = 2;
const RING_DEG = 55;              // demi-ouverture de l'anneau de boussole du dôme
const THEMES = {
  // Verre (maquette 1) : ruban turquoise -> vert lumineux, chevrons blancs
  verre: {ribbon: true, half: 0.6, chevW: 0.62, chevL: 0.38, chevGap: 2.6, chevStroke: 0.09, chevRGB: "255,255,255", glow: "rgba(61,220,151,.9)", pins: false},
  // Néon (maquette 2) : grands chevrons turquoise lumineux, léger halo au sol
  neon: {ribbon: false, half: 0.75, chevW: 0.95, chevL: 0.55, chevGap: 2.4, chevStroke: 0.15, chevRGB: "140,244,248", glow: "rgba(91,224,234,1)", pins: true},
};
const TITLE = {left: "Tournez à gauche", slight_left: "Serrez à gauche", right: "Tournez à droite", slight_right: "Serrez à droite",
  uturn: "Faites demi-tour", straight: "Continuez tout droit", depart: "Continuez tout droit", arrive: "Vous arrivez"};
const MAN_ICON = {left: "corner-up-left", right: "corner-up-right", slight_left: "arrow-up-left", slight_right: "arrow-up-right",
  uturn: "uturn", straight: "arrow-up", depart: "navigation", arrive: "flag"};
const PROFILE = {manual_wheelchair: "Profil PMR", electric_wheelchair: "Profil PMR", cane_or_walker: "Mobilité réduite",
  low_vision: "Malvoyance", hard_of_hearing: "Malentendance", pedestrian: "Piéton"};
const REPORT_KINDS = [["works", "Travaux", "construction"], ["step", "Marche", "stairs"], ["street_furniture", "Mobilier urbain", "lamp-floor"],
  ["narrow_sidewalk", "Trottoir étroit", "narrow"], ["elevator_out", "Ascenseur en panne", "elevator"], ["parked_vehicle", "Véhicule garé", "car"],
  ["other", "Autre obstacle", "circle-alert"]];
// Lieux : icône, couleur, nom de catégorie (si le lieu n'a pas de nom)
const PLACE = {
  cafe: ["coffee", "#8D5B3E", "Café"], restaurant: ["utensils", "#D9480F", "Restaurant"], fast_food: ["sandwich", "#D9480F", "Restauration rapide"],
  bar: ["beer", "#A61E4D", "Bar"], bakery: ["croissant", "#B7791F", "Boulangerie"], food: ["shopping-basket", "#2B8A3E", "Alimentation"],
  shop: ["shopping-bag", "#6741D9", "Commerce"], clothes: ["shirt", "#6741D9", "Vêtements"], hairdresser: ["scissors", "#A61E4D", "Coiffeur"],
  health_shop: ["heart-pulse", "#C2255C", "Santé"], pharmacy: ["pill", "#2B8A3E", "Pharmacie"], doctor: ["stethoscope", "#1971C2", "Médecin"],
  hospital: ["hospital", "#C92A2A", "Hôpital"], bank: ["landmark", "#364FC7", "Banque"], post_office: ["mail", "#E67700", "La Poste"],
  townhall: ["landmark", "#007489", "Mairie"], library: ["book-open", "#5F3DC4", "Médiathèque"], school: ["graduation-cap", "#1864AB", "École"],
  police: ["shield", "#1864AB", "Police"], worship: ["church", "#495057", "Lieu de culte"], culture: ["drama", "#9C36B5", "Culture"],
  social: ["users", "#0B7285", "Services sociaux"], market: ["store", "#2B8A3E", "Marché"], hotel: ["bed", "#4263EB", "Hôtel"],
  park: ["trees", "#2B8A3E", "Parc"], sport: ["dumbbell", "#D9480F", "Sport"], bus_stop: ["bus", "#1971C2", "Arrêt de bus"],
  tram: ["tram-front", "#0C8599", "Tramway"], train: ["train-front", "#3B5BDB", "Gare"], metro: ["train-front", "#0B7285", "Métro"],
};
const WHEEL = {yes: ["#2B8A3E", "Accessible en fauteuil"], limited: ["#E67700", "Accès partiel"], no: ["#C92A2A", "Non accessible"]};
const POI = {elevator: ["elevator", "Ascenseur"], accessible_toilet: ["toilet", "WC adaptés"], disabled_parking: ["square-parking", "Place PMR"],
  accessible_entrance: ["door-open", "Entrée accessible"], audio_beacon: ["volume-2", "Balise sonore"]};

let arrivalCheered = false;
let api = null, root = null, video = null, canvas = null, ctx = null, stream = null, raf = 0, noCamera = false;
let sensors = {heading: null, pitch: null, roll: 0}, mapFull = false, sheet = null, domeGeom = null, domeObserver = null;
let camHeight = PHONE_HEIGHT_M.standing, view = null;     // view : origine et position lissées
let blocking = true, sheetMessage = null, lastUi = "";
// Détection d'obstacles (N°5, N°17, N°18)
let dets = [], detsAt = 0, detBusy = false, detState = "", lastPitch = 10, lastAutoSample = 0;
// Couloir de marche (js/corridor.js) : suivi des obstacles d'une image à l'autre, annonces une seule fois
const tracker = makeTracker();
let annState = {}, lastMovePos = null, lastMoveAt = 0;

// ---- Appli Android de terrain : ARCore Geospatial dessine le tracé sous la page (pont « VisionARNative ») ----
const NATIVE = globalThis.VisionARNative;
let nativeOn = false, nativeStatus = null, nativeRoute = null, nativeTheme = null, nativePosAt = 0;
globalThis.__vaNative = {
  onStatus(st) {
    nativeStatus = {...st, at: Date.now()};
    if (st.localized && st.hAcc > 0 && st.hAcc <= 5) api?.nativeFix?.(st.lat, st.lon, st.hAcc);
  },
};
const nativeLocalized = () => nativeOn && !!nativeStatus?.localized && Date.now() - nativeStatus.at < 2000;
const nativeHeading = () => nativeOn && nativeStatus && Date.now() - nativeStatus.at < 2000 &&
  nativeStatus.heading >= 0 && nativeStatus.yawAcc >= 0 && nativeStatus.yawAcc < 25 ? nativeStatus.heading : null;
function nativePayload(s) {
  return JSON.stringify({geometry: s.nav.route.geometry.map(p => [p.lat, p.lon]), pos: s.nav.pos, neon: s.theme === "neon", cameraHeight: camHeight});
}
function syncNative(s) {
  if (s.nav.route !== nativeRoute || s.theme !== nativeTheme) {
    nativeRoute = s.nav.route; nativeTheme = s.theme;
    NATIVE.setRoute(nativePayload(s));
  }
  if (performance.now() - nativePosAt > 500) { nativePosAt = performance.now(); NATIVE.setPos(s.nav.pos); }
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const round5 = m => m < 100 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;   // au mètre près sous 100 m
const dist = m => m < 1000 ? `${round5(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
const theme = () => THEMES[api.state()?.theme] || THEMES.verre;

// ---- Capteurs --------------------------------------------------------------------------
function screenAngle() { return (screen.orientation?.angle ?? window.orientation ?? 0) % 360; }
// Direction visée par la caméra arrière (méthode du W3C « compass heading ») : valable téléphone
// tenu droit ou incliné, quelle que soit l'orientation de l'écran.
function backCameraHeading(alpha, beta, gamma) {
  const d = Math.PI / 180, x = beta * d, y = gamma * d, z = alpha * d;
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  if (Math.hypot(vx, vy) < 0.15) return null;                  // téléphone à plat : direction indéfinie
  return (Math.atan2(vx, vy) / d + 360) % 360;
}
let lastAbsolute = 0;
function onOrientation(e) {
  if (typeof e.beta !== "number" || typeof e.gamma !== "number") return;
  let heading = null;
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
    heading = e.webkitCompassHeading;                                                // iPhone
    sensors.compassAcc = typeof e.webkitCompassAccuracy === "number" ? e.webkitCompassAccuracy : null;   // degrés, -1 = à calibrer
  }
  else if (e.absolute && typeof e.alpha === "number") { heading = backCameraHeading(e.alpha, e.beta, e.gamma); lastAbsolute = performance.now(); }
  else if (performance.now() - lastAbsolute < 2000) return;   // Android : l'événement relatif ne remplace pas l'absolu
  if (heading !== null) sensors.heading = heading;
  // Gravité dans le repère du téléphone -> inclinaison sous l'horizon et roulis de l'image
  const d = Math.PI / 180, cb = Math.cos(e.beta * d);
  const gx = cb * Math.sin(e.gamma * d), gy = -Math.sin(e.beta * d), gz = -cb * Math.cos(e.gamma * d);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -gz))) / d;
  const roll = Math.atan2(gx, -gy) / d + screenAngle();
  sensors.pitch = pitch;
  sensors.roll = ((roll + 540) % 360) - 180;
}
// Filtre « 1 € » (Casiez et al., 2012) : très lisse quand le téléphone bouge peu (les tremblements de la
// main et le bruit de la boussole disparaissent), réactif quand on tourne vraiment.
class OneEuro {
  constructor(minCutoff, beta, wrap = false) { Object.assign(this, {minCutoff, beta, wrap, x: null, dx: 0, t: 0}); }
  reset() { this.x = null; }
  filter(value, now) {
    if (this.x === null) { Object.assign(this, {x: value, dx: 0, t: now}); return value; }
    const dt = Math.max(0.001, Math.min(0.5, (now - this.t) / 1000));
    this.t = now;
    let d = value - this.x;
    if (this.wrap) d = ((d + 540) % 360) - 180;
    const a = c => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    this.dx += a(1) * (d / dt - this.dx);
    this.x += a(this.minCutoff + this.beta * Math.abs(this.dx)) * d;
    if (this.wrap) this.x = (this.x + 360) % 360;
    return this.x;
  }
}
// Réglage terrain (v66) : plus lisse qu'avant (le ruban et les étiquettes tremblaient), toujours réactif quand on tourne
const F = {heading: new OneEuro(0.15, 0.006, true), pitch: new OneEuro(0.25, 0.006), roll: new OneEuro(0.25, 0.006)};
async function startSensors() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
      await DeviceOrientationEvent.requestPermission();                                            // iPhone : autorisation
  } catch { /* refus : on suit le sens de l'itinéraire */ }
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
}
function stopSensors() {
  window.removeEventListener("deviceorientationabsolute", onOrientation);
  window.removeEventListener("deviceorientation", onOrientation);
}

// ---- Géométrie : monde (mètres autour de soi) -> écran ----------------------------------------
function enu(origin, p) {
  const k = Math.cos(origin.lat * Math.PI / 180);
  return {x: (p.lon - origin.lon) * k * 111320, y: (p.lat - origin.lat) * 111320, z: -camHeight};
}
// Focale en pixels du canevas : celle de la vidéo, à l'échelle de son affichage (object-fit: cover)
function focalPx(w, h) {
  const vw = video?.videoWidth, vh = video?.videoHeight;
  if (noCamera || !vw || !vh) return (h / 2) / Math.tan(VFOV_DEG * Math.PI / 360);
  const fVideo = (Math.max(vw, vh) / 2) / Math.tan(CAMERA_LONG_FOV_DEG * Math.PI / 360);
  return fVideo * Math.max(w / vw, h / vh);
}
function makeCamera(headingDeg, pitchDeg, rollDeg, w, h) {
  const yaw = headingDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180, roll = -rollDeg * Math.PI / 180;
  const f = focalPx(w, h);
  const sy = Math.sin(yaw), cyw = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch), sr = Math.sin(roll), cr = Math.cos(roll);
  return {
    toCam(p) {
      const fwd = p.x * sy + p.y * cyw, right = p.x * cyw - p.y * sy;
      return {r: right, v: fwd * sp + p.z * cp, d: fwd * cp - p.z * sp};
    },
    toScreen(c) {                                   // projection puis roulis autour du centre de l'image
      const x = c.r / c.d * f, y = -c.v / c.d * f;
      return [w / 2 + x * cr - y * sr, h / 2 + x * sr + y * cr];
    },
    scale(depth) { return f / depth; },
  };
}
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ina = a.d >= NEAR_M, inb = b.d >= NEAR_M;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (NEAR_M - a.d) / (b.d - a.d);
      out.push({r: a.r + t * (b.r - a.r), v: a.v + t * (b.v - a.v), d: NEAR_M});
    }
  }
  return out;
}
function fillGround(cam, pts) {               // polygone au sol, coupé devant l'objectif
  const c = clipNear(pts.map(p => cam.toCam(p)));
  if (c.length < 3) return false;
  ctx.beginPath();
  c.forEach((q, k) => { const [x, y] = cam.toScreen(q); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  return true;
}

// ---- Dessin du chemin ---------------------------------------------------------------------------
// Ligne centrale lissée (Chaikin) : les virages deviennent des courbes, comme sur les maquettes
function chaikin(pts, rounds = 2) {
  for (let r = 0; r < rounds; r++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push({x: a.x * .75 + b.x * .25, y: a.y * .75 + b.y * .25, z: a.z}, {x: a.x * .25 + b.x * .75, y: a.y * .25 + b.y * .75, z: a.z});
    }
    out.push(pts.at(-1));
    pts = out;
  }
  return pts;
}
// Bords gauche / droite d'une bande au sol, projetés à l'écran (coupés avant le premier point trop proche)
function bandEdges(cam, pts, half) {
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const l = cam.toCam({x: pts[i].x - dy * half, y: pts[i].y + dx * half, z: pts[i].z});
    const r = cam.toCam({x: pts[i].x + dy * half, y: pts[i].y - dx * half, z: pts[i].z});
    if (l.d < NEAR_M || r.d < NEAR_M) { if (left.length) break; continue; }
    left.push(cam.toScreen(l)); right.push(cam.toScreen(r));
  }
  return [left, right];
}
function bandPath(left, right) {
  ctx.beginPath();
  left.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k][0], right[k][1]);
  ctx.closePath();
}
function drawPath(cam, s, here, pos) {
  const t = theme(), dpr = devicePixelRatio;
  const raw = [], from = Math.max(0, pos - BEHIND_M), to = Math.min(s.nav.total, pos + PATH_AHEAD_M);
  for (let d = from; d < to; d += 1.5) raw.push(enu(here, s.posAt(d)));
  raw.push(enu(here, s.posAt(to)));
  if (raw.length < 3) return;
  const pts = chaikin(raw);
  const [left, right] = bandEdges(cam, pts, t.half);
  if (left.length < 2) return;
  const yNear = Math.max(left[0][1], right[0][1]), yFar = Math.min(left.at(-1)[1], right.at(-1)[1]);
  const fade = (c0, c1, c2) => {                          // opaque devant soi, transparent au loin
    const g = ctx.createLinearGradient(0, yNear, 0, Math.min(yNear - 1, yFar));
    g.addColorStop(0, c0); g.addColorStop(0.55, c1); g.addColorStop(1, c2);
    return g;
  };
  ctx.save();
  if (t.ribbon) {
    // halo, ruban, cœur clair : le « tapis lumineux » de la maquette 1
    ctx.shadowColor = t.glow; ctx.shadowBlur = 34 * dpr;
    bandPath(left, right);
    ctx.fillStyle = fade("rgba(0,174,204,.80)", "rgba(20,190,200,.62)", "rgba(61,220,151,0)");
    ctx.fill();
    ctx.shadowBlur = 0;
    const [cl, cr] = bandEdges(cam, pts, t.half * 0.35);
    if (cl.length > 1) { bandPath(cl, cr); ctx.fillStyle = fade("rgba(200,255,240,.55)", "rgba(170,250,225,.35)", "rgba(61,220,151,0)"); ctx.fill(); }
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = fade("rgba(255,255,255,.75)", "rgba(255,255,255,.35)", "rgba(255,255,255,0)");
    ctx.beginPath(); left.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    ctx.beginPath(); right.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  } else {
    // léger halo au sol sous les chevrons (maquette 2)
    bandPath(left, right);
    ctx.fillStyle = fade("rgba(91,224,234,.16)", "rgba(91,224,234,.08)", "rgba(91,224,234,0)");
    ctx.fill();
  }
  ctx.restore();

  // Chevrons « ^ » tracés au sol le long de la ligne lissée, à intervalle régulier
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.shadowColor = t.glow; ctx.shadowBlur = (t.ribbon ? 8 : 26) * dpr;
  // chevrons ancrés à l'itinéraire (ils ne glissent pas avec soi) : ils approchent, puis s'effacent sous les pieds
  let acc = 0, next = Math.ceil((pos - 1.5) / t.chevGap) * t.chevGap - from;
  const wave = (performance.now() / 1000 * 7) % (PATH_AHEAD_M + 6) - 1;   // onde lumineuse, de soi vers l'avant
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (!seg) continue;
    while (acc + seg >= next) {
      const f = (next - acc) / seg, ux = (b.x - a.x) / seg, uy = (b.y - a.y) / seg;
      const c = {x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z};
      const tip = {x: c.x + ux * t.chevL / 2, y: c.y + uy * t.chevL / 2, z: c.z};
      const back = (side) => ({x: c.x - ux * t.chevL / 2 - uy * side * t.chevW / 2, y: c.y - uy * t.chevL / 2 + ux * side * t.chevW / 2, z: c.z});
      const q = [back(1), tip, back(-1)].map(p => cam.toCam(p));
      if (q.every(v => v.d >= NEAR_M)) {
        const along = next - (pos - from);               // distance devant soi
        const passed = along < CHEV_START_M ? Math.max(0, (along + 1.5) / (CHEV_START_M + 1.5)) : 1;
        const pulse = Math.exp(-((along - wave) ** 2) / 3);
        const alpha = passed * Math.max(0, 1 - along / PATH_AHEAD_M) ** 0.8 * (0.5 + 0.5 * pulse);
        ctx.strokeStyle = `rgba(${t.chevRGB},${alpha.toFixed(3)})`;
        ctx.lineWidth = Math.max(1.5 * dpr, Math.min(16 * dpr, cam.scale(q[1].d) * t.chevStroke));
        ctx.beginPath();
        q.forEach((v, k) => { const [x, y] = cam.toScreen(v); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
      next += t.chevGap;
    }
    acc += seg;
  }
  ctx.restore();
}
// Pointillés au sol de sa position réelle jusqu'à l'itinéraire (à l'intérieur, sur le parking, à l'écart…)
function drawJoin(cam, here, target) {
  const t = theme(), end = enu(here, target), L = Math.hypot(end.x, end.y);
  if (L < 3) return;
  const ux = end.x / L, uy = end.y / L, w = 0.09;
  ctx.save();
  ctx.fillStyle = `rgba(${t.chevRGB},.9)`; ctx.shadowColor = t.glow; ctx.shadowBlur = 10 * devicePixelRatio;
  for (let d = 1; d < L - 0.3; d += 0.9) {
    const a = d, b = Math.min(L, d + 0.35), z = -camHeight;
    const quad = [{x: ux * a - uy * w, y: uy * a + ux * w, z}, {x: ux * b - uy * w, y: uy * b + ux * w, z},
                  {x: ux * b + uy * w, y: uy * b - ux * w, z}, {x: ux * a + uy * w, y: uy * a - ux * w, z}];
    if (fillGround(cam, quad)) ctx.fill();
  }
  ctx.restore();
}
// Sol quadrillé quand il n'y a pas d'image caméra (ordinateur, caméra refusée)
function drawGrid(cam, here, headingDeg) {
  const neon = api.state().theme === "neon";
  ctx.save();
  ctx.strokeStyle = neon ? "rgba(91,224,234,.18)" : "rgba(15,37,55,.12)";
  ctx.lineWidth = devicePixelRatio;
  const yaw = headingDeg * Math.PI / 180, fx = Math.sin(yaw), fy = Math.cos(yaw), rx = Math.cos(yaw), ry = -Math.sin(yaw);
  const line = (a, b) => {
    const c = clipNear([cam.toCam(a), cam.toCam(b)]);
    if (c.length < 2) return;
    const [x1, y1] = cam.toScreen(c[0]), [x2, y2] = cam.toScreen(c[1]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  const z = -camHeight;
  for (let r = -20; r <= 20; r += 4) line({x: rx * r + fx * 1, y: ry * r + fy * 1, z}, {x: rx * r + fx * 120, y: ry * r + fy * 120, z});
  for (let f = 2; f <= 120; f += 6) line({x: rx * -40 + fx * f, y: ry * -40 + fy * f, z}, {x: rx * 40 + fx * f, y: ry * 40 + fy * f, z});
  ctx.restore();
}

// ---- Repères dans la rue ----------------------------------------------------------------------------
function anchorsAhead(s, me) {
  const {nav, net, reports, posAt} = s, out = [], from = me || nav.here;
  let along = 0;
  for (const id of nav.route.edge_ids || []) {
    const e = net.edges[id];
    let len = 0;
    for (let i = 1; i < e.shape.length; i++) len += haversineM(e.shape[i - 1][0], e.shape[i - 1][1], e.shape[i][0], e.shape[i][1]);
    const ahead = along - nav.pos;
    if (ahead > -2 && ahead < AHEAD_M) {
      const at = posAt(along + Math.min(1.5, len / 2)), d = haversineM(from.lat, from.lon, at.lat, at.lon);
      if (e.is_crossing && e.kerb_lowered === true) out.push({at, label: "Trottoir abaissé", ic: "accessibility", ahead: d, color: "#1C7A4D", glow: "#3DDC97"});
      else if (e.is_crossing && e.kerb_lowered === false) out.push({at, label: "Bordure haute", ic: "triangle-alert", ahead: d, color: "#B42318", glow: "#FF6B5B"});
      if (e.is_crossing && e.sound_signal) out.push({at, label: "Feu sonore", ic: "volume-2", ahead: d + 0.01, color: "#1C7A4D", glow: "#3DDC97"});
      if (e.has_step) out.push({at, label: "Marche", ic: "stairs", ahead: d, color: "#7A4B00", glow: "#FFC24B"});
      if (e.slope_pct !== null && Math.abs(e.slope_pct) >= 5)
        out.push({at, label: `${e.slope_pct > 0 ? "Montée" : "Descente"} ${Math.abs(e.slope_pct).toFixed(0)} %`, ic: "mountain", ahead: d, color: "#7A4B00", glow: "#FFC24B"});
    }
    along += len;
  }
  for (const r of reports) {
    const d = haversineM(from.lat, from.lon, r.lat, r.lon);
    const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1);
    if (d < AHEAD_M) out.push({at: r, label: k[1], ic: k[2], ahead: d, color: "#B42318", glow: "#FF6B5B", obstacle: true});
  }
  for (const [cat, lat, lon, name, wheel] of net.places || []) {
    const d = haversineM(from.lat, from.lon, lat, lon);
    if (d > (s.placesRange ?? PLACES_M) || !PLACE[cat]) continue;
    const [ic, color, label] = PLACE[cat];
    out.push({at: {lat, lon}, label: name || label, ic, ahead: d, color, glow: "#5BE0EA", place: true, wheel: WHEEL[wheel]});
  }
  for (const [kind, lat, lon, name] of net.pois) {
    if (!POI[kind]) continue;
    const d = haversineM(from.lat, from.lon, lat, lon);
    if (d < (s.placesRange ?? PLACES_M)) out.push({at: {lat, lon}, label: POI[kind][1], sub: name, ic: POI[kind][0], ahead: d, color: "#007489", glow: "#5BE0EA", poi: true});
  }
  return out;
}
const iconCache = new Map();
function iconImage(name, color) {
  const key = name + color;
  if (!iconCache.has(key)) {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96" fill="none" stroke="${color}" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`);
    iconCache.set(key, img);
  }
  return iconCache.get(key);
}
function font(weight, px) { return `${weight} ${px}px "Atkinson Hyperlegible", system-ui, -apple-system, Roboto, sans-serif`; }

// Étiquette en verre (thème Verre)
function glassLabel(x, y, a, groundY = y + 18 * devicePixelRatio) {
  const dpr = devicePixelRatio, h = 36 * dpr, r = h / 2, ic = 22 * dpr;
  ctx.font = font(700, 15 * dpr);
  const w1 = ctx.measureText(a.label).width;
  ctx.font = font(400, 15 * dpr);
  const w2 = ctx.measureText(" " + dist(Math.max(1, a.ahead))).width;
  const badge = a.wheel ? 24 * dpr : 0;
  const w = 10 * dpr + ic + 8 * dpr + w1 + w2 + 14 * dpr + badge;
  const left = Math.max(8 * dpr, Math.min(canvas.width - w - 8 * dpr, x - w / 2)), top = y - h;
  ctx.save();
  ctx.shadowColor = "rgba(15,37,55,.25)"; ctx.shadowBlur = 12 * dpr; ctx.shadowOffsetY = 3 * dpr;
  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(left, top, w, h, r) : ctx.rect(left, top, w, h); ctx.fill();
  ctx.restore();
  ctx.fillStyle = a.color;
  ctx.beginPath(); ctx.arc(left + 10 * dpr + ic / 2, top + h / 2, ic / 2, 0, Math.PI * 2); ctx.fill();
  const img = iconImage(a.ic, "#ffffff");
  if (img.complete) ctx.drawImage(img, left + 10 * dpr + ic * 0.2, top + h / 2 - ic * 0.3, ic * 0.6, ic * 0.6);
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0F2537"; ctx.font = font(700, 15 * dpr);
  ctx.fillText(a.label, left + 18 * dpr + ic, top + h / 2 + dpr);
  ctx.fillStyle = "#4B5E70"; ctx.font = font(400, 15 * dpr);
  ctx.fillText(" " + dist(Math.max(1, a.ahead)), left + 18 * dpr + ic + w1, top + h / 2 + dpr);
  if (a.wheel) {                                        // badge fauteuil : vert / orange / rouge
    const bx = left + w - 14 * dpr - 9 * dpr, by = top + h / 2;
    ctx.fillStyle = a.wheel[0]; ctx.beginPath(); ctx.arc(bx, by, 10 * dpr, 0, Math.PI * 2); ctx.fill();
    const wi = iconImage("accessibility", "#ffffff");
    if (wi.complete) ctx.drawImage(wi, bx - 7 * dpr, by - 7 * dpr, 14 * dpr, 14 * dpr);
  }
  // petit trait vers le point au sol
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.moveTo(x, top + h); ctx.lineTo(x, groundY); ctx.stroke();
  ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(x, groundY, 4 * dpr, 0, Math.PI * 2); ctx.fill();
  return {left, top, w, h: h + 22 * dpr};
}
// Repère en goutte translucide (thème Néon)
function glassPin(x, y, a, H) {
  const dpr = devicePixelRatio;
  const W = H * 0.66, R = W / 2, cy = y - H + R;
  ctx.save();
  ctx.shadowColor = a.glow; ctx.shadowBlur = 24 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - R * 0.35, y - H * 0.3, x - R, cy + R * 0.55, x - R, cy);
  ctx.arc(x, cy, R, Math.PI, 0);
  ctx.bezierCurveTo(x + R, cy + R * 0.55, x + R * 0.35, y - H * 0.3, x, y);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, cy - R, 0, y);
  g.addColorStop(0, a.obstacle ? "rgba(255,107,91,.42)" : "rgba(0,174,204,.42)");
  g.addColorStop(1, a.obstacle ? "rgba(255,107,91,.08)" : "rgba(0,174,204,.06)");
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 1.6 * dpr; ctx.strokeStyle = a.obstacle ? "rgba(255,150,140,.9)" : "rgba(130,236,242,.9)"; ctx.stroke();
  ctx.restore();
  // pastille d'icône au sommet
  const s = Math.min(R * 1.05, 64 * dpr), bx = x - s / 2, by = cy - s / 2 - R * 0.15;
  ctx.save();
  ctx.fillStyle = a.obstacle ? "rgba(214,64,52,.85)" : a.place ? a.color : "rgba(0,174,204,.85)";
  ctx.shadowColor = a.glow; ctx.shadowBlur = 14 * dpr;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, s, s, s * 0.22) : ctx.rect(bx, by, s, s); ctx.fill();
  ctx.restore();
  const img = iconImage(a.ic, "#ffffff");
  if (img.complete) ctx.drawImage(img, bx + s * 0.18, by + s * 0.18, s * 0.64, s * 0.64);
  if (a.wheel) {
    const r = s * 0.2, cx = bx + s, cy2 = by;
    ctx.fillStyle = a.wheel[0]; ctx.beginPath(); ctx.arc(cx, cy2, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = "#fff"; ctx.stroke();
    const wi = iconImage("accessibility", "#ffffff");
    if (wi.complete) ctx.drawImage(wi, cx - r * 0.7, cy2 - r * 0.7, r * 1.4, r * 1.4);
  }
  // nom sous la pastille, distance à droite
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#fff";
  ctx.font = font(700, Math.max(12, Math.min(18, s / dpr * 0.3)) * dpr);
  ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 4 * dpr;
  const fs = Math.max(12, Math.min(18, s / dpr * 0.3)) * dpr;
  const tw = ctx.measureText(a.label).width, tx = Math.max(tw / 2 + 8 * dpr, Math.min(canvas.width - tw / 2 - 8 * dpr, x));
  ctx.fillText(a.label, tx, by + s + 6 * dpr);
  ctx.font = font(400, fs * 0.9);
  ctx.fillStyle = "#CFF7FA";
  ctx.fillText(dist(Math.max(1, a.ahead)), tx, by + s + 8 * dpr + fs);
  ctx.shadowBlur = 0; ctx.textAlign = "start";
  return {left: x - R, top: cy - R, w: W, h: H};
}
// ---- Où suis-je vraiment ? -----------------------------------------------------------------------------
// Les étiquettes se placent depuis la VRAIE position GPS (et non la position ramenée sur l'itinéraire), lissée
// pour ne pas sauter à chaque mesure : plus le GPS est imprécis, plus le lissage est lent.
let obs = null;
function observer(s, fallback) {
  const r = s.nav.real;
  // pas de position récente : rien (sur ordinateur, sans boussole, on montre depuis le point de vue du trajet)
  if (!r || Date.now() - r.at > 15000) return fallback ? {...fallback, acc: 0} : null;
  const now = performance.now();
  if (!obs || haversineM(obs.lat, obs.lon, r.lat, r.lon) > 80) obs = {lat: r.lat, lon: r.lon, acc: r.acc, t: now};
  else {
    const k = 1 - Math.exp(-Math.min(1, (now - obs.t) / 1000) / (1.5 + r.acc / 8));
    obs = {lat: obs.lat + (r.lat - obs.lat) * k, lon: obs.lon + (r.lon - obs.lon) * k, acc: r.acc, t: now};
  }
  return obs;
}
// Boussole utilisable : sur iPhone, précision annoncée ≤ 25° (−1 = à calibrer) ; ailleurs, pas d'information
const compassOk = () => sensors.compassAcc === null || sensors.compassAcc === undefined || (sensors.compassAcc >= 0 && sensors.compassAcc <= 25);
// Erreur d'angle possible pour un repère à d mètres quand la position est connue à acc mètres près
const angleError = (acc, d) => Math.atan2(acc, Math.max(1, d)) * 180 / Math.PI;
const MAX_LABEL_ERROR_DEG = 12;                 // au-delà, l'étiquette pourrait pointer à côté : on ne l'affiche pas
const labelSmooth = new Map();                  // position à l'écran lissée, par étiquette

// Étiquettes : chacune est accrochée à SA position fixe sur la carte. On calcule la direction (cap) depuis soi,
// et on la dessine sur la ligne d'horizon de la caméra (plus bas quand c'est proche). Ce placement ne dépend pas
// de la hauteur du téléphone : il reste juste à l'étage d'un immeuble comme dans la rue. Une étiquette dont la
// direction est trop incertaine (GPS imprécis pour sa distance, boussole à calibrer) n'est pas affichée.
function drawAnchors(cam, s, me) {
  const dpr = devicePixelRatio, w = canvas.width, h = canvas.height, neon = theme().pins;
  if (!me || !compassOk()) { labelSmooth.clear(); return; }
  // les plus proches d'abord : si deux repères se gênent, le plus lointain attend d'être plus près
  const rank = a => a.obstacle ? 0 : a.place || a.poi ? 2 : 1;   // obstacles d'abord, puis le trajet, puis les lieux
  const anchors = anchorsAhead(s, me).filter(a => angleError(me.acc, a.ahead) <= MAX_LABEL_ERROR_DEG)
    .sort((a, b) => rank(a) - rank(b) || a.ahead - b.ahead).slice(0, 10);
  const taken = reservedAreas(), toDraw = [], seen = new Set();
  const topLimit = (root.querySelector(".top")?.getBoundingClientRect().bottom ?? 0) * dpr + 6 * dpr;
  for (const a of anchors) {
    const p = enu(me, a.at);
    p.z = 0;                                           // à hauteur des yeux : sur l'horizon, quelle que soit l'altitude
    const c = cam.toCam(p);
    if (c.d < 2) continue;
    let [x, y] = cam.toScreen(c);
    y += Math.min(h * 0.14, 520 * dpr / c.d);          // proche : un peu sous l'horizon ; loin : sur l'horizon
    // téléphone penché vers le sol : l'horizon passe derrière la consigne. Seule la DIRECTION (gauche / droite)
    // compte : l'étiquette descend dans la zone visible, au même endroit horizontalement.
    const domeTop = (root.querySelector(".dome")?.getBoundingClientRect().top ?? h / dpr) * dpr;
    y = Math.max(topLimit + (neon ? 150 : 80) * dpr, Math.min(domeTop - 20 * dpr, y));
    // lissage à l'écran (les petites secousses de la main ne font plus danser les étiquettes)
    const key = `${a.label}|${a.at.lat}|${a.at.lon}`, prev = labelSmooth.get(key);
    seen.add(key);
    if (prev && Math.abs(prev.x - x) < w / 3) { x = prev.x + (x - prev.x) * 0.25; y = prev.y + (y - prev.y) * 0.25; }
    labelSmooth.set(key, {x, y});
    if (x < -60 * dpr || x > w + 60 * dpr || y < topLimit || y > h) continue;
    // taille de la goutte : selon la distance, mais jamais sous les pastilles ou l'alerte du haut
    const ceiling = Math.max(0, ...taken.filter(t => t.ui && !t.bubble && t.top + t.h <= y).map(t => t.top + t.h));
    const H = Math.min(Math.max(70 * dpr, Math.min(240 * dpr, cam.scale(c.d) * 3.2)), y - ceiling - 12 * dpr);
    if (neon && H < 56 * dpr) continue;
    const est = neon ? {left: x - H * 0.33, top: y - H, w: H * 0.66, h: H} : {left: x - 90 * dpr, top: y - 70 * dpr, w: 180 * dpr, h: 60 * dpr};
    if (!neon) {                                       // même calage que glassLabel (repoussée du bord d'écran)
      ctx.font = font(700, 15 * dpr);
      est.w = ctx.measureText(a.label).width + (a.wheel ? 134 : 110) * dpr;
      est.left = Math.max(8 * dpr, Math.min(w - est.w - 8 * dpr, x - est.w / 2));
    } else if (x - H * 0.4 < 0 || x + H * 0.4 > w) continue;      // goutte entière à l'écran
    const pad = 6 * dpr;
    const hit = t => est.left < t.left + t.w + pad && t.left < est.left + est.w + pad && est.top < t.top + t.h + pad && t.top < est.top + est.h + pad;
    let labelY = y - 24 * dpr;
    if (!neon) {                                       // gênée : elle remonte, reliée à son point par un trait
      for (let tries = 0; tries < 4; tries++) {
        const t = taken.find(hit);
        if (!t) break;
        labelY = t.top - 8 * dpr;
        est.top = labelY - 36 * dpr; est.h = 36 * dpr;
      }
      if (taken.some(hit) || est.top < Math.max(ceiling, topLimit)) continue;
    } else if (taken.some(t => hit(t) && !t.bubble)) continue;       // une goutte peut passer derrière la bulle
    taken.push(est);
    toDraw.push(() => neon ? glassPin(x, y, a, H) : glassLabel(x, labelY, a, y));
  }
  for (const k of labelSmooth.keys()) if (!seen.has(k)) labelSmooth.delete(k);
  toDraw.reverse().forEach(draw => draw());          // les lointains d'abord, les proches par-dessus
}
// ---- Obstacles vus par la caméra -----------------------------------------------------------------------------
// Point de l'image vidéo (coordonnées normalisées 0–1) -> pixels du canevas (vidéo affichée en « cover »)
function videoToCanvas(nx, ny) {
  const W = canvas.clientWidth, H = canvas.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
  const sc = Math.max(W / vw, H / vh), dpr = devicePixelRatio;
  return [((W - vw * sc) / 2 + nx * vw * sc) * dpr, ((H - vh * sc) / 2 + ny * vh * sc) * dpr];
}
// Fréquence d'analyse : au plus ~3 images par seconde en marchant, 1 en mode économie, 1 toutes les 2 s à
// l'arrêt (aucun progrès d'1 m depuis 6 s). En arrière-plan : aucune analyse.
function detectInterval(s) {
  const now = performance.now(), pos = s.nav.pos;
  if (lastMovePos === null || Math.abs(pos - lastMovePos) > 1) { lastMovePos = pos; lastMoveAt = now; }
  return now - lastMoveAt > 6000 ? 2000 : s.eco ? 1000 : 300;
}
function runDetection(s) {
  if (document.hidden || detBusy || performance.now() - detsAt < detectInterval(s) || !video?.videoWidth) return;
  if (!modelReady()) {
    if (detState !== "loading" && detState !== "error") {
      detState = "loading"; lastUi = "";
      loadModel().then(() => { detState = "ready"; lastUi = ""; }).catch(e => { console.warn("Détecteur d'obstacles :", e?.message || e); detState = "error"; lastUi = ""; });
    }
    return;
  }
  detBusy = true;
  // seuil 0,3 pour repérer les cas douteux (collecte d'images) ; seuls ceux ≥ 0,5 sont suivis et annoncés
  detect(video, s.detectDebug ? 0.25 : 0.3).then(found => {
    dets = found; detsAt = performance.now();
    for (const d of dets) d.ground = corridor2D(d.box, video.videoWidth, video.videoHeight);
    // seuls les objets sûrs (≥ 50 %) dont le bas est dans le trapèze du couloir alimentent le suivi
    // de nuit (image sombre), le détecteur est moins sûr de lui : seuil 0,4 au lieu de 0,5 (terrain du 19/10 :
    // potelet devant soi non signalé). Le suivi sur plusieurs images évite les fausses alertes isolées.
    const minScore = lastLuma < 70 ? 0.4 : CORRIDOR.minScore;
    tracker.update(dets.filter(d => d.alert && d.score >= minScore && d.ground), detsAt);
    obstacleAlerts(s);
    autoSample(s);
  }).catch(() => {}).finally(() => { detBusy = false; });
}
// Alerte (voix + vibration) : obstacle confirmé dans le couloir, une seule fois, le plus proche d'abord,
// avec le côté pour passer (« Potelet à droite, environ 3 mètres, passez à gauche »)
function obstacleAlerts(s) {
  const a = nextAnnouncement(tracker, performance.now(), annState, {wheelchair: (s.mobility || "").includes("wheelchair")});
  if (a) api.obstacleAlert(a.text);
}
// Repères à l'écran : au plus 3 obstacles du couloir, un anneau orange au pied de l'objet et son nom (pas de boîte)
function drawCorridorMarks() {
  if (performance.now() - detsAt > 2500) return;
  const dpr = devicePixelRatio;
  ctx.save();
  ctx.font = font(700, 14 * dpr); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  for (const t of tracker.confirmed().slice(0, MAX_SHOWN)) {
    if (!t.g) continue;
    const [x, y] = videoToCanvas(t.g.nx, t.g.ny);
    const r = Math.max(14 * dpr, Math.min(70 * dpr, 60 * dpr / t.dist));
    ctx.lineWidth = 4 * dpr; ctx.strokeStyle = "#FF8A00"; ctx.shadowColor = "rgba(255,138,0,.8)"; ctx.shadowBlur = 14 * dpr;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.35, 0, 0, 2 * Math.PI); ctx.stroke();
    ctx.shadowBlur = 0;
    const text = `${t.label} · ≈ ${Math.max(1, Math.round(t.dist))} m`, tw = ctx.measureText(text).width + 14 * dpr;
    ctx.fillStyle = "rgba(15,37,55,.85)"; ctx.fillRect(x - tw / 2, y - r * 0.35 - 30 * dpr, tw, 24 * dpr);
    ctx.fillStyle = "#FFB45C"; ctx.fillText(text, x, y - r * 0.35 - 10 * dpr);
  }
  ctx.restore();
}
// Collecte automatique (si l'usager l'a accepté) : images où le modèle hésite, une toutes les 20 s au plus
function autoSample(s) {
  if (!s.dataConsent || !s.autoLowConf || performance.now() - lastAutoSample < 20000) return;
  if (!dets.some(d => d.alert && d.score >= 0.3 && d.score < 0.5)) return;
  lastAutoSample = performance.now();
  captureSample(video, {kind: "faible_confiance", detections: dets, meta: sampleMeta(s)}).catch(() => {});
}
function sampleMeta(s) {
  const r = s.nav.real;
  return {lat: r?.lat, lon: r?.lon, accuracy: r?.acc, heading: Math.round(F.heading.x ?? -1), pitch: Math.round(lastPitch)};
}
// Mode test : toutes les détections encadrées, avec le nom et le score
function drawDetections() {
  if (!video?.videoWidth) return;
  const dpr = devicePixelRatio;
  // couloir (trapèze) et graduations de distance : pour calibrer DIST_CALIB sur le terrain
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 2 * dpr; ctx.setLineDash([8 * dpr, 6 * dpr]);
  const T = TRAPEZE, pts = [[0.5 - T.topHalf, T.top], [0.5 + T.topHalf, T.top], [0.5 + T.bottomHalf, 1], [0.5 - T.bottomHalf, 1]].map(([x, y]) => videoToCanvas(x, y));
  ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]); ctx.font = font(700, 12 * dpr); ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
  for (const [y, d] of DIST_CALIB) {
    const [x0, yy] = videoToCanvas(0.5 - halfAt(y), Math.min(y, 0.995)), [x1] = videoToCanvas(0.5 + halfAt(y), y);
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(`${String(d).replace(".", ",")} m`, x1 + 6 * dpr, yy);
  }
  ctx.fillText(`détecteur : ${BACKEND || "…"}`, 12 * dpr, videoToCanvas(0, T.top)[1] - 14 * dpr);
  ctx.restore();
  if (performance.now() - detsAt > 4000) return;              // jusqu'au résultat suivant (téléphone lent : jusqu'à 4 s)
  ctx.save();
  ctx.lineWidth = 3 * dpr; ctx.font = font(700, 14 * dpr); ctx.textBaseline = "top";
  for (const d of dets) {
    const g = d.ground, W = canvas.clientWidth, H = canvas.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.max(W / vw, H / vh);
    const raw = [(W - vw * sc) / 2 + d.box[0] * sc, (H - vh * sc) / 2 + d.box[1] * sc, d.box[2] * sc, d.box[3] * sc];
    // boîte ramenée dans la partie visible de l'écran (un objet tout proche dépasse souvent du cadre)
    const top = (root.querySelector(".top")?.getBoundingClientRect().bottom ?? 0) + 4;
    const x0 = Math.max(2, raw[0]), y0 = Math.max(top, raw[1]), x1 = Math.min(W - 2, raw[0] + raw[2]), y1 = Math.min(H - 2, raw[1] + raw[3]);
    if (x1 - x0 < 8 || y1 - y0 < 8) continue;
    const [x, y, w, h] = [x0, y0 + 22, x1 - x0, y1 - y0 - 22].map(v => v * dpr);
    const strong = d.alert && d.score >= 0.5 && !!g;                 // orange : sûr ET dans le couloir
    ctx.strokeStyle = strong ? "#FF8A00" : "rgba(255,255,255,.85)";
    ctx.strokeRect(x, y, w, h);
    const text = `${d.label} ${Math.round(d.score * 100)} %${g ? ` · ${g.dist.toFixed(1).replace(".", ",")} m` : ""}`;
    const tw = ctx.measureText(text).width + 10 * dpr;
    ctx.fillStyle = strong ? "#FF8A00" : "rgba(15,37,55,.85)";
    ctx.fillRect(x, Math.max(0, y - 22 * dpr), tw, 22 * dpr);
    ctx.fillStyle = strong ? "#04222B" : "#fff";
    ctx.fillText(text, x + 5 * dpr, Math.max(0, y - 22 * dpr) + 4 * dpr);
  }
  ctx.restore();
}
// N°12 : gros repère posé sur la destination, visible dès qu'elle est dans le champ, qui grossit à l'approche ;
// il disparaît une fois l'arrivée confirmée (la flèche aussi : on ne superpose jamais les deux)
function drawDestination(cam, s, here) {
  const dest = s.dest;
  if (!dest || s.st.arrived) return;
  const d = haversineM(here.lat, here.lon, dest.lat, dest.lon);
  if (d > 150) return;
  const c = cam.toCam(enu(here, dest));
  if (c.d < 1.5) return;
  const [x, y] = cam.toScreen(c), dpr = devicePixelRatio;
  if (x < 0 || x > canvas.width || y < 0) return;
  const label = dest.label || "";
  const ic = /arr[eê]t|bus/i.test(label) ? "bus" : /m[ée]tro|gare|rer|station/i.test(label) ? "train-front" : /tram/i.test(label) ? "tram-front" : "flag";
  const H = Math.max(110 * dpr, Math.min(280 * dpr, cam.scale(c.d) * 3.6));
  glassPin(x, Math.min(y, canvas.height), {label: "Arrivée", ic, ahead: d, color: "#C92A2A", glow: "#FF6B5B", place: true}, H);
}
function reservedAreas() {
  const dpr = devicePixelRatio, out = [];
  for (const el of root.querySelectorAll(".top, .dome, .dock")) {
    const r = el.getBoundingClientRect();
    if (r.width) out.push({left: r.left * dpr, top: r.top * dpr, w: r.width * dpr, h: r.height * dpr, ui: true, bubble: false});
  }
  return out;
}

// ---- Orientation ---------------------------------------------------------------------------------
function routeBearing(s) {
  // On regarde vers le prochain virage (au plus 15 m devant) : le chemin file droit devant puis tourne,
  // comme sur la maquette. Juste avant le virage, on regarde déjà un peu dans la nouvelle direction.
  const turnAt = s.nav.stepAt[s.st.idx + 1] ?? s.nav.total;
  let ahead = Math.min(15, turnAt - s.nav.pos);
  if (ahead < 3) ahead = 8;
  const a = s.posAt(s.nav.pos), b = s.posAt(Math.min(s.nav.total, s.nav.pos + ahead));
  if (a.lat === b.lat && a.lon === b.lon) return F.heading.x ?? 0;   // (sans boussole : ordinateur, capteurs refusés)
  const k = Math.cos(a.lat * Math.PI / 180);
  return (Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
}
// ---- Boucle d'affichage -------------------------------------------------------------------------------
let lastFrameAt = 0;
function frame() {
  raf = requestAnimationFrame(frame);
  const s = api.state();
  if (!s) return;
  // Économie de batterie (loin du prochain virage et des obstacles) : 20 images par seconde au lieu de 60
  if (s.eco && performance.now() - lastFrameAt < 48) return;
  lastFrameAt = performance.now();
  const dpr = devicePixelRatio, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  if (nativeOn) syncNative(s);
  // démonstration : la vue suit le sens du trajet (pas la boussole du téléphone, qui n'est pas dans la rue simulée)
  const now = performance.now(), nh = nativeHeading(), compass = !s.simulated && (nh !== null || sensors.heading !== null);
  const heading = F.heading.filter(nh ?? (compass ? sensors.heading : routeBearing(s)), now);
  document.documentElement.style.setProperty("--heading", `${heading.toFixed(1)}deg`);
  const pitch = F.pitch.filter(Math.max(-30, Math.min(80, sensors.pitch ?? 10)), now);   // sans capteur : téléphone presque droit
  const roll = compass ? ((F.roll.filter(sensors.roll + 180, now) + 360) % 360) - 180 : 0;
  const cam = makeCamera(heading, pitch, roll, w, h);
  lastPitch = pitch;
  const v = viewpoint(s);
  ribbonA += (ribbonTarget(s, compass) - ribbonA) * 0.08;   // fondu doux, jamais de saut
  if (!mapFull && !nativeOn) {                             // (appli Android : ARCore dessine le tracé lui-même)
    if (noCamera) drawGrid(cam, v.here, heading);
    if (ribbonA > 0.02 && !s.st.arrived) {
      ctx.save(); ctx.globalAlpha = ribbonA;
      drawPath(cam, s, v.here, v.pos);
      ctx.restore();
    }
    // pointillés vers l'itinéraire : seulement si la position est connue à 8 m près (sinon ils mentiraient)
    const accNow = precision(s);
    if (s.st.final && s.dest && !recal && compassOk()) drawJoin(cam, v.here, s.dest);   // pointillés jusqu'à la porte
    if (v.join && !s.st.arrived && !recal && compassOk() && (!compass || (accNow !== null && accNow <= 15))) drawJoin(cam, v.here, v.join);
    drawAnchors(cam, s, observer(s, compass ? null : v.here));
    drawDestination(cam, s, v.here);
    if (s.detect && !noCamera) { runDetection(s); if (s.detectDebug) drawDetections(); else drawCorridorMarks(); }
  }
  renderUi(s, heading, compass);
}
// Un seul repère visuel : le ruban au sol. Il ne montre jamais un tracé faux : il pâlit quand la position
// devient imprécise (8 à 25 m d'incertitude) et disparaît au-delà, ou pendant le recalage après une pause de
// l'appli. La voix et la consigne écrite prennent alors le relais.
let ribbonA = 0, recal = null;          // recal : {since (horloge), at (performance)} pendant le recalage
function precision(s) {
  const r = s.nav.real;
  return r && Date.now() - r.at < 15000 ? r.acc : null;
}
function ribbonTarget(s, compass) {
  const r = s.nav.real;
  if (recal) {
    // fin du recalage : une position GPS reçue APRÈS le retour, assez précise, et la boussole stabilisée (2 s)
    if (r && r.at > recal.since && r.acc <= 20 && performance.now() - recal.at > 2000) { recal = null; lastUi = ""; }
    else return 0;
  }
  if (!compass) return 1;                                   // ordinateur : pas de GPS de terrain, on montre tout
  // Le ruban est posé au sol depuis la position sur l'itinéraire : il n'a de sens que si l'on y est vraiment
  // (pas à l'intérieur, pas à l'écart), avec un GPS précis et une boussole fiable. Sinon : la voix et le plan.
  const n = s.nav;
  if (n.phase !== "route" || n.offRoute || n.away || !compassOk()) return 0;
  const acc = precision(s);
  // terrain de nuit (19/10) : GPS à 14 m en permanence, le ruban ne s'affichait jamais. Plein jusqu'à 8 m,
  // de plus en plus pâle jusqu'à 25 m, masqué au-delà.
  return acc === null || acc > 25 ? 0 : acc <= 8 ? 1 : 1 - 0.6 * (acc - 8) / 17;
}
// Retour dans l'appli après une pause (écran verrouillé, autre appli) : l'ancien calage est faux. On efface
// le ruban, on annonce « Recalage en cours », on remet à zéro filtres et suivi, et on relance la caméra.
function onVisibility() {
  if (!root || root.hidden) return;
  if (document.visibilityState === "hidden") { hiddenAt = performance.now(); return; }
  if (performance.now() - hiddenAt < 1500) return;
  recal = {since: Date.now(), at: performance.now()};
  ribbonA = 0; view = null; lastUi = ""; obs = null; labelSmooth.clear();
  Object.values(F).forEach(f => f.reset());
  tracker.reset(); dets = [];
  api.say?.("Recalage en cours, gardez le téléphone devant vous.", 1);   // niveau CONSIGNE (js/speech.js)
  const track = stream?.getVideoTracks()[0];
  if (!nativeOn && !noCamera && !mapFull && (!track || track.readyState === "ended" || video.paused)) startCamera();
}
let hiddenAt = 0;
// Point de vue : sur l'itinéraire, la position projetée sur le tracé (le ruban part de sous les pieds).
// À l'écart du tracé (à l'intérieur, de l'autre côté de la rue, hors itinéraire), la vraie position GPS :
// le ruban reste à sa vraie place dans la rue et des pointillés montrent comment le rejoindre.
// Glissement lent entre deux mesures GPS pour que les lignes ne sautent pas.
let lastView = 0;
function viewpoint(s) {
  const n = s.nav, fresh = n.real && Date.now() - n.real.at < 15000;
  const away = !!(fresh && (n.offRoute || n.away));
  const target = away ? {lat: n.real.lat, lon: n.real.lon} : s.posAt(n.pos);
  const now = performance.now(), k = 1 - Math.exp(-Math.min(1, (now - lastView) / 1000) / 1.6);
  lastView = now;
  // Glissement doux, y compris quand on passe de « sur l'itinéraire » à « à l'écart » : plus de saut du tracé
  if (!view || haversineM(view.here.lat, view.here.lon, target.lat, target.lon) > 60) view = {here: {...target}, pos: n.pos};
  else {
    view.here = {lat: view.here.lat + (target.lat - view.here.lat) * k, lon: view.here.lon + (target.lon - view.here.lon) * k};
    view.pos += (n.pos - view.pos) * k;
  }
  view.join = away ? s.posAt(n.gapAlong ?? n.pos) : null;
  return view;
}
export const currentHeading = () => (arOpen() ? nativeHeading() ?? sensors.heading : null);

// ---- Interface (DOM) -----------------------------------------------------------------------------------
function chip(cls, ic, label, value) {
  return `<div class="chip ${cls}"><span class="chip-ic">${icon(ic)}</span><span><small>${label}</small><b>${value}</b></span></div>`;
}
function renderUi(s, heading, compass) {
  const st = s.st, next = st.next, r = s.nav.route;
  const eta = new Date(Date.now() + st.remaining / s.speed * 1000).toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit"});
  const after = s.nav.route.steps[st.idx + 2];
  const crossing = next.alerts.some(a => a.startsWith("Traversée"));
  const sub = st.arrived ? (s.dest?.label || "") : crossing ? `puis traversez au passage piéton${next.alerts.some(a => a.includes("feu sonore")) ? " (feu sonore)" : ""}`
    : next.maneuver === "arrive" ? (s.dest?.label || "") : `puis ${dist(next.distance_m)} ${next.street ? "· " + next.street : "tout droit"}`;
  const approach = !st.arrived && s.nav.phase === "approach";
  const joining = !st.arrived && !approach && !s.nav.offRoute && s.nav.away;
  const acc = s.nav.real && Date.now() - s.nav.real.at < 15000 ? s.nav.real.acc : null;
  const vague = !nativeLocalized() && (acc === null || acc > 20);       // N°9 : pas de virage « au mètre près »
  // N°1 : la consigne dit ce qu'il faut faire MAINTENANT, comme la flèche. Loin du virage : « Continuez »,
  // le virage à venir est annoncé dessous ; à 25 m : « Tournez à gauche ».
  const turnSoon = st.toManeuver <= 25 && !vague;
  const upcoming = (TITLE[next.maneuver] || "Continuez tout droit");
  const title = st.arrived ? "Vous êtes arrivé" : st.final ? "Continuez jusqu'à l'adresse" : approach ? "Rejoignez l'itinéraire" : joining ? "Rejoignez l'itinéraire"
    : vague ? "Position approximative" : turnSoon || next.maneuver === "straight" ? upcoming : "Continuez tout droit";
  const manIcon = approach || joining ? "footprints" : st.arrived ? MAN_ICON.arrive
    : turnSoon ? MAN_ICON[next.maneuver] || "arrow-up" : vague ? "navigation" : "arrow-up";
  const away = st.arrived ? "" : st.final ? dist(st.toDest) : approach ? dist(s.nav.approachDist) : joining ? dist(s.nav.gap) : (vague ? "≈ " : "") + dist(st.toManeuver);
  const lowerUp = upcoming.charAt(0).toLowerCase() + upcoming.slice(1);
  // les pointillés ne sont dessinés que si la position est précise (≤ 8 m) : le texte dit la même chose que l'écran
  const dots = !compass || (acc !== null && acc <= 8 && compassOk());
  const subText = approach ? (dots ? "suivez les pointillés jusqu'au trottoir : le trajet commence là" : "le départ du trajet est indiqué sur le plan")
    : joining ? (dots ? `suivez les pointillés jusqu'à l'itinéraire, puis ${lowerUp}` : `revenez vers l'itinéraire indiqué sur le plan, puis ${lowerUp}`)
    : st.arrived ? sub
    : st.final ? "suivez les pointillés jusqu'à la porte"
    : vague ? `prochain virage : ${lowerUp}, dans environ ${dist(st.toManeuver)}`
    : turnSoon ? sub : `dans ${dist(st.toManeuver)} : ${lowerUp}${next.street ? " · " + next.street : ""}`;
  // N°8 : « Données à confirmer » ne s'affiche plus pendant le guidage (il reste sur la fiche de l'itinéraire)
  const shownAlerts = next.alerts.filter(a => !a.startsWith("Traversée") && a !== "Données à confirmer");
  const rer = s.nav.rerouted && Date.now() - s.nav.rerouted.at < 10000 ? s.nav.rerouted : null;
  const haz = s.nav.hazard && Date.now() - s.nav.hazard.at < 6000 ? s.nav.hazard : null;   // alerte de proximité : 6 s à l'écran
  const banner = haz ? `<div class="banner danger" role="alert">${icon(haz.ic)}<span><b>${esc(haz.label)}</b> à ${haz.dist} m, ${esc(haz.where)}</span></div>`
    : rer ? `<div class="banner danger">${icon("triangle-alert")}<span><b>${esc(rer.title)}</b> Itinéraire recalculé</span></div>`
    : s.gpsProblem && s.gpsDenied ? `<button class="banner warn banner-btn" data-act="gps-help">${icon("map-pin")}<span>${esc(s.gpsProblem)}</span>${icon("chevron-right")}</button>`
    : s.gpsProblem ? `<div class="banner warn">${icon("map-pin")}<span>${esc(s.gpsProblem)}</span></div>`
    : s.gpsInfo ? `<div class="banner ${s.nav.offRoute ? "warn" : "info"}">${icon(s.nav.offRoute ? "route" : "locate-fixed")}<span>${esc(s.gpsInfo)}</span></div>` : "";
  const alt = s.alt;
  if (st.arrived && !arrivalCheered) { arrivalCheered = true; stickerPop("bien-arrive", 2400); }   // une seule fois par trajet
  if (!st.arrived) arrivalCheered = false;
  const html = `
    <div class="top">
      <div class="chips">${chip("c-steps", "stairs", "Marches", r.steps_count)}${chip("c-eta", "clock", "Arrivée", eta)}${chip("c-dist", "route", "Distance", dist(st.remaining))}</div>
      <div class="bubble"><i class="bubble-ic">${icon(manIcon)}</i>
        <div class="bubble-txt"><b>${esc(title)}</b><span>${esc(subText)}</span>
        ${nativeOn && !nativeLocalized() && !st.arrived ? `<em class="arrow-note">${icon("camera")} ${esc(nativeStatus?.message || "Localisation précise en cours : filmez les façades et la rue autour de vous.")}</em>` : ""}
        ${!nativeOn && recal && !st.arrived ? `<em class="arrow-note">${icon("locate-fixed")} Recalage en cours : gardez le téléphone devant vous</em>` : ""}
        ${!nativeOn && !recal && compass && !compassOk() && !st.arrived ? `<em class="arrow-note">${icon("compass")} Boussole à calibrer : décrivez un 8 avec le téléphone</em>` : ""}
        ${!nativeOn && !recal && compass && compassOk() && (acc === null || acc > 25) && !st.arrived ? `<em class="arrow-note">${icon("volume-2")} Position imprécise${acc !== null ? ` (à ${Math.round(acc)} m près)` : ""} : tracé et repères masqués, suivez la voix</em>` : ""}
        ${s.simulated && !st.arrived ? `<em class="arrow-note">${icon("play")} Démonstration : le trajet défile tout seul</em>` : ""}
        ${s.detect && !nativeOn && detState === "loading" ? `<em class="arrow-note">${icon("scan-eye")} Chargement du détecteur d'obstacles…</em>` : ""}
        ${s.detect && !nativeOn && detState === "error" ? `<em>${icon("triangle-alert")} Détecteur d'obstacles indisponible (connexion ?)</em>` : ""}
        ${!st.arrived && !approach && !joining && shownAlerts.length ? `<em>${icon("triangle-alert")} ${esc(shownAlerts.join(" · "))}</em>` : ""}</div>
        ${away ? `<strong class="bubble-dist">${away}</strong>` : ""}${st.arrived ? sticker("bien-arrive", "stk-arrive") : ""}</div>
      ${banner}
    </div>
    <div class="dome-credit" aria-hidden="true">© OpenStreetMap · OpenFreeMap · OpenMapTiles</div>
    <div class="dome-ui">
      ${alt ? `<div class="alt-note">${esc(alt)}</div>` : ""}
      <div class="rose ${compass ? "on" : ""}" role="img" aria-label="${compass ? "Boussole active" : "Boussole indisponible : la vue suit le sens de l'itinéraire"}">
        <span class="needle"></span><i>N</i></div>
    </div>
    <nav class="dock" aria-label="Commandes du guidage">
      <button class="round" data-act="settings" aria-label="Réglages du guidage">${icon("sliders-horizontal")}<span aria-hidden="true">Réglages</span></button>
      <button class="pill" data-act="map">${icon(mapFull ? "camera" : "map")}<span>${mapFull ? "Caméra" : "Plan"}</span></button>
      <button class="center" data-act="report" aria-label="Signaler un obstacle">${icon("triangle-alert")}</button>
      <button class="pill stop" data-act="ask-stop" aria-label="Arrêter le guidage">${icon("x")}<span>Arrêter</span></button>
      <button class="round" data-act="voice" aria-label="${s.voice ? "Couper la voix" : "Activer la voix"}">${icon(s.voice ? "volume-2" : "volume-x")}<span aria-hidden="true">${s.voice ? "Son" : "Muet"}</span></button>
    </nav>
    ${st.arrived && s.nav.arrivedAt && !s.nav.stayed && !sheet ? arrivalPanel(s) : ""}
    ${sheet ? `<div class="scrim" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-modal="true">${sheet === "settings" ? settingsSheet(s) : sheet === "stop" ? stopSheet() : reportSheet()}</section>` : ""}`;
  const ui = root.querySelector(".ar-ui");
  if (html !== lastUi) { ui.innerHTML = html; lastUi = html; }
  // VoiceOver / TalkBack : la consigne n'est lue que lorsqu'elle CHANGE (avant, la bulle était relue à chaque
  // mètre parcouru). Les dangers passent par le bandeau « alert » et par la voix de l'appli (js/speech.js).
  const live = root.querySelector(".ar-live"), said = `${title}. ${subText}`;
  if (live && live.dataset.title !== title) { live.dataset.title = title; live.textContent = said; }
  root.classList.toggle("sheet-open", !!sheet);
  // carte agrandie : elle s'arrête sous la consigne, pour que la poignée reste visible et attrapable
  const topH = `${Math.round(root.querySelector(".top").getBoundingClientRect().bottom)}px`;
  if (root.style.getPropertyValue("--top-h") !== topH) root.style.setProperty("--top-h", topH);
}
// Écran de fin de trajet : destination, durée et distance, puis Terminer (sortie en douceur) ou Rester
function arrivalPanel(s) {
  const n = s.nav, mins = Math.max(1, Math.round((n.arrivedAt - (n.startedAt || n.arrivedAt)) / 60000));
  return `<section class="arrive-panel" role="dialog" aria-labelledby="arrT">
    <div class="arrive-flag">${icon("flag")}</div>
    <h3 id="arrT">Vous êtes arrivé</h3>
    <p class="arrive-dest">${esc(s.dest?.label || "")}</p>
    <p class="arrive-sum">${n.startedAt ? `${mins} min · ` : ""}${dist(n.total)} parcourus</p>
    <div class="arrive-actions"><button class="btn soft" data-act="arr-stay">Rester ici</button>
      <button class="btn dark" data-act="arr-end">${icon("check")} Terminer</button></div></section>`;
}
// Bord du dôme : une seule ellipse sert à découper la carte, à tracer l'anneau et à placer le « N »
function domeEdgeY(x) {
  const g = domeGeom;
  return g.top + g.ry - g.ry * Math.sqrt(Math.max(0, 1 - ((x - g.W / 2) / g.rx) ** 2));
}
// La petite carte change de taille (carte agrandie, poignée, consigne sur 2 ou 3 lignes) : Leaflet doit le
// savoir, sinon il ne charge les tuiles que pour l'ancienne taille et laisse une bande vide en marchant
let mapResizeTimer = 0;
function refreshMapSize() {
  clearTimeout(mapResizeTimer);
  mapResizeTimer = setTimeout(() => api?.map.invalidateSize({pan: false}), 60);
}
function layoutDome() {
  const dome = root?.querySelector(".dome"), map = dome?.querySelector(".dome-map");
  if (!map || !map.clientWidth) return;
  refreshMapSize();
  const W = map.clientWidth, H = map.clientHeight, landscape = matchMedia("(orientation: landscape) and (max-height: 600px)").matches;
  domeGeom = {W, top: map.offsetTop, rx: W * (mapFull ? 1.6 : landscape ? 0.9 : 0.78), ry: H};
  map.style.clipPath = `ellipse(${domeGeom.rx.toFixed(1)}px ${H}px at 50% 100%)`;
  const svg = dome.querySelector(".ring");
  svg.setAttribute("viewBox", `0 0 ${W} ${dome.clientHeight}`);
  let d = "";
  for (let i = 0; i <= 80; i++) { const x = W * i / 80; d += `${i ? "L" : "M"}${x.toFixed(1)} ${domeEdgeY(x).toFixed(1)}`; }
  svg.querySelector(".ring-arc").setAttribute("d", d);
  svg.querySelector(".ring-ticks").innerHTML = Array.from({length: 23}, (_, i) => {
    const x = W * (0.06 + 0.88 * i / 22);
    return `<circle cx="${x.toFixed(1)}" cy="${(domeEdgeY(x) + 7).toFixed(1)}" r="${i % 5 === 0 ? 2 : 1.2}"/>`;
  }).join("");
  dome.querySelector(".dome-grip").style.top = `${(domeGeom.top - 22).toFixed(1)}px`;
}
// Poignée du dôme : tirer vers le haut agrandit la carte, vers le bas la remet en place ; un toucher bascule
function bindGrip() {
  const grip = root.querySelector(".dome-grip"), dome = root.querySelector(".dome");
  let y0 = null, h0 = 0, moved = 0;
  grip.addEventListener("pointerdown", e => {
    y0 = e.clientY; h0 = dome.offsetHeight; moved = 0;
    grip.setPointerCapture(e.pointerId);
    dome.style.transition = "none";
  });
  grip.addEventListener("pointermove", e => {
    if (y0 === null) return;
    moved = e.clientY - y0;
    const max = root.clientHeight - root.querySelector(".top").getBoundingClientRect().bottom - 12;
    dome.style.height = `${Math.max(120, Math.min(max, h0 - moved)).toFixed(0)}px`;
    layoutDome();
  });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    dome.style.transition = ""; dome.style.height = "";
    if (Math.abs(moved) < 8) setMapFull(!mapFull);
    else setMapFull(moved < 0);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}
function settingsSheet(s) {
  const seg = (act, opts, cur) => `<div class="seg">${opts.map(([v, l, ic]) =>
    `<button data-act="${act}" data-v="${v}" class="${cur === v ? "on" : ""}">${ic ? icon(ic) : ""}${l}</button>`).join("")}</div>`;
  return `<div class="sheet-head"><h3>${icon("sliders-horizontal")} Réglages du guidage</h3><button class="x" data-act="close-sheet" aria-label="Fermer">${icon("x")}</button></div>
    <p class="sheet-label">Ma position</p>
    <div class="gps-state">${icon("locate-fixed")}<span>${esc(s.gpsStatus || "Recherche de votre position…")}</span></div>
    <button class="btn soft" data-act="reroute">${icon("rotate-ccw")} Recalculer l'itinéraire</button>
    <p class="sheet-label">Vibrations de direction</p>
    <label class="setting">${icon("vibrate")}<span class="grow">Vibrer pour indiquer la direction</span>
      <input type="checkbox" class="switch" data-act="haptics" ${s.haptics ? "checked" : ""}></label>
    <ul class="haptic-legend">
      <li><b>2 impulsions</b> tournez à gauche</li><li><b>3 impulsions</b> tournez à droite</li>
      <li><b>5 impulsions rapides</b> mauvais sens : faites demi-tour</li><li><b>1 longue</b> vous êtes arrivé</li>
      <li><b>1 longue + 1 courte</b> obstacle devant vous</li></ul>
    <p class="sheet-label">Obstacles vus par la caméra (expérimental)</p>
    <label class="setting">${icon("scan-eye")}<span class="grow">Détecter les obstacles</span>
      <input type="checkbox" class="switch" data-act="detect" ${s.detect ? "checked" : ""}></label>
    <label class="setting">${icon("square-dashed")}<span class="grow">Mode test : tout encadrer</span>
      <input type="checkbox" class="switch" data-act="detect-debug" ${s.detectDebug ? "checked" : ""}></label>
    ${s.hapticsNote ? `<p class="fine">${icon("info")} ${esc(s.hapticsNote)}</p>` : ""}
    <p class="sheet-label">Thème</p>
    <div class="themes">${[["verre", "Verre", "Clair, ruban lumineux"], ["neon", "Néon", "Sombre, repères flottants"]].map(([v, l, d]) =>
      `<button class="theme-card ${s.theme === v ? "on" : ""}" data-act="theme" data-v="${v}"><span class="preview pv-${v}"><i></i><i></i><i></i></span><b>${l}</b><small>${d}</small></button>`).join("")}</div>
    <button class="btn soft" data-act="hud">${icon("glasses")} Vue lunettes connectées</button>
    <button class="btn danger-soft" data-act="stop">${icon("x")} Arrêter le guidage</button>`;
}
// Arrêt depuis l'écran de guidage : une confirmation évite d'arrêter par un toucher involontaire
function stopSheet() {
  return `<div class="sheet-head"><h3>${icon("x")} Arrêter le guidage ?</h3><button class="x" data-act="close-sheet" aria-label="Fermer">${icon("x")}</button></div>
    <p class="stop-text">Vous reviendrez à la recherche d'itinéraire. La destination reste enregistrée.</p>
    <button class="btn danger" data-act="stop">${icon("x")} Oui, arrêter le guidage</button>
    <button class="btn soft" data-act="close-sheet">${icon("navigation")} Non, continuer</button>`;
}
function reportSheet() {
  return `<div class="sheet-head"><h3>${icon("triangle-alert")} Signaler un obstacle</h3><button class="x" data-act="close-sheet" aria-label="Fermer">${icon("x")}</button></div>
    <label class="setting strong">${icon("ban")}<span class="grow">Je ne peux pas passer</span>
      <input type="checkbox" class="switch" data-act="blocking" ${blocking ? "checked" : ""}></label>
    <div class="tiles">${REPORT_KINDS.map(([k, l, ic]) => `<button class="tile report" data-act="report-kind" data-v="${k}">
      <span class="tile-ic">${icon(ic)}</span><span class="tile-label">${l}</span></button>`).join("")}</div>
    <p class="sheet-label">Aider à améliorer la détection</p>
    <div class="sheet-row"><button class="btn soft" data-act="sample" data-v="obstacle_manque">${icon("scan-eye")} Obstacle non détecté</button>
      <button class="btn soft" data-act="sample" data-v="fausse_alerte">${icon("circle-alert")} Fausse alerte</button></div>
    ${sheetMessage ? `<div class="msg ok">${icon("check")}<span>${esc(sheetMessage)}</span></div>` : ""}`;
}
async function saveSample(kind) {
  const s = api.state();
  if (nativeOn || noCamera || !video?.videoWidth) { sheetMessage = "Image caméra indisponible ici (appli Android : bientôt)."; lastUi = ""; return; }
  if (!s.dataConsent) { sheetMessage = "Activez d'abord « Contribuer à l'entraînement » dans les Paramètres (images floutées, gardées sur ce téléphone)."; lastUi = ""; return; }
  try {
    await captureSample(video, {kind, detections: performance.now() - detsAt < 2000 ? dets : [], meta: sampleMeta(s)});
    sheetMessage = "Merci : image enregistrée (visages et plaques floutés) sur ce téléphone.";
    stickerPop("merci");
  } catch (err) { sheetMessage = `Enregistrement impossible : ${err.message}`; }
  lastUi = "";
}
function onAction(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act, v = b.dataset.v;
  if (act === "settings") sheet = "settings";
  else if (act === "ask-stop") sheet = "stop";
  else if (act === "report") { sheet = "report"; sheetMessage = null; }
  else if (act === "close-sheet") sheet = null;
  else if (act === "map") setMapFull(!mapFull);
  else if (act === "arr-end") { api.endSoftly?.(); return; }
  else if (act === "arr-stay") { api.stay?.(); lastUi = ""; return; }
  else if (act === "gps-help") { api.locationHelp?.(); return; }
  else if (act === "hud") { sheet = null; api.openHud(); }
  else if (act === "voice") api.toggleVoice();
  else if (act === "reroute") { sheet = null; api.reroute(); }
  else if (act === "haptics") { api.setHaptics(b.checked); }
  else if (act === "theme") api.setTheme(v);
  else if (act === "blocking") { blocking = b.checked; return; }
  else if (act === "sample") { saveSample(v); return; }
  else if (act === "detect" || act === "detect-debug") { api.setOption(act === "detect" ? "detect" : "detectDebug", b.checked); }
  else if (act === "report-kind") { sheetMessage = api.report(v, blocking); setTimeout(() => { if (sheet === "report") { sheet = null; lastUi = ""; } }, 1800); }
  else if (act === "stop") { sheet = null; api.stop(); return; }
  lastUi = "";
}
// Mini-carte du guidage : tenue en marchant, le pouce la zoomait ou la déplaçait sans le vouloir (terrain du
// 19/10 : zooms soudains, trajet hors du dôme). Petite : verrouillée, zoom 17, recentrée sur vous. En grand
// (bouton « Plan ») : manipulable.
const MAP_HANDLERS = ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard", "tap"];
function lockMap(on) {
  const m = api?.map;
  if (!m) return;
  for (const h of MAP_HANDLERS) on ? m[h]?.disable() : m[h]?.enable();
  if (on && m.getZoom() !== 17) m.setZoom(17, {animate: false});
}
function setMapFull(on) {
  mapFull = on;
  lockMap(!on);
  if (!on && !stream && !nativeOn && !noCamera && !api.state()?.simulated) startCamera();   // sortie du mode audio seul
  root.classList.toggle("map-full", on);
  const grip = root.querySelector(".dome-grip");
  grip.setAttribute("aria-label", on ? "Réduire la carte" : "Agrandir la carte");
  grip.setAttribute("aria-expanded", String(on));
  lastUi = "";
  layoutDome();
  setTimeout(() => { layoutDome(); api.map.invalidateSize(); }, 320);
}

// ---- Ouverture / fermeture ------------------------------------------------------------------------------
export async function openAR(options) {
  api = options;
  const mob = api.state()?.mobility || "";
  camHeight = mob.includes("wheelchair") ? PHONE_HEIGHT_M.wheelchair : PHONE_HEIGHT_M.standing;
  view = null; mapFull = false; sheet = null; lastUi = ""; ribbonA = 0; recal = null; obs = null; labelSmooth.clear();
  tracker.reset(); annState = {}; lastMovePos = null;
  Object.values(F).forEach(f => f.reset());
  sensors = {heading: null, pitch: null, roll: 0};
  root = document.getElementById("ar");
  root.hidden = false;
  root.className = "";
  root.innerHTML = `<video playsinline muted autoplay></video><canvas></canvas>
    <div class="dome"><div class="dome-map"></div>
      <svg class="ring" preserveAspectRatio="none" aria-hidden="true"><path class="ring-arc"/><g class="ring-ticks"></g></svg>
      <button class="dome-grip" aria-label="Agrandir la carte" aria-expanded="false"><span></span></button></div>
    <div class="ar-ui"></div><div class="ar-live sr-only" aria-live="polite"></div>`;
  video = root.querySelector("video");
  canvas = root.querySelector("canvas");
  ctx = canvas.getContext("2d");
  root.querySelector(".dome-map").append(api.map.getContainer());
  lockMap(true);
  try { api.map.invalidateSize(); } catch { /* dôme pas encore dimensionné : refait par layoutDome */ }
  bindGrip();
  domeObserver = new ResizeObserver(layoutDome);
  domeObserver.observe(root.querySelector(".dome"));
  layoutDome();
  root.addEventListener("click", onAction);
  root.addEventListener("change", onAction);
  startSensors();
  noCamera = false;
  nativeOn = !!NATIVE;
  if (nativeOn) {                                      // appli Android : la caméra et le tracé viennent d'ARCore
    nativeStatus = null; nativeRoute = api.state().nav.route; nativeTheme = api.state().theme;
    root.classList.add("native-ar");
    document.documentElement.classList.add("native-ar-on");
    NATIVE.startAr(nativePayload(api.state()));
    frame();
    return;
  }
  frame();                                             // l'interface d'abord, la caméra peut mettre du temps
  document.addEventListener("visibilitychange", onVisibility);
  // Mode audio seul (batterie) : pas de caméra ni de détection ; le plan en grand, la voix guide.
  // Le bouton « Caméra » l'allume quand même à la demande.
  if (api.state().audioOnly) { root.classList.add("audio-only"); setMapFull(true); return; }
  // Démonstration : pas de caméra (la personne n'est pas dans la rue) ; sol quadrillé et ruban, vus en marchant
  if (api.state().simulated) { noCamera = true; root.classList.add("no-camera", "simulated"); return; }
  await startCamera();
}
// 960 × 540 suffit à l'écran et au détecteur (qui analyse en 320 à 640 px) : moins de batterie qu'en 1280 × 720
async function startCamera() {
  try {
    stream?.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}, width: {ideal: 960}, height: {ideal: 540}}, audio: false});
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    noCamera = true;
    root.classList.add("no-camera");
  }
}
export function closeAR() {
  cancelAnimationFrame(raf);
  lockMap(false);                                        // la carte redevient manipulable hors du guidage
  document.removeEventListener("visibilitychange", onVisibility);
  stopSensors();
  domeObserver?.disconnect(); domeObserver = null; domeGeom = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (nativeOn) {
    NATIVE.stopAr();
    nativeOn = false;
    document.documentElement.classList.remove("native-ar-on");
  }
  if (root) {
    root.removeEventListener("click", onAction);
    root.removeEventListener("change", onAction);
    document.body.prepend(api.map.getContainer());       // la carte retourne à sa place
    root.hidden = true; root.innerHTML = ""; root.className = "";
  }
  api?.map.invalidateSize();
}
export const arOpen = () => root && !root.hidden;
// Tests automatiques uniquement (adresse terminée par ?debug) : état des capteurs et des étiquettes
if (new URLSearchParams(location.search).has("debug"))
  globalThis.__ar = {get sensors() { return sensors; }, get obs() { return obs; }, get labels() { return [...labelSmooth]; }, compassOk, get ribbonA() { return ribbonA; }};
