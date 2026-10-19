// Tests des calculs du détecteur YOLO (js/yolo.js). Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {decodeYolo, letterbox, namesFromOnnx, nms, toNCHW} from "../js/yolo.js";

test("letterbox 1280 × 720 dans 640 : bandes en haut et en bas", () => {
  const lb = letterbox(1280, 720, 640);
  assert.deepEqual(lb, {S: 640, k: 0.5, nw: 640, nh: 360, px: 0, py: 140});
});

test("NCHW : plans R, G, B séparés, valeurs 0–1", () => {
  const out = toNCHW(new Uint8ClampedArray([255, 0, 51, 255, 0, 255, 0, 255]), 1, new Float32Array(6));
  // S = 1 : un seul pixel lu (les 4 premiers octets)
  assert.deepEqual([...out.slice(0, 3)].map(v => +v.toFixed(2)), [1, 0, 0.2]);
});

test("décodage : seuil 0,5, NMS, retour à l'échelle de la vidéo, nombre de classes lu sur la sortie", () => {
  const C = 8, N = 100, data = new Float32Array((4 + C) * N);
  const put = (j, cx, cy, w, h, c, s) => { data[j] = cx; data[N + j] = cy; data[2 * N + j] = w; data[3 * N + j] = h; data[(4 + c) * N + j] = s; };
  put(0, 320, 400, 40, 80, 5, 0.9);     // potelet
  put(1, 322, 401, 40, 80, 5, 0.7);     // même potelet, doublon -> retiré par la NMS
  put(2, 100, 300, 20, 20, 0, 0.3);     // barrière trop peu sûre -> ignorée
  put(3, 330, 400, 40, 80, 1, 0.8);     // autre classe au même endroit -> gardée (NMS par classe)
  const lb = letterbox(1280, 720, 640);
  const d = decodeYolo(data, [1, 4 + C, N], lb, {minScore: 0.5, vw: 1280, vh: 720});
  assert.equal(d.length, 2);
  assert.equal(d[0].cls, 5);
  assert.deepEqual(d[0].box.map(v => Math.round(v)), [600, 440, 80, 160]);   // (320-20)/0,5 ; (400-40-140)/0,5
});

test("NMS : garde la plus sûre", () => {
  const k = nms([{cls: 0, score: 0.6, box: [0, 0, 10, 10]}, {cls: 0, score: 0.9, box: [1, 1, 10, 10]}]);
  assert.equal(k.length, 1);
  assert.equal(k[0].score, 0.9);
});

test("noms des classes lus dans les métadonnées ONNX", () => {
  const fake = new TextEncoder().encode("xx\u0000names\u0012\u0050{0: 'barriere', 1: 'deux_roues', 2: 'potelet'}\u0000yy");
  assert.deepEqual(namesFromOnnx(fake), ["barriere", "deux_roues", "potelet"]);
  const f = new URL("../models/detecteur_obstacles.onnx", import.meta.url);
  if (existsSync(f)) assert.deepEqual(namesFromOnnx(readFileSync(f)),
    ["barriere", "deux_roues", "mobilier", "pieton_immobile", "poteau", "potelet", "travaux", "voiture_trottoir"]);
});
