// Tests du départ « Ma position » vivant (js/origin.js). Lancer : node --test web/tests/*.test.mjs
// Chaque situation possible est couverte : premier relevé précis ou non, attente, relevés vieux ou invalides,
// bruit du GPS, vrai déplacement, correction de précision, cadence des recalculs, départ périmé.
import {test} from "node:test";
import assert from "node:assert/strict";
import {ORIGIN_RULES as R, decideOrigin, distM, originValid, usableFix} from "../js/origin.js";

const T = 1_000_000, LAT = 48.926, LON = 2.2957, M = 1 / 111320;
const fix = (dN, dE, acc, at = T) => ({lat: LAT + dN * M, lon: LON + dE * M / Math.cos(LAT * Math.PI / 180), acc, at});
const origin = (dN, dE, acc, confirmedAt = T) => ({...fix(dN, dE, acc), confirmedAt});

test("relevés inutilisables : jamais pris comme départ", () => {
  for (const f of [null, {lat: NaN, lon: LON, acc: 5, at: T}, {lat: LAT, lon: LON, acc: 0, at: T}, {lat: LAT, lon: LON, acc: -3, at: T},
                   {lat: 0, lon: 0, acc: 5, at: T}, {lat: 95, lon: LON, acc: 5, at: T}, fix(0, 0, 5, T - R.maxAgeMs - 1),
                   fix(0, 0, 5, T + 60000), {lat: LAT, lon: LON, acc: 5}])
    assert.equal(decideOrigin({origin: null}, f, T).action, "ignore", JSON.stringify(f));
  assert.equal(usableFix(fix(0, 0, 5, T - 1000), T), true);
});

test("premier départ : un relevé précis est pris tout de suite", () => {
  const r = decideOrigin({origin: null, searchSince: T}, fix(0, 0, 8), T);
  assert.equal(r.action, "use");
});

test("premier départ imprécis : on attend, puis on prend le meilleur reçu", () => {
  const first = decideOrigin({origin: null, searchSince: T}, fix(60, 0, 80), T);
  assert.equal(first.action, "wait");                                        // 80 m : trop flou, on attend
  const second = decideOrigin({origin: null, searchSince: T, best: first.best}, fix(30, 0, 50, T + 2000), T + 2000);
  assert.equal(second.action, "wait");
  assert.equal(second.best.acc, 50);                                         // le meilleur reçu est gardé
  const later = decideOrigin({origin: null, searchSince: T, best: second.best}, fix(70, 0, 90, T + 6500), T + 6500);
  assert.equal(later.action, "use");                                         // 6 s et un relevé correct (50 m) : on le prend
  assert.equal(later.fix.acc, 50);
  // un relevé précis arrivé pendant l'attente l'emporte aussitôt
  assert.equal(decideOrigin({origin: null, searchSince: T, best: first.best}, fix(2, 0, 12, T + 1000), T + 1000).action, "use");
});

test("au bout de 15 s, le meilleur relevé reçu, même flou", () => {
  const r = decideOrigin({origin: null, searchSince: T, best: fix(0, 0, 120, T + 14000)}, fix(0, 0, 150, T + 15000), T + 15000);
  assert.equal(r.action, "use");
  assert.equal(r.fix.acc, 120);
});

test("bruit du GPS autour d'une position fixe : pas de recalcul", () => {
  const o = origin(0, 0, 10);
  for (const [dn, de] of [[3, 2], [-6, 4], [8, -7], [0, 12]])
    assert.equal(decideOrigin({origin: o, lastUseAt: T - 10000}, fix(dn, de, 10, T + 500), T + 500).action, "confirm");
});

test("vrai déplacement : le départ suit la personne", () => {
  const o = origin(0, 0, 8);
  assert.equal(decideOrigin({origin: o, lastUseAt: T - 10000}, fix(0, 25, 8, T + 500), T + 500).action, "use");
  // avec un relevé flou (40 m), 25 m peuvent être du bruit : on attend un écart plus net
  assert.equal(decideOrigin({origin: o, lastUseAt: T - 10000}, fix(0, 25, 40, T + 500), T + 500).action, "confirm");
  assert.equal(decideOrigin({origin: o, lastUseAt: T - 10000}, fix(0, 55, 40, T + 500), T + 500).action, "use");
});

test("relevé nettement plus précis qui place ailleurs : correction immédiate (le cas du 20/10)", () => {
  const o = origin(60, 0, 70);                                               // premier relevé : 60 m trop au nord
  const r = decideOrigin({origin: o, lastUseAt: T}, fix(0, 0, 8, T + 300), T + 300);
  assert.equal(r.action, "use");                                             // même juste après un recalcul
});

test("pas plus d'un recalcul toutes les 2,5 s pour un déplacement", () => {
  const o = origin(0, 0, 8);
  assert.equal(decideOrigin({origin: o, lastUseAt: T}, fix(0, 30, 8, T + 1000), T + 1000).action, "ignore");
  assert.equal(decideOrigin({origin: o, lastUseAt: T}, fix(0, 30, 8, T + R.minGapMs), T + R.minGapMs).action, "use");
});

test("départ périmé (aucun relevé depuis 30 s) : règles du premier départ", () => {
  const old = origin(0, 0, 8, T - R.staleMs - 1);
  assert.equal(originValid(old, T), false);
  assert.equal(decideOrigin({origin: old, searchSince: T}, fix(200, 0, 80), T).action, "wait");   // pas un relevé flou
  assert.equal(decideOrigin({origin: old, searchSince: T}, fix(200, 0, 10), T).action, "use");
});

test("distances", () => {
  assert.ok(Math.abs(distM(fix(0, 0, 1), fix(30, 40, 1)) - 50) < 0.5);
});
