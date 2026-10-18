// Tests du choix de l'entrée d'arrivée (js/arrival.js). Lancer : node --test web/tests/
import {test} from "node:test";
import assert from "node:assert/strict";
import {entranceFor, streetBetween} from "../js/arrival.js";

// Une rue est-ouest à la latitude 48.93000 ; l'adresse est au nord, à 10 m de la rue
const LAT = 48.93, LON = 2.30, M = 1 / 111320;           // M : 1 mètre en degrés de latitude
const street = {kind: "street", is_crossing: false, shape: [[LAT, LON - 0.002], [LAT, LON + 0.002]]};
const address = {lat: LAT + 10 * M, lon: LON, label: "5 rue Gisèle Halimi"};
const net = pois => ({edges: [street], pois, places: []});

test("une rue entre l'adresse et l'entrée est détectée", () => {
  assert.equal(streetBetween(net([]), address, {lat: LAT - 10 * M, lon: LON}), true);
  assert.equal(streetBetween(net([]), address, {lat: LAT + 25 * M, lon: LON}), false);
});

test("entrée du même côté de la rue : retenue", () => {
  const r = entranceFor(net([["accessible_entrance", LAT + 25 * M, LON, "Entrée PMR"]]), address);
  assert.ok(r.entrance);
  assert.equal(r.note, "");
});

test("entrée de l'autre côté de la rue : refusée, on va à l'adresse", () => {
  const r = entranceFor(net([["accessible_entrance", LAT - 12 * M, LON, "Entrée PMR"]]), address);
  assert.equal(r.entrance, null);
  assert.match(r.note, /autre côté de la rue/);
});

test("entrée à plus de 50 m : refusée et signalée", () => {
  const r = entranceFor(net([["accessible_entrance", LAT + 80 * M, LON, ""]]), address);
  assert.equal(r.entrance, null);
  assert.match(r.note, /70 m/);       // adresse à +10 m, entrée à +80 m
});

test("la plus proche valide est choisie quand une autre est en face", () => {
  const r = entranceFor(net([["accessible_entrance", LAT - 11 * M, LON, "en face"],
                             ["accessible_entrance", LAT + 30 * M, LON, "bonne"]]), address);
  assert.equal(r.entrance.name, "bonne");
});
