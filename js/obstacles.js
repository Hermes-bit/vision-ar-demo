// Détection d'obstacles par la caméra et collecte d'images pour améliorer le modèle.
//
// Modèle : models/detecteur_obstacles.onnx — YOLO11n entraîné par Geomessen sur les obstacles du trottoir,
// exporté par Ultralytics (entrée 640 × 640, sortie [1, 4 + classes, 8400], sans NMS). Exécuté sur le
// téléphone par onnxruntime-web (WebAssembly), dans un fil à part (js/detector-worker.js) : il ne peut plus
// bloquer l'écran. Rien n'est envoyé sur Internet.
//
// Remplacer le modèle par une v2 : déposer le nouveau fichier sous le même nom. Le nombre de classes est lu sur
// la sortie du modèle et leurs noms dans les métadonnées du fichier (js/yolo.js) : aucun code à changer
// (ajouter seulement le nom parlé des nouvelles classes dans OBSTACLE_LABELS, js/corridor.js).
//
// Calculs (mise au carré, décodage, NMS) : js/yolo.js. Couloir, distance et annonces : js/corridor.js.

import {spokenName} from "./corridor.js";
import {decodeYolo, letterbox, namesFromOnnx, toNCHW} from "./yolo.js";

const MODEL_URL = "models/detecteur_obstacles.onnx";
const INPUT = 640;
// Noms si le fichier n'en contient pas (ordre du modèle v1)
const DEFAULT_NAMES = ["barriere", "deux_roues", "mobilier", "pieton_immobile", "poteau", "potelet", "travaux", "voiture_trottoir"];

export let MODEL_VERSION = "detecteur_obstacles.onnx";
export let TARGET_CATEGORIES = DEFAULT_NAMES;           // catégories de l'export d'images (= classes du modèle)
export let lastLuma = 128;                                // luminosité moyenne de la dernière image (0–255)
export let BACKEND = "";                                  // moteur utilisé, affiché en mode test

let worker = null, ready = false, loading = null, names = DEFAULT_NAMES, canvas = null, ctx2d = null;
let spare = null, seq = 0;
const pending = new Map();                               // analyses en cours dans le fil du détecteur
function ask(msg, transfer = []) {
  return new Promise((ok, ko) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); ko(new Error("détecteur trop lent")); }, msg.type === "init" ? 120000 : 15000);
    pending.set(id, {ok: v => { clearTimeout(timer); ok(v); }, ko: e => { clearTimeout(timer); ko(e); }, type: msg.type});
    worker.postMessage({...msg, id}, transfer);
  });
}
/**
 * Charge le modèle (≈ 11 Mo, une seule fois ; gardé ensuite pour le hors-ligne) dans un fil à part
 * (js/detector-worker.js) : l'écran reste utilisable pendant le chargement et les analyses.
 */
export function loadModel() {
  if (ready) return Promise.resolve(true);
  loading ||= (async () => {
    const bytes = await fetch(MODEL_URL).then(r => { if (!r.ok) throw new Error(`modèle introuvable (${r.status})`); return r.arrayBuffer(); });
    const read = namesFromOnnx(new Uint8Array(bytes));
    if (read.length) names = read;
    worker = new Worker(new URL("./detector-worker.js", import.meta.url));
    worker.onmessage = ({data: m}) => {
      const job = m.type === "ready" ? [...pending.entries()].find(([, j]) => j.type === "init") : [m.id, pending.get(m.id)];
      if (!job?.[1]) return;
      pending.delete(job[0]);
      if (m.type === "error") job[1].ko(new Error(m.message)); else job[1].ok(m);
    };
    worker.onerror = e => { for (const j of pending.values()) j.ko(new Error(e.message || "erreur du détecteur")); pending.clear(); };
    await ask({type: "init", bytes, size: INPUT}, [bytes]);
    ready = true;
    BACKEND = "wasm (fil séparé)";
    TARGET_CATEGORIES = names;
    MODEL_VERSION = `detecteur_obstacles.onnx (${names.length} classes, ${BACKEND})`;
    return true;
  })().catch(e => { loading = null; worker?.terminate(); worker = null; throw e; });
  return loading;
}
export const modelReady = () => ready;

/**
 * Détections sur l'image vidéo : [{cls, label, alert, score, box: [x, y, w, h] en pixels vidéo}].
 * Image mise au carré 640 × 640 (bandes grises comme à l'entraînement), valeurs 0–1, format NCHW ; le modèle
 * tourne dans son fil ; sortie décodée ici : seuil `minScore`, NMS (IoU 0,45), boîtes à l'échelle de la vidéo.
 */
export async function detect(video, minScore = 0.5) {
  if (!ready || !video.videoWidth) return [];
  const vw = video.videoWidth, vh = video.videoHeight, lb = letterbox(vw, vh, INPUT);
  if (!canvas) {
    canvas = document.createElement("canvas"); canvas.width = canvas.height = INPUT;
    ctx2d = canvas.getContext("2d", {willReadFrequently: true});
  }
  ctx2d.fillStyle = "rgb(114,114,114)";
  ctx2d.fillRect(0, 0, INPUT, INPUT);
  ctx2d.drawImage(video, lb.px, lb.py, lb.nw, lb.nh);
  const px = ctx2d.getImageData(0, 0, INPUT, INPUT).data;
  // luminosité moyenne de l'image (échantillon) : la nuit, le détecteur est moins sûr de lui (voir js/ar.js)
  let sum = 0, cnt = 0;
  for (let i = 0; i < px.length; i += 4 * 97) { sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; cnt++; }
  lastLuma = sum / cnt;
  const input = toNCHW(px, INPUT, spare || undefined);
  spare = null;
  const res = await ask({type: "run", input, size: INPUT}, [input.buffer]);
  spare = res.input;                                     // le tampon revient : réutilisé à l'image suivante
  return decodeYolo(res.data, res.dims, lb, {minScore, iouMax: 0.45, vw, vh}).map(d => {
    const cls = names[d.cls] ?? `classe_${d.cls}`;
    return {cls, label: spokenName(cls), alert: true, score: d.score, box: d.box};
  });
}

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
    if (d.cls === "pieton_immobile") blur(x - 8, y - 8, bw + 16, bh + 16);
    if (["voiture_trottoir", "deux_roues"].includes(d.cls)) blur(x, y + bh * 0.55, bw, bh * 0.45);
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
  // images prises avec l'ancien détecteur (COCO) : classes COCO -> classes du modèle (voitures à vérifier)
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
