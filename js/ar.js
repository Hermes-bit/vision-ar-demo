// Écran de guidage en réalité augmentée : la rue filmée par la caméra arrière,
// l'itinéraire dessiné au sol, une bulle de consigne ancrée dans la rue, une
// mini-carte en dôme et une barre de commandes en verre.
//
// Deux thèmes :
//   « verre » : ruban lumineux turquoise→vert à chevrons blancs, étiquettes en verre clair ;
//   « neon »  : grands chevrons lumineux au sol, repères en goutte flottant dans la rue.
//
// Pas de reconnaissance d'image : tout vient des données (itinéraire, signalements,
// bordures, marches, pentes, équipements) placées par la position (GPS ou simulation),
// la boussole et l'inclinaison du téléphone. Précision : quelques mètres.
import {haversineM} from "./routing.js";
import {icon, ICONS} from "./icons.js";

const CAMERA_HEIGHT_M = 1.4;      // téléphone tenu devant soi (fauteuil : ~1,1 m)
const VFOV_DEG = 62;              // champ vertical approximatif d'une caméra arrière en portrait
const AHEAD_M = 70;               // longueur d'itinéraire dessinée
const NEAR_M = 1.2;
const START_M = 2.5;
const RING_DEG = 55;              // demi-ouverture de l'anneau de boussole du dôme
const THEMES = {
  verre: {ribbon: true, chevW: 0.95, chevLen: 1.7, chevTh: 0.55, chevGap: 3.6, chevRGB: "255,255,255", glow: "rgba(61,220,151,.85)", pins: false},
  neon: {ribbon: false, chevW: 1.8, chevLen: 2.6, chevTh: 0.8, chevGap: 3.4, chevRGB: "130,242,247", glow: "rgba(91,224,234,.95)", pins: true},
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
const POI = {elevator: ["elevator", "Ascenseur"], accessible_toilet: ["toilet", "WC adaptés"], disabled_parking: ["square-parking", "Place PMR"],
  accessible_entrance: ["door-open", "Entrée accessible"], audio_beacon: ["volume-2", "Balise sonore"]};

let api = null, root = null, video = null, canvas = null, ctx = null, stream = null, raf = 0, noCamera = false;
let sensors = {heading: null, pitch: null, roll: 0}, useCompass = false, smoothHeading = null, mapFull = false, sheet = null;
let blocking = true, sheetMessage = null, lastUi = "";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const round5 = m => m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;
const dist = m => m < 1000 ? `${round5(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
const theme = () => THEMES[api.state()?.theme] || THEMES.verre;

// ---- Capteurs --------------------------------------------------------------------------
function screenAngle() { return (screen.orientation?.angle ?? window.orientation ?? 0) % 360; }
function onOrientation(e) {
  const angle = screenAngle();
  let heading = null;
  if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading;            // iPhone
  else if (e.absolute && typeof e.alpha === "number") heading = (360 - e.alpha) % 360;           // Android
  if (heading !== null) sensors.heading = (heading + angle + 360) % 360;
  if (typeof e.beta === "number") {
    sensors.pitch = angle === 90 || angle === 270 ? 90 - Math.abs(e.gamma) : 90 - e.beta;
    sensors.roll = angle === 0 ? e.gamma : 0;
  }
}
async function startSensors() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
      await DeviceOrientationEvent.requestPermission();                                            // iPhone : autorisation
  } catch { /* refus : on suit l'itinéraire */ }
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
  return {x: (p.lon - origin.lon) * k * 111320, y: (p.lat - origin.lat) * 111320, z: -CAMERA_HEIGHT_M};
}
function makeCamera(headingDeg, pitchDeg, w, h) {
  const yaw = headingDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
  const f = (h / 2) / Math.tan(VFOV_DEG * Math.PI / 360);
  const sy = Math.sin(yaw), cyw = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return {
    toCam(p) {
      const fwd = p.x * sy + p.y * cyw, right = p.x * cyw - p.y * sy;
      return {r: right, v: fwd * sp + p.z * cp, d: fwd * cp - p.z * sp};
    },
    toScreen(c) { return [w / 2 + c.r / c.d * f, h / 2 - c.v / c.d * f]; },
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
function ribbon(cam, pts, halfWidth) {
  ctx.beginPath();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * halfWidth, ny = dx / L * halfWidth;
    const c = clipNear([{x: a.x + nx, y: a.y + ny, z: a.z}, {x: b.x + nx, y: b.y + ny, z: b.z},
                        {x: b.x - nx, y: b.y - ny, z: b.z}, {x: a.x - nx, y: a.y - ny, z: a.z}].map(p => cam.toCam(p)));
    if (c.length < 3) continue;
    c.forEach((q, k) => { const [x, y] = cam.toScreen(q); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
  }
}
function drawPath(cam, s, here) {
  const t = theme(), dpr = devicePixelRatio, h = canvas.height;
  const pts = [];
  for (let d = s.nav.pos + START_M; d <= Math.min(s.nav.total, s.nav.pos + AHEAD_M); d += 2) pts.push(enu(here, s.posAt(d)));
  if (pts.length < 2) return;
  if (t.ribbon) {
    const g = ctx.createLinearGradient(0, h, 0, h * 0.4);
    g.addColorStop(0, "rgba(47,128,237,.55)");
    g.addColorStop(0.45, "rgba(18,181,195,.62)");
    g.addColorStop(1, "rgba(61,220,151,.42)");
    ctx.save();
    ctx.shadowColor = t.glow;
    ctx.shadowBlur = 26 * dpr;
    ribbon(cam, pts, 0.75);
    ctx.fillStyle = g;
    ctx.fill("nonzero");
    ctx.restore();
  }
  // chevrons posés au sol, de plus en plus transparents au loin
  ctx.save();
  ctx.shadowColor = t.glow;
  ctx.shadowBlur = (t.ribbon ? 6 : 22) * dpr;
  for (let d = s.nav.pos + START_M + 0.8; d <= Math.min(s.nav.total, s.nav.pos + AHEAD_M); d += t.chevGap) {
    const p = enu(here, s.posAt(d)), q = enu(here, s.posAt(Math.min(s.nav.total, d + 1)));
    let ux = q.x - p.x, uy = q.y - p.y;
    const L = Math.hypot(ux, uy);
    if (L < 1e-3) continue;
    ux /= L; uy /= L;
    const lx = -uy, ly = ux, W = t.chevW / 2, len = t.chevLen, th = t.chevTh;
    const at = (a, b) => ({x: p.x + ux * a + lx * b, y: p.y + uy * a + ly * b, z: p.z});
    // chevron « ^ » : pointe devant, deux branches d'épaisseur th vers l'arrière
    const shape = [at(len / 2, 0), at(-len / 2, -W), at(-len / 2 + th, -W), at(len / 2 - th, 0),
                   at(-len / 2 + th, W), at(-len / 2, W)];
    if (!fillGround(cam, shape)) continue;
    const alpha = Math.max(0.12, 1 - (d - s.nav.pos) / AHEAD_M);
    ctx.fillStyle = `rgba(${t.chevRGB},${(alpha * (t.ribbon ? 0.95 : 1)).toFixed(3)})`;
    ctx.fill();
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
  const z = -CAMERA_HEIGHT_M;
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
  for (const [kind, lat, lon, name] of net.pois) {
    if (!POI[kind]) continue;
    const d = haversineM(nav.here.lat, nav.here.lon, lat, lon);
    if (d < 90) out.push({at: {lat, lon}, label: POI[kind][1], sub: name, ic: POI[kind][0], ahead: d, color: "#0B5E78", glow: "#5BE0EA", poi: true});
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
function glassLabel(x, y, a) {
  const dpr = devicePixelRatio, h = 36 * dpr, r = h / 2, ic = 22 * dpr;
  ctx.font = font(700, 15 * dpr);
  const w1 = ctx.measureText(a.label).width;
  ctx.font = font(400, 15 * dpr);
  const w2 = ctx.measureText(" " + dist(Math.max(1, a.ahead))).width;
  const w = 10 * dpr + ic + 8 * dpr + w1 + w2 + 14 * dpr;
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
  // petit trait vers le point au sol
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.moveTo(x, top + h); ctx.lineTo(x, y + 18 * dpr); ctx.stroke();
  ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(x, y + 18 * dpr, 4 * dpr, 0, Math.PI * 2); ctx.fill();
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
  g.addColorStop(0, a.obstacle ? "rgba(255,107,91,.42)" : "rgba(18,181,195,.42)");
  g.addColorStop(1, a.obstacle ? "rgba(255,107,91,.08)" : "rgba(18,181,195,.06)");
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 1.6 * dpr; ctx.strokeStyle = a.obstacle ? "rgba(255,150,140,.9)" : "rgba(130,236,242,.9)"; ctx.stroke();
  ctx.restore();
  // pastille d'icône au sommet
  const s = Math.min(R * 1.05, 64 * dpr), bx = x - s / 2, by = cy - s / 2 - R * 0.15;
  ctx.save();
  ctx.fillStyle = a.obstacle ? "rgba(214,64,52,.85)" : "rgba(18,181,195,.85)";
  ctx.shadowColor = a.glow; ctx.shadowBlur = 14 * dpr;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, s, s, s * 0.22) : ctx.rect(bx, by, s, s); ctx.fill();
  ctx.restore();
  const img = iconImage(a.ic, "#ffffff");
  if (img.complete) ctx.drawImage(img, bx + s * 0.18, by + s * 0.18, s * 0.64, s * 0.64);
  // nom sous la pastille, distance à droite
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#fff";
  ctx.font = font(700, Math.max(12, Math.min(18, s / dpr * 0.3)) * dpr);
  ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 4 * dpr;
  const fs = Math.max(12, Math.min(18, s / dpr * 0.3)) * dpr;
  ctx.fillText(a.label, x, by + s + 6 * dpr);
  ctx.font = font(400, fs * 0.9);
  ctx.fillStyle = "#CFF7FA";
  ctx.fillText(dist(Math.max(1, a.ahead)), x, by + s + 8 * dpr + fs);
  ctx.shadowBlur = 0; ctx.textAlign = "start";
  return {left: x - R, top: cy - R, w: W, h: H};
}
function drawAnchors(cam, s, here) {
  const dpr = devicePixelRatio, w = canvas.width, h = canvas.height, neon = theme().pins;
  // les plus proches d'abord : si deux repères se gênent, le plus lointain attend d'être plus près
  const rank = a => a.obstacle ? 0 : a.poi ? 2 : 1;      // obstacles d'abord, puis le trajet, puis les équipements
  const anchors = anchorsAhead(s).filter(a => neon || !a.poi || a.ahead < 50).sort((a, b) => rank(a) - rank(b) || a.ahead - b.ahead).slice(0, 7);
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
    if (!neon) { ctx.font = font(700, 15 * dpr); est.w = ctx.measureText(a.label).width + 110 * dpr; est.left = x - est.w / 2; }
    const pad = 6 * dpr;
    const hit = t => est.left < t.left + t.w + pad && t.left < est.left + est.w + pad && est.top < t.top + t.h + pad && t.top < est.top + est.h + pad;
    if (taken.some(t => hit(t) && (!neon || !t.bubble))) continue;     // une goutte peut passer derrière la bulle
    taken.push(est);
    toDraw.push(() => neon ? glassPin(x, y, a, H) : glassLabel(x, y - 24 * dpr, a));
  }
  toDraw.reverse().forEach(draw => draw());          // les lointains d'abord, les proches par-dessus
}
function reservedAreas() {
  const dpr = devicePixelRatio, out = [];
  for (const el of root.querySelectorAll(".chips, .banner, .bubble, .dome, .dock")) {
    const r = el.getBoundingClientRect();
    if (r.width) out.push({left: r.left * dpr, top: r.top * dpr, w: r.width * dpr, h: r.height * dpr, ui: true, bubble: el.classList.contains("bubble")});
  }
  return out;
}

// ---- Orientation ---------------------------------------------------------------------------------
function routeBearing(s) {
  // direction du tronçon où l'on se trouve (3 m devant) : on regarde dans le sens de la marche, le virage apparaît sur le côté
  const a = s.posAt(s.nav.pos), b = s.posAt(Math.min(s.nav.total, s.nav.pos + 3));
  if (a.lat === b.lat && a.lon === b.lon) return smoothHeading ?? 0;
  const k = Math.cos(a.lat * Math.PI / 180);
  return (Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
}
function smooth(target) {
  if (smoothHeading === null) return (smoothHeading = target);
  const diff = ((target - smoothHeading + 540) % 360) - 180;
  smoothHeading = (smoothHeading + diff * 0.15 + 360) % 360;
  return smoothHeading;
}

// ---- Boucle d'affichage -------------------------------------------------------------------------------
function frame() {
  raf = requestAnimationFrame(frame);
  const s = api.state();
  if (!s) return;
  const dpr = devicePixelRatio, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  const compass = useCompass && sensors.heading !== null;
  const heading = smooth(compass ? sensors.heading : routeBearing(s));
  document.documentElement.style.setProperty("--heading", `${heading.toFixed(1)}deg`);
  const pitch = Math.max(5, Math.min(70, sensors.pitch ?? 22));
  const cam = makeCamera(heading, pitch, w, h);
  const here = s.nav.here;
  if (!mapFull) {
    ctx.save();
    if (sensors.roll) { ctx.translate(w / 2, h / 2); ctx.rotate(-sensors.roll * Math.PI / 180 * 0.5); ctx.translate(-w / 2, -h / 2); }
    if (noCamera) drawGrid(cam, here, heading);
    drawPath(cam, s, here);
    drawAnchors(cam, s, here);
    ctx.restore();
  }
  renderUi(s, cam, here, heading, compass);
}

// ---- Interface (DOM) -----------------------------------------------------------------------------------
function chip(cls, ic, label, value) {
  return `<div class="chip ${cls}"><span class="chip-ic">${icon(ic)}</span><span><small>${label}</small><b>${value}</b></span></div>`;
}
function renderUi(s, cam, here, heading, compass) {
  const st = s.st, next = st.next, r = s.nav.route;
  const eta = new Date(Date.now() + st.remaining / s.speed * 1000).toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit"});
  const after = s.nav.route.steps[st.idx + 2];
  const crossing = next.alerts.some(a => a.startsWith("Traversée"));
  const sub = st.arrived ? (s.dest?.label || "") : crossing ? `puis traversez au passage piéton${next.alerts.some(a => a.includes("feu sonore")) ? " (feu sonore)" : ""}`
    : next.maneuver === "arrive" ? (s.dest?.label || "") : `puis ${dist(next.distance_m)} ${next.street ? "· " + next.street : "tout droit"}`;
  const title = st.arrived ? "Vous êtes arrivé" : TITLE[next.maneuver] || "Continuez tout droit";
  const manIcon = MAN_ICON[st.arrived ? "arrive" : next.maneuver] || "arrow-up";
  const rer = s.nav.rerouted && Date.now() - s.nav.rerouted.at < 10000 ? s.nav.rerouted : null;
  const banner = rer ? `<div class="banner danger">${icon("triangle-alert")}<span><b>${esc(rer.title)}</b> Itinéraire recalculé</span></div>`
    : s.mode === "gps" && s.gpsProblem ? `<div class="banner warn">${icon("map-pin")}<span>${esc(s.gpsProblem)}</span></div>`
    : s.mode === "gps" && s.gpsInfo ? `<div class="banner info">${icon("locate-fixed")}<span>${esc(s.gpsInfo)}</span></div>` : "";
  const alt = s.alt;
  const html = `
    <div class="chips">${chip("c-steps", "stairs", "Marches", r.steps_count)}${chip("c-eta", "clock", "Arrivée", eta)}${chip("c-dist", "route", "Distance", dist(st.remaining))}</div>
    ${banner}
    <div class="bubble" role="status" aria-live="polite"><b>${esc(title)}</b><span>${esc(sub)}</span>
      ${!st.arrived && next.alerts.some(a => !a.startsWith("Traversée")) ? `<em>${icon("triangle-alert")} ${esc(next.alerts.filter(a => !a.startsWith("Traversée")).join(" · "))}</em>` : ""}
      <i class="bubble-ic">${icon(manIcon)}</i></div>
    <div class="dome-ui">
      <div class="next-pill"><span>${icon(manIcon)}</span><b>${st.arrived ? "Arrivé" : dist(st.toManeuver)}</b></div>
      ${alt ? `<div class="alt-note">${esc(alt)}</div>` : ""}
      <button class="rose ${compass ? "on" : ""}" data-act="compass" aria-label="Orientation : ${compass ? "boussole" : "sens de l'itinéraire"}">
        <span class="needle"></span><i>N</i></button>
      ${s.mode === "sim" ? `<button class="sim-btn" data-act="play" aria-label="${s.playing ? "Pause" : "Marcher"}">${icon(s.playing ? "pause" : "play")}</button>` : ""}
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
  placeBubble(s, cam, here);
  placeNorth(heading);
}
// La bulle de consigne s'accroche au point de la prochaine manœuvre, si on le voit
function placeBubble(s, cam, here) {
  const b = root.querySelector(".bubble");
  if (!b) return;
  const dpr = devicePixelRatio, W = canvas.clientWidth, H = canvas.clientHeight;
  const top = (root.querySelector(".chips")?.getBoundingClientRect().bottom || 80) + 64;
  const bottom = (root.querySelector(".dome")?.getBoundingClientRect().top || H * 0.6) - 24;
  let x = W / 2, y = (top + bottom) / 2 - 40;
  if (!mapFull && !s.st.arrived) {
    const c = cam.toCam(enu(here, s.posAt(s.nav.stepAt[s.st.idx + 1] ?? s.nav.total)));
    if (c.d > 2) {
      const [sx, sy] = cam.toScreen(c);
      if (sx > 0 && sx < W * dpr) { x = sx / dpr; y = sy / dpr - 70; }
    }
  }
  const bw = b.offsetWidth, bh = b.offsetHeight;
  x = Math.max(12 + bw / 2, Math.min(W - 12 - bw / 2, x));
  y = Math.max(top, Math.min(bottom - bh, y));
  b.style.transform = `translate(${(x - bw / 2).toFixed(1)}px, ${y.toFixed(1)}px)`;
}
// Anneau de boussole du dôme : « N » placé là où se trouve le nord par rapport au regard
function placeNorth(heading) {
  const n = root.querySelector(".ring-n");
  if (!n) return;
  const ring = root.querySelector(".ring").getBoundingClientRect(), dome = root.querySelector(".dome").getBoundingClientRect();
  const rel = ((-heading + 540) % 360) - 180;
  n.style.opacity = Math.abs(rel) <= RING_DEG ? "1" : "0";
  // même courbe que l'arc dessiné (Bézier quadratique 8,118 → 200,-20 → 392,118)
  const t = 0.5 + Math.max(-RING_DEG, Math.min(RING_DEG, rel)) / RING_DEG * 0.42;
  const x = (1 - t) ** 2 * 8 + 2 * (1 - t) * t * 200 + t * t * 392, y = (1 - t) ** 2 * 118 + 2 * (1 - t) * t * -20 + t * t * 118;
  n.style.left = `${(ring.left - dome.left + x / 400 * ring.width).toFixed(1)}px`;
  n.style.top = `${(ring.top - dome.top + y / 120 * ring.height).toFixed(1)}px`;
}
function settingsSheet(s) {
  const seg = (act, opts, cur) => `<div class="seg">${opts.map(([v, l, ic]) =>
    `<button data-act="${act}" data-v="${v}" class="${cur === v ? "on" : ""}">${ic ? icon(ic) : ""}${l}</button>`).join("")}</div>`;
  return `<div class="sheet-head"><h3>${icon("sliders-horizontal")} Réglages du guidage</h3><button class="x" data-act="close-sheet" aria-label="Fermer">${icon("x")}</button></div>
    <p class="sheet-label">Position</p>${seg("mode", [["sim", "Simulation", "play"], ["gps", "GPS réel", "locate-fixed"]], s.mode)}
    ${s.mode === "sim" ? `<div class="sheet-row"><button class="btn soft" data-act="play">${icon(s.playing ? "pause" : "play")} ${s.playing ? "Pause" : "Marcher"}</button>
      ${seg("speed", [[1, "×1"], [5, "×5"], [20, "×20"]], s.factor)}<button class="icon-btn" data-act="rewind" aria-label="Recommencer">${icon("rotate-ccw")}</button></div>` : ""}
    <p class="sheet-label">Orientation de la vue</p>${seg("orient", [["route", "Sens de l'itinéraire", "route"], ["compass", "Boussole", "compass"]], useCompass ? "compass" : "route")}
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
  else if (act === "report") { sheet = "report"; sheetMessage = null; api.pause(); }
  else if (act === "close-sheet") sheet = null;
  else if (act === "map") setMapFull(!mapFull);
  else if (act === "hud") api.openHud();
  else if (act === "voice") api.toggleVoice();
  else if (act === "compass" || act === "orient") useCompass = act === "compass" ? !useCompass : v === "compass";
  else if (act === "play") api.togglePlay();
  else if (act === "mode") api.setMode(v);
  else if (act === "speed") api.setFactor(+v);
  else if (act === "rewind") api.rewind();
  else if (act === "theme") api.setTheme(v);
  else if (act === "blocking") { blocking = b.checked; return; }
  else if (act === "report-kind") { sheetMessage = api.report(v, blocking); setTimeout(() => { if (sheet === "report") { sheet = null; lastUi = ""; } }, 1800); }
  else if (act === "stop") { sheet = null; api.stop(); return; }
  lastUi = "";
}
function setMapFull(on) {
  mapFull = on;
  root.classList.toggle("map-full", on);
  setTimeout(() => api.map.invalidateSize(), 320);
}

// ---- Ouverture / fermeture ------------------------------------------------------------------------------
export async function openAR(options) {
  api = options;
  useCompass = api.state()?.mode === "gps";
  smoothHeading = null; mapFull = false; sheet = null; lastUi = "";
  root = document.getElementById("ar");
  root.hidden = false;
  root.className = "";
  root.innerHTML = `<video playsinline muted autoplay></video><canvas></canvas>
    <div class="dome"><div class="dome-map"></div>
      <svg class="ring" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
        <path class="ring-arc" d="M8 118 Q200 -20 392 118"/>${Array.from({length: 23}, (_, i) => {
          const t = i / 22, x = (1 - t) * (1 - t) * 8 + 2 * (1 - t) * t * 200 + t * t * 392, y = (1 - t) * (1 - t) * 118 + 2 * (1 - t) * t * -20 + t * t * 118;
          return `<circle cx="${x.toFixed(1)}" cy="${(y + 7).toFixed(1)}" r="${i % 5 === 0 ? 1.6 : 1}"/>`;
        }).join("")}</svg>
      <span class="ring-n">N</span></div>
    <div class="ar-ui"></div>`;
  video = root.querySelector("video");
  canvas = root.querySelector("canvas");
  ctx = canvas.getContext("2d");
  root.querySelector(".dome-map").append(api.map.getContainer());
  api.map.invalidateSize();
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
