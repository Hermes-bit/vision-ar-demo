// Partage des signalements entre téléphones (js/sync.js) : traduction, fusion, et les deux
// garanties du réseau — ne jamais lever pendant un guidage, ne jamais perdre un signalement.
// Aucun réseau réel : `reseau` est injecté.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {
  MARGE_BBOX_M, RAYON_CHEMIN_M,
  aEnvoyer, aSignalerALUsager, depuisServeur, emprise, envoyer, fusionner, recuperer,
  surLeChemin, versServeur, voter,
} from "../js/sync.js";

const MAINTENANT = Date.parse("2026-11-18T10:00:00Z");
const DANS_UN_JOUR = MAINTENANT + 24 * 3600e3;

const local = (o = {}) => ({
  id: 1763460000, kind: "street_furniture", blocking: true,
  lat: 48.9335, lon: 2.2975, created: MAINTENANT, expires: DANS_UN_JOUR, ...o,
});
const distant = (o = {}) => ({
  id: 42, kind: "works", blocking: true, lat: 48.9340, lon: 2.2980,
  created_at: "2026-11-18T09:00:00Z", expires_at: "2026-11-25T09:00:00Z",
  confirmations: 2, denials: 0, ...o,
});

// Remplace le réseau le temps d'un appel ; renvoie les requêtes vues.
function fauxReseau(reponse) {
  const vues = [];
  return [vues, async (url, init) => {
    vues.push({url, init});
    return typeof reponse === "function" ? reponse(vues.length) : reponse;
  }];
}
const ok = corps => ({ok: true, status: 201, json: async () => corps});

// ---- Traduction -----------------------------------------------------------------------------

test("vers le serveur : seulement ce que l'API attend", () => {
  assert.deepEqual(versServeur(local()), {
    lat: 48.9335, lon: 2.2975, kind: "street_furniture", blocking: true, source: "user",
  });
});

test("un signalement non bloquant reste non bloquant", () => {
  assert.equal(versServeur(local({blocking: false})).blocking, false);
});

test("depuis le serveur : dates converties, marqué comme venant d'ailleurs", () => {
  const r = depuisServeur(distant());
  assert.equal(r.distant, true);
  assert.equal(r.serverId, 42);
  assert.equal(r.id, "s42", "un identifiant qui ne peut pas heurter ceux du téléphone");
  assert.equal(r.expires, Date.parse("2026-11-25T09:00:00Z"));
  assert.equal(r.confirmations, 2);
});

test("réponse abîmée : écartée plutôt qu'affichée de travers", () => {
  assert.equal(depuisServeur({id: 1}), null);
  assert.equal(depuisServeur({id: 1, expires_at: "pas une date"}), null);
  assert.equal(depuisServeur(null), null);
});

// ---- Fusion ---------------------------------------------------------------------------------

test("mon signalement qui me revient du serveur n'apparaît pas deux fois", () => {
  const mien = local({serverId: 42});
  const liste = fusionner([mien], [depuisServeur(distant())]);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].id, mien.id, "c'est la version locale qu'on garde : elle est effaçable");
});

test("les signalements des autres entrent bien dans la liste", () => {
  const liste = fusionner([local()], [depuisServeur(distant())]);
  assert.equal(liste.length, 2);
  assert.ok(liste.some(r => r.distant));
});

test("listes vides : rien ne casse", () => {
  assert.deepEqual(fusionner([], []), []);
  assert.deepEqual(fusionner(null, null), []);
});

// ---- Ce qui reste à envoyer -------------------------------------------------------------------

test("on n'envoie que les siens, non accusés et non périmés", () => {
  const liste = [
    local({id: 1}),                                        // à envoyer
    local({id: 2, serverId: 7}),                           // déjà accusé
    local({id: 3, expires: MAINTENANT - 1}),               // périmé
    depuisServeur(distant()),                              // vient des autres
  ];
  assert.deepEqual(aEnvoyer(liste, MAINTENANT).map(r => r.id), [1]);
});

// ---- Emprise ----------------------------------------------------------------------------------

test("emprise élargie autour du chemin", () => {
  const b = emprise([{lat: 48.93, lon: 2.29}, {lat: 48.94, lon: 2.30}]);
  assert.ok(b.south < 48.93 && b.north > 48.94);
  assert.ok(b.west < 2.29 && b.east > 2.30);
  const margeLat = (48.93 - b.south) * 111320;
  assert.ok(Math.abs(margeLat - MARGE_BBOX_M) < 1, `marge de ${margeLat.toFixed(0)} m`);
});

test("sans point exploitable : aucune requête à faire", () => {
  assert.equal(emprise([]), null);
  assert.equal(emprise(null), null);
  assert.equal(emprise([{lat: undefined, lon: 2.3}]), null);
});

// ---- Sur mon chemin ---------------------------------------------------------------------------

const CHEMIN = [{lat: 48.9335, lon: 2.2975}, {lat: 48.9340, lon: 2.2975}];

test("un obstacle sur le tracé est vu comme tel", () => {
  assert.equal(surLeChemin({lat: 48.93352, lon: 2.2975}, CHEMIN), true);
});

test("un obstacle dans la rue d'à côté ne me concerne pas", () => {
  assert.equal(surLeChemin({lat: 48.9335, lon: 2.2985}, CHEMIN), false,
    `à plus de ${RAYON_CHEMIN_M} m du tracé`);
});

test("obstacle sans position : jamais retenu", () => {
  assert.equal(surLeChemin({lat: null, lon: 2.3}, CHEMIN), false);
  assert.equal(surLeChemin(null, CHEMIN), false);
});

// ---- Quand prévenir l'usager ------------------------------------------------------------------

test("un obstacle bloquant qui vient d'apparaître sur mon chemin : on prévient", () => {
  const nouveau = {id: "s99", blocking: true, lat: 48.93352, lon: 2.2975};
  assert.deepEqual(aSignalerALUsager([], [nouveau], CHEMIN).map(r => r.id), ["s99"]);
});

test("déjà connu : on ne prévient pas deux fois", () => {
  const connu = {id: "s99", blocking: true, lat: 48.93352, lon: 2.2975};
  assert.deepEqual(aSignalerALUsager([connu], [connu], CHEMIN), []);
});

test("obstacle gênant : pas d'interruption, il renchérira le calcul et sera dit à l'approche", () => {
  const genant = {id: "s100", blocking: false, lat: 48.93352, lon: 2.2975};
  assert.deepEqual(aSignalerALUsager([], [genant], CHEMIN), []);
});

test("obstacle bloquant mais ailleurs : on ne coupe la marche de personne pour rien", () => {
  const ailleurs = {id: "s101", blocking: true, lat: 48.9335, lon: 2.2995};
  assert.deepEqual(aSignalerALUsager([], [ailleurs], CHEMIN), []);
});

// ---- Envoi ------------------------------------------------------------------------------------

test("envoi réussi : l'identifiant du serveur revient, pour ne plus jamais le renvoyer", async () => {
  const [vues, reseau] = fauxReseau(ok({id: 7, merged: false}));
  const r = await envoyer([local({id: 1})],
    {url: "https://exemple.test/", device: "a".repeat(20), reseau, maintenant: MAINTENANT});
  assert.deepEqual(r.accuses, [{id: 1, serverId: 7, merged: false}]);
  assert.equal(vues[0].url, "https://exemple.test/reports", "la barre finale ne doit pas se doubler");
  assert.equal(vues[0].init.headers["X-Device-Id"], "a".repeat(20));
});

test("le serveur avait déjà cet obstacle : accusé comme fusionné, pas comme créé", async () => {
  const [, reseau] = fauxReseau({ok: true, status: 200, json: async () => ({id: 7, merged: true})});
  const r = await envoyer([local({id: 1})], {url: "u", reseau, maintenant: MAINTENANT});
  assert.equal(r.accuses[0].merged, true);
});

test("serveur en erreur : rien n'est accusé, donc rien n'est perdu", async () => {
  const [, reseau] = fauxReseau({ok: false, status: 500, json: async () => ({})});
  const r = await envoyer([local({id: 1})], {url: "u", reseau, maintenant: MAINTENANT});
  assert.deepEqual(r.accuses, []);
  assert.match(r.echecs[0].raison, /500/);
});

test("réseau coupé : l'envoi ne lève pas et le signalement repartira plus tard", async () => {
  const reseau = async () => { throw new Error("hors ligne"); };
  const r = await envoyer([local({id: 1})], {url: "u", reseau, maintenant: MAINTENANT});
  assert.deepEqual(r.accuses, []);
  assert.equal(r.echecs.length, 1);
});

test("sans serveur configuré : aucune requête, l'appli reste hors ligne d'abord", async () => {
  const [vues, reseau] = fauxReseau(ok({id: 1}));
  const r = await envoyer([local({id: 1})], {url: "", reseau, maintenant: MAINTENANT});
  assert.deepEqual(r, {accuses: [], echecs: []});
  assert.equal(vues.length, 0);
});

// ---- Récupération ---------------------------------------------------------------------------

test("récupération : les signalements des autres arrivent traduits", async () => {
  const [vues, reseau] = fauxReseau({ok: true, status: 200,
    json: async () => [distant(), distant({id: 43})]});
  const liste = await recuperer({south: 48.9, west: 2.2, north: 49, east: 2.4}, {url: "u", reseau});
  assert.equal(liste.length, 2);
  assert.ok(liste.every(r => r.distant));
  assert.match(vues[0].url, /south=48\.9/);
});

test("serveur muet ou en panne : liste vide, jamais d'erreur", async () => {
  const [, enErreur] = fauxReseau({ok: false, status: 503, json: async () => ({})});
  assert.deepEqual(await recuperer({south: 0, west: 0, north: 1, east: 1}, {url: "u", reseau: enErreur}), []);
  const coupe = async () => { throw new Error("hors ligne"); };
  assert.deepEqual(await recuperer({south: 0, west: 0, north: 1, east: 1}, {url: "u", reseau: coupe}), []);
});

test("sans serveur ni emprise : aucune requête", async () => {
  const [vues, reseau] = fauxReseau({ok: true, status: 200, json: async () => []});
  assert.deepEqual(await recuperer(null, {url: "u", reseau}), []);
  assert.deepEqual(await recuperer({south: 0, west: 0, north: 1, east: 1}, {url: "", reseau}), []);
  assert.equal(vues.length, 0);
});


// ---- Démenti ---------------------------------------------------------------------------------

test("« il n'est plus là » : le serveur reçoit un démenti, pas une confirmation", async () => {
  const [vues, reseau] = fauxReseau({ok: true, status: 200, json: async () => ({})});
  const pris = await voter(42, {url: "https://exemple.test", device: "a".repeat(20), encore: false, reseau});
  assert.equal(pris, true);
  assert.equal(vues[0].url, "https://exemple.test/reports/42/vote");
  assert.deepEqual(JSON.parse(vues[0].init.body), {still_there: false});
  assert.equal(vues[0].init.headers["X-Device-Id"], "a".repeat(20));
});

test("« toujours là » prolonge le signalement", async () => {
  const [vues, reseau] = fauxReseau({ok: true, status: 200, json: async () => ({})});
  await voter(42, {url: "u", device: "a".repeat(20), encore: true, reseau});
  assert.deepEqual(JSON.parse(vues[0].init.body), {still_there: true});
});

test("sans serveur, sans appareil ou sans identifiant : aucune requête", async () => {
  const [vues, reseau] = fauxReseau({ok: true, status: 200, json: async () => ({})});
  assert.equal(await voter(42, {url: "", device: "a".repeat(20), reseau}), false);
  assert.equal(await voter(42, {url: "u", device: null, reseau}), false);
  assert.equal(await voter(null, {url: "u", device: "a".repeat(20), reseau}), false);
  assert.equal(vues.length, 0);
});

test("réseau coupé pendant un démenti : pas d'erreur remontée à l'usager", async () => {
  const reseau = async () => { throw new Error("hors ligne"); };
  assert.equal(await voter(42, {url: "u", device: "a".repeat(20), reseau}), false);
});
