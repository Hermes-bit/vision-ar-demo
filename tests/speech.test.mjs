// Tests de la file d'annonces vocales (js/speech.js). Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {CONSIGNE, DANGER, INFO, makeSpeech} from "../js/speech.js";

function setup() {
  let t = 0;
  const said = [], ends = [];
  const engine = {speak(text, onEnd) { said.push(text); ends.push(onEnd); }, cancel() { said.push("<coupé>"); }};
  const sp = makeSpeech(engine, () => t);
  return {sp, said, end: () => ends.at(-1)(), tick: ms => { t += ms; }};
}

test("un danger coupe une info en cours", () => {
  const {sp, said} = setup();
  sp.say("Position imprécise", INFO);
  sp.say("Potelet droit devant, 2 mètres, passez à gauche", DANGER);
  assert.deepEqual(said, ["Position imprécise", "<coupé>", "Potelet droit devant, 2 mètres, passez à gauche"]);
});

test("une consigne n'interrompt pas un danger : elle attend", () => {
  const {sp, said, end} = setup();
  sp.say("Barrière à droite", DANGER);
  sp.say("Tournez à gauche", CONSIGNE);
  assert.equal(said.length, 1);
  end();
  assert.deepEqual(said, ["Barrière à droite", "Tournez à gauche"]);
});

test("un seul message en attente par niveau, le plus récent", () => {
  const {sp, said, end} = setup();
  sp.say("Danger A", DANGER);
  sp.say("Dans 30 mètres, tournez à gauche", CONSIGNE);
  sp.say("Dans 10 mètres, tournez à gauche", CONSIGNE);
  end();
  assert.deepEqual(said, ["Danger A", "Dans 10 mètres, tournez à gauche"]);
});

test("message périmé abandonné", () => {
  const {sp, said, end, tick} = setup();
  sp.say("Danger A", DANGER);
  sp.say("Fiche d'arrivée", INFO);
  tick(11000);
  end();
  assert.deepEqual(said, ["Danger A"]);
});

test("pas de répétition du même texte dans les 10 s", () => {
  const {sp, said, end, tick} = setup();
  sp.say("Tournez à droite", CONSIGNE); end();
  tick(3000);
  assert.equal(sp.say("Tournez à droite", CONSIGNE), false);
  tick(8000);
  assert.equal(sp.say("Tournez à droite", CONSIGNE), true);
  assert.equal(said.filter(s => s === "Tournez à droite").length, 2);
});

test("les infos se taisent juste après un danger", () => {
  const {sp, end, tick} = setup();
  sp.say("Travaux droit devant", DANGER); end();
  tick(1000);
  assert.equal(sp.say("GPS précis", INFO), false);
  tick(3000);
  assert.equal(sp.say("GPS précis", INFO), true);
});
