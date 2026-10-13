// Détection d'obstacles par la caméra (expérimental) et collecte d'images pour entraîner un modèle dédié.
//
// Modèle actuel : COCO-SSD (TensorFlow.js, entraîné sur 80 objets du quotidien), chargé seulement si
// l'usager active la détection. Il reconnaît une partie des obstacles du trottoir : vélos et deux-roues,
// voitures et camions, bancs, bornes à incendie, horodateurs, panneaux, bacs à plantes, chaises et tables
// de terrasse, valises. Il NE connaît PAS les potelets, poubelles, barrières de travaux, trous, marches :
// c'est le rôle du modèle dédié, entraîné avec les images collectées ici (voir docs/entrainement-obstacles.md).
//
// Distance et côté : le bas de la boîte détectée touche le sol ; avec la hauteur du téléphone, son
// inclinaison et la focale de la caméra, on en déduit la distance et le décalage gauche / droite.

export const MODEL_VERSION = "coco-ssd-lite-mobilenet-v2@2.2.3";
const TFJS = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const COCO = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";

// Classes COCO utiles sur un trottoir -> nom en français, et si elles déclenchent une alerte
export const CLASSES = {
  bicycle: ["Vélo", true], motorcycle: ["Deux-roues", true], car: ["Voiture", true], truck: ["Camion", true],
  bench: ["Banc", true], "fire hydrant": ["Borne", true], "parking meter": ["Horodateur", true], "stop sign": ["Panneau", true],
  "potted plant": ["Bac à plantes", true], chair: ["Chaise de terrasse", true], "dining table": ["Table de terrasse", true],
  suitcase: ["Valise", true], person: ["Personne", false], dog: ["Chien", false], bus: ["Bus", false], "traffic light": ["Feu", false],
};
// Catégories à annoter pour le modèle dédié (le modèle actuel n'en connaît qu'une partie)
export const TARGET_CATEGORIES = ["potelet", "borne", "poteau", "poubelle", "trottinette", "velo", "deux_roues", "vehicule_sur_trottoir",
  "terrasse", "travaux", "barriere", "trou", "marche", "vegetation", "mobilier_urbain", "panneau", "banc", "autre"];

let model = null, loading = null;
function loadScript(src) {
  return new Promise((ok, ko) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    s.onload = ok; s.onerror = () => ko(new Error(`chargement impossible : ${src}`));
    document.head.append(s);
  });
}
/** Charge TensorFlow.js et le modèle (≈ 6 Mo, une seule fois). */
export function loadModel() {
  if (model) return Promise.resolve(model);
  loading ||= (async () => {
    await loadScript(TFJS);
    await loadScript(COCO);
    model = await window.cocoSsd.load({base: "lite_mobilenet_v2"});
    return model;
  })().catch(e => { loading = null; throw e; });
  return loading;
}
export const modelReady = () => !!model;

/** Détections sur l'image vidéo : [{cls, label, alert, score, box: [x, y, w, h] en pixels vidéo}]. */
export async function detect(video, minScore = 0.2) {
  if (!model || !video.videoWidth) return [];
  const raw = await model.detect(video, 20, minScore);
  return raw.map(d => ({cls: d.class, label: CLASSES[d.class]?.[0] || d.class, alert: !!CLASSES[d.class]?.[1], score: d.score, box: d.bbox}));
}

/**
 * Position au sol d'une détection : distance (m) et décalage latéral (m, négatif = à gauche).
 * `view` : {vw, vh, W, H, focal (px écran), pitchDeg, height (m)} ; image vidéo affichée en « cover ».
 */
export function groundPosition(det, view) {
  const {vw, vh, W, H, focal, pitchDeg, height} = view;
  const scale = Math.max(W / vw, H / vh), ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const [x, y, w, h] = det.box;
  const sx = ox + (x + w / 2) * scale, sy = oy + (y + h) * scale;         // milieu du bas de la boîte, à l'écran
  const below = pitchDeg * Math.PI / 180 + Math.atan((sy - H / 2) / focal);
  if (below < 0.03) return null;                                          // au-dessus de l'horizon : pas au sol
  const dist = height / Math.tan(below);
  const lateral = dist * (sx - W / 2) / focal;
  return {dist, lateral, screen: [ox + x * scale, oy + y * scale, w * scale, h * scale]};
}
export const sideText = lateral => lateral < -0.5 ? "sur votre gauche" : lateral > 0.5 ? "sur votre droite" : "devant vous";

// ---- Collecte pour l'entraînement (N°18) : images floutées, stockées sur ce téléphone ------------------------
const DB = "va-dataset", STORE = "samples";
function db() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, {keyPath: "id"});
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, ko) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE), res = fn(st);
    t.oncomplete = () => ok(res?.result ?? res); t.onerror = () => ko(t.error);
  });
}
/**
 * Enregistre l'image caméra courante avec ses métadonnées. Visages et plaques : les personnes sont
 * entièrement floutées, et le bas des véhicules (zone des plaques) aussi, avant tout enregistrement.
 */
export async function captureSample(video, {kind, note = "", detections = [], meta = {}}) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) throw new Error("pas d'image caméra");
  const k = Math.min(1, 1280 / Math.max(vw, vh)), w = Math.round(vw * k), h = Math.round(vh * k);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(video, 0, 0, w, h);
  const blur = (x, y, bw, bh) => {
    x = Math.max(0, x); y = Math.max(0, y); bw = Math.min(w - x, bw); bh = Math.min(h - y, bh);
    if (bw <= 2 || bh <= 2) return;
    g.save(); g.beginPath(); g.rect(x, y, bw, bh); g.clip(); g.filter = "blur(18px)";
    g.drawImage(c, 0, 0); g.restore();
  };
  for (const d of detections) {
    const [x, y, bw, bh] = d.box.map(v => v * k);
    if (d.cls === "person") blur(x - 8, y - 8, bw + 16, bh + 16);
    if (["car", "truck", "bus", "motorcycle"].includes(d.cls)) blur(x, y + bh * 0.55, bw, bh * 0.45);
  }
  const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.82));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sample = {id, kind, note, width: w, height: h, blob, model: MODEL_VERSION, created: new Date().toISOString(), ...meta,
    detections: detections.map(d => ({cls: d.cls, label: d.label, score: +d.score.toFixed(3), box: d.box.map(v => +(v * k).toFixed(1))}))};
  await tx("readwrite", st => st.put(sample));
  return sample;
}
export const listSamples = () => tx("readonly", st => st.getAll());
export const clearSamples = () => tx("readwrite", st => st.clear());

// ---- Export ZIP (format COCO) : à importer dans Label Studio, CVAT ou Roboflow ------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {                                         // fichiers stockés sans compression (les JPEG le sont déjà)
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const {name, data} of files) {
    const n = enc.encode(name), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(8, 0, true);
    head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true); head.setUint16(26, n.length, true);
    parts.push(new Uint8Array(head.buffer), n, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, n.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {type: "application/zip"});
}
/** ZIP : images/*.jpg + annotations.json (COCO ; boîtes du modèle en pré-annotation, à corriger). */
export async function exportZip() {
  const samples = await listSamples();
  const cats = TARGET_CATEGORIES.map((name, i) => ({id: i + 1, name}));
  const cocoToTarget = {bicycle: "velo", motorcycle: "deux_roues", car: "vehicule_sur_trottoir", truck: "vehicule_sur_trottoir",
    bench: "banc", "fire hydrant": "borne", "parking meter": "mobilier_urbain", "stop sign": "panneau", "potted plant": "vegetation",
    chair: "terrasse", "dining table": "terrasse", suitcase: "autre"};
  const images = [], annotations = [], files = [];
  let aid = 1;
  samples.forEach((s, i) => {
    const file = `images/${s.id}.jpg`;
    images.push({id: i + 1, file_name: file, width: s.width, height: s.height, date_captured: s.created,
      vision_ar: {kind: s.kind, note: s.note, model: s.model, lat: s.lat, lon: s.lon, accuracy_m: s.accuracy, heading: s.heading, pitch: s.pitch}});
    for (const d of s.detections) {
      const target = cocoToTarget[d.cls];
      if (!target) continue;
      annotations.push({id: aid++, image_id: i + 1, category_id: TARGET_CATEGORIES.indexOf(target) + 1, bbox: d.box,
        area: d.box[2] * d.box[3], iscrowd: 0, score: d.score, source: s.model});
    }
  });
  for (const s of samples) files.push({name: `images/${s.id}.jpg`, data: new Uint8Array(await s.blob.arrayBuffer())});
  files.push({name: "annotations.json", data: new TextEncoder().encode(JSON.stringify(
    {info: {description: "Vision AR — obstacles sur trottoir (Gennevilliers)", version: "1", date_created: new Date().toISOString()},
     licenses: [], categories: cats, images, annotations}, null, 1))});
  return zip(files);
}
