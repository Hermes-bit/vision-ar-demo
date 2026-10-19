// Tests de l'icône « ma position » (js/navmarker.js). Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {markerPosition} from "../js/navmarker.js";

// itinéraire tout droit vers le nord : le point à d mètres est à lat0 + d / 111320
const LAT = 48.92, LON = 2.29, M = 1 / 111320;
const posAt = d => ({lat: LAT + d * M, lon: LON});
const now = 1_000_000;
const nav = (o = {}) => ({phase: "route", away: false, offRoute: false, pos: 40, gapAlong: 40, here: posAt(40),
  real: {lat: LAT + 40 * M, lon: LON + 9 / 73000, acc: 10, at: now - 1000}, ...o});

test("sur l'itinéraire, GPS à 9 m de côté : l'icône reste sur le tracé (pas de travers)", () => {
  const m = markerPosition(nav(), posAt, now);
  assert.equal(m.lon, LON);
  assert.ok(Math.abs(m.lat - posAt(40).lat) < 1e-9);
  assert.equal(m.stale, false);
});

test("on recule : l'icône recule aussi (elle ne reste pas bloquée sur la progression)", () => {
  const m = markerPosition(nav({pos: 40, gapAlong: 20}), posAt, now);
  assert.ok(Math.abs(m.lat - posAt(20).lat) < 1e-9);
});

test("approche du départ, à l'écart ou hors itinéraire : la vraie position", () => {
  for (const o of [{phase: "approach"}, {away: true}, {offRoute: true}]) {
    const n = nav(o), m = markerPosition(n, posAt, now);
    assert.equal(m.lon, n.real.lon, JSON.stringify(o));
  }
});

test("plus de position GPS depuis 15 s : dernière place connue, signalée comme ancienne", () => {
  const n = nav({real: {lat: LAT, lon: LON + 0.001, acc: 8, at: now - 16000}});
  const m = markerPosition(n, posAt, now);
  assert.equal(m.stale, true);
  assert.equal(m.lon, LON + 0.001);
});

test("aucune position GPS reçue : le départ de l'itinéraire, signalé comme ancien", () => {
  const m = markerPosition(nav({real: null, phase: "approach", here: posAt(0)}), posAt, now);
  assert.equal(m.stale, true);
  assert.equal(m.lat, LAT);
});
