// Surveillance du flux caméra (js/camera.js).
//
// Deux risques symétriques, et les tests tiennent les deux bouts : ne pas voir un flux mort
// laisse l'usager marcher devant une image figée ; croire mort un flux sain le fait redémarrer
// en boucle, ce qui coupe l'image pour de bon.
// Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {VERIF_MS, cameraMorte} from "../js/camera.js";

const piste = (o = {}) => ({readyState: "live", muted: false, ...o});
const video = (o = {}) => ({paused: false, ended: false, ...o});

test("flux sain : on ne touche à rien", () => {
  assert.equal(cameraMorte(piste(), video()), false);
});

test("piste terminée : il faut relancer", () => {
  assert.equal(cameraMorte(piste({readyState: "ended"}), video()), true);
});

test("piste coupée en restant « live » : c'est le cas iPhone qu'on ne voyait pas", () => {
  assert.equal(cameraMorte(piste({muted: true}), video()), true,
    "capture d'écran, enregistrement vidéo, autre appli qui prend l'objectif");
});

test("aucune piste : il faut relancer", () => {
  assert.equal(cameraMorte(null, video()), true);
  assert.equal(cameraMorte(undefined, video()), true);
});

test("vidéo en pause ou terminée : il faut relancer", () => {
  assert.equal(cameraMorte(piste(), video({paused: true})), true);
  assert.equal(cameraMorte(piste(), video({ended: true})), true);
});

test("élément vidéo absent : il faut relancer", () => {
  assert.equal(cameraMorte(piste(), null), true);
});

test("champs absents : on ne déclare pas mort ce qu'on ne sait pas", () => {
  // Un navigateur qui n'expose pas `muted` ne doit pas provoquer de relance en boucle.
  assert.equal(cameraMorte({readyState: "live"}, {}), false);
});

test("la vérification reste espacée d'au moins une seconde", () => {
  assert.ok(VERIF_MS >= 1000, "relancer plus souvent couperait l'image au lieu de la réparer");
});
