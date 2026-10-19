// Calculs du détecteur YOLO (export Ultralytics ONNX, sans NMS intégré), sans dépendance au navigateur :
// mise au carré « letterbox », décodage de la sortie, suppression des doublons (NMS), noms des classes.
// Testé par web/tests/yolo.test.mjs.

/** Mise au carré : l'image (vw × vh) est réduite dans un carré de S px, centrée, bandes grises autour. */
export function letterbox(vw, vh, S = 640) {
  const k = Math.min(S / vw, S / vh), nw = Math.round(vw * k), nh = Math.round(vh * k);
  return {S, k, nw, nh, px: Math.floor((S - nw) / 2), py: Math.floor((S - nh) / 2)};
}

/**
 * Pixels RGBA d'un carré S × S -> tenseur NCHW [1, 3, S, S], valeurs 0–1 (ordre attendu par Ultralytics).
 * `out` : Float32Array réutilisé d'une image à l'autre (moins de travail pour le ramasse-miettes).
 */
export function toNCHW(rgba, S, out = new Float32Array(3 * S * S)) {
  const plane = S * S;
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    out[i] = rgba[j] / 255;
    out[plane + i] = rgba[j + 1] / 255;
    out[2 * plane + i] = rgba[j + 2] / 255;
  }
  return out;
}

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
};
/** NMS par classe : on garde la boîte la plus sûre, on retire celles de la même classe qui la recouvrent trop. */
export function nms(dets, iouMax = 0.45, maxOut = 20) {
  const sorted = [...dets].sort((a, b) => b.score - a.score), kept = [];
  for (const d of sorted) {
    if (kept.some(k => k.cls === d.cls && iou(k.box, d.box) > iouMax)) continue;
    kept.push(d);
    if (kept.length >= maxOut) break;
  }
  return kept;
}

/**
 * Sortie [1, 4 + C, N] (cx, cy, w, h en pixels du carré, puis un score par classe) -> détections dans
 * l'image d'origine : [{cls (indice), score, box: [x, y, w, h]}]. Le nombre de classes C se lit sur
 * la forme de la sortie : un modèle v2 avec d'autres classes marche sans changer le code.
 */
export function decodeYolo(data, dims, lb, {minScore = 0.5, iouMax = 0.45, vw = Infinity, vh = Infinity} = {}) {
  const C = dims[1] - 4, N = dims[2], out = [];
  for (let j = 0; j < N; j++) {
    let best = -1, score = minScore;
    for (let c = 0; c < C; c++) {
      const s = data[(4 + c) * N + j];
      if (s >= score) { score = s; best = c; }
    }
    if (best < 0) continue;
    const cx = data[j], cy = data[N + j], w = data[2 * N + j], h = data[3 * N + j];
    // retour à l'échelle de la vidéo : on enlève les bandes, on divise par le facteur de réduction
    let x = (cx - w / 2 - lb.px) / lb.k, y = (cy - h / 2 - lb.py) / lb.k, bw = w / lb.k, bh = h / lb.k;
    const x2 = Math.min(vw, x + bw), y2 = Math.min(vh, y + bh);
    x = Math.max(0, x); y = Math.max(0, y); bw = x2 - x; bh = y2 - y;
    if (bw > 1 && bh > 1) out.push({cls: best, score, box: [x, y, bw, bh]});
  }
  return nms(out, iouMax);
}

/**
 * Noms des classes inscrits par Ultralytics dans les métadonnées du fichier ONNX
 * (« names » : {0: 'barriere', 1: 'deux_roues', …}). Lus directement dans les octets du fichier : ainsi un
 * nouveau modèle apporte ses propres noms. Renvoie [] si rien n'est trouvé.
 */
export function namesFromOnnx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tail = u8.subarray(Math.max(0, u8.length - 65536));             // les métadonnées sont à la fin du fichier
  let text = "";
  for (let i = 0; i < tail.length; i += 8192) text += String.fromCharCode(...tail.subarray(i, i + 8192));
  try { text = decodeURIComponent(escape(text)); } catch { /* octets non UTF-8 autour : on garde le texte brut */ }
  const at = text.lastIndexOf("names");
  const m = at >= 0 && text.slice(at).match(/\{(\s*\d+\s*:\s*'[^']*'\s*,?)+\s*\}/);
  if (!m) return [];
  const names = [];
  for (const [, i, n] of m[0].matchAll(/(\d+)\s*:\s*'([^']*)'/g)) names[+i] = n;
  return names;
}
