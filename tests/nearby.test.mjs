// Alertes à proximité (js/nearby.js) : filtrage selon le profil réel du moteur, distances, tri.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {alertesAutour, phraseAlerte, TYPES} from "../js/nearby.js";
import {preset} from "../js/routing.js";

const POS = {lat: 48.9330, lon: 2.2970};          // Gennevilliers
const nord = m => 48.9330 + m / 111320;           // ~m mètres au nord

// Une arête minimale, telle que loadNetwork la produit.
const arete = (o = {}) => ({
  has_step: false, is_crossing: false, kerb_lowered: null, sound_signal: null,
  slope_pct: null, width_m: null, name: "", shape: [[nord(50), 2.2970]], ...o,
});

const reseau = (edges = [], pois = []) => ({edges, pois});
const types = r => r.map(a => a.type);

test("une marche n'est signalée qu'à qui ne peut pas la monter", () => {
  const net = reseau([arete({has_step: true})]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("manual_wheelchair")})), ["marche"]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("pedestrian")})), []);
});

test("une traversée sans feu sonore n'est signalée qu'à qui en a besoin", () => {
  const net = reseau([arete({is_crossing: true, sound_signal: false})]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("low_vision")})), ["sans_feu"]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("pedestrian")})), []);
});

test("un feu sonore inconnu (null) ne déclenche aucune alerte", () => {
  const net = reseau([arete({is_crossing: true, sound_signal: null})]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("low_vision")})), []);
});

test("bordure non abaissée : pour le fauteuil, pas pour le piéton", () => {
  const net = reseau([arete({is_crossing: true, kerb_lowered: false})]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("manual_wheelchair")})), ["bordure"]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("pedestrian")})), []);
});

test("pente forte : comparée au maximum du profil, dans les deux sens", () => {
  const p = preset("manual_wheelchair");                       // max_slope_pct = 5
  assert.deepEqual(types(alertesAutour(reseau([arete({slope_pct: 9})]), POS, {profil: p})), ["pente"]);
  assert.deepEqual(types(alertesAutour(reseau([arete({slope_pct: -9})]), POS, {profil: p})), ["pente"],
    "une descente à -9 % gêne aussi");
  assert.deepEqual(types(alertesAutour(reseau([arete({slope_pct: 3})]), POS, {profil: p})), []);
});

test("passage étroit : comparé à la largeur minimale du profil", () => {
  const p = preset("manual_wheelchair");
  assert.ok(p.min_width_m > 0, "le profil fauteuil impose une largeur minimale");
  assert.deepEqual(types(alertesAutour(reseau([arete({width_m: 0.5})]), POS, {profil: p})), ["etroit"]);
  assert.deepEqual(types(alertesAutour(reseau([arete({width_m: 3})]), POS, {profil: p})), []);
});

test("au-delà du rayon, rien n'est signalé", () => {
  const loin = reseau([arete({has_step: true, shape: [[nord(900), 2.2970]]})]);
  assert.deepEqual(types(alertesAutour(loin, POS, {profil: preset("manual_wheelchair")})), []);
});

test("une seule alerte par type : la plus proche l'emporte", () => {
  const net = reseau([
    arete({has_step: true, shape: [[nord(200), 2.2970]], name: "Loin"}),
    arete({has_step: true, shape: [[nord(40), 2.2970]], name: "Près"}),
  ]);
  const r = alertesAutour(net, POS, {profil: preset("manual_wheelchair")});
  assert.equal(r.length, 1);
  assert.equal(r[0].nom, "Près");
});

test("la distance est mesurée au point le plus proche du tracé, pas au premier", () => {
  const net = reseau([arete({has_step: true, shape: [[nord(250), 2.2970], [nord(30), 2.2970]]})]);
  const [a] = alertesAutour(net, POS, {profil: preset("manual_wheelchair")});
  assert.ok(a.distance < 40, `attendu ~30 m, obtenu ${Math.round(a.distance)} m`);
});

test("tri par distance croissante et limite respectée", () => {
  const net = reseau([
    arete({has_step: true, shape: [[nord(120), 2.2970]]}),
    arete({is_crossing: true, kerb_lowered: false, shape: [[nord(60), 2.2970]]}),
    arete({slope_pct: 12, shape: [[nord(20), 2.2970]]}),
  ]);
  const r = alertesAutour(net, POS, {profil: preset("manual_wheelchair")});
  assert.deepEqual(types(r), ["pente", "bordure", "marche"]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("manual_wheelchair"), limite: 2})),
    ["pente", "bordure"]);
});

test("place PMR : seulement en fauteuil — il n'existe pas de mobilité « wheelchair »", () => {
  const net = reseau([], [["disabled_parking", nord(50), 2.2970, "Parking mairie", "unknown"]]);
  for (const m of ["manual_wheelchair", "electric_wheelchair"]) {
    assert.deepEqual(types(alertesAutour(net, POS, {profil: preset(m)})), ["place_pmr"], m);
  }
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("low_vision")})), []);
});

test("entrée accessible, ascenseur et toilettes servent à tout le monde", () => {
  const net = reseau([], [
    ["accessible_entrance", nord(30), 2.2970, "Cinéma Jean-Vigo", "unknown"],
    ["elevator", nord(60), 2.2970, "", "unknown"],
    ["accessible_toilet", nord(90), 2.2970, "", "unknown"],
  ]);
  assert.deepEqual(types(alertesAutour(net, POS, {profil: preset("pedestrian")})),
    ["entree", "ascenseur", "toilettes"]);
});

test("chaque type annoncé porte un libellé et dit s'il gêne ou s'il aide", () => {
  for (const [type, t] of Object.entries(TYPES)) {
    assert.ok(t.label && t.icone, `${type} doit avoir un libellé et une icône`);
    assert.equal(typeof t.genant, "boolean", `${type} doit dire s'il gêne`);
  }
});

test("phrase dite par la voix : distance arrondie à 5 m, rue citée si connue", () => {
  assert.equal(phraseAlerte({label: "Marche", distance: 42, nom: "Rue Gisèle Halimi"}),
    "Marche à 40 m, Rue Gisèle Halimi");
  assert.equal(phraseAlerte({label: "Ascenseur", distance: 13, nom: ""}), "Ascenseur à 15 m");
});

test("sans position, sans réseau ou sans profil : liste vide, pas de plantage", () => {
  const net = reseau([arete({has_step: true})]);
  assert.deepEqual(alertesAutour(null, POS, {profil: preset("pedestrian")}), []);
  assert.deepEqual(alertesAutour(net, null, {profil: preset("pedestrian")}), []);
  assert.deepEqual(alertesAutour(net, POS, {}), []);
});
