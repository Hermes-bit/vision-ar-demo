// Itinéraires comparés (js/compare.js) : « Le plus accessible » toujours en premier, « Le plus rapide » seulement
// s'il fait gagner au moins une minute, temps comptés à la vitesse du profil, différence expliquée.
// Vérifié sur des centaines de trajets tirés au hasard dans la ville, pour plusieurs profils.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {computeRoutes, loadNetwork, resolveProfile, RoutingError} from "../js/routing.js";
import {extras, labelPoints, minutes, routeFacts, walkingChoices} from "../js/compare.js";
import {headingFrom, smoothHeading} from "../js/compass.js";

const file = new URL("../data/gennevilliers.json", import.meta.url);
const net = existsSync(file) ? loadNetwork(JSON.parse(readFileSync(file, "utf8"))) : null;
const PROFILES = {
  "piéton": {mobility: "pedestrian"},
  "fauteuil + malvoyance (réglages du 20/10)": {mobility: "manual_wheelchair", steps_allowed: true, max_slope_pct: 12, prefers_sound_signals: true},
  "fauteuil strict": {mobility: "manual_wheelchair"},
  "malvoyance": {mobility: "low_vision"},
  "canne": {mobility: "cane_or_walker"},
};
let seed = 20261025;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;

test("règles d'affichage sur 400 trajets au hasard", {skip: !net && "données absentes"}, () => {
  let shown = 0, fast = 0;
  for (const [name, p] of Object.entries(PROFILES)) {
    const prof = resolveProfile(p);
    for (let k = 0; k < 80; k++) {
      const a = net.nodes[Math.floor(rnd() * net.nodes.length)], b = net.nodes[Math.floor(rnd() * net.nodes.length)];
      let res;
      try { res = computeRoutes(net, {origin: a, destination: b, profile: p, compare_shortest: true}, []); }
      catch (e) { if (e instanceof RoutingError) continue; throw e; }
      const ch = walkingChoices(res.routes, net, prof), ctx = `${name}, trajet ${k}`;
      shown++;
      assert.ok(ch.length >= 1 && ch.length <= 3, ctx);
      assert.equal(ch[0].kind, "accessible", ctx);
      assert.equal(ch[0].label, "Le plus accessible", ctx);
      assert.equal(ch[0].edge_ids.join(), res.routes[0].edge_ids.join(), `${ctx} : le recommandé est celui du moteur`);
      const f = ch.find(r => r.kind === "fastest");
      if (f) {
        fast++;
        assert.ok(f.accessible, `${ctx} : le plus rapide est praticable`);
        assert.ok(minutes(f) < minutes(ch[0]), `${ctx} : le plus rapide fait gagner au moins une minute`);
        assert.equal(f.duration_s, Math.round(f.length_m / prof.speed_m_s), `${ctx} : temps à la vitesse du profil`);
        assert.ok(f.note && ch[0].note, `${ctx} : différence expliquée sur les deux cartes`);
        assert.equal(ch[0].alsoFastest, false, ctx);
      } else assert.equal(ch[0].alsoFastest, true, `${ctx} : seul praticable -> aussi le plus rapide`);
      for (const r of ch.filter(x => x.kind === "unadapted")) assert.equal(r.accessible, false, `${ctx} : « sans adaptation » montré seulement s'il est impraticable`);
      // plus de doublon : deux cartes ne montrent jamais le même chemin
      const ids = ch.map(r => r.edge_ids.join());
      assert.equal(new Set(ids).size, ids.length, `${ctx} : itinéraires distincts`);
    }
  }
  assert.ok(shown > 300, `${shown} trajets calculés`);
  assert.ok(fast > 20, `le plus rapide proposé ${fast} fois`);
});

test("trajet Picard -> métro Les Agnettes (vidéo Citymapper du 24/10)", {skip: !net && "données absentes"}, () => {
  const p = {mobility: "manual_wheelchair", steps_allowed: true, max_slope_pct: 12, prefers_sound_signals: true};
  const res = computeRoutes(net, {origin: {lat: 48.925767, lon: 2.295317}, destination: {lat: 48.923035, lon: 2.285944}, profile: p, compare_shortest: true}, []);
  const ch = walkingChoices(res.routes, net, resolveProfile(p));
  assert.equal(ch[0].label, "Le plus accessible");
  assert.ok(ch[0].length_m > 850 && ch[0].length_m < 1100, `${ch[0].length_m} m (Citymapper : 0,9 km)`);
  assert.ok(!ch.some(r => r.kind === "fastest") ? ch[0].alsoFastest : true);
});

test("explications : la différence la plus importante d'abord", () => {
  const prof = resolveProfile({mobility: "low_vision"});
  const base = {road: 0, crossings: 2, noSignal: 1, rough: 0, unknown: 0, steps: 0, slope: 2};
  assert.deepEqual(extras({...base, steps: 2, noSignal: 4, road: 42}, base, prof), ["2 marches", "3 traversées sans feu sonore", "40 m sur la chaussée"]);
  assert.deepEqual(extras(base, base, prof), []);
  const walker = resolveProfile({mobility: "pedestrian"});
  assert.deepEqual(extras({...base, crossings: 3, noSignal: 2}, base, walker), ["1 traversée"]);
  assert.deepEqual(extras({...base, slope: 6.24}, base, walker), ["une pente à 6,2 % (au lieu de 2,0 %)"]);
});

test("faits d'un itinéraire : chaussée, traversées, feux sonores", {skip: !net && "données absentes"}, () => {
  const p = resolveProfile({mobility: "low_vision"});
  const res = computeRoutes(net, {origin: {lat: 48.925767, lon: 2.295317}, destination: {lat: 48.9339, lon: 2.3145}, profile: {mobility: "low_vision"}}, []);
  const f = routeFacts(res.routes[0], net, p);
  assert.ok(f.crossings >= f.noSignal && f.noSignal >= 0);
  assert.ok(f.road >= 0 && f.rough >= 0 && f.unknown >= 0);
});

test("étiquettes sur le plan : là où les itinéraires se séparent", () => {
  const line = (lat0, dLon, n = 20) => Array.from({length: n}, (_, i) => ({lat: lat0, lon: 2.29 + dLon * i / (n - 1)}));
  const a = line(48.92, 0.01), b = a.map((p, i) => i > 4 && i < 15 ? {lat: p.lat + 0.002, lon: p.lon} : p);
  const [pa, pb] = labelPoints([a, b]);
  assert.ok(pb.lat > 48.9215, "l'étiquette du détour est posée sur le détour");
  assert.ok(Math.abs(pa.lat - 48.92) < 1e-9);
  // itinéraires confondus : étiquettes à des endroits différents
  const [q1, q2] = labelPoints([a, a.map(p => ({...p}))]);
  assert.notDeepEqual(q1, q2);
  assert.equal(labelPoints([a]).length, 1);
});

test("boussole du plan : cap lu sur iPhone et Android, lissage par le plus court chemin", () => {
  assert.equal(headingFrom({webkitCompassHeading: 87}), 87);
  assert.equal(headingFrom({webkitCompassHeading: -1, absolute: true, alpha: 90}), 270);
  assert.equal(headingFrom({absolute: true, alpha: 0}), 0);
  assert.equal(headingFrom({absolute: false, alpha: 120}), null);           // Android relatif : pas un cap
  assert.equal(smoothHeading(null, 42), 42);
  assert.ok(Math.abs(smoothHeading(359, 1, 0.5) - 0) < 1e-9);               // 359° -> 1° passe par 0°, pas par 180°
  assert.ok(Math.abs(smoothHeading(10, 350, 0.5) - 0) < 1e-9);
  assert.ok(Math.abs(smoothHeading(90, 100, 0.2) - 92) < 1e-9);
});
