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

// Hauteur du téléphone au-dessus du trottoir, tenu devant soi
const PHONE_HEIGHT_M = {standing: 1.35, wheelchair: 1.05};
const CAMERA_LONG_FOV_DEG = 68;   // champ de la caméra arrière principale sur le grand côté de l'image (iPhone ≈ 69°, Android 65-70°)
const VFOV_DEG = 62;              // sans image vidéo (ordinateur)
const AHEAD_M = 55;               // longueur d'itinéraire dessinée
const PLACES_M = 130;             // portée des étiquettes de lieux
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

let api = null, root = null, video = null, canvas = null, ctx = null, stream = null, raf = 0, noCamera = false;
let sensors = {heading: null, pitch: null, roll: 0}, mapFull = false, sheet = null, domeGeom = null, domeObserver = null;
let camHeight = PHONE_HEIGHT_M.standing, view = null;     // view : origine et position lissées
let blocking = true, sheetMessage = null, lastUi = "";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const round5 = m => m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;
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
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) heading = e.webkitCompassHeading;   // iPhone
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
const F = {heading: new OneEuro(0.35, 0.012, true), pitch: new OneEuro(0.4, 0.01), roll: new OneEuro(0.4, 0.01)};
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
  const raw = [], from = Math.max(0, pos - BEHIND_M), to = Math.min(s.nav.total, pos + AHEAD_M);
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
  let acc = 0, next = (pos - from) + CHEV_START_M;      // premier chevron à 2 m devant soi
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
        const alpha = Math.max(0, 1 - along / AHEAD_M) ** 0.8;
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
function anchorsAhead(s) {
  const {nav, net, reports, posAt} = s, out = [];
  let along = 0;
  for (const id of nav.route.edge_ids || []) {
    const e = net.edges[id];
    let len = 0;
    for (let i = 1; i < e.shape.length; i++) len += haversineM(e.shape[i - 1][0], e.shape[i - 1][1], e.shape[i][0], e.shape[i][1]);
    const ahead = along - nav.pos;
    if (ahead > -2 && ahead < AHEAD_M) {
      const at = posAt(along + Math.min(1.5, len / 2));
      if (e.is_crossing && e.kerb_lowered === true) out.push({at, label: "Trottoir abaissé", ic: "accessibility", ahead, color: "#1C7A4D", glow: "#3DDC97"});
      else if (e.is_crossing && e.kerb_lowered === false) out.push({at, label: "Bordure haute", ic: "triangle-alert", ahead, color: "#B42318", glow: "#FF6B5B"});
      if (e.is_crossing && e.sound_signal) out.push({at, label: "Feu sonore", ic: "volume-2", ahead: ahead + 0.01, color: "#1C7A4D", glow: "#3DDC97"});
      if (e.has_step) out.push({at, label: "Marche", ic: "stairs", ahead, color: "#7A4B00", glow: "#FFC24B"});
      if (e.slope_pct !== null && Math.abs(e.slope_pct) >= 5)
        out.push({at, label: `${e.slope_pct > 0 ? "Montée" : "Descente"} ${Math.abs(e.slope_pct).toFixed(0)} %`, ic: "mountain", ahead, color: "#7A4B00", glow: "#FFC24B"});
    }
    along += len;
  }
  for (const r of reports) {
    const d = haversineM(nav.here.lat, nav.here.lon, r.lat, r.lon);
    const k = REPORT_KINDS.find(x => x[0] === r.kind) || REPORT_KINDS.at(-1);
    if (d < AHEAD_M) out.push({at: r, label: k[1], ic: k[2], ahead: d, color: "#B42318", glow: "#FF6B5B", obstacle: true});
  }
  for (const [cat, lat, lon, name, wheel] of net.places || []) {
    const d = haversineM(nav.here.lat, nav.here.lon, lat, lon);
    if (d > PLACES_M || !PLACE[cat]) continue;
    const [ic, color, label] = PLACE[cat];
    out.push({at: {lat, lon}, label: name || label, ic, ahead: d, color, glow: "#5BE0EA", place: true, wheel: WHEEL[wheel]});
  }
  for (const [kind, lat, lon, name] of net.pois) {
    if (!POI[kind]) continue;
    const d = haversineM(nav.here.lat, nav.here.lon, lat, lon);
    if (d < 90) out.push({at: {lat, lon}, label: POI[kind][1], sub: name, ic: POI[kind][0], ahead: d, color: "#007489", glow: "#5BE0EA", poi: true});
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
function drawAnchors(cam, s, here) {
  const dpr = devicePixelRatio, w = canvas.width, h = canvas.height, neon = theme().pins;
  // les plus proches d'abord : si deux repères se gênent, le plus lointain attend d'être plus près
  const rank = a => a.obstacle ? 0 : a.place || a.poi ? 2 : 1;   // obstacles d'abord, puis le trajet, puis les lieux
  const anchors = anchorsAhead(s).sort((a, b) => rank(a) - rank(b) || a.ahead - b.ahead).slice(0, 10);
  const taken = reservedAreas(), toDraw = [];
  for (const a of anchors) {
    const c = cam.toCam(enu(here, a.at));
    if (c.d < 2) continue;
    const [x, y] = cam.toScreen(c);
    if (x < -60 * dpr || x > w + 60 * dpr || y < 0 || y > h) continue;
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
      if (taken.some(hit) || est.top < ceiling) continue;
    } else if (taken.some(t => hit(t) && !t.bubble)) continue;       // une goutte peut passer derrière la bulle
    taken.push(est);
    toDraw.push(() => neon ? glassPin(x, y, a, H) : glassLabel(x, labelY, a, y));
  }
  toDraw.reverse().forEach(draw => draw());          // les lointains d'abord, les proches par-dessus
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
function frame() {
  raf = requestAnimationFrame(frame);
  const s = api.state();
  if (!s) return;
  const dpr = devicePixelRatio, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  const now = performance.now(), compass = sensors.heading !== null;
  const heading = F.heading.filter(compass ? sensors.heading : routeBearing(s), now);
  document.documentElement.style.setProperty("--heading", `${heading.toFixed(1)}deg`);
  const pitch = F.pitch.filter(Math.max(-30, Math.min(80, sensors.pitch ?? 10)), now);   // sans capteur : téléphone presque droit
  const roll = compass ? ((F.roll.filter(sensors.roll + 180, now) + 360) % 360) - 180 : 0;
  const cam = makeCamera(heading, pitch, roll, w, h);
  const v = viewpoint(s);
  if (!mapFull) {
    if (noCamera) drawGrid(cam, v.here, heading);
    if (v.join) drawJoin(cam, v.here, v.join);
    drawPath(cam, s, v.here, v.pos);
    drawAnchors(cam, s, v.here);
  }
  renderUi(s, heading, compass);
}
// Point de vue : sur l'itinéraire, la position projetée sur le tracé (le ruban part de sous les pieds).
// À l'écart du tracé (à l'intérieur, de l'autre côté de la rue, hors itinéraire), la vraie position GPS :
// le ruban reste à sa vraie place dans la rue et des pointillés montrent comment le rejoindre.
// Glissement lent entre deux mesures GPS pour que les lignes ne sautent pas.
let lastView = 0;
function viewpoint(s) {
  const n = s.nav, away = !!(n.real && (n.offRoute || n.gap > 6));
  const target = away ? {lat: n.real.lat, lon: n.real.lon} : n.here;
  const now = performance.now(), k = 1 - Math.exp(-Math.min(1, (now - lastView) / 1000) / 0.8);
  lastView = now;
  if (!view || view.away !== away || haversineM(view.here.lat, view.here.lon, target.lat, target.lon) > 60) view = {here: {...target}, pos: n.pos, away};
  else {
    view.here = {lat: view.here.lat + (target.lat - view.here.lat) * k, lon: view.here.lon + (target.lon - view.here.lon) * k};
    view.pos += (n.pos - view.pos) * k;
  }
  if (!away) view.here = s.posAt(view.pos);
  view.join = away ? s.posAt(n.gapAlong ?? n.pos) : null;
  return view;
}
export const currentHeading = () => (arOpen() ? sensors.heading : null);

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
  const joining = !st.arrived && !s.nav.offRoute && s.nav.gap > 8;
  const title = st.arrived ? "Vous êtes arrivé" : joining ? "Rejoignez l'itinéraire" : TITLE[next.maneuver] || "Continuez tout droit";
  const manIcon = joining ? "footprints" : MAN_ICON[st.arrived ? "arrive" : next.maneuver] || "arrow-up";
  const away = st.arrived ? "" : joining ? dist(s.nav.gap) : dist(st.toManeuver);
  const subText = joining ? `suivez les pointillés jusqu'à la rue, puis ${(TITLE[next.maneuver] || "continuez").toLowerCase()}` : sub;
  const rer = s.nav.rerouted && Date.now() - s.nav.rerouted.at < 10000 ? s.nav.rerouted : null;
  const banner = rer ? `<div class="banner danger">${icon("triangle-alert")}<span><b>${esc(rer.title)}</b> Itinéraire recalculé</span></div>`
    : s.gpsProblem ? `<div class="banner warn">${icon("map-pin")}<span>${esc(s.gpsProblem)}</span></div>`
    : s.gpsInfo ? `<div class="banner ${s.nav.offRoute ? "warn" : "info"}">${icon(s.nav.offRoute ? "route" : "locate-fixed")}<span>${esc(s.gpsInfo)}</span></div>` : "";
  const alt = s.alt;
  const html = `
    <div class="top">
      <div class="chips">${chip("c-steps", "stairs", "Marches", r.steps_count)}${chip("c-eta", "clock", "Arrivée", eta)}${chip("c-dist", "route", "Distance", dist(st.remaining))}</div>
      <div class="bubble" role="status" aria-live="polite"><i class="bubble-ic">${icon(manIcon)}</i>
        <div class="bubble-txt"><b>${esc(title)}</b><span>${esc(subText)}</span>
        ${!st.arrived && !joining && next.alerts.some(a => !a.startsWith("Traversée")) ? `<em>${icon("triangle-alert")} ${esc(next.alerts.filter(a => !a.startsWith("Traversée")).join(" · "))}</em>` : ""}</div>
        ${away ? `<strong class="bubble-dist">${away}</strong>` : ""}</div>
      ${banner}
    </div>
    <div class="dome-ui">
      ${alt ? `<div class="alt-note">${esc(alt)}</div>` : ""}
      <div class="rose ${compass ? "on" : ""}" role="img" aria-label="${compass ? "Boussole active" : "Boussole indisponible : la vue suit le sens de l'itinéraire"}">
        <span class="needle"></span><i>N</i></div>
    </div>
    <nav class="dock" aria-label="Commandes du guidage">
      <button class="round" data-act="settings" aria-label="Réglages du guidage">${icon("sliders-horizontal")}</button>
      <button class="pill" data-act="map">${icon(mapFull ? "camera" : "map")}<span>${mapFull ? "Caméra" : "Plan"}</span></button>
      <button class="center" data-act="report" aria-label="Signaler un obstacle">${icon("triangle-alert")}</button>
      <button class="pill" data-act="hud">${icon("glasses")}<span>Lunettes</span></button>
      <button class="round" data-act="voice" aria-label="${s.voice ? "Couper la voix" : "Activer la voix"}">${icon(s.voice ? "volume-2" : "volume-x")}</button>
    </nav>
    ${sheet ? `<div class="scrim" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-modal="true">${sheet === "settings" ? settingsSheet(s) : reportSheet()}</section>` : ""}`;
  const ui = root.querySelector(".ar-ui");
  if (html !== lastUi) { ui.innerHTML = html; lastUi = html; }
  root.classList.toggle("sheet-open", !!sheet);
  // carte agrandie : elle s'arrête sous la consigne, pour que la poignée reste visible et attrapable
  const topH = `${Math.round(root.querySelector(".top").getBoundingClientRect().bottom)}px`;
  if (root.style.getPropertyValue("--top-h") !== topH) root.style.setProperty("--top-h", topH);
  placeNorth(heading);
}
// Bord du dôme : une seule ellipse sert à découper la carte, à tracer l'anneau et à placer le « N »
function domeEdgeY(x) {
  const g = domeGeom;
  return g.top + g.ry - g.ry * Math.sqrt(Math.max(0, 1 - ((x - g.W / 2) / g.rx) ** 2));
}
function layoutDome() {
  const dome = root?.querySelector(".dome"), map = dome?.querySelector(".dome-map");
  if (!map || !map.clientWidth) return;
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
// « N » sur l'anneau, là où se trouve le nord par rapport au regard
function placeNorth(heading) {
  const n = root.querySelector(".ring-n");
  if (!n || !domeGeom) return;
  const rel = ((-heading + 540) % 360) - 180;
  n.style.opacity = Math.abs(rel) <= RING_DEG ? "1" : "0";
  const x = domeGeom.W / 2 + Math.max(-1, Math.min(1, rel / RING_DEG)) * domeGeom.W * 0.4;
  n.style.left = `${x.toFixed(1)}px`;
  n.style.top = `${(domeEdgeY(x) - (Math.abs(x - domeGeom.W / 2) < 64 ? 40 : 16)).toFixed(1)}px`;   // au-dessus de la poignée
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
      <li><b>5 impulsions rapides</b> mauvais sens : faites demi-tour</li><li><b>1 longue</b> vous êtes arrivé</li></ul>
    ${s.hapticsNote ? `<p class="fine">${icon("info")} ${esc(s.hapticsNote)}</p>` : ""}
    <p class="sheet-label">Thème</p>
    <div class="themes">${[["verre", "Verre", "Clair, ruban lumineux"], ["neon", "Néon", "Sombre, repères flottants"]].map(([v, l, d]) =>
      `<button class="theme-card ${s.theme === v ? "on" : ""}" data-act="theme" data-v="${v}"><span class="preview pv-${v}"><i></i><i></i><i></i></span><b>${l}</b><small>${d}</small></button>`).join("")}</div>
    <button class="btn danger-soft" data-act="stop">${icon("x")} Arrêter le guidage</button>`;
}
function reportSheet() {
  return `<div class="sheet-head"><h3>${icon("triangle-alert")} Signaler un obstacle</h3><button class="x" data-act="close-sheet" aria-label="Fermer">${icon("x")}</button></div>
    <label class="setting strong">${icon("ban")}<span class="grow">Je ne peux pas passer</span>
      <input type="checkbox" class="switch" data-act="blocking" ${blocking ? "checked" : ""}></label>
    <div class="tiles">${REPORT_KINDS.map(([k, l, ic]) => `<button class="tile report" data-act="report-kind" data-v="${k}">
      <span class="tile-ic">${icon(ic)}</span><span class="tile-label">${l}</span></button>`).join("")}</div>
    ${sheetMessage ? `<div class="msg ok">${icon("check")}<span>${esc(sheetMessage)}</span></div>` : ""}`;
}
function onAction(e) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act, v = b.dataset.v;
  if (act === "settings") sheet = "settings";
  else if (act === "report") { sheet = "report"; sheetMessage = null; }
  else if (act === "close-sheet") sheet = null;
  else if (act === "map") setMapFull(!mapFull);
  else if (act === "hud") api.openHud();
  else if (act === "voice") api.toggleVoice();
  else if (act === "reroute") { sheet = null; api.reroute(); }
  else if (act === "haptics") { api.setHaptics(b.checked); }
  else if (act === "theme") api.setTheme(v);
  else if (act === "blocking") { blocking = b.checked; return; }
  else if (act === "report-kind") { sheetMessage = api.report(v, blocking); setTimeout(() => { if (sheet === "report") { sheet = null; lastUi = ""; } }, 1800); }
  else if (act === "stop") { sheet = null; api.stop(); return; }
  lastUi = "";
}
function setMapFull(on) {
  mapFull = on;
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
  view = null; mapFull = false; sheet = null; lastUi = "";
  Object.values(F).forEach(f => f.reset());
  sensors = {heading: null, pitch: null, roll: 0};
  root = document.getElementById("ar");
  root.hidden = false;
  root.className = "";
  root.innerHTML = `<video playsinline muted autoplay></video><canvas></canvas>
    <div class="dome"><div class="dome-map"></div>
      <svg class="ring" preserveAspectRatio="none" aria-hidden="true"><path class="ring-arc"/><g class="ring-ticks"></g></svg>
      <span class="ring-n">N</span>
      <button class="dome-grip" aria-label="Agrandir la carte" aria-expanded="false"><span></span></button></div>
    <div class="ar-ui"></div>`;
  video = root.querySelector("video");
  canvas = root.querySelector("canvas");
  ctx = canvas.getContext("2d");
  root.querySelector(".dome-map").append(api.map.getContainer());
  api.map.invalidateSize();
  bindGrip();
  domeObserver = new ResizeObserver(layoutDome);
  domeObserver.observe(root.querySelector(".dome"));
  layoutDome();
  root.addEventListener("click", onAction);
  root.addEventListener("change", onAction);
  startSensors();
  noCamera = false;
  frame();                                             // l'interface d'abord, la caméra peut mettre du temps
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    noCamera = true;
    root.classList.add("no-camera");
  }
}
export function closeAR() {
  cancelAnimationFrame(raf);
  stopSensors();
  domeObserver?.disconnect(); domeObserver = null; domeGeom = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (root) {
    root.removeEventListener("click", onAction);
    root.removeEventListener("change", onAction);
    document.body.prepend(api.map.getContainer());       // la carte retourne à sa place
    root.hidden = true; root.innerHTML = ""; root.className = "";
  }
  api?.map.invalidateSize();
}
export const arOpen = () => root && !root.hidden;
