// Tests du couloir de marche (js/corridor.js). Lancer : node --test web/tests/
import {test} from "node:test";
import assert from "node:assert/strict";
import {announceText, freeSpace, inCorridor, makeTracker, nextAnnouncement, positionText} from "../js/corridor.js";

const det = (cls, dist, lateral, halfWidth = 0.1, score = 0.8) => ({cls, label: cls === "potelet" ? "Potelet" : cls, score, ground: {dist, lateral, halfWidth}});

test("couloir : 1,5 m de large, 0,5 à 7 m de profondeur", () => {
  assert.equal(inCorridor({dist: 3, lateral: 0.5, halfWidth: 0.1}), true);
  assert.equal(inCorridor({dist: 3, lateral: 2.0, halfWidth: 0.4}), false);   // voiture garée le long de la rue
  assert.equal(inCorridor({dist: 3, lateral: 1.2, halfWidth: 0.6}), true);    // objet large qui mord sur le couloir
  assert.equal(inCorridor({dist: 12, lateral: 0, halfWidth: 0.1}), false);
  assert.equal(inCorridor({dist: 0.3, lateral: 0, halfWidth: 0.1}), false);
});

test("une détection isolée n'est pas confirmée ; deux images de suite oui", () => {
  const tr = makeTracker();
  assert.equal(tr.update([det("potelet", 4, 0.3)], 0).length, 0);
  assert.equal(tr.update([det("potelet", 3.8, 0.32)], 350).length, 1);
  assert.equal(tr.tracks.length, 1);                                          // même objet, une seule piste
});

test("faux positif d'une image : oublié après 1,5 s", () => {
  const tr = makeTracker();
  tr.update([det("potelet", 4, 0)], 0);
  tr.update([], 800);
  tr.update([], 1600);
  assert.equal(tr.tracks.length, 0);
});

test("une annonce par obstacle, la plus proche d'abord, avec le côté pour passer", () => {
  const tr = makeTracker(), st = {};
  for (const t of [0, 350]) tr.update([det("potelet", 3, 0.4), det("barriere", 6, -0.3, 0.3)], t);
  const a = nextAnnouncement(tr, 400, st);
  assert.equal(a.text, "Potelet légèrement à droite, 3 mètres, passez à gauche.");
  assert.equal(nextAnnouncement(tr, 500, st), null);                          // pas deux annonces en 2,5 s
  const b = nextAnnouncement(tr, 3000, st);
  assert.match(b.text, /^barriere légèrement à gauche, 6 mètres, passez à droite/);
  tr.update([det("potelet", 2.5, 0.4), det("barriere", 5.5, -0.3, 0.3)], 3100);
  assert.equal(nextAnnouncement(tr, 6000, st), null);                         // jamais répétée
});

test("rangée de potelets : une seule annonce", () => {
  const tr = makeTracker(), st = {};
  for (const t of [0, 350]) tr.update([det("potelet", 3, 0.4), det("potelet", 4.5, -0.5)], t);
  assert.ok(nextAnnouncement(tr, 400, st));
  assert.equal(nextAnnouncement(tr, 3000, st), null);
});

test("fauteuil : avertissement si la place restante est trop étroite", () => {
  const t = {label: "Barrière", dist: 2, lateral: 0, halfWidth: 0.6};
  assert.match(announceText(t, [t], {wheelchair: true}), /trop étroit pour un fauteuil/);
  const small = {label: "Potelet", dist: 2, lateral: 0.5, halfWidth: 0.1};
  assert.doesNotMatch(announceText(small, [small], {wheelchair: true}), /trop étroit/);
});

test("place libre réduite par un obstacle voisin", () => {
  const a = {dist: 3, lateral: 0.5, halfWidth: 0.1}, b = {dist: 3.5, lateral: -0.4, halfWidth: 0.2};
  const f = freeSpace(a, [a, b]);
  assert.ok(Math.abs(f.left - 0.6) < 1e-9);
});

test("textes de position", () => {
  assert.equal(positionText(0.1), "droit devant");
  assert.equal(positionText(-0.4), "légèrement à gauche");
  assert.equal(positionText(1.0), "à droite");
});
