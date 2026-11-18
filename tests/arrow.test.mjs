// Flèche de direction du guidage AR (js/arrow.js) : rotation, lissage, forme, et quand la montrer.
// Un signe inversé ici enverrait un aveugle à gauche quand l'itinéraire part à droite : c'est la
// raison d'être de ce fichier.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {
  AVANT_M, PAS_MAX_DEG, PRECISION_MAX_M, ZONE_MORTE_DEG,
  capFleche, formeFleche, lisserCap, opaciteFleche, placer,
} from "../js/arrow.js";

const proche = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// ---- Vers où pointe-t-elle ----------------------------------------------------------------

test("itinéraire droit devant : la flèche ne tourne pas", () => {
  assert.equal(capFleche(90, 90), 0);
});

test("itinéraire à droite : angle positif ; à gauche : négatif", () => {
  assert.equal(capFleche(90, 0), 90, "le tracé part à l'est, on regarde au nord");
  assert.equal(capFleche(270, 0), -90, "le tracé part à l'ouest");
});

test("le passage par le nord se fait par le plus court chemin", () => {
  assert.equal(capFleche(10, 350), 20, "et non -340");
  assert.equal(capFleche(350, 10), -20, "et non 340");
});

test("demi-tour : la flèche pointe vers soi", () => {
  assert.equal(Math.abs(capFleche(180, 0)), 180);
});

test("donnée manquante : pas d'angle inventé", () => {
  assert.equal(capFleche(null, 0), null);
  assert.equal(capFleche(90, undefined), null);
  assert.equal(capFleche(90, NaN), null);
});

// ---- Stabilité : c'est la demande du 16/11/2026 -------------------------------------------

test("première image : la flèche se pose directement, sans balayer l'écran", () => {
  assert.equal(lisserCap(null, 42), 42);
});

test("tremblement de boussole sous la zone morte : rien ne bouge", () => {
  const avant = 30;
  assert.equal(lisserCap(avant, avant + ZONE_MORTE_DEG - 0.5), avant);
  assert.equal(lisserCap(avant, avant - ZONE_MORTE_DEG + 0.5), avant);
});

test("un à-coup de boussole ne peut pas faire pivoter la flèche d'un coup", () => {
  const saut = lisserCap(0, 179);
  assert.ok(Math.abs(saut) <= PAS_MAX_DEG, `a bougé de ${saut}° en une image`);
});

test("un vrai virage finit par être suivi", () => {
  let a = 0;
  for (let i = 0; i < 400; i++) a = lisserCap(a, 90);
  assert.ok(Math.abs(90 - a) <= ZONE_MORTE_DEG, `s'est arrêtée à ${a}°`);
});

test("le lissage passe le nord par le plus court chemin", () => {
  const apres = lisserCap(170, -170);     // 20° vers la droite, pas 340° vers la gauche
  assert.ok(apres > 170 || apres < -170, `est repartie en arrière : ${apres}`);
  assert.ok(Math.abs(((apres - 170 + 540) % 360) - 180) <= PAS_MAX_DEG);
});

test("cible perdue en route : la flèche garde son dernier angle au lieu de disparaître", () => {
  assert.equal(lisserCap(55, null), 55);
  assert.equal(lisserCap(null, null), null);
});

// ---- Forme ---------------------------------------------------------------------------------

test("la forme est une flèche : pointe en avant, tête plus large que la tige", () => {
  const f = formeFleche();
  const pointe = f[0];
  assert.equal(pointe.b, 0, "la pointe est sur l'axe");
  assert.ok(f.every(p => p.a <= pointe.a + 1e-9), "rien ne dépasse la pointe");
  const largeurMax = Math.max(...f.map(p => Math.abs(p.b)));
  const largeurArriere = Math.abs(f.at(-4).b);
  assert.ok(largeurMax > largeurArriere, "la tête doit être plus large que la tige");
});

test("la flèche est symétrique : elle ne penche d'aucun côté", () => {
  const f = formeFleche();
  const gauche = f.filter(p => p.b < 0).map(p => [p.a, -p.b]).sort();
  const droite = f.filter(p => p.b > 0).map(p => [p.a, p.b]).sort();
  assert.deepEqual(gauche, droite);
});

// ---- Placement : le test qui empêche d'envoyer quelqu'un du mauvais côté --------------------

test("droit devant : la pointe est devant l'objectif, sur l'axe", () => {
  const p = placer({a: 1, b: 0}, 0);
  proche(p.avant, AVANT_M + 1);
  proche(p.droite, 0);
});

test("itinéraire à droite : la pointe part à droite", () => {
  const p = placer({a: 1, b: 0}, 90);
  proche(p.avant, AVANT_M);
  proche(p.droite, 1);
});

test("itinéraire à gauche : la pointe part à gauche", () => {
  const p = placer({a: 1, b: 0}, -90);
  proche(p.avant, AVANT_M);
  proche(p.droite, -1);
});

test("demi-tour : la pointe revient vers soi", () => {
  const p = placer({a: 1, b: 0}, 180);
  proche(p.avant, AVANT_M - 1);
  proche(p.droite, 0);
});

test("la flèche garde sa taille en tournant", () => {
  const forme = formeFleche();
  const longueur = cap => {
    const a = placer(forme[0], cap), b = placer(forme[3], cap);
    return Math.hypot(a.avant - b.avant, a.droite - b.droite);
  };
  proche(longueur(0), longueur(57), 1e-9);
  proche(longueur(0), longueur(-123), 1e-9);
});

// ---- Quand la montrer ------------------------------------------------------------------------

const surLItineraire = {phase: "route", offRoute: false, away: false, boussoleOk: true};

test("sur l'itinéraire, GPS correct : pleine", () => {
  assert.equal(opaciteFleche({...surLItineraire, precisionM: 6}), 1);
});

test("boussole non calibrée : masquée, car elle ferait tourner toute la flèche", () => {
  assert.equal(opaciteFleche({...surLItineraire, boussoleOk: false, precisionM: 4}), 0);
});

test("hors de l'itinéraire ou à l'écart : masquée, le cap du tracé ne veut plus rien dire", () => {
  assert.equal(opaciteFleche({...surLItineraire, offRoute: true, precisionM: 4}), 0);
  assert.equal(opaciteFleche({...surLItineraire, away: true, precisionM: 4}), 0);
  assert.equal(opaciteFleche({...surLItineraire, phase: "approach", precisionM: 4}), 0);
});

test("recalage après une pause, ou arrivée : masquée", () => {
  assert.equal(opaciteFleche({...surLItineraire, recalage: true, precisionM: 4}), 0);
  assert.equal(opaciteFleche({...surLItineraire, arrive: true, precisionM: 4}), 0);
});

test("terrain de nuit du 19/10 : à 14 m de GPS, la flèche reste pleine là où le ruban s'effaçait", () => {
  assert.equal(opaciteFleche({...surLItineraire, precisionM: 14}), 1);
});

test("GPS très imprécis : elle pâlit, puis disparaît", () => {
  const a = opaciteFleche({...surLItineraire, precisionM: 32});
  assert.ok(a > 0 && a < 1, `opacité inattendue : ${a}`);
  assert.equal(opaciteFleche({...surLItineraire, precisionM: PRECISION_MAX_M + 1}), 0);
});

test("sans mesure de précision (ordinateur, démonstration) : montrée", () => {
  assert.equal(opaciteFleche({...surLItineraire, precisionM: null}), 1);
});
