// Panneau du guidage composé par besoins (js/panneau.js).
//
// Ce que ces tests protègent avant tout : que les profils se CUMULENT. Les maquettes montraient
// sept écrans exclusifs ; quelqu'un en fauteuil et malentendant doit voir les deux sections, pas
// choisir. Et qu'une carte de communication ne révèle jamais un handicap non déclaré.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {DANGER, CONSIGNE, INFO} from "../js/speech.js";
import {MAX_CONSIGNES, clignoter, historique, phraseCommunication, sectionsPanneau} from "../js/panneau.js";

const prof = (...m) => new Set(m);

// ---- Quelles sections, pour qui ---------------------------------------------------------------

test("fauteuil manuel : l'effort, rien d'autre", () => {
  assert.deepEqual(sectionsPanneau(prof("manual_wheelchair")), ["effort"]);
});

test("malentendance : les consignes écrites, et la carte de communication", () => {
  assert.deepEqual(sectionsPanneau(prof("hard_of_hearing")), ["consignes", "communication"]);
});

test("malvoyance : la carte, sans historique écrit", () => {
  assert.deepEqual(sectionsPanneau(prof("low_vision")), ["communication"]);
});

test("fauteuil ET malentendant : les deux besoins, les deux sections", () => {
  assert.deepEqual(sectionsPanneau(prof("manual_wheelchair", "hard_of_hearing")),
    ["consignes", "effort", "communication"]);
});

test("les consignes passent avant tout quand on n'entend pas : elles remplacent la voix", () => {
  assert.equal(sectionsPanneau(prof("cane_or_walker", "hard_of_hearing"))[0], "consignes");
});

test("piéton sans besoin déclaré : aucune section ajoutée", () => {
  assert.deepEqual(sectionsPanneau(prof("pedestrian")), []);
  assert.deepEqual(sectionsPanneau(prof()), []);
  assert.deepEqual(sectionsPanneau(null), []);
});

// ---- L'historique des consignes ----------------------------------------------------------------

test("la plus récente d'abord", () => {
  const h = historique([{texte: "A", at: 1}, {texte: "B", at: 3}, {texte: "C", at: 2}]);
  assert.deepEqual(h.map(e => e.texte), ["B", "C", "A"]);
});

test("une consigne répétée ne chasse pas les autres", () => {
  const h = historique([
    {texte: "Continuez tout droit", at: 1}, {texte: "Tournez à gauche", at: 2},
    {texte: "Continuez tout droit", at: 3}, {texte: "Continuez tout droit", at: 4},
  ]);
  assert.deepEqual(h.map(e => e.texte), ["Continuez tout droit", "Tournez à gauche"]);
  assert.equal(h[0].at, 4, "on garde la plus récente de chaque texte");
});

test("la liste reste courte : elle se lit en marchant", () => {
  const entrees = Array.from({length: 20}, (_, i) => ({texte: `consigne ${i}`, at: i}));
  assert.equal(historique(entrees).length, MAX_CONSIGNES);
});

test("rien à montrer : liste vide, pas d'erreur", () => {
  assert.deepEqual(historique([]), []);
  assert.deepEqual(historique(null), []);
  assert.deepEqual(historique([{texte: "", at: 1}]), []);
});

// ---- La carte de communication ------------------------------------------------------------------

test("malentendant : le message demande d'être prévenu ou qu'on lui écrive", () => {
  const p = phraseCommunication(prof("hard_of_hearing"), "Mairie de Gennevilliers");
  assert.match(p, /sourd\(e\) ou malentendant\(e\)/);
  assert.match(p, /Mairie de Gennevilliers/);
  assert.match(p, /écrire/);
});

test("malvoyant : le message demande où l'on est, pas qu'on écrive", () => {
  const p = phraseCommunication(prof("low_vision"), "Mairie");
  assert.match(p, /malvoyant\(e\)/);
  assert.doesNotMatch(p, /écrire/);
});

test("les deux déclarés : les deux dits", () => {
  const p = phraseCommunication(prof("hard_of_hearing", "low_vision"), "Mairie");
  assert.match(p, /malentendant\(e\), et malvoyant\(e\)/);
});

test("la carte ne révèle jamais un handicap non déclaré", () => {
  const p = phraseCommunication(prof("hard_of_hearing", "manual_wheelchair"), "Mairie");
  assert.doesNotMatch(p, /fauteuil|malvoyant/i,
    "le profil est une donnée de santé : on ne dit que ce que l'usager a choisi de montrer");
});

test("sans destination, le message tient quand même", () => {
  const p = phraseCommunication(prof("hard_of_hearing"), "");
  assert.ok(p && !p.includes("Je vais à"));
});

test("aucun besoin de communication : pas de carte", () => {
  assert.equal(phraseCommunication(prof("manual_wheelchair"), "Mairie"), null);
  assert.equal(phraseCommunication(prof(), "Mairie"), null);
});

// ---- Le clignotement du bord de l'écran ----------------------------------------------------------

test("malentendant et danger : le bord clignote", () => {
  assert.equal(clignoter(prof("hard_of_hearing"), DANGER), true);
});

test("une simple consigne ne fait pas clignoter : sinon plus rien ne signale rien", () => {
  assert.equal(clignoter(prof("hard_of_hearing"), CONSIGNE), false);
  assert.equal(clignoter(prof("hard_of_hearing"), INFO), false);
});

test("qui entend n'a pas besoin du clignotement", () => {
  assert.equal(clignoter(prof("manual_wheelchair"), DANGER), false);
  assert.equal(clignoter(prof(), DANGER), false);
});
