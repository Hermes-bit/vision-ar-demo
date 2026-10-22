// Écrans d'authentification : Bienvenue, Connexion, Inscription.
//
// MODE DÉMONSTRATION : les comptes sont enregistrés uniquement sur ce téléphone
// (localStorage), le mot de passe n'est jamais gardé en clair (PBKDF2-SHA-256,
// sel aléatoire). Rien n'est envoyé à un serveur. Pour de vrais comptes partagés
// entre appareils, remplacer createAccount / checkLogin par un service (Supabase).
import {icon} from "./icons.js";
import {sticker} from "./stickers.js";

const ACCOUNTS = "va-accounts", SESSION = "va-session";
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

export const currentSession = () => store.get(SESSION, null);
export const isGuest = () => !!currentSession()?.guest;
export function logout() { store.del(SESSION); }
// Connexion sans compte (invité) : aucune adresse e-mail, aucun mot de passe ; profil, favoris et réglages restent
// sur ce téléphone comme pour un compte. On peut créer un compte plus tard (Déconnexion, puis Inscription).
function guestLogin() { store.set(SESSION, {guest: true, name: "Invité", since: Date.now()}); }
// Version de présentation (recruteurs) : l'accueil met la découverte sans compte en premier
let OPTS = {presentation: false};
export function configureAuth(o) { OPTS = {...OPTS, ...o}; }

// ---- Mots de passe : jamais en clair ------------------------------------------------------------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt, iterations: 150000}, key, 256);
  return {salt: b64(salt), hash: b64(bits)};
}
const normEmail = e => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function createAccount({name, email, password}) {
  const accounts = store.get(ACCOUNTS, {}), key = normEmail(email);
  if (accounts[key]) throw {email: "Un compte existe déjà avec cette adresse. Connectez-vous."};
  accounts[key] = {name: name.trim(), ...(await hashPassword(password)), created: Date.now()};
  store.set(ACCOUNTS, accounts);
  store.set(SESSION, {email: key, name: name.trim(), since: Date.now()});
}
async function checkLogin({email, password}) {
  const acc = store.get(ACCOUNTS, {})[normEmail(email)];
  const fail = {form: "Adresse e-mail ou mot de passe incorrect."};      // même message : on ne dit pas lequel est faux
  if (!acc) throw fail;
  const {hash} = await hashPassword(password, acc.salt);
  if (hash !== acc.hash) throw fail;
  store.set(SESSION, {email: normEmail(email), name: acc.name, since: Date.now()});
}

// ---- État des formulaires -------------------------------------------------------------------------
const F = {values: {}, errors: {}, busy: false, showPwd: false};
export function resetForm() { F.values = {}; F.errors = {}; F.busy = false; F.showPwd = false; }

function field(id, label, ic, {type = "text", autocomplete, inputmode, hint} = {}) {
  const err = F.errors[id], isPwd = type === "password";
  return `<div class="field ${err ? "invalid" : ""}">
    <label for="f-${id}">${label}</label>
    <span class="field-ic" aria-hidden="true">${icon(ic)}</span>
    <input id="f-${id}" name="${id}" type="${isPwd && F.showPwd ? "text" : type}" value="${esc(F.values[id] || "")}"
      ${autocomplete ? `autocomplete="${autocomplete}"` : ""} ${inputmode ? `inputmode="${inputmode}"` : ""}
      ${type === "email" ? 'autocapitalize="none" spellcheck="false"' : ""} required
      aria-invalid="${!!err}" aria-describedby="m-${id}">
    ${isPwd ? `<button type="button" class="field-eye" data-auth="toggle-pwd" aria-label="${F.showPwd ? "Masquer" : "Afficher"} le mot de passe"
      aria-pressed="${F.showPwd}">${icon(F.showPwd ? "eye-off" : "eye")}</button>` : ""}
    <small id="m-${id}" class="${err ? "field-err" : "field-hint"}">${err ? `${icon("circle-alert")} ${esc(err)}` : hint || ""}</small>
  </div>`;
}
const hero = (title, stk) => `<header class="auth-hero">
    ${sticker(stk, "stk-hero")}
    <img class="hero-bg" src="img/auth-bg.jpg" alt="">
    <img class="hero-logo" src="img/geomessen-blanc.png" alt="Geomessen Burkina Faso">
    <h1>${title}</h1>
    <svg class="hero-wave" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 34 C 90 70 170 -6 260 22 C 320 41 360 46 400 30 L400 60 L0 60 Z"/></svg>
  </header>`;
const demoNote = `<p class="demo-note">${icon("shield-check")} Mode démonstration : votre compte reste sur ce téléphone, rien n'est envoyé.</p>`;
const formError = () => F.errors.form ? `<div class="msg warn" role="alert">${icon("circle-alert")}<span>${esc(F.errors.form)}</span></div>` : "";

// Logos officiels simplifiés (boutons « Continuer avec »)
const GOOGLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.29 14.28A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.56.38-2.28V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4.01-3.11z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77z"/></svg>`;
const APPLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.37 12.7c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.6 1.1 8.75.73 1.05 1.6 2.23 2.73 2.19 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.3-3.5zM14.2 6.25c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.67.97.08 1.96-.49 2.56-1.22z"/></svg>`;

// ---- Écrans -----------------------------------------------------------------------------------------
export function screenWelcome() {
  return `<div class="auth welcome">
    <i class="blob b1" aria-hidden="true"></i><i class="blob b2" aria-hidden="true"></i>
    <i class="blob b3" aria-hidden="true"></i><i class="blob b4" aria-hidden="true"></i>
    <img class="welcome-logo" src="img/geomessen.png" alt="Geomessen Burkina Faso">
    <div class="welcome-illu" aria-hidden="true"><img src="img/accueil.jpg" alt=""><span class="welcome-badge">${icon("accessibility")}</span>
      ${sticker("salut", "stk-welcome")}</div>
    <h1>Bienvenue</h1>
    <p class="lead">Vision AR vous guide à pied, en fauteuil ou avec une canne, par les trajets les plus accessibles.</p>
    ${OPTS.presentation ? `<p class="pres-note">${icon("info")} Version de présentation : découvrez l'application sans créer de compte.
      Le guidage est simulé, inutile de vous déplacer.</p>
    <button class="btn ink" data-auth="guest">Découvrir l'application ${icon("chevron-right")}</button>
    <p class="switch-auth">Déjà un compte ? <button class="link" data-auth="to-login">Se connecter</button></p>`
    : `<button class="btn ink" data-auth="start">Commencer ${icon("chevron-right")}</button>
    <button class="btn guest-btn" data-auth="guest">${icon("user-round")} Continuer sans compte</button>
    <p class="switch-auth">Déjà inscrit ? <button class="link" data-auth="to-login">Se connecter</button></p>`}
  </div>`;
}
export function screenLogin() {
  return `<div class="auth with-hero">${hero("Connexion", "vision-ar")}
    <form class="auth-form" data-form="login" novalidate>
      ${formError()}
      ${field("email", "Adresse e-mail", "mail", {type: "email", autocomplete: "email", inputmode: "email"})}
      ${field("password", "Mot de passe", "lock", {type: "password", autocomplete: "current-password"})}
      <button class="link small" type="button" data-auth="forgot">Mot de passe oublié ?</button>
      <button class="btn primary" type="submit" ${F.busy ? "disabled" : ""}>${icon("log-in")} ${F.busy ? "Connexion…" : "Se connecter"}</button>
    </form>
    <p class="switch-auth">Pas encore de compte ? <button class="link strong" data-auth="to-signup">S'inscrire</button></p>
    <p class="switch-auth">ou <button class="link strong" data-auth="guest">continuer sans compte</button></p>
    ${demoNote}
  </div>`;
}
export function screenSignup() {
  return `<div class="auth with-hero">${hero("Inscription", "on-y-va")}
    <form class="auth-form" data-form="signup" novalidate>
      ${formError()}
      ${field("name", "Prénom et nom", "user-round", {autocomplete: "name"})}
      ${field("email", "Adresse e-mail", "mail", {type: "email", autocomplete: "email", inputmode: "email"})}
      ${field("password", "Mot de passe", "lock", {type: "password", autocomplete: "new-password", hint: "8 caractères minimum"})}
      ${field("confirm", "Confirmer le mot de passe", "lock", {type: "password", autocomplete: "new-password"})}
      <button class="btn primary" type="submit" ${F.busy ? "disabled" : ""}>${icon("user-plus")} ${F.busy ? "Création…" : "Créer mon compte"}</button>
    </form>
    <div class="social"><p>Ou inscrivez-vous avec</p>
      <div class="social-row">
        <button class="social-btn" data-auth="social" data-v="Google" aria-label="Continuer avec Google">${GOOGLE}</button>
        <button class="social-btn apple" data-auth="social" data-v="Apple" aria-label="Continuer avec Apple">${APPLE}</button>
      </div></div>
    <p class="switch-auth">Déjà un compte ? <button class="link strong" data-auth="to-login">Se connecter</button></p>
    <p class="switch-auth">ou <button class="link strong" data-auth="guest">continuer sans compte</button></p>
    ${demoNote}
  </div>`;
}

// ---- Événements -----------------------------------------------------------------------------------
function validate(kind) {
  const v = F.values, e = {};
  if (kind === "signup" && (v.name || "").trim().length < 2) e.name = "Indiquez votre prénom et votre nom.";
  if (!EMAIL_RE.test((v.email || "").trim())) e.email = "Adresse e-mail invalide (exemple : nom@domaine.fr).";
  if (!v.password) e.password = "Indiquez votre mot de passe.";
  else if (kind === "signup" && v.password.length < 8) e.password = "Le mot de passe doit faire au moins 8 caractères.";
  if (kind === "signup" && v.confirm !== v.password) e.confirm = "Les deux mots de passe ne sont pas identiques.";
  return e;
}
/** ctx : {go(screen), done(), toast(text), rerender()} */
export function bindAuth(root, ctx) {
  root.querySelectorAll("input").forEach(inp => inp.oninput = () => {
    F.values[inp.name] = inp.value;
    if (F.errors[inp.name]) {                             // l'erreur disparaît dès qu'on corrige le champ
      delete F.errors[inp.name];
      const f = inp.closest(".field"), m = f.querySelector("small");
      f.classList.remove("invalid"); inp.setAttribute("aria-invalid", "false");
      m.className = "field-hint"; m.textContent = inp.name === "password" && root.querySelector("[data-form=signup]") ? "8 caractères minimum" : "";
    }
  });
  root.querySelectorAll("[data-auth]").forEach(b => b.onclick = () => {
    const a = b.dataset.auth;
    if (a === "start" || a === "to-login") { resetForm(); ctx.go("login"); }
    else if (a === "to-signup") { resetForm(); ctx.go("signup"); }
    else if (a === "toggle-pwd") { F.showPwd = !F.showPwd; ctx.rerender(); root.querySelector(".field-eye")?.focus(); }
    else if (a === "forgot") ctx.toast("Mode démonstration : le compte est sur ce téléphone, il n'y a pas d'e-mail de récupération. Créez un nouveau compte si besoin.");
    else if (a === "social") ctx.toast(`Connexion avec ${b.dataset.v} : bientôt disponible. Utilisez l'e-mail en attendant.`);
    else if (a === "guest") { guestLogin(); resetForm(); ctx.done(); }
  });
  const form = root.querySelector("form[data-form]");
  if (!form) return;
  form.onsubmit = async ev => {
    ev.preventDefault();
    const kind = form.dataset.form;
    F.errors = validate(kind);
    if (Object.keys(F.errors).length) {
      ctx.rerender();
      root.querySelector('[aria-invalid="true"]')?.focus();           // le lecteur d'écran lit l'erreur du champ
      return;
    }
    F.busy = true; ctx.rerender();
    try {
      await (kind === "signup" ? createAccount(F.values) : checkLogin(F.values));
      resetForm();
      ctx.done();
    } catch (err) {
      F.busy = false;
      F.errors = err && typeof err === "object" && !(err instanceof Error) ? err : {form: "Une erreur est survenue, réessayez."};
      ctx.rerender();
      (root.querySelector('[aria-invalid="true"]') || root.querySelector('[role="alert"]'))?.focus?.();
    }
  };
}
