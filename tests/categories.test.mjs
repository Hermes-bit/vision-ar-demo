// Tests des catégories d'établissements (js/categories.js). Lancer : node --test web/tests/*.test.mjs
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, existsSync} from "node:fs";
import {CATEGORIES, entranceAccess, erpCategory} from "../js/categories.js";
import {ICONS} from "../js/icons.js";

test("activités courantes : la bonne famille et le bon pictogramme", () => {
  const cases = {
    "Pharmacie": ["pharmacy", "cross"], "Restauration rapide": ["food", "sandwich"], "Café, bar, brasserie": ["food", "coffee"],
    "Restaurant": ["food", "utensils"], "Hôtel restaurant": ["lodging", "bed"], "Boulangerie Pâtisserie": ["food", "croissant"],
    "Boucherie / commerce de viande": ["food", "beef"], "Supermarché": ["food", "shopping-cart"], "Coiffure": ["beauty", "scissors"],
    "Dentiste, chirurgien dentiste": ["health", "smile"], "Laboratoire d'analyse médicale": ["health", "flask-conical"],
    "Auto école": ["education", "car"], "École maternelle": ["education", "school"], "Carrosserie": ["auto", "car-front"],
    "Vente d'articles de sport": ["shop", "shopping-bag"], "Gymnase": ["leisure", "dumbbell"], "Stade": ["leisure", "trophy"],
    "Piscine, centre aquatique": ["leisure", "waves"], "Bureau de poste": ["services", "mail"], "Pompes funèbres": ["services", "flower-2"],
    "Centre de protection maternelle et infantile (pmi)": ["health", "baby"], "Opticien": ["shop", "glasses"],
  };
  for (const [activity, [key, icon]] of Object.entries(cases)) {
    const c = erpCategory(activity);
    assert.deepEqual([c.key, c.icon], [key, icon], activity);
  }
});

test("toutes les activités de Gennevilliers ont une catégorie et un pictogramme existant", () => {
  const f = new URL("../data/gennevilliers.acces.json", import.meta.url);
  if (!existsSync(f)) return;
  const activities = new Set(JSON.parse(readFileSync(f, "utf8")).erps.map(e => e[1]));
  const generic = [];
  for (const a of activities) {
    const c = erpCategory(a);
    assert.ok(CATEGORIES[c.key], a);
    assert.ok(ICONS[c.icon], `pictogramme manquant pour « ${a} » : ${c.icon}`);
    if (c.icon === "store") generic.push(a);
  }
  assert.deepEqual(generic, [], "activités sans catégorie précise");
});

test("accessibilité de l'entrée", () => {
  assert.equal(entranceAccess({entree_plain_pied: true}), "ok");
  assert.equal(entranceAccess({entree_plain_pied: false}), "steps");
  assert.equal(entranceAccess({entree_plain_pied: false, entree_marches_rampe: "fixe"}), "ok");
  assert.equal(entranceAccess({}), "");
});
