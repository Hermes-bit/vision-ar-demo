// Vue caméra « réalité augmentée » : la rue filmée par la caméra arrière, avec
// l'itinéraire dessiné au sol en perspective et les étiquettes des obstacles.
//
// Pas de reconnaissance d'image : tout vient des données (itinéraire, signalements,
// bordures, marches, pentes) placées par la position (GPS ou simulation), la boussole
// et l'inclinaison du téléphone. Précision : quelques mètres, celle du GPS et de la boussole.
import {haversineM} from "./routing.js";

const CAMERA_HEIGHT_M = 1.4;      // hauteur du téléphone tenu devant soi (fauteuil : ~1,1 m)
const VFOV_DEG = 62;              // champ vertical approximatif d'une caméra arrière en portrait
const AHEAD_M = 70;               // longueur d'itinéraire dessinée
const NEAR_M = 1.2;               // en deçà, rien n'est dessiné (trop près de l'objectif)
const START_M = 2.5;              // le ruban commence un peu devant soi
const RIBBON_M = 0.8, GLOW_M = 1.4;
const TITLE = {left: "À gauche", slight_left: "Légèrement à gauche", right: "À droite", slight_right: "Légèrement à droite",
  uturn: "Demi-tour", straight: "Tout droit", depart: "Tout droit", arrive: "Arrivée"};
const PROFILE = {manual_wheelchair: "Profil PMR", electric_wheelchair: "Profil PMR", cane_or_walker: "Profil mobilité réduite",
  low_vision: "Profil malvoyant", hard_of_hearing: "Profil malentendant", pedestrian: "Profil piéton"};
const REPORT_LABEL = {works: "Travaux", step: "Marche", street_furniture: "Mobilier urbain", narrow_sidewalk: "Trottoir étroit",
  elevator_out: "Ascenseur en panne", parked_vehicle: "Véhicule garé", other: "Obstacle"};
// Flèches de la carte de consigne (dessinées, comme sur la maquette)
const ICON = {
  right: "M7 21V12a3 3 0 0 1 3-3h8M14 5l4 4-4 4", left: "M17 21V12a3 3 0 0 0-3-3H6M10 5L6 9l4 4",
  slight_right: "M8 21v-6l8-8M10 7h6v6", slight_left: "M16 21v-6L8 7M14 7H8v6",
  straight: "M12 21V4M7 9l5-5 5 5", depart: "M12 21V4M7 9l5-5 5 5", uturn: "M8 21V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4",
  arrive: "M12 21v-7M12 3a5 5 0 0 1 5 5c0 4-5 7-5 7s-5-3-5-7a5 5 0 0 1 5-5z",
};

let api = null, root = null, video = null, canvas = null, ctx = null, stream = null, raf = 0;
let sensors = {heading: null, pitch: null, roll: 0, source: "itinéraire"}, useCompass = false, smoothHeading = null;

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const round5 = m => m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;
const dist = m => m < 1000 ? `${round5(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;

// ---- Capteurs --------------------------------------------------------------------------
function screenAngle() { return (screen.orientation?.angle ?? window.orientation ?? 0) % 360; }
function onOrientation(e) {
  const angle = screenAngle();
  let heading = null;
  if (typeof e.webkitCompassHeading === "number") heading = e.webkitCompassHeading;            // iPhone
  else if (e.absolute && typeof e.alpha === "number") heading = (360 - e.alpha) % 360;           // Android
  if (heading !== null) sensors.heading = (heading + angle + 360) % 360;
  if (typeof e.beta === "number") {
    // inclinaison sous l'horizon : téléphone vertical = 0°, à plat écran vers le ciel = 90°
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
    // coordonnées caméra : r (droite), v (haut), d (profondeur)
    toCam(p) {
      const fwd = p.x * sy + p.y * cyw, right = p.x * cyw - p.y * sy;
      return {r: right, v: fwd * sp + p.z * cp, d: fwd * cp - p.z * sp};
    },
    toScreen(c) { return [w / 2 + c.r / c.d * f, h / 2 - c.v / c.d * f]; },
    scale(depth) { return f / depth; },              // pixels par mètre à cette profondeur
  };
}
// Coupe un polygone (en coordonnées caméra) devant le plan proche
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

// ---- Dessin ---------------------------------------------------------------------------------
function ribbonPath(cam, pts, halfWidth) {
  ctx.beginPath();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * halfWidth, ny = dx / L * halfWidth;
    const quad = [{x: a.x + nx, y: a.y + ny, z: a.z}, {x: b.x + nx, y: b.y + ny, z: b.z},
                  {x: b.x - nx, y: b.y - ny, z: b.z}, {x: a.x - nx, y: a.y - ny, z: a.z}];
    const clipped = clipNear(quad.map(p => cam.toCam(p)));
    if (clipped.length < 3) continue;
    clipped.forEach((c, k) => { const [sx, sy] = cam.toScreen(c); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
  }
}
function drawRibbon(cam, pts) {
  if (pts.length < 2) return;
  ribbonPath(cam, pts, GLOW_M / 2);
  ctx.fillStyle = "rgba(80, 220, 255, 0.20)";
  ctx.fill("nonzero");
  ribbonPath(cam, pts, RIBBON_M / 2);
  ctx.fillStyle = "rgba(40, 200, 255, 0.55)";
  ctx.fill("nonzero");
  // ligne centrale pointillée
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3 * devicePixelRatio;
  ctx.setLineDash([14 * devicePixelRatio, 12 * devicePixelRatio]);
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipNear([cam.toCam(pts[i]), cam.toCam(pts[i + 1])]);
    if (seg.length < 2) { pen = false; continue; }
    const [x1, y1] = cam.toScreen(seg[0]), [x2, y2] = cam.toScreen(seg[1]);
    if (!pen) ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    pen = true;
  }
  ctx.stroke();
  ctx.restore();
  // flèche au bout du ruban
  const a = pts.at(-2), b = pts.at(-1), dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L, s = 1.3;
  const tri = [{x: b.x + ux * s, y: b.y + uy * s, z: b.z}, {x: b.x - uy * s * 0.75, y: b.y + ux * s * 0.75, z: b.z},
               {x: b.x + uy * s * 0.75, y: b.y - ux * s * 0.75, z: b.z}].map(p => cam.toCam(p));
  if (tri.every(c => c.d >= NEAR_M)) {
    ctx.beginPath();
    tri.forEach((c, k) => { const [sx, sy] = cam.toScreen(c); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = "#39d0ff";
    ctx.fill();
  }
}
function pill(x, y, text, strong, color) {
  const dpr = devicePixelRatio;
  ctx.font = `700 ${15 * dpr}px system-ui, -apple-system, Roboto, sans-serif`;
  const wStrong = ctx.measureText(strong).width;
  ctx.font = `400 ${15 * dpr}px system-ui, -apple-system, Roboto, sans-serif`;
  const wText = ctx.measureText(" " + text).width;
  const padX = 12 * dpr, dot = 10 * dpr, h = 32 * dpr, w = padX * 2 + dot + 8 * dpr + wStrong + wText;
  const left = Math.max(8 * dpr, Math.min(canvas.width - w - 8 * dpr, x - w / 2)), top = y - h;
  ctx.fillStyle = "rgba(20, 28, 36, 0.82)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(left, top, w, h, h / 2) : ctx.rect(left, top, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(left + padX + dot / 2, top + h / 2, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${15 * dpr}px system-ui, -apple-system, Roboto, sans-serif`;
  ctx.fillText(strong, left + padX + dot + 8 * dpr, top + h / 2 + dpr);
  ctx.font = `400 ${15 * dpr}px system-ui, -apple-system, Roboto, sans-serif`;
  ctx.fillText(" " + text, left + padX + dot + 8 * dpr + wStrong, top + h / 2 + dpr);
  return {left, top, w, h};
}
function brackets(x, y, size, color) {
  const dpr = devicePixelRatio, s = size, k = Math.max(8 * dpr, s * 0.28);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * dpr;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x - s, y - s, 1, 1], [x + s, y - s, -1, 1], [x - s, y + s * 0.4, 1, -1], [x + s, y + s * 0.4, -1, -1]]) {
    ctx.moveTo(cx, cy + dy * k); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * k, cy);
  }
  ctx.stroke();
}

// Points d'intérêt le long de l'itinéraire : bordures, marches, traversées, pentes, signalements
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
      if (e.is_crossing && e.kerb_lowered === true) out.push({at, label: "Trottoir abaissé", ahead, color: "#2fd27a"});
      else if (e.is_crossing && e.kerb_lowered === false) out.push({at, label: "Bordure haute", ahead, color: "#ff5a5f"});
      if (e.is_crossing && e.sound_signal) out.push({at, label: "Feu sonore", ahead: ahead + 0.01, color: "#2fd27a", lift: 1});
      if (e.has_step) out.push({at, label: "Marche", ahead, color: "#ffb020"});
      if (e.slope_pct !== null && Math.abs(e.slope_pct) >= 5)
        out.push({at, label: `${e.slope_pct > 0 ? "Montée" : "Descente"} ${Math.abs(e.slope_pct).toFixed(0)} %`, ahead, color: "#ffb020"});
    }
    along += len;
  }
  for (const r of reports) {
    const d = haversineM(nav.here.lat, nav.here.lon, r.lat, r.lon);
    if (d < AHEAD_M) out.push({at: r, label: REPORT_LABEL[r.kind] || "Obstacle", ahead: d, color: "#ff5a5f", obstacle: true});
  }
  return out;
}

// Rectangles occupés par les cartes de l'interface, en pixels du canevas
function reservedAreas() {
  const dpr = devicePixelRatio, out = [];
  for (const el of root.querySelectorAll(".ar-chip, .ar-alert, .ar-step, .ar-foot > *")) {
    const r = el.getBoundingClientRect();
    if (r.width) out.push({left: r.left * dpr, top: r.top * dpr, w: r.width * dpr, h: r.height * dpr, ui: true});
  }
  return out;
}
// Cherche, au-dessus du point visé, une place qui ne chevauche ni une carte ni une autre étiquette
function freeSpot(taken, x, ty, label) {
  const dpr = devicePixelRatio, h = 32 * dpr, w = (label.length * 9 + 110) * dpr;
  const box = y => ({left: Math.max(8 * dpr, Math.min(canvas.width - w - 8 * dpr, x - w / 2)), top: y - h, w, h});
  const hits = b => taken.find(t => b.left < t.left + t.w && t.left < b.left + b.w && b.top < t.top + t.h + 6 * dpr && t.top < b.top + b.h + 6 * dpr);
  for (let y = ty, tries = 0; tries < 12; tries++) {
    const t = hits(box(y));
    if (!t) return y;
    y = t.ui ? t.top + t.h + h + 10 * dpr : t.top - 6 * dpr;   // sous une carte, au-dessus d'une étiquette
    if (y > canvas.height - 120 * dpr) return null;
  }
  return null;
}

function routeBearing(s) {
  const a = s.posAt(s.nav.pos), b = s.posAt(Math.min(s.nav.total, s.nav.pos + 8));
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

function frame() {
  raf = requestAnimationFrame(frame);
  const s = api.state();
  if (!s) return;
  const dpr = devicePixelRatio, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);

  const compass = useCompass && sensors.heading !== null;
  const heading = smooth(compass ? sensors.heading : routeBearing(s));
  const pitch = Math.max(5, Math.min(70, sensors.pitch ?? 24));
  const cam = makeCamera(heading, pitch, w, h);
  const here = s.nav.here;

  // horizon légèrement penché comme le téléphone
  ctx.save();
  if (sensors.roll) { ctx.translate(w / 2, h / 2); ctx.rotate(-sensors.roll * Math.PI / 180 * 0.5); ctx.translate(-w / 2, -h / 2); }
  const pts = [];
  for (let d = s.nav.pos + START_M; d <= Math.min(s.nav.total, s.nav.pos + AHEAD_M); d += 2) pts.push(enu(here, s.posAt(d)));
  if (s.nav.total - s.nav.pos > 0.5) pts.push(enu(here, s.posAt(Math.min(s.nav.total, s.nav.pos + AHEAD_M))));
  drawRibbon(cam, pts);

  // étiquettes, les plus lointaines d'abord
  const anchors = anchorsAhead(s).sort((a, b) => b.ahead - a.ahead);
  const placed = reservedAreas(), labels = [];
  for (const a of anchors) {
    const c = cam.toCam(enu(here, a.at));
    if (c.d < 1.5) continue;
    const [x, y] = cam.toScreen(c);
    if (x < -40 * dpr || x > w + 40 * dpr || y < 0 || y > h) continue;
    const size = Math.max(14 * dpr, Math.min(110 * dpr, cam.scale(c.d) * (a.obstacle ? 1.2 : 0.7)));
    brackets(x, y, size, a.color);
    let ty = y - size - 8 * dpr - (a.lift ? 40 * dpr : 0);
    ty = freeSpot(placed, x, ty, a.label);
    if (ty === null) continue;                         // pas de place : l'étiquette attendra d'être plus proche
    const pillH = 32 * dpr, pillW = (a.label.length * 9 + 110) * dpr;
    placed.push({left: x - pillW / 2, top: ty - pillH, w: pillW, h: pillH});
    labels.push([x, ty, dist(Math.max(1, a.ahead)), a.label, a.color]);
  }
  for (const l of labels) pill(...l);                  // étiquettes par-dessus tous les cadres
  ctx.restore();
  renderCards(s, compass);
}

function renderCards(s, compass) {
  const st = s.st, next = st.next, r = s.nav.route;
  const title = st.arrived ? "Vous êtes arrivé" : next.maneuver === "arrive" ? `Arrivée dans ${dist(st.toManeuver)}`
    : `${TITLE[next.maneuver] || "Tout droit"} dans ${dist(st.toManeuver)}`;
  const sub = st.arrived ? s.dest?.label || "" : next.alerts.some(a => a.startsWith("Traversée"))
    ? `Traversez au passage piéton${next.alerts.some(a => a.includes("feu sonore")) ? " (feu sonore)" : ""}`
    : next.street ? next.street : next.alerts.join(" · ") || "Suivez la ligne au sol";
  const icon = ICON[st.arrived ? "arrive" : next.maneuver] || ICON.straight;
  const rer = s.nav.rerouted && Date.now() - s.nav.rerouted.at < 10000 ? s.nav.rerouted : null;
  const clean = r.accessible && !r.warnings.includes("données incomplètes");
  const mins = Math.max(1, Math.ceil(st.remaining / s.speed / 60));
  const html = `
    <div class="ar-chip"><i></i>${esc(PROFILE[s.mobility] || "Profil")}</div>
    ${rer ? `<div class="ar-alert"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3zm0 6v6m0 3v.01"/></svg>
      <div><b>${esc(rer.title)}</b><span>Itinéraire recalculé</span></div></div>` : ""}
    <div class="ar-step" role="status" aria-live="polite">
      <div class="ar-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg></div>
      <div><b>${esc(title)}</b><span>${esc(sub)}</span></div></div>
    <div class="ar-foot">
    ${useCompass && sensors.heading === null ? `<div class="ar-note">Boussole indisponible : orientation suivant l'itinéraire</div>` : ""}
    <div class="ar-tools">
      ${s.mode === "sim" ? `<button data-ar="play" aria-label="${s.playing ? "Pause" : "Marcher"}">${s.playing ? "⏸" : "▶"}</button>` : ""}
      <button data-ar="compass" class="${useCompass ? "on" : ""}" aria-label="Orientation : ${compass ? "boussole" : "itinéraire"}">🧭</button>
      <button data-ar="close" aria-label="Fermer la vue caméra">✕</button></div>
    <div class="ar-bottom"><b>${esc(s.dest?.label || "Destination")}</b>
      <span><b>${dist(st.remaining)}</b> · ${mins} min · <em class="${clean ? "ok" : "warn"}">${
        clean ? "itinéraire 100 % accessible" : r.accessible ? "itinéraire accessible · données à confirmer" : "itinéraire non praticable"}</em></span></div>
    </div>`;
  const ui = root.querySelector(".ar-ui");
  if (ui.dataset.html !== html) { ui.innerHTML = html; ui.dataset.html = html; }
}

// ---- Ouverture / fermeture ------------------------------------------------------------------
export async function openAR(options) {
  api = options;
  useCompass = api.state()?.mode === "gps";
  smoothHeading = null;
  root = document.getElementById("ar");
  root.hidden = false;
  root.innerHTML = `<video playsinline muted autoplay></video><canvas></canvas><div class="ar-ui"></div>`;
  video = root.querySelector("video");
  canvas = root.querySelector("canvas");
  ctx = canvas.getContext("2d");
  root.querySelector(".ar-ui").onclick = e => {
    const b = e.target.closest("[data-ar]");
    if (!b) return;
    if (b.dataset.ar === "close") closeAR();
    else if (b.dataset.ar === "play") api.togglePlay();
    else if (b.dataset.ar === "compass") useCompass = !useCompass;
  };
  startSensors();
  frame();                                             // l'interface d'abord, la caméra peut mettre du temps
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    root.classList.add("no-camera");
    api.toast?.("Caméra indisponible ou refusée : aperçu sans image de la rue.");
  }
}
export function closeAR() {
  cancelAnimationFrame(raf);
  stopSensors();
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (root) { root.hidden = true; root.innerHTML = ""; root.classList.remove("no-camera"); }
  api?.onClose?.();
}
export const arOpen = () => root && !root.hidden;
