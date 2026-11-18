// Résumé d'effort d'un itinéraire (js/effort.js).
//
// Ce que ce fichier protège avant tout : qu'une donnée absente ne devienne jamais un zéro
// rassurant. Sur le réseau de Gennevilliers, le revêtement est inconnu sur 69 % des tronçons ;
// afficher « Pavés : 0 m » y reviendrait à promettre un sol lisse qu'on n'a jamais mesuré.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {
  COUVERTURE_MIN, SEUIL_MODERE, SEUIL_SOUTENU,
  effortDouteux, lignesEffort, mesure, niveauEffort, resumeEffort, sensDesAretes,
} from "../js/effort.js";

// Un tronçon complet : tous les champs que arcCost lit, aux valeurs « rien de particulier ».
const arete = (id, source, target, o = {}) => ({
  id, source, target, length_m: 100,
  slope_pct: 0, cross_slope_pct: 0, width_m: null,
  has_step: false, is_crossing: false, oneway: false, beside_sidewalk: false,
  surface: "asphalt", kerb_lowered: null, sound_signal: null, ...o,
});
const reseau = aretes => ({edges: Object.fromEntries(aretes.map(e => [e.id, e]))});
const trajet = (aretes, o = {}) => ({
  edge_ids: aretes.map(e => e.id),
  length_m: aretes.reduce((s, e) => s + e.length_m, 0), duration_s: 120, ...o,
});
const FAUTEUIL = {mobility: "manual_wheelchair"};

// ---- Sens de parcours : c'est lui qui décide si une pente monte ou descend -------------------

test("chaîne simple : tout est parcouru dans le sens source vers target", () => {
  assert.deepEqual(sensDesAretes([arete(0, 1, 2), arete(1, 2, 3), arete(2, 3, 4)]), [true, true, true]);
});

test("un tronçon cartographié à l'envers est reconnu comme tel", () => {
  // 1→2, puis un tronçon saisi 3→2 que l'on parcourt donc de 2 vers 3
  assert.deepEqual(sensDesAretes([arete(0, 1, 2), arete(1, 3, 2)]), [true, false]);
});

test("la première arête se lit sur celle qui la suit", () => {
  // tronçon saisi 2→1 mais parcouru de 1 vers 2, puisque la suite part de 2
  assert.deepEqual(sensDesAretes([arete(0, 2, 1), arete(1, 2, 3)]), [false, true]);
});

test("un seul tronçon : pas de chaîne, on le prend dans son sens", () => {
  assert.deepEqual(sensDesAretes([arete(0, 1, 2)]), [true]);
});

// ---- Une mesure dit toujours sur quoi elle repose ---------------------------------------------

test("couverture complète : la mesure est fiable", () => {
  const m = mesure(6, 200, 200);
  assert.equal(m.valeur, 6);
  assert.equal(m.couverture, 1);
  assert.equal(m.fiable, true);
});

test("couverture insuffisante : la valeur existe mais n'est pas fiable", () => {
  const m = mesure(6, 10, 200);
  assert.equal(m.fiable, false, `${COUVERTURE_MIN * 100} % de couverture sont exigés`);
});

test("rien de connu : couverture nulle, jamais une fausse certitude", () => {
  assert.deepEqual(mesure(null, 0, 200), {valeur: null, couverture: 0, fiable: false});
  assert.equal(mesure(1, 5, 0).couverture, 0, "trajet de longueur nulle");
});

// ---- Niveau d'effort --------------------------------------------------------------------------

test("les trois niveaux suivent le rapport coût d'effort sur longueur", () => {
  assert.equal(niveauEffort(1.0), "faible");
  assert.equal(niveauEffort(SEUIL_MODERE + 0.01), "modéré");
  assert.equal(niveauEffort(SEUIL_SOUTENU + 0.01), "soutenu");
});

test("rapport absurde : aucun niveau inventé", () => {
  assert.equal(niveauEffort(0), null);
  assert.equal(niveauEffort(NaN), null);
  assert.equal(niveauEffort(null), null);
});

// ---- Le cœur : ne jamais transformer l'ignorance en bonne nouvelle ----------------------------

test("revêtement inconnu partout : la mesure est marquée non fiable, pas « 0 m de pavés »", () => {
  const a = [arete(0, 1, 2, {surface: "unknown"}), arete(1, 2, 3, {surface: "unknown"})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  assert.equal(r.revetementRugueux.couverture, 0);
  assert.equal(r.revetementRugueux.fiable, false,
    "l'écran doit dire « on ne sait pas », pas annoncer zéro pavé");
});

test("dévers jamais renseigné : la valeur est nulle, pas zéro", () => {
  const a = [arete(0, 1, 2, {cross_slope_pct: null}), arete(1, 2, 3, {cross_slope_pct: null})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  assert.equal(r.devers.valeur, null, "0 % laisserait croire à un trottoir parfaitement plat");
  assert.equal(r.devers.fiable, false);
});

test("pente connue sur la moitié du trajet : la mesure le dit", () => {
  const a = [arete(0, 1, 2, {slope_pct: 3}), arete(1, 2, 3, {slope_pct: null})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  assert.equal(r.pente.valeur, 3);
  assert.equal(r.pente.couverture, 0.5);
  assert.equal(r.pente.fiable, false, "la moitié ne suffit pas à affirmer une pente maximale");
});

test("la part que le moteur juge mal renseignée est rapportée telle quelle", () => {
  // Largeur donnée sur les deux tronçons : seule la pente manquante doit peser.
  const a = [arete(0, 1, 2, {slope_pct: null, width_m: 1.4}), arete(1, 2, 3, {width_m: 1.4})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  assert.ok(r.incomplet > 0.4 && r.incomplet < 0.6, `incomplet = ${r.incomplet}`);
});

test("en fauteuil, une largeur de trottoir inconnue suffit à rendre le tronçon douteux", () => {
  // Découvert en écrivant le test précédent : arcCost compte la largeur manquante comme une
  // donnée incomplète dès qu'on roule. C'est juste — un passage jamais mesuré peut être trop
  // étroit — et cela explique pourquoi presque tout Gennevilliers ressort « incomplet » en
  // fauteuil : la largeur n'y est connue que sur 0,9 % des tronçons.
  const a = [arete(0, 1, 2, {width_m: null}), arete(1, 2, 3, {width_m: null})];
  assert.equal(resumeEffort(reseau(a), trajet(a), FAUTEUIL).incomplet, 1);
  assert.equal(resumeEffort(reseau(a), trajet(a), {mobility: "pedestrian"}).incomplet, 0,
    "à pied, la largeur n'entre pas dans le calcul");
});

test("longueur au-delà de la pente que le profil tolère", () => {
  // fauteuil manuel : 5 % au plus ; 4 % et 4,8 % passent, rien ne dépasse
  const a = [arete(0, 1, 2, {slope_pct: 4}), arete(1, 2, 3, {slope_pct: 4.8})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  assert.equal(r.penteRaideM, 0);
});

// ---- Le sens compte vraiment : une côte montée n'est pas une côte descendue -------------------

test("monter coûte plus cher que descendre, et le résumé le voit", () => {
  const monte = [arete(0, 1, 2, {slope_pct: 4}), arete(1, 2, 3, {slope_pct: 4})];
  const rMonte = resumeEffort(reseau(monte), trajet(monte), FAUTEUIL);
  // mêmes tronçons, saisis dans l'autre sens : on les descend
  const descend = [arete(0, 2, 1, {slope_pct: 4}), arete(1, 3, 2, {slope_pct: 4})];
  const rDescend = resumeEffort(reseau(descend), trajet(descend), FAUTEUIL);
  assert.ok(rMonte.rapport > rDescend.rapport,
    `montée ${rMonte.rapport.toFixed(2)} devrait dépasser descente ${rDescend.rapport.toFixed(2)}`);
});

// ---- Comptages et cas limites ------------------------------------------------------------------

test("marches, traversées et feux sonores sont comptés", () => {
  const a = [
    arete(0, 1, 2, {has_step: true}),
    arete(1, 2, 3, {is_crossing: true, sound_signal: true}),
    arete(2, 3, 4, {is_crossing: true, sound_signal: null, kerb_lowered: false}),
  ];
  const r = resumeEffort(reseau(a), trajet(a), {mobility: "low_vision"});
  assert.equal(r.marches, 1);
  assert.equal(r.traversees, 2);
  assert.equal(r.sansFeuSonor, 1, "« non renseigné » n'est pas « il y en a un »");
  assert.equal(r.bordureHaute, 1);
});

test("itinéraire vide ou introuvable : rien n'est résumé", () => {
  assert.equal(resumeEffort(reseau([]), trajet([]), FAUTEUIL), null);
  assert.equal(resumeEffort({edges: {}}, {edge_ids: [7], length_m: 50}, FAUTEUIL), null);
  assert.equal(resumeEffort(null, null, FAUTEUIL), null);
});

test("un trajet plat et bien renseigné est annoncé faible", () => {
  const a = [arete(0, 1, 2), arete(1, 2, 3)];
  const r = resumeEffort(reseau(a), trajet(a), {mobility: "pedestrian"});
  assert.equal(r.niveau, "faible");
  assert.equal(r.incomplet, 0);
});

// ---- Ce que l'écran a le droit de dire -------------------------------------------------------

const ligne = (lignes, cle) => lignes.find(l => l.cle === cle);

test("une mesure non fiable sort sans valeur : l'écran ne peut pas annoncer un chiffre", () => {
  const a = [arete(0, 1, 2, {surface: "unknown"}), arete(1, 2, 3, {surface: "unknown"})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  const l = ligne(lignesEffort(r, FAUTEUIL), "revetement");
  assert.equal(l.ton, "inconnu");
  assert.equal(l.valeur, null, "pas de 0 : il n'y a pas de valeur à donner");
});

test("chaque profil ne voit que ce qui le concerne", () => {
  const a = [arete(0, 1, 2, {slope_pct: 2, width_m: 1.5})];
  const r = resumeEffort(reseau(a), trajet(a), FAUTEUIL);
  const cles = l => lignesEffort(r, l).map(x => x.cle);
  assert.ok(cles(FAUTEUIL).includes("devers"), "un fauteuil manuel se soucie du dévers");
  assert.ok(cles(FAUTEUIL).includes("largeur"));
  assert.ok(!cles({mobility: "pedestrian"}).includes("devers"), "un piéton, non");
  assert.ok(!cles({mobility: "pedestrian"}).includes("largeur"));
});

test("malvoyance : les traversées sans feu sonore remontent, et elles alertent", () => {
  const a = [arete(0, 1, 2, {is_crossing: true, sound_signal: null})];
  const r = resumeEffort(reseau(a), trajet(a), {mobility: "low_vision"});
  const l = ligne(lignesEffort(r, {mobility: "low_vision"}), "feu_sonore");
  assert.equal(l.ton, "attention");
  assert.equal(l.valeur, 1);
  assert.equal(l.total, 1);
});

test("une marche sur le trajet d'un fauteuil est une alerte, pas une statistique", () => {
  const a = [arete(0, 1, 2, {has_step: true})];
  const r = resumeEffort(reseau(a), trajet(a), {mobility: "cane_or_walker"});
  assert.equal(ligne(lignesEffort(r, FAUTEUIL), "marches").ton, "attention");
});

test("sans résumé, aucune ligne inventée", () => {
  assert.deepEqual(lignesEffort(null, FAUTEUIL), []);
});

test("un effort calculé surtout sur de l'inconnu est signalé comme tel", () => {
  const connu = [arete(0, 1, 2, {width_m: 1.5}), arete(1, 2, 3, {width_m: 1.5})];
  assert.equal(effortDouteux(resumeEffort(reseau(connu), trajet(connu), FAUTEUIL)), false);
  const inconnu = [arete(0, 1, 2, {width_m: null}), arete(1, 2, 3, {width_m: null})];
  assert.equal(effortDouteux(resumeEffort(reseau(inconnu), trajet(inconnu), FAUTEUIL)), true,
    "« effort faible » sur un trajet non mesuré n'est pas une bonne nouvelle");
  assert.equal(effortDouteux(null), false);
});
