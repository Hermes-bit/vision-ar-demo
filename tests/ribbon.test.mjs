// Recentrage latéral du ruban (js/ribbon.js).
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {recentrage, RECENTRAGE_MAX_M, cameraDOffice} from "../js/ribbon.js";

test("route déjà sous les pieds : aucune correction", () => {
  assert.deepEqual(recentrage({x: 0, y: 0}), {x: 0, y: 0, reste: 0});
});

test("écart plausible : corrigé en entier, le ruban revient sous les pieds", () => {
  const r = recentrage({x: 3, y: 0});
  assert.equal(r.x, 3);
  assert.equal(r.y, 0);
  assert.equal(r.reste, 0, "rien ne doit rester visible : c'est une imprécision, pas une erreur");
});

test("écart trop grand : corrigé jusqu'à la limite, le reste continue de se voir", () => {
  const r = recentrage({x: 20, y: 0});
  assert.equal(r.x, RECENTRAGE_MAX_M);
  assert.equal(r.reste, 20 - RECENTRAGE_MAX_M, "l'usager doit voir qu'il n'est pas sur le chemin");
});

test("la correction garde la direction de l'écart", () => {
  const r = recentrage({x: 30, y: 40});          // 50 m, en diagonale
  assert.ok(Math.abs(Math.hypot(r.x, r.y) - RECENTRAGE_MAX_M) < 1e-9);
  assert.ok(Math.abs(r.x / r.y - 30 / 40) < 1e-9, "même direction, longueur bornée");
});

test("écart exactement à la limite : corrigé en entier", () => {
  const r = recentrage({x: 0, y: RECENTRAGE_MAX_M});
  assert.equal(r.y, RECENTRAGE_MAX_M);
  assert.equal(r.reste, 0);
});

test("limite réglable, pour le terrain", () => {
  assert.equal(recentrage({x: 10, y: 0}, 2).x, 2);
});

test("entrée absente ou absurde : aucune correction, pas de NaN", () => {
  for (const mauvais of [null, undefined, {}, {x: NaN, y: 1}, {x: 1, y: Infinity}]) {
    const r = recentrage(mauvais);
    assert.deepEqual(r, {x: 0, y: 0, reste: 0}, JSON.stringify(mauvais));
  }
});

test("la limite reste du bon ordre de grandeur pour une erreur de GPS", () => {
  assert.ok(RECENTRAGE_MAX_M >= 4 && RECENTRAGE_MAX_M <= 10,
    "un GPS de téléphone se trompe de 5 à 10 m entre les immeubles");
});

test("caméra d'office pour qui voit le ruban", () => {
  assert.equal(cameraDOffice({malvoyance: false, detection: false}), true);
  assert.equal(cameraDOffice(), true, "sans information, on garde le comportement d'avant");
});

test("malvoyance : pas de caméra d'office, elle viderait la batterie pour rien", () => {
  assert.equal(cameraDOffice({malvoyance: true, detection: false}), false);
});

test("malvoyance AVEC détection d'obstacles : la caméra reste, c'est elle qui détecte", () => {
  assert.equal(cameraDOffice({malvoyance: true, detection: true}), true);
});


test("caméra refusée par l'usager : le guidage part réduit, quel que soit le profil", () => {
  assert.equal(cameraDOffice({demandee: false}), false);
  assert.equal(cameraDOffice({malvoyance: false, detection: true, demandee: false}), false,
    "même la détection d'obstacles ne doit pas passer outre le choix");
});

test("sans choix exprimé, la règle du profil s'applique comme avant", () => {
  assert.equal(cameraDOffice({demandee: true}), true);
  assert.equal(cameraDOffice({malvoyance: true, demandee: true}), false);
  assert.equal(cameraDOffice({malvoyance: true, detection: true, demandee: true}), true);
});
