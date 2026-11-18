// Panneau de diagnostic de la vue AR (js/diag.js).
//
// Ce qui compte ici : une alerte ne doit se lever que lorsqu'il y a vraiment quelque chose à
// voir. Un panneau qui crie tout le temps ne se lit plus, et c'est de nuit, en marchant, qu'on
// le regarde.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {creerMesureur, lignesDiag, memeCadre} from "../js/diag.js";

const SAIN = {
  video: {w: 1280, h: 720}, videoBox: {w: 393, h: 852},
  canvas: {w: 1179, h: 2556}, canvasBox: {w: 393, h: 852}, dpr: 3,
  piste: {readyState: "live", muted: false, w: 1280, h: 720, fps: 30},
  images: 58, lecture: {n: 40, min: 4, med: 7, max: 15}, relances: 0,
};
const ligne = (etat, cle) => lignesDiag(etat).find(l => l.cle === cle);

// ---- Mesureur ---------------------------------------------------------------------------------

test("sans mesure, aucune statistique inventée", () => {
  assert.equal(creerMesureur().stats(), null);
});

test("minimum, médiane et maximum sur les durées relevées", () => {
  const m = creerMesureur();
  [10, 2, 6, 30, 4].forEach(v => m.ajouter(v));
  const s = m.stats();
  assert.equal(s.n, 5);
  assert.equal(s.min, 2);
  assert.equal(s.med, 6);
  assert.equal(s.max, 30);
});

test("seules les dernières mesures comptent : un pic ancien ne pèse pas pour toujours", () => {
  const m = creerMesureur(3);
  [900, 1, 2, 3].forEach(v => m.ajouter(v));
  assert.equal(m.stats().max, 3, "le pic de 900 ms est sorti de la fenêtre");
  assert.equal(m.stats().n, 3);
});

test("valeurs absurdes écartées", () => {
  const m = creerMesureur();
  [NaN, undefined, null, "12"].forEach(v => m.ajouter(v));
  assert.equal(m.stats(), null);
});

// ---- Le cadre : la mesure qui tranche le bug 4 -------------------------------------------------

test("vidéo et tracé dans la même boîte : rien à signaler", () => {
  assert.equal(memeCadre({w: 393, h: 852}, {w: 393, h: 852}), true);
  assert.equal(memeCadre({w: 393, h: 852}, {w: 394, h: 851}), true, "un pixel d'écart est du bruit");
});

test("vidéo réduite pendant que le tracé occupe tout : c'est exactement le bug 4", () => {
  assert.equal(memeCadre({w: 393, h: 480}, {w: 393, h: 852}), false);
  assert.equal(ligne({...SAIN, videoBox: {w: 393, h: 480}}, "cadre").alerte, true);
});

test("cadre inconnu : on ne prétend pas que tout va bien", () => {
  assert.equal(memeCadre(null, {w: 1, h: 1}), false);
});

// ---- Les alertes ne se lèvent que quand il le faut ---------------------------------------------

test("tout va bien : aucune ligne n'alerte", () => {
  assert.deepEqual(lignesDiag(SAIN).filter(l => l.alerte).map(l => l.cle), []);
});

test("piste coupée : la ligne alerte et le dit en clair", () => {
  const l = ligne({...SAIN, piste: {...SAIN.piste, muted: true}}, "piste");
  assert.equal(l.alerte, true);
  assert.match(l.texte, /COUPÉE/);
});

test("piste absente : alerte", () => {
  assert.equal(ligne({...SAIN, piste: null}, "piste").alerte, true);
});

test("lecture d'image lente : c'est le suspect du gel, il doit sauter aux yeux", () => {
  assert.equal(ligne({...SAIN, lecture: {n: 40, min: 20, med: 40, max: 90}}, "lecture").alerte, true);
  assert.equal(ligne(SAIN, "lecture").alerte, false, "7 ms de médiane n'est pas un problème");
});

test("affichage effondré : alerte sous vingt images par seconde", () => {
  assert.equal(ligne({...SAIN, images: 12}, "images").alerte, true);
  assert.equal(ligne({...SAIN, images: 58}, "images").alerte, false);
});

test("une relance de caméra est toujours digne d'intérêt", () => {
  assert.equal(ligne({...SAIN, relances: 1}, "relances").alerte, true);
  assert.equal(ligne(SAIN, "relances").alerte, false);
});

test("un mesureur peut être passé directement, sans appeler stats()", () => {
  const m = creerMesureur();
  [50, 60, 70].forEach(v => m.ajouter(v));
  assert.equal(ligne({...SAIN, lecture: m}, "lecture").alerte, true);
});

test("panneau sans aucune donnée : il s'affiche sans casser", () => {
  const l = lignesDiag();
  assert.ok(l.length >= 5);
  assert.ok(l.every(x => typeof x.texte === "string"));
});
