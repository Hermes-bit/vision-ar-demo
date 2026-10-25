// Cap de la vue de guidage (js/heading.js) : le gyroscope fait bouger le ruban tout de suite, la boussole recale
// le nord doucement. C'est ce qui garde le ruban collé au sol quand on tourne le téléphone.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {angleDiff, makeHeadingFusion} from "../js/heading.js";

const HZ = 60, near = (a, b, tol, msg) => assert.ok(Math.abs(angleDiff(a, b)) <= tol, `${msg} : ${a.toFixed(1)} au lieu de ${b.toFixed(1)}`);
let seed = 7;
const noise = amp => { seed = (seed * 48271) % 2147483647; return (seed / 2147483647 * 2 - 1) * amp; };

test("une rotation du téléphone est suivie immédiatement, sans attendre la boussole", () => {
  const f = makeHeadingFusion();
  let t = 0;
  for (let i = 0; i < 3 * HZ; i++, t += 1 / HZ) f.update(100, 40, t);          // cap vrai : 40°
  near(f.update(100, 40, t), 40, 0.5, "au repos");
  // on tourne de 30° vers la droite en 0,2 s ; la boussole, elle, est encore à l'ancien cap
  let h;
  for (let i = 1; i <= 12; i++) { t += 1 / HZ; h = f.update(100 + 30 * i / 12, 40, t); }
  near(h, 70, 1.5, "juste après la rotation");
});

test("bruit de la boussole (±15°) : le cap reste stable à ±2°", () => {
  const f = makeHeadingFusion();
  let t = 0, worst = 0;
  for (let i = 0; i < 20 * HZ; i++, t += 1 / HZ) {
    const h = f.update(200, 75 + noise(15), t);
    if (t > 5) worst = Math.max(worst, Math.abs(angleDiff(h, 75)));
  }
  assert.ok(worst < 2.5, `écart maximal ${worst.toFixed(2)}°`);
});

test("dérive lente du gyroscope (1°/s) corrigée par la boussole", () => {
  const f = makeHeadingFusion();
  let t = 0, worst = 0;
  for (let i = 0; i < 30 * HZ; i++, t += 1 / HZ) {
    const h = f.update(10 + t, 120, t);                                       // le gyroscope dérive, le téléphone ne bouge pas
    if (t > 5) worst = Math.max(worst, Math.abs(angleDiff(h, 120)));
  }
  assert.ok(worst < 4, `écart maximal ${worst.toFixed(2)}°`);
});

test("perturbation magnétique d'une seconde (+60°) : le ruban ne part pas de travers", () => {
  const f = makeHeadingFusion();
  let t = 0, worst = 0;
  for (let i = 0; i < 5 * HZ; i++, t += 1 / HZ) f.update(0, 300, t);
  for (let i = 0; i < HZ; i++, t += 1 / HZ) worst = Math.max(worst, Math.abs(angleDiff(f.update(0, 0, t), 300)));   // voiture garée à côté
  assert.ok(worst < 8, `écart pendant la perturbation ${worst.toFixed(2)}°`);
  for (let i = 0; i < 6 * HZ; i++, t += 1 / HZ) f.update(0, 300, t);
  near(f.update(0, 300, t), 300, 1, "après la perturbation");
});

test("vrai changement de cap de la boussole (mauvais départ) : rattrapé en quelques secondes", () => {
  const f = makeHeadingFusion();
  let t = 0;
  f.update(50, 90, t);                                                        // premier relevé faux de 50°
  for (let i = 0; i < 15 * HZ; i++) { t += 1 / HZ; f.update(50, 140, t); }
  near(f.update(50, 140, t), 140, 2, "après 15 s");
});

test("départ : recalage rapide sur les 2 premières secondes", () => {
  const f = makeHeadingFusion();
  let t = 0;
  f.update(0, 112, t);                                                        // premier relevé : 12° d'erreur
  for (let i = 0; i < 2 * HZ; i++) { t += 1 / HZ; f.update(0, 100, t); }
  near(f.update(0, 100, t), 100, 1.5, "au bout de 2 s");
});

test("passage par le nord (359° -> 1°) sans tour complet", () => {
  const f = makeHeadingFusion();
  let t = 0;
  for (let i = 0; i < 3 * HZ; i++, t += 1 / HZ) f.update(358, 358, t);
  let h;
  for (let i = 1; i <= 10; i++) { t += 1 / HZ; h = f.update((358 + i * 0.5) % 360, 359, t); }
  near(h, 3, 1, "après 5° de rotation");
});

test("sans gyroscope : boussole seule, lissée ; sans mesure : pas de cap", () => {
  const f = makeHeadingFusion();
  assert.equal(f.update(null, 30, 0), null);
  assert.equal(f.update(10, null, 0.1), null);                               // pas encore de boussole : pas de cap inventé
  const g = makeHeadingFusion();
  let t = 0, h;
  for (let i = 0; i < 2 * HZ; i++, t += 1 / HZ) h = g.compassOnly(i < HZ ? 10 : 350, t);
  near(h, 350, 1, "boussole seule");
  g.reset();
  assert.equal(g.compassOnly(null, 0), null);
});
