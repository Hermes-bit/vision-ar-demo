// Tests du geste du panneau du bas (js/sheet.js). Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {chooseStop, rubber, snapDuration, velocity} from "../js/sheet.js";

const ys = {full: 0, mid: 300, collapsed: 600};

test("résistance élastique : rien entre les limites, de moins en moins au-delà", () => {
  assert.equal(rubber(250, 0, 600), 250);
  const a = rubber(-50, 0, 600), b = rubber(-300, 0, 600);
  assert.ok(a < 0 && a > -50);                 // on avance moins que le doigt
  assert.ok(b < a && b > -120);                // jamais plus loin que la course maximale
  assert.ok(rubber(700, 0, 600) > 600 && rubber(700, 0, 600) < 700);
});

test("vitesse mesurée sur les 80 dernières ms seulement", () => {
  const s = [{t: 0, y: 0}, {t: 100, y: 0}, {t: 140, y: 40}, {t: 180, y: 80}];   // arrêt puis glissement rapide
  assert.equal(velocity(s), 1);                 // (80 - 0) / (180 - 100)
  assert.equal(velocity([{t: 0, y: 5}]), 0);
});

test("relâché lentement : l'arrêt le plus proche", () => {
  assert.equal(chooseStop(120, 0, ys, "mid"), "full");
  assert.equal(chooseStop(420, 0, ys, "mid"), "mid");
  assert.equal(chooseStop(520, 0, ys, "mid"), "collapsed");
});

test("geste vif : on passe à l'arrêt voisin dans le sens du geste", () => {
  assert.equal(chooseStop(320, 0.8, ys, "mid"), "collapsed");    // petit glissement rapide vers le bas
  assert.equal(chooseStop(290, -0.8, ys, "mid"), "full");        // vers le haut
  assert.equal(chooseStop(590, 1.2, ys, "collapsed"), "collapsed"); // déjà tout en bas
});

test("durée de calage bornée", () => {
  assert.ok(snapDuration(600, 0) <= 420);
  assert.ok(snapDuration(5, 3) >= 180);
});
