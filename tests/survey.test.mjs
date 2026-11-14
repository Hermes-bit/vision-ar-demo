// Relevé systématique (js/survey.js) : quand photographier, et surtout quand s'abstenir.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {creerReleve, ecartCap, RELEVE} from "../js/survey.js";

const LAT0 = 48.9330, LON0 = 2.2970;
const nord = m => LAT0 + m / 111320;                 // ~m mètres au nord
const fix = (m, o = {}) => ({lat: nord(m), lon: LON0, acc: 8, cap: 0, at: 100000 + m * 1000, ...o});

test("la toute première position est toujours photographiée", () => {
  const r = creerReleve();
  const d = r.decider(fix(0));
  assert.equal(d.capturer, true);
  assert.equal(d.raison, "premiere");
});

test("en ligne droite : une image tous les 25 m, pas avant", () => {
  const r = creerReleve();
  r.noter(fix(0));
  assert.equal(r.decider(fix(20)).capturer, false, "20 m ne suffisent pas");
  assert.equal(r.decider(fix(20)).raison, "pas-assez-avance");
  const d = r.decider(fix(26));
  assert.equal(d.capturer, true);
  assert.equal(d.raison, "pas");
  assert.ok(d.distance > 25 && d.distance < 27, `distance ${d.distance}`);
});

test("après un virage, on resserre à 10 m : la scène change vite", () => {
  const r = creerReleve();
  r.noter(fix(0, {cap: 0}));
  const d = r.decider(fix(12, {cap: 90}));
  assert.equal(d.capturer, true);
  assert.equal(d.raison, "virage");
});

test("virage mais encore trop près : on attend quand même", () => {
  const r = creerReleve();
  r.noter(fix(0, {cap: 0}));
  const d = r.decider(fix(5, {cap: 90}));
  assert.equal(d.capturer, false);
  assert.equal(d.raison, "virage-trop-pres");
});

test("un léger lacet n'est pas un virage", () => {
  const r = creerReleve();
  r.noter(fix(0, {cap: 0}));
  assert.equal(r.decider(fix(12, {cap: 20})).capturer, false, "20° reste de la marche normale");
});

test("position trop floue : une image de référence mal placée ne sert à rien", () => {
  const r = creerReleve();
  r.noter(fix(0));
  const d = r.decider(fix(40, {acc: 45}));
  assert.equal(d.capturer, false);
  assert.equal(d.raison, "position-trop-floue");
});

test("deux positions coup sur coup : on ne prend pas deux images du même endroit", () => {
  const r = creerReleve();
  r.noter(fix(0, {at: 100000}));
  const d = r.decider({...fix(40), at: 100500});          // 500 ms plus tard
  assert.equal(d.capturer, false);
  assert.equal(d.raison, "trop-tot");
});

test("à l'arrêt, rien n'est photographié, même après longtemps", () => {
  const r = creerReleve();
  r.noter(fix(0, {at: 100000}));
  for (const t of [120000, 180000, 300000]) {
    assert.equal(r.decider({...fix(0), at: t}).capturer, false, `à t=${t}`);
  }
  assert.equal(r.etat().images, 1, "une seule image, celle du départ");
});

test("le plafond de stockage est respecté", () => {
  const r = creerReleve({maxImages: 3});
  for (let i = 0; i < 3; i++) {
    const f = fix(i * 30);
    assert.equal(r.decider(f).capturer, true, `image ${i + 1}`);
    r.noter(f);
  }
  const d = r.decider(fix(200));
  assert.equal(d.capturer, false);
  assert.equal(d.raison, "plein");
  assert.equal(r.etat().reste, 0);
});

test("sans position : refus, pas de plantage", () => {
  const r = creerReleve();
  for (const f of [null, {}, {lat: NaN, lon: 2}, {lat: 48.9, lon: undefined}]) {
    assert.equal(r.decider(f).capturer, false);
    assert.equal(r.decider(f).raison, "sans-position");
  }
});

test("écart de cap : le passage par zéro ne compte pas pour 340 degrés", () => {
  assert.equal(ecartCap(350, 10), 20);
  assert.equal(ecartCap(10, 350), 20);
  assert.equal(ecartCap(0, 180), 180);
  assert.equal(ecartCap(90, 90), 0);
});

test("cap inconnu (boussole indisponible) : aucun virage détecté", () => {
  assert.equal(ecartCap(-1, 90), 0);
  assert.equal(ecartCap(null, 90), 0);
  const r = creerReleve();
  r.noter(fix(0, {cap: -1}));
  assert.equal(r.decider(fix(12, {cap: -1})).capturer, false, "sans cap, seule la distance compte");
  assert.equal(r.decider(fix(30, {cap: -1})).capturer, true);
});

test("reprendre() : un nouveau relevé ne se souvient pas du précédent", () => {
  const r = creerReleve();
  r.noter(fix(0));
  assert.equal(r.decider(fix(5)).capturer, false);
  r.reprendre();
  assert.equal(r.decider(fix(5)).capturer, true, "première image du nouveau relevé");
  assert.equal(r.etat().images, 1, "le compteur de stockage, lui, est conservé");
});

test("les réglages par défaut restent cohérents entre eux", () => {
  assert.ok(RELEVE.pasVirageM < RELEVE.pasM, "un virage doit resserrer le pas, pas l'élargir");
  assert.ok(RELEVE.pasM <= 30, "au-delà de 30 m, un potelet passe entre deux images");
  assert.ok(RELEVE.precisionMaxM < RELEVE.pasM, "une précision pire que le pas rendrait la position inutile");
});
