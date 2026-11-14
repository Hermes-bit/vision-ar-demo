// Comptes et mots de passe (js/auth.js) : PBKDF2, sel, pas d'énumération des comptes, navigation privée.
// Lancer : node --test web/tests/*.test.mjs
import {test, beforeEach} from "node:test";
import assert from "node:assert/strict";

// localStorage n'existe pas dans Node : on le remplace, comme le navigateur le fournit.
function fakeStorage({throws = false} = {}) {
  const d = new Map();
  return {
    d,
    getItem(k) { if (throws) throw new DOMException("refusé"); return d.has(k) ? d.get(k) : null; },
    setItem(k, v) { if (throws) throw new DOMException("refusé"); d.set(k, String(v)); },
    removeItem(k) { if (throws) throw new DOMException("refusé"); d.delete(k); },
  };
}
globalThis.localStorage = fakeStorage();

const {hashPassword, normEmail, createAccount, checkLogin, currentSession, logout} = await import("../js/auth.js");

const COMPTE = {name: "Awa Traoré", email: "awa@exemple.fr", password: "chemin-sans-marche"};

beforeEach(() => { globalThis.localStorage = fakeStorage(); });

test("le mot de passe n'est jamais enregistré, même en morceau", async () => {
  await createAccount(COMPTE);
  const tout = [...globalThis.localStorage.d.values()].join(" ");
  assert.ok(!tout.includes(COMPTE.password), "le mot de passe en clair est dans localStorage");
  assert.ok(!tout.includes("chemin"), "un morceau du mot de passe est dans localStorage");
  const compte = JSON.parse(globalThis.localStorage.d.get("va-accounts"))["awa@exemple.fr"];
  assert.deepEqual(Object.keys(compte).sort(), ["created", "hash", "name", "salt"]);
});

test("PBKDF2 : même mot de passe et même sel donnent la même empreinte", async () => {
  const a = await hashPassword("mot-de-passe-long", "AAAAAAAAAAAAAAAAAAAAAA==");
  const b = await hashPassword("mot-de-passe-long", "AAAAAAAAAAAAAAAAAAAAAA==");
  assert.equal(a.hash, b.hash);
});

test("le sel sert : deux comptes au même mot de passe ont des empreintes différentes", async () => {
  const a = await hashPassword("mot-de-passe-long");
  const b = await hashPassword("mot-de-passe-long");
  assert.notEqual(a.salt, b.salt, "le sel devrait être tiré au hasard");
  assert.notEqual(a.hash, b.hash);
});

test("sel de 16 octets, empreinte de 256 bits, en base64", async () => {
  const {salt, hash} = await hashPassword("mot-de-passe-long");
  assert.equal(Buffer.from(salt, "base64").length, 16);
  assert.equal(Buffer.from(hash, "base64").length, 32);
});

test("un mot de passe différent sur le même sel change l'empreinte", async () => {
  const sel = "AAAAAAAAAAAAAAAAAAAAAA==";
  const a = await hashPassword("mot-de-passe-long", sel);
  const b = await hashPassword("mot-de-passe-lonG", sel);
  assert.notEqual(a.hash, b.hash);
});

test("inscription puis connexion avec le bon mot de passe : la session s'ouvre", async () => {
  await createAccount(COMPTE);
  logout();
  assert.equal(currentSession(), null);
  await checkLogin({email: COMPTE.email, password: COMPTE.password});
  assert.equal(currentSession().email, "awa@exemple.fr");
  assert.equal(currentSession().name, "Awa Traoré");
});

test("mauvais mot de passe : refus, et aucune session ouverte", async () => {
  await createAccount(COMPTE);
  logout();
  await assert.rejects(
    () => checkLogin({email: COMPTE.email, password: "autre-mot-de-passe"}),
    e => e.form === "Adresse e-mail ou mot de passe incorrect.",
  );
  assert.equal(currentSession(), null);
});

test("pas d'énumération : compte inconnu et mot de passe faux donnent le même message", async () => {
  await createAccount(COMPTE);
  logout();
  const inconnu = await checkLogin({email: "personne@exemple.fr", password: "x"}).catch(e => e);
  const faux = await checkLogin({email: COMPTE.email, password: "x"}).catch(e => e);
  assert.deepEqual(inconnu, faux);
});

test("deux inscriptions sur la même adresse : la seconde est refusée", async () => {
  await createAccount(COMPTE);
  await assert.rejects(
    () => createAccount({...COMPTE, name: "Quelqu'un d'autre"}),
    e => typeof e.email === "string" && e.email.includes("existe déjà"),
  );
});

test("adresse e-mail normalisée : espaces et majuscules ignorés", async () => {
  assert.equal(normEmail("  Awa@EXEMPLE.FR "), "awa@exemple.fr");
  await createAccount(COMPTE);
  logout();
  await checkLogin({email: "  AWA@Exemple.FR  ", password: COMPTE.password});
  assert.equal(currentSession().email, "awa@exemple.fr");
});

test("navigation privée (localStorage refusé) : l'application ne plante pas", async () => {
  globalThis.localStorage = fakeStorage({throws: true});
  await createAccount(COMPTE);                 // ne doit pas jeter
  assert.equal(currentSession(), null);        // rien n'a pu être gardé
  logout();                                    // ne doit pas jeter non plus
});
