// Panneau du guidage composé par besoins (js/panneau.js).
//
// Ce que ces tests protègent avant tout : que les profils se CUMULENT. Les maquettes montraient
// sept écrans exclusifs ; quelqu'un en fauteuil et malentendant doit voir les deux sections, pas
// choisir. Et qu'une carte de communication ne révèle jamais un handicap non déclaré.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {DANGER, CONSIGNE, INFO} from "../js/speech.js";
import {
  MAX_CONSIGNES, blocsPanneau, clignoter, historique, phraseCommunication, sectionsPanneau, valeur,
} from "../js/panneau.js";

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

// ---- Le contenu des écrans, d'après les maquettes ------------------------------------------
//
// La règle choisie le 18/11 : une valeur absente GARDE SA PLACE et s'affiche « non renseigné ».
// Masquer la ligne laisserait croire qu'il n'y a rien à signaler.

const bloc = (bl, cle) => bl.find(b => b.cle === cle);
const type = (bl, t) => bl.find(b => b.type === t);

test("une valeur absente ne devient jamais zéro", () => {
  assert.deepEqual(valeur(null, "6 %"), {texte: "non renseigné", connu: false});
  assert.deepEqual(valeur(undefined, "6 %"), {texte: "non renseigné", connu: false});
  assert.deepEqual(valeur(0, "0 m"), {texte: "0 m", connu: true}, "zéro mesuré reste zéro");
  assert.deepEqual(valeur(6, "6 %"), {texte: "6 %", connu: true});
});

test("fauteuil manuel : la barre d'effort, les quatre pastilles, la pause", () => {
  const b = blocsPanneau(prof("manual_wheelchair"), {
    effort: {niveau: "faible", pente: 6, penteRaideM: 35, devers: null, revetementM: null, bordureHaute: 0},
  });
  assert.equal(type(b, "effort").niveau, "faible");
  const p = type(b, "pastilles").items.map(x => x.cle);
  assert.deepEqual(p, ["pente", "devers", "revetement", "bordures"]);
  assert.ok(type(b, "pastilles").items.find(x => x.cle === "pente").texte.includes("6 %"));
  assert.ok(bloc(b, "pause"), "la ligne de pause reste là même sans banc connu");
});

test("les pastilles sans donnée restent affichées, en « non renseigné »", () => {
  const b = blocsPanneau(prof("manual_wheelchair"), {effort: {niveau: "faible"}});
  const items = type(b, "pastilles").items;
  assert.equal(items.length, 4, "les quatre pastilles sont là, même vides");
  for (const i of items) {
    assert.equal(i.connu, false);
    assert.equal(i.texte, "non renseigné");
  }
});

test("Gennevilliers : zéro banc cartographié, la ligne le dit au lieu de disparaître", () => {
  const b = blocsPanneau(prof("manual_wheelchair"), {effort: {}});
  assert.equal(bloc(b, "pause").texte, "non renseigné");
});

test("fauteuil électrique : l'en-tête des dimensions et les trois lignes", () => {
  const b = blocsPanneau(prof("electric_wheelchair"), {ascenseur: {distanceM: 400}});
  assert.match(type(b, "entete").texte, /VOTRE FAUTEUIL/);
  assert.equal(type(b, "entete").connu, false, "les dimensions ne sont pas encore demandées");
  assert.ok(bloc(b, "passage") && bloc(b, "virage"));
  assert.equal(bloc(b, "ascenseur").texte, "400 m", "celui-là, on le connaît");
  assert.equal(bloc(b, "passage").texte, "non renseigné");
});

test("canne ou déambulateur : frise, banc, escalier, et la traversée s'il y en a une", () => {
  const b = blocsPanneau(prof("cane_or_walker"), {
    escalier: {distanceM: 140, marches: 4},
    traversee: {distanceM: 90, dureeVertS: null, monTempsS: 18},
  });
  assert.ok(type(b, "frise"));
  assert.equal(bloc(b, "escalier").texte, "140 m");
  const t = type(b, "traversee");
  assert.equal(t.vert.connu, false, "la durée du feu vert n'existe dans aucune base ouverte");
  assert.equal(t.moi.texte, "18 s", "mon temps de traversée, lui, se calcule");
  assert.match(t.conseil, /début du vert/);
});

test("malvoyance : « Ce qui vous attend », trois lignes et le bouton de description", () => {
  const b = blocsPanneau(prof("low_vision"), {feuSonore: {distanceM: 90}});
  assert.equal(type(b, "titre").texte, "Ce qui vous attend");
  assert.equal(bloc(b, "feu_sonore").texte, "90 m");
  assert.equal(bloc(b, "podotactile").texte, "non renseigné");
  assert.equal(bloc(b, "mur").texte, "non renseigné");
  assert.equal(bloc(b, "decrire").texte, "Décrire ce qui m'entoure");
});

test("malentendance : le bandeau d'alerte passe avant tout le reste", () => {
  const b = blocsPanneau(prof("hard_of_hearing"), {
    alerte: {texte: "Bordure haute dans 20 m"},
    consignes: [{texte: "Continuez tout droit 60 m", at: 2}],
  });
  assert.equal(b[0].type, "bandeau");
  assert.equal(b[0].texte, "Bordure haute dans 20 m");
  assert.equal(b[1].type, "consignes");
  assert.equal(b[1].entrees[0].texte, "Continuez tout droit 60 m");
});

test("sans alerte en cours, pas de bandeau vide", () => {
  const b = blocsPanneau(prof("hard_of_hearing"), {consignes: []});
  assert.equal(type(b, "bandeau"), undefined);
});

test("la carte de communication ferme la marche, pour qui n'entend pas ou ne voit pas", () => {
  const sourd = blocsPanneau(prof("hard_of_hearing"), {destination: "Mairie de Gennevilliers"});
  const c = type(sourd, "communication");
  assert.match(c.texte, /Mairie de Gennevilliers/);
  assert.deepEqual(c.boutons.map(x => x.cle), ["ecrire", "transcrire"]);
  assert.equal(type(blocsPanneau(prof("manual_wheelchair"), {}), "communication"), undefined);
});

test("profils cumulés : les blocs des deux besoins, le plus contraignant d'abord", () => {
  const b = blocsPanneau(prof("manual_wheelchair", "hard_of_hearing"), {effort: {niveau: "modéré"}});
  const types = b.map(x => x.type);
  assert.ok(types.indexOf("consignes") < types.indexOf("effort"),
    "ne pas entendre passe avant l'effort : les consignes écrites remplacent la voix");
  assert.ok(type(b, "pastilles"), "et le fauteuil garde ses pastilles");
});

test("aucun besoin déclaré : aucun bloc", () => {
  assert.deepEqual(blocsPanneau(prof("pedestrian"), {}), []);
  assert.deepEqual(blocsPanneau(prof(), {}), []);
});
