// Détection d'obstacles par la caméra et collecte d'images pour améliorer le modèle.
//
// Modèle : models/detecteur_obstacles.onnx — YOLO11n entraîné par Geomessen sur les obstacles du trottoir,
// exporté par Ultralytics (entrée 640 × 640, sortie [1, 4 + classes, 8400], sans NMS). Exécuté sur le
// téléphone par onnxruntime-web : WebGPU si le navigateur l'a (Safari iOS 26, Chrome Android récents), sinon
// WebAssembly. Rien n'est envoyé sur Internet.
//
// Remplacer le modèle par une v2 : déposer le nouveau fichier sous le même nom. Le nombre de classes est lu sur
// la sortie du modèle et leurs noms dans les métadonnées du fichier (js/yolo.js) : aucun code à changer
// (ajouter seulement le nom parlé des nouvelles classes dans OBSTACLE_LABELS, js/corridor.js).
//
// Calculs (mise au carré, décodage, NMS) : js/yolo.js. Couloir, distance et annonces : js/corridor.js.

import {spokenName} from "./corridor.js";
import {decodeYolo, letterbox, namesFromOnnx, toNCHW} from "./yolo.js";

const MODEL_URL = "models/detecteur_obstacles.onnx";
const ORT_DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const INPUT = 640;
// Noms si le fichier n'en contient pas (ordre du modèle v1)
const DEFAULT_NAMES = ["barriere", "deux_roues", "mobilier", "pieton_immobile", "poteau", "potelet", "travaux", "voiture_trottoir"];

export let MODEL_VERSION = "detecteur_obstacles.onnx";
export let TARGET_CATEGORIES = DEFAULT_NAMES;           // catégories de l'export d'images (= classes du modèle)
export let BACKEND = "";                                  // « webgpu » ou « wasm », pour le mode test

let session = null, loading = null, names = DEFAULT_NAMES, canvas = null, ctx2d = null, input = null;
let modelBytes = null, slowRuns = 0, switching = false;
function loadScript(src) {
  return new Promise((ok, ko) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script");
    s.src = src; s.async = true; s.crossOrigin = "anonymous";
    s.onload = ok; s.onerror = () => ko(new Error(`chargement impossible : ${src}`));
    document.head.append(s);
  });
}
/** Charge onnxruntime-web et le modèle (≈ 11 Mo, une seule fois ; gardé ensuite pour le hors-ligne). */
export function loadModel() {
  if (session) return Promise.resolve(session);
  loading ||= (async () => {
    const gpu = !!navigator.gpu;
    await loadScript(ORT_DIR + (gpu ? "ort.webgpu.min.js" : "ort.min.js"));
    const ort = window.ort;
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const bytes = new Uint8Array(await fetch(MODEL_URL).then(r => { if (!r.ok) throw new Error(`modèle introuvable (${r.status})`); return r.arrayBuffer(); }));
    modelBytes = bytes;
    const read = namesFromOnnx(bytes);
    if (read.length) names = read;
    for (const providers of gpu ? [["webgpu"], ["wasm"]] : [["wasm"]]) {
      try {
        session = await ort.InferenceSession.create(bytes, {executionProviders: providers, graphOptimizationLevel: "all"});
        BACKEND = providers[0];
        break;
      } catch (e) { console.warn(`Détecteur : ${providers[0]} indisponible`, e); }
    }
    if (!session) throw new Error("aucun moteur d'exécution disponible");
    // analyse « à vide » : la première exécution prépare les calculs (plusieurs secondes en WebGPU) ;
    // faite ici, pendant « Chargement du détecteur », la première vraie image est analysée sans attente
    try {
      const warm = await session.run({[session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * INPUT * INPUT), [1, 3, INPUT, INPUT])});
      Object.values(warm).forEach(t => t.dispose?.());
    } catch (e) { console.warn("Détecteur : préchauffage impossible", e); }
    TARGET_CATEGORIES = names;
    MODEL_VERSION = `detecteur_obstacles.onnx (${names.length} classes, ${BACKEND})`;
    return session;
  })().catch(e => { loading = null; throw e; });
  return loading;
}
export const modelReady = () => !!session;
// Garde-fou : si WebGPU est plus lent que prévu (pilote graphique, téléphone chargé), au-delà de 1,5 s par
// image trois fois de suite, on repasse en WebAssembly, plus prévisible.
function watchdog(ms) {
  if (BACKEND !== "webgpu" || switching) return;
  slowRuns = ms > 1500 ? slowRuns + 1 : 0;
  if (slowRuns < 3) return;
  switching = true;
  window.ort.InferenceSession.create(modelBytes, {executionProviders: ["wasm"], graphOptimizationLevel: "all"})
    .then(s => { const old = session; session = s; BACKEND = "wasm"; MODEL_VERSION = MODEL_VERSION.replace("webgpu", "wasm"); old.release?.(); })
    .catch(e => console.warn("Détecteur : passage en WebAssembly impossible", e))
    .finally(() => { switching = false; slowRuns = 0; });
}

/**
 * Détections sur l'image vidéo : [{cls, label, alert, score, box: [x, y, w, h] en pixels vidéo}].
 * Image mise au carré 640 × 640 (bandes grises comme à l'entraînement), valeurs 0–1, format NCHW ;
 * sortie décodée, seuil `minScore`, NMS (IoU 0,45), boîtes ramenées à l'échelle de la vidéo.
 */
export async function detect(video, minScore = 0.5) {
  if (!session || !video.videoWidth) return [];
  const vw = video.videoWidth, vh = video.videoHeight, lb = letterbox(vw, vh, INPUT);
  if (!canvas) {
    canvas = document.createElement("canvas"); canvas.width = canvas.height = INPUT;
    ctx2d = canvas.getContext("2d", {willReadFrequently: true});
  }
  ctx2d.fillStyle = "rgb(114,114,114)";
  ctx2d.fillRect(0, 0, INPUT, INPUT);
  ctx2d.drawImage(video, lb.px, lb.py, lb.nw, lb.nh);
  input = toNCHW(ctx2d.getImageData(0, 0, INPUT, INPUT).data, INPUT, input || undefined);
  const ort = window.ort, feeds = {[session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, INPUT, INPUT])};
  const t0 = performance.now(), res = await session.run(feeds), out = res[session.outputNames[0]];
  watchdog(performance.now() - t0);
  const data = out.data instanceof Float32Array ? out.data : Float32Array.from(await out.getData());
  out.dispose?.();
  return decodeYolo(data, out.dims, lb, {minScore, iouMax: 0.45, vw, vh}).map(d => {
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
