// Voix Hermès et Séléna (js/voices.js) : texte rendu prononçable, découpage en phrases, fichier son.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {VOICES, normalizeFr, sentences, wavBlob} from "../js/voices.js";

test("les deux voix choisies : Hermès (mls, locuteur 8778 = n° 7) et Séléna (upmc, Jessica = n° 0)", () => {
  assert.equal(VOICES.hermes.name, "Hermès");
  assert.equal(VOICES.hermes.model, "fr/fr_FR/mls/medium/fr_FR-mls-medium");
  assert.equal(VOICES.hermes.speaker, 7);
  assert.equal(VOICES.selena.name, "Séléna");
  assert.equal(VOICES.selena.model, "fr/fr_FR/upmc/medium/fr_FR-upmc-medium");
  assert.equal(VOICES.selena.speaker, 0);
});

test("unités dites en entier (la voix lisait « m » comme la lettre)", () => {
  assert.equal(normalizeFr("Dans 140 m, tournez à droite"), "Dans 140 mètres, tournez à droite");
  assert.equal(normalizeFr("2,3 km, environ 44 min"), "2 virgule 3 kilomètres, environ 44 minutes");
  assert.equal(normalizeFr("pente 6 %"), "pente 6 pour cent");
  assert.equal(normalizeFr("Encore 1 m"), "Encore 1 mètre");
  assert.equal(normalizeFr("1 min"), "1 minute");
  assert.equal(normalizeFr("21 m"), "21 mètres");
});

test("un mot déjà écrit en entier n'est pas modifié (« mètres » avec accent)", () => {
  assert.equal(normalizeFr("Dans 50 mètres, tournez à droite."), "Dans 50 mètres, tournez à droite.");
  assert.equal(normalizeFr("à 6 mètres, devant vous"), "à 6 mètres, devant vous");
  assert.equal(normalizeFr("3 minutes"), "3 minutes");
});

test("séparateurs de l'écran remplacés par des pauses", () => {
  assert.equal(normalizeFr("Attention : 170 m sur la chaussée"), "Attention, 170 mètres sur la chaussée");
  assert.equal(normalizeFr("Encore 1 m · porte"), "Encore 1 mètre, porte");
});

test("phrases séparées : la voix commence dès que la première est prête", () => {
  assert.deepEqual(sentences("Vous êtes au point de départ, le trajet commence. Partez, Esplanade Maria Casarès. 2,3 km."),
    ["Vous êtes au point de départ, le trajet commence.", "Partez, Esplanade Maria Casarès.", "2 virgule 3 kilomètres."]);
  assert.deepEqual(sentences(""), []);
});

test("fichier son WAV 16 bits, mono, à la fréquence de la voix", async () => {
  const pcm = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
  const buf = new DataView(await wavBlob(pcm, 22050).arrayBuffer());
  assert.equal(String.fromCharCode(buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3)), "RIFF");
  assert.equal(buf.getUint16(22, true), 1);                  // mono
  assert.equal(buf.getUint32(24, true), 22050);
  assert.equal(buf.getUint32(40, true), pcm.length * 2);
  assert.equal(buf.getInt16(44 + 3 * 2, true), 0x7fff);      // 1 -> maximum
  assert.equal(buf.getInt16(44 + 5 * 2, true), 0x7fff);      // au-delà de 1 : limité
});
