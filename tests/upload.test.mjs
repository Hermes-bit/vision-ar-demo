// Envoi des images de relevé (js/upload.js) : découpe, traduction, et surtout ce qu'on a le
// droit d'effacer du téléphone. Aucun réseau : `fetch` est remplacé.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {LOT, lots, descriptionDe, deviceId, setDeviceId, CODE_RE, envoyer} from "../js/upload.js";

const image = (id, o = {}) => ({
  id, created: "2026-11-14T03:12:00.000Z", lat: 48.933, lon: 2.297, accuracy: 8,
  heading: 42, pitch: 10, width: 1280, height: 720, model: "detecteur_obstacles.onnx",
  kind: "releve", detections: [], blob: new Blob([new Uint8Array([255, 216, 255])]), ...o,
});

// Remplace fetch le temps d'un appel ; renvoie les requêtes vues.
function fauxReseau(reponse) {
  const vues = [];
  globalThis.fetch = async (url, init) => {
    vues.push({url, init});
    return typeof reponse === "function" ? reponse(vues.length) : reponse;
  };
  return vues;
}
const ok = corps => ({ok: true, status: 201, json: async () => corps});

test("découpe en lots de 10 par défaut", () => {
  const l = lots(Array.from({length: 25}, (_, i) => i));
  assert.deepEqual(l.map(x => x.length), [10, 10, 5]);
  assert.equal(LOT, 10);
});

test("liste vide : aucun lot", () => {
  assert.deepEqual(lots([]), []);
});

test("traduction vers le format du serveur", () => {
  const d = descriptionDe(image("1763070000-a1b2c"));
  assert.equal(d.sample_id, "1763070000-a1b2c");
  assert.equal(d.captured_at, "2026-11-14T03:12:00.000Z");
  assert.equal(d.width_px, 1280);
  assert.equal(d.height_px, 720);
  assert.equal(d.heading_deg, 42);
  assert.equal(d.accuracy_m, 8);
});

test("image sans position : écartée, car le serveur rejetterait tout le lot", () => {
  assert.equal(descriptionDe(image("x", {lat: undefined})), null);
  assert.equal(descriptionDe(image("x", {lon: null})), null);
  assert.equal(descriptionDe(null), null);
});

test("boussole ou précision absentes : null, pas NaN", () => {
  const d = descriptionDe(image("x", {heading: undefined, accuracy: undefined, pitch: null}));
  assert.equal(d.heading_deg, null);
  assert.equal(d.accuracy_m, null);
  assert.equal(d.pitch_deg, null);
});

test("cap de -1 conservé : c'est une valeur normale, pas une absence", () => {
  assert.equal(descriptionDe(image("x", {heading: -1})).heading_deg, -1);
});

test("identifiant d'appareil : tiré une fois, puis stable", () => {
  const d = new Map();
  const store = {get: (k, v) => (d.has(k) ? d.get(k) : v), set: (k, v) => d.set(k, v)};
  const a = deviceId(store);
  assert.ok(a.length >= 16, `trop court : ${a}`);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "doit passer le contrôle du serveur");
  assert.equal(deviceId(store), a, "ne doit pas changer d'un appel à l'autre");
});

test("envoi : les identifiants accusés par le serveur sont effaçables", async () => {
  const vues = fauxReseau(ok([{sample_id: "a", stored: true}, {sample_id: "b", stored: false, reason: "déjà reçu"}]));
  const r = await envoyer([image("a"), image("b")], {url: "/samples", device: "appareil-0123456789"});
  assert.deepEqual(r.envoyes, ["a", "b"], "« déjà reçu » compte aussi : l'image est arrivée");
  assert.deepEqual(r.refuses, []);
  assert.equal(vues.length, 1);
  assert.equal(vues[0].init.headers["X-Device-Id"], "appareil-0123456789");
});

test("envoi en plusieurs lots, avec progression", async () => {
  const vues = fauxReseau(n => ok(Array.from({length: n === 3 ? 5 : 10}, (_, i) => ({sample_id: `s${n}-${i}`, stored: true}))));
  const etapes = [];
  const images = Array.from({length: 25}, (_, i) => image(`s${i}`));
  const r = await envoyer(images, {url: "/samples", onProgress: (f, t) => etapes.push([f, t])});
  assert.equal(vues.length, 3, "25 images = 3 requêtes");
  assert.deepEqual(etapes, [[10, 25], [20, 25], [25, 25]]);
  assert.equal(r.envoyes.length, 25);
});

test("erreur serveur : rien n'est déclaré envoyé", async () => {
  fauxReseau({ok: false, status: 500, json: async () => ({})});
  const r = await envoyer([image("a"), image("b")], {url: "/samples"});
  assert.deepEqual(r.envoyes, [], "aucune image ne doit être effacée du téléphone");
  assert.equal(r.refuses.length, 2);
  assert.match(r.refuses[0].raison, /500/);
});

test("images sans position : refusées sans être envoyées", async () => {
  const vues = fauxReseau(ok([{sample_id: "bonne", stored: true}]));
  const r = await envoyer([image("bonne"), image("perdue", {lat: undefined})], {url: "/samples"});
  assert.deepEqual(r.envoyes, ["bonne"]);
  assert.deepEqual(r.refuses, [{id: "perdue", raison: "sans position"}]);
  assert.equal(JSON.parse(vues[0].init.body.get("metas")).length, 1, "une seule description envoyée");
});

test("rien à envoyer : aucune requête réseau", async () => {
  const vues = fauxReseau(ok([]));
  const r = await envoyer([], {url: "/samples"});
  assert.deepEqual(r, {envoyes: [], refuses: []});
  assert.equal(vues.length, 0);
});


const faireStore = () => {
  const d = new Map();
  return {get: (k, v) => (d.has(k) ? d.get(k) : v), set: (k, v) => d.set(k, v)};
};

test("reprendre un code sur un autre appareil : les envois se regroupent", () => {
  const premier = faireStore(), second = faireStore();
  const code = deviceId(premier);
  assert.equal(setDeviceId(second, code), code);
  assert.equal(deviceId(second), code, "le second appareil envoie désormais sous le même code");
});

test("code collé avec des espaces : nettoyé, pas refusé", () => {
  const s = faireStore(), code = "a".repeat(20);
  assert.equal(setDeviceId(s, `  ${code}
`), code);
});

test("saisie qui ne convient pas : refusée, et le code en place est gardé", () => {
  const s = faireStore(), avant = deviceId(s);
  for (const mauvais of ["abc", "", null, "a".repeat(20) + "/evasion", "a".repeat(200)]) {
    assert.equal(setDeviceId(s, mauvais), null, `devrait refuser ${JSON.stringify(mauvais)}`);
  }
  assert.equal(deviceId(s), avant, "un refus ne doit jamais faire perdre le code existant");
});

test("un code abîmé dans le stockage est remplacé, pas propagé au serveur", () => {
  const s = faireStore();
  s.set("va-device-id", "trop-court");
  const code = deviceId(s);
  assert.ok(CODE_RE.test(code), "le serveur n'accepterait pas « trop-court »");
});

