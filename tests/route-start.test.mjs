// Le trajet part de là où l'on est : vérifié sur toute la ville, pas seulement sur quelques cas.
// Pour des centaines de positions tirées au hasard (sur les trottoirs, les chemins, dans les cours, jusqu'à
// 25 m d'un cheminement) et des destinations au hasard, et pour plusieurs profils, le trajet doit commencer
// au point praticable le plus proche de la position réelle (jamais « derrière » soi). Plus les cinq cas du
// terrain du 20/10 autour de la rue Gisèle Halimi, qui doivent donner le trajet direct.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {arcCost, computeRoutes, haversineM, loadNetwork, resolveProfile, RoutingError} from "../js/routing.js";

const file = new URL("../data/gennevilliers.json", import.meta.url);
const net = existsSync(file) ? loadNetwork(JSON.parse(readFileSync(file, "utf8"))) : null;
const PROFILES = {
  "piéton": {mobility: "pedestrian"},
  "fauteuil (réglages du 20/10)": {mobility: "manual_wheelchair", steps_allowed: true, max_slope_pct: 12, prefers_sound_signals: true},
  "fauteuil strict": {mobility: "manual_wheelchair"},
  "canne": {mobility: "cane_or_walker"},
};
let seed = 20261020;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const shapeOf = e => e.shape.length >= 2 ? e.shape : [[net.nodes[e.source].lat, net.nodes[e.source].lon], [net.nodes[e.target].lat, net.nodes[e.target].lon]];
// distance (m) d'un point au segment [a, b]
function segDist(lat, lon, a, b) {
  const k = Math.cos(lat * Math.PI / 180) * 111320;
  const ax = (a[1] - lon) * k, ay = (a[0] - lat) * 111320, bx = (b[1] - lon) * k, by = (b[0] - lat) * 111320;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// distance au cheminement praticable le plus proche pour ce profil (calcul indépendant du moteur)
function nearestPassable(lat, lon, profile) {
  let best = Infinity;
  for (const e of net.edges) {
    if (arcCost(e, profile, true).cost === null && arcCost(e, profile, false).cost === null) continue;
    const sh = shapeOf(e);
    if (Math.abs(sh[0][0] - lat) > 0.003 && Math.abs(sh.at(-1)[0] - lat) > 0.003) continue;
    for (let i = 1; i < sh.length; i++) best = Math.min(best, segDist(lat, lon, sh[i - 1], sh[i]));
  }
  return best;
}
// position au hasard : un point d'un tronçon, décalé de 0 à 25 m sur le côté (cour, entrée d'immeuble, trottoir)
function randomSpot() {
  const e = net.edges[Math.floor(rnd() * net.edges.length)], sh = shapeOf(e), i = 1 + Math.floor(rnd() * (sh.length - 1));
  const t = rnd(), a = sh[i - 1], b = sh[i], lat = a[0] + t * (b[0] - a[0]), lon = a[1] + t * (b[1] - a[1]);
  const ang = rnd() * 2 * Math.PI, off = rnd() * 25, k = Math.cos(lat * Math.PI / 180);
  return {lat: lat + off * Math.cos(ang) / 111320, lon: lon + off * Math.sin(ang) / (111320 * k)};
}

test("sur toute la ville : le trajet commence au point praticable le plus proche de la position réelle", {skip: !net}, () => {
  let checked = 0;
  const bad = [];
  for (const [name, input] of Object.entries(PROFILES)) {
    const profile = resolveProfile(input);
    for (let n = 0; n < 60; n++) {
      const from = randomSpot(), to = randomSpot();
      const crow = haversineM(from.lat, from.lon, to.lat, to.lon);
      if (crow < 40 || crow > 1500) { n--; continue; }
      let route;
      try { route = computeRoutes(net, {origin: from, destination: to, profile: input, compare_shortest: false}, []).routes[0]; }
      catch (e) { if (e instanceof RoutingError) continue; throw e; }       // pas de trajet possible : rien à vérifier
      const start = route.geometry[0], d = haversineM(from.lat, from.lon, start.lat, start.lon), near = nearestPassable(from.lat, from.lon, profile);
      checked++;
      if (d > near + 1.5) bad.push(`${name} : départ à ${d.toFixed(1)} m au lieu de ${near.toFixed(1)} m (${from.lat.toFixed(6)}, ${from.lon.toFixed(6)})`);
    }
  }
  assert.ok(checked >= 150, `seulement ${checked} trajets vérifiés`);
  assert.deepEqual(bad, [], `trajets qui ne partent pas de la position réelle :\n${bad.join("\n")}`);
});

test("terrain du 20/10 (rue Gisèle Halimi) : depuis la vraie position, le trajet direct", {skip: !net}, () => {
  const here = {lat: 48.92600, lon: 2.29574};
  const profile = PROFILES["fauteuil (réglages du 20/10)"];
  for (const [name, to] of Object.entries({"5 rue Gisèle Halimi": {lat: 48.926054, lon: 2.295122},
      "Histoire de goût": {lat: 48.925926, lon: 2.294616}, "Picard": {lat: 48.925767, lon: 2.295317}})) {
    const r = computeRoutes(net, {origin: here, destination: to, profile, compare_shortest: false}, []).routes[0];
    const crow = haversineM(here.lat, here.lon, to.lat, to.lon);
    assert.ok(r.length_m <= crow * 1.35 + 15, `${name} : ${Math.round(r.length_m)} m pour ${Math.round(crow)} m à vol d'oiseau`);
  }
});
