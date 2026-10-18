// Détection d'obstacles par la caméra (expérimental) et collecte d'images pour entraîner un modèle dédié.
//
// Modèle dédié (prioritaire) : YOLO entraîné sur 10 classes d'obstacles de trottoir (potelet, poteau, barrière,
// mobilier, deux-roues, voiture sur le trottoir, travaux, dénivelé, obstacle en hauteur, piéton immobile),
// exporté pour le web dans models/obstacles/ (model.json + labels.json : voir ml/ et
// docs/entrainement-obstacles.md). S'il n'est pas là, on se rabat sur le modèle généraliste ci-dessous.
//
// Modèle de secours : COCO-SSD (TensorFlow.js, entraîné sur 80 objets du quotidien), chargé seulement si
// l'usager active la détection. Il reconnaît une partie des obstacles du trottoir : vélos et deux-roues,
// voitures et camions, bancs, bornes à incendie, horodateurs, panneaux, bacs à plantes, chaises et tables
// de terrasse, valises. Il NE connaît PAS les potelets, poubelles, barrières de travaux, trous, marches :
// c'est le rôle du modèle dédié, entraîné avec les images collectées ici (voir docs/entrainement-obstacles.md).
//
// Distance et côté : le bas de la boîte détectée touche le sol ; avec la hauteur du téléphone, son
// inclinaison et la focale de la caméra, on en déduit la distance et le décalage gauche / droite.

import {OBSTACLE_LABELS} from "./corridor.js";

export let MODEL_VERSION = "coco-ssd-lite-mobilenet-v2@2.2.3";
const YOLO_DIR = "models/obstacles/";
const TFJS = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const COCO = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";

// Classes COCO utiles sur un trottoir -> nom en français, et si elles déclenchent une alerte
export const CLASSES = {
  // véhicules : jamais d'alerte (on ne sait pas s'ils sont garés sur la chaussée ou sur le trottoir)
  bicycle: ["Vélo", true], motorcycle: ["Deux-roues", true], car: ["Voiture", false], truck: ["Camion", false],
  bench: ["Banc", true], "fire hydrant": ["Borne", true], "parking meter": ["Horodateur", true], "stop sign": ["Panneau", true],
  "potted plant": ["Bac à plantes", true], chair: ["Chaise de terrasse", true], "dining table": ["Table de terrasse", true],
  suitcase: ["Valise", true], person: ["Personne", false], dog: ["Chien", false], bus: ["Bus", false], "traffic light": ["Feu", false],
};
// Catégories à annoter pour le modèle dédié (le modèle actuel n'en connaît qu'une partie)
// (les 10 classes du modèle dédié, dans le même ordre que ml/obstacles.yaml)
export const TARGET_CATEGORIES = ["potelet", "poteau", "barriere", "mobilier", "deux_roues", "voiture_trottoir", "travaux",
  "denivele", "obstacle_haut", "pieton_immobile"];

let model = null, loading = null, yolo = null;   // yolo : {graph, names, imgsz}
function loadScript(src) {
  return new Promise((ok, ko) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    s.onload = ok; s.onerror = () => ko(new Error(`chargement impossible : ${src}`));
    document.head.append(s);
  });
}
/** Charge TensorFlow.js et le modèle : le modèle dédié s'il est publié, sinon COCO-SSD (≈ 6 Mo, une seule fois). */
export function loadModel() {
  if (model) return Promise.resolve(model);
  loading ||= (async () => {
    await loadScript(TFJS);
    const meta = await fetch(YOLO_DIR + "labels.json").then(r => r.ok ? r.json() : null).catch(() => null);
    if (meta?.names?.length) {
      try {
        yolo = {graph: await window.tf.loadGraphModel(YOLO_DIR + "model.json"), names: meta.names, imgsz: meta.imgsz || 320};
        MODEL_VERSION = meta.version || "yolo-obstacles";
        model = yolo.graph;
        return model;
      } catch (e) { console.warn("Modèle dédié illisible, retour au modèle généraliste", e); yolo = null; }
    }
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
  if (yolo) return detectYolo(video, minScore);
  const raw = await model.detect(video, 20, minScore);
  return raw.map(d => ({cls: d.class, label: OBSTACLE_LABELS[d.class] || CLASSES[d.class]?.[0] || d.class, alert: !!CLASSES[d.class]?.[1], score: d.score, box: d.bbox}));
}
// Modèle dédié (export Ultralytics « tfjs », sans NMS intégré) : image mise au carré (bandes grises comme à
// l'entraînement), sortie [1, 4 + classes, N] -> boîtes, puis suppression des doublons (NMS, IoU 0,45).
async function detectYolo(video, minScore) {
  const tf = window.tf, S = yolo.imgsz, vw = video.videoWidth, vh = video.videoHeight, k = S / Math.max(vw, vh);
  const nw = Math.round(vw * k), nh = Math.round(vh * k), px = Math.floor((S - nw) / 2), py = Math.floor((S - nh) / 2);
  const [boxes, scores, classes] = tf.tidy(() => {
    const img = tf.image.resizeBilinear(tf.browser.fromPixels(video), [nh, nw]).div(255);
    const input = img.pad([[py, S - nh - py], [px, S - nw - px], [0, 0]], 114 / 255).expandDims(0);
    let out = yolo.graph.execute(input);
    if (Array.isArray(out)) out = out[0];
    const t = out.squeeze([0]).transpose();               // [N, 4 + classes]
    const xywh = t.slice([0, 0], [-1, 4]), cls = t.slice([0, 4], [-1, -1]);
    const [cx, cy, w, h] = tf.split(xywh, 4, 1);
    const yx = tf.concat([cy.sub(h.div(2)), cx.sub(w.div(2)), cy.add(h.div(2)), cx.add(w.div(2))], 1);
    return [yx, cls.max(1), cls.argMax(1)];
  });
  const keep = await tf.image.nonMaxSuppressionAsync(boxes, scores, 20, 0.45, minScore);
  const [b, sc, c, idx] = await Promise.all([boxes.array(), scores.array(), classes.array(), keep.array()]);
  tf.dispose([boxes, scores, classes, keep]);
  return idx.map(i => {
    const [y1, x1, y2, x2] = b[i], cls = yolo.names[c[i]] || String(c[i]);
    const x = (x1 - px) / k, y = (y1 - py) / k;
    return {cls, label: OBSTACLE_LABELS[cls] || cls, alert: cls in OBSTACLE_LABELS, score: sc[i], box: [x, y, (x2 - x1) / k, (y2 - y1) / k]};
  });
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
  const halfWidth = dist * (w * scale / 2) / focal;                        // demi-largeur de l'objet, au sol (m)
  return {dist, lateral, halfWidth, screen: [ox + x * scale, oy + y * scale, w * scale, h * scale]};
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
  // pré-annotations : classes COCO -> classes du modèle dédié (les voitures sont à vérifier : sur le trottoir ou non)
  const cocoToTarget = {bicycle: "deux_roues", motorcycle: "deux_roues", car: "voiture_trottoir", truck: "voiture_trottoir",
    bench: "mobilier", "fire hydrant": "potelet", "parking meter": "mobilier", "stop sign": "poteau", "potted plant": "mobilier",
    chair: "mobilier", "dining table": "mobilier", person: "pieton_immobile"};
  const images = [], annotations = [], files = [];
  let aid = 1;
  samples.forEach((s, i) => {
    const file = `images/${s.id}.jpg`;
    images.push({id: i + 1, file_name: file, width: s.width, height: s.height, date_captured: s.created,
      vision_ar: {kind: s.kind, note: s.note, model: s.model, lat: s.lat, lon: s.lon, accuracy_m: s.accuracy, heading: s.heading, pitch: s.pitch}});
    for (const d of s.detections) {
      const target = TARGET_CATEGORIES.includes(d.cls) ? d.cls : cocoToTarget[d.cls];
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
