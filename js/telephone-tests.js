// Tests en direct dans le téléphone virtuel (telephone.html) : on regarde l'appli se faire tester comme par une
// personne, toucher après toucher (un doigt montre où), avec le résultat de chaque vérification au fur et à mesure.
// Lancement : panneau « Tests en direct », ou adresse telephone.html?tests=tout (utilisé aussi pour les essais
// automatiques : le résultat est dans window.__simTests).
const sleep = ms => new Promise(r => setTimeout(r, ms));
let C = null;                                              // contexte donné par js/telephone.js
const T = {running: false, stop: false, passed: 0, failed: 0, lines: []};
window.__simTests = T;

const win = () => C.sim.win, doc = () => C.sim.win?.document, va = () => C.sim.win?.__va, ar = () => C.sim.win?.__ar;
const el = sel => typeof sel === "string" ? doc()?.querySelector(sel) : sel;
const text = sel => el(sel)?.innerText.replace(/\s+/g, " ").trim() || "";
async function waitFor(fn, ms = 8000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (T.stop) throw new Error("tests arrêtés");
    try { const v = fn(); if (v) return v; } catch { /* pas encore */ }
    await sleep(120);
  }
  return null;
}
// Le doigt : un rond qui apparaît là où le test touche l'écran
function finger(e) {
  const f = document.getElementById("phone"), fr = f.getBoundingClientRect(), k = fr.width / f.clientWidth, r = e.getBoundingClientRect();
  const dot = document.createElement("i");
  dot.className = "finger";
  dot.style.left = `${fr.left + (r.left + r.width / 2) * k}px`;
  dot.style.top = `${fr.top + (r.top + r.height / 2) * k}px`;
  document.body.append(dot);
  setTimeout(() => dot.remove(), 900);
}
async function tap(sel, label) {
  const e = await waitFor(() => el(sel), 8000);
  if (!e) throw new Error(`bouton introuvable : ${label || sel}`);
  e.scrollIntoView?.({block: "nearest"});
  await sleep(200);
  finger(e);
  await sleep(380);
  const now = typeof sel === "string" ? el(sel) : e;      // l'élément à cet endroit au moment du toucher
  (now?.isConnected ? now : e).click();
  await sleep(450);
}
async function type(sel, value) {
  const e = await waitFor(() => el(sel), 8000);
  if (!e) throw new Error(`champ introuvable : ${sel}`);
  finger(e); e.focus(); e.value = "";
  for (const ch of value) { e.value += ch; e.dispatchEvent(new (win().Event)("input", {bubbles: true})); await sleep(110); }
}
function line(kind, msg) {
  T.lines.push(`${kind} ${msg}`);
  const li = document.createElement("li");
  li.className = kind === "✔" ? "ok" : kind === "✖" ? "ko" : kind === "▶" ? "head" : "step";
  li.textContent = `${kind} ${msg}`;
  const box = document.getElementById("test-out");
  box.append(li); li.scrollIntoView({block: "nearest"});
  document.getElementById("test-sum").textContent = `${T.passed} réussi${T.passed > 1 ? "s" : ""} · ${T.failed} échoué${T.failed > 1 ? "s" : ""}`;
}
const step = msg => line("·", msg);
function check(msg, ok, detail = "") {
  ok ? T.passed++ : T.failed++;
  line(ok ? "✔" : "✖", `${msg}${!ok && detail ? ` (${detail})` : ""}`);
  return ok;
}
async function appReady() {
  await waitFor(() => va()?.net, 60000);
  // premier lancement sur ce navigateur : accueil, puis profil
  if (await waitFor(() => el('[data-auth="guest"]') || el("#q") || el("#cont"), 15000) && el('[data-auth="guest"]')) {
    step("Premier lancement : « Continuer sans compte »");
    await tap('[data-auth="guest"]', "Continuer sans compte");
  }
  if (await waitFor(() => el("#cont") || el("#q"), 8000) && el("#cont")) { step("Profil : « Continuer »"); await tap("#cont", "Continuer"); }
  return !!(await waitFor(() => el("#q") || el("#ar:not([hidden])"), 15000));
}
async function backToSearch() {                            // sortir d'un guidage ou d'un choix d'itinéraire
  if (va()?.S.nav) { va().stopGuidance(); await sleep(1200); }
  if (el("#mapClose")) await tap("#mapClose", "Fermer");
}
const DEST = "Gare de Gennevilliers";
async function pickDestination(query = "Gare de Genn", wanted = "Gare") {
  await type("#q", query);
  const item = await waitFor(() => [...doc().querySelectorAll("#placesBox .place")].find(p => p.innerText.includes(wanted)), 9000);
  if (item) { await tap(item, item.innerText.split("\n")[0]); return true; }
  step("Pas de suggestion (réseau ?) : destination choisie directement");
  va().chooseDest({label: DEST, lat: 48.9339, lon: 2.3145, type: "poi"});
  return false;
}

// ---- Scénarios ---------------------------------------------------------------------------------------------------
const SCENARIOS = [
  ["depart", "Départ = ma position", async () => {
    C.setPermission("granted", true);
    Object.assign(C.sim, {lat: 48.925767, lon: 2.295317, walking: false, gpsOff: false});
    step("Ouverture de l'appli, téléphone au 9 Allée Maria Casarès");
    C.loadApp();
    check("L'appli s'ouvre", await appReady());
    await backToSearch();
    const row = await waitFor(() => text("#editOrigin").includes("Ma position") && text("#editOrigin"), 12000);
    check("Le départ se remplit tout seul avec « Ma position »", !!row, text("#editOrigin"));
    check("Pas de départ à la Mairie", !text("#editOrigin").includes("Mairie"));
  }],
  ["itineraire", "Chercher une adresse et comparer", async () => {
    await backToSearch();
    step(`Saisie de « ${DEST} »`);
    await pickDestination();
    const routes = await waitFor(() => va().S.routes.length && va().S.routes, 10000);
    check("Des itinéraires sont proposés", !!routes, va().S.message || "aucun");
    if (!routes) return;
    check("Le premier est « Le plus accessible »", routes[0].label === "Le plus accessible", routes[0].label);
    const fast = routes.find(r => r.label === "Le plus rapide");
    check(fast ? `« Le plus rapide » proposé avec sa différence : ${fast.note}` : "Le plus accessible est aussi le plus rapide",
      fast ? !!fast.note : routes[0].alsoFastest);
    if (routes.length > 1) check("Étiquettes des itinéraires sur la carte", doc().querySelectorAll(".route-tag").length >= 2);
  }],
  ["profil", "Changer de profil sous les itinéraires", async () => {
    if (!va().S.routes.length) { await backToSearch(); await pickDestination(); await waitFor(() => va().S.routes.length, 10000); }
    const before = Math.ceil(va().S.routes[0].duration_s / 60);
    await tap('[data-trip-mob="pedestrian"]', "À pied");
    const after = await waitFor(() => va().S.tripMob === "pedestrian" && va().S.routes.length && Math.ceil(va().S.routes[0].duration_s / 60), 8000);
    check(`« À pied » : ${after} min (avant : ${before} min)`, !!after);
    await tap('[data-trip-mob=""]', "Mon profil");
    check("Retour à « Mon profil »", !!(await waitFor(() => va().S.tripMob === null, 5000)));
  }],
  ["inverser", "Inverser départ et arrivée", async () => {
    if (!va().S.routes.length) { await backToSearch(); await pickDestination(); await waitFor(() => va().S.routes.length, 10000); }
    const dest = va().S.dest.label;
    await tap("#swapTrip", "Inverser");
    check(`Le départ devient « ${dest} »`, !!(await waitFor(() => text("#editOrigin").includes(dest.split(" ")[0]), 6000)), text("#editOrigin"));
    check("L'arrivée devient « Ma position »", va().S.dest?.label === "Ma position", va().S.dest?.label);
    await tap("#swapTrip", "Inverser à nouveau");
    check("Deuxième appui : retour au trajet de départ", !!(await waitFor(() => text("#editOrigin").includes("Ma position"), 8000)), text("#editOrigin"));
  }],
  ["guidage", "Guidage et marche", async () => {
    if (!va().S.routes.length) { await backToSearch(); await pickDestination(); await waitFor(() => va().S.routes.length, 10000); }
    va().S.simulate = false;                               // vrai guidage, avec le GPS et la caméra du téléphone virtuel
    await tap("#start", "Démarrer le guidage");
    check("L'écran de guidage s'ouvre", !!(await waitFor(() => va().S.screen === "nav" && el("#ar:not([hidden])"), 8000)));
    check("La caméra montre la rue virtuelle", !!(await waitFor(() => el("#ar video")?.videoWidth, 6000)));
    step("Le téléphone marche le long du trajet");
    C.setFast(false); if (!C.sim.walking) C.toggleWalk();
    const moved = await waitFor(() => va().S.nav?.phase === "route" && va().S.nav.pos > 8 && Math.round(va().S.nav.pos), 25000);
    check(`On avance sur l'itinéraire (${moved || 0} m)`, !!moved);
    check("Le ruban est affiché au sol", !!(await waitFor(() => ar()?.ribbonA > 0.5, 6000)), `opacité ${ar()?.ribbonA?.toFixed(2)}`);
    check("Temps restant affiché en haut (« min »)", text("#ar .c-eta").includes("min"), text("#ar .c-eta"));
    // pendant la marche, la consigne change à chaque mètre ; les boutons, eux, ne doivent pas être recréés (sinon un
    // toucher qui tombe à ce moment-là est perdu : « Réduire » sans effet, tests du 25/10)
    const btns = ['[data-act="minimize"]', '[data-act="voice"]', '[data-act="ask-stop"]'].map(q => el(`#ar ${q}`));
    const pos0 = va().S.nav.pos, info0 = text("#ar .bubble");
    await waitFor(() => va().S.nav.pos > pos0 + 4 || text("#ar .bubble") !== info0, 10000);
    check("La consigne s'est mise à jour en marchant", text("#ar .bubble") !== info0 || va().S.nav.pos > pos0 + 4);
    check("Les boutons restent les mêmes pendant la marche (aucun toucher perdu)", btns.every(b => b?.isConnected));
  }],
  ["tourner", "Tourner le téléphone : le ruban suit sans retard", async () => {
    if (va()?.S.screen !== "nav") { check("Guidage en cours", false, "lancez « Guidage et marche » avant"); return; }
    if (C.sim.walking) C.toggleWalk();
    C.setFollow(false);
    for (const by of [35, -70, 35]) {
      step(`Rotation de ${by > 0 ? "+" : ""}${by}° en 0,4 s`);
      C.turn(by, 400);
      await sleep(200);                                     // au milieu de la rotation
      const gap = Math.abs(((ar()?.sensors.heading - C.sim.heading + 540) % 360) - 180);
      check(`Le cap de l'appli suit le téléphone en pleine rotation (écart ${gap.toFixed(1)}°)`, gap < 4);
      await sleep(400);
    }
    C.setFollow(true);
  }],
  ["reduire", "Réduire et reprendre le guidage", async () => {
    if (va()?.S.screen !== "nav") { check("Guidage en cours", false, "lancez « Guidage et marche » avant"); return; }
    await tap('#ar [data-act="minimize"]', "Réduire");
    check("Retour au plan, guidage toujours actif", !!(await waitFor(() => va().S.screen === "route" && va().S.nav, 5000)));
    check("Pastille « Trajet en cours »", !!(await waitFor(() => text("#tripPill").includes("Trajet en cours"), 5000)), text("#tripPill"));
    await tap("#tripPill", "Trajet en cours");
    check("Le guidage reprend (caméra et consignes)", !!(await waitFor(() => va().S.screen === "nav" && el("#ar:not([hidden])"), 6000)));
  }],
  ["arrivee", "Petit trajet jusqu'à l'arrivée", async () => {
    await backToSearch();
    if (C.sim.walking) C.toggleWalk();
    Object.assign(C.sim, {lat: 48.925767, lon: 2.295317});
    await sleep(2200);                                      // le départ suit la position
    step("Destination à 150 m");
    va().chooseDest({label: "Point proche", lat: 48.92640, lon: 2.29660, type: "poi"});
    await waitFor(() => va().S.routes.length, 10000);
    va().S.simulate = false;
    await tap("#start", "Démarrer le guidage");
    await waitFor(() => va().S.screen === "nav", 6000);
    step("Marche accélérée ×5");
    C.setFast(true); if (!C.sim.walking) C.toggleWalk();
    const arrived = await waitFor(() => va().navState?.().arrived, 90000);
    check("« Vous êtes arrivé »", !!arrived);
    C.setFast(false);
    if (arrived) {
      await tap('#ar [data-act="arr-end"]', "Terminer");
      check("Fin du guidage, retour au plan", !!(await waitFor(() => !va().S.nav && va().S.screen === "route", 6000)));
    }
  }],
  ["refus", "Localisation refusée", async () => {
    if (C.sim.walking) C.toggleWalk();
    C.setPermission("denied", true);
    step("Localisation refusée, réouverture de l'appli");
    C.loadApp();
    await appReady();
    await backToSearch();
    const row = await waitFor(() => text("#editOrigin").includes("refusée") && text("#editOrigin"), 10000);
    check("Le départ dit « localisation refusée » et invite à choisir", !!row, text("#editOrigin"));
    check("Pas de fenêtre surgissante au lancement", !el(".confirm"));
    C.setPermission("granted", true);
    step("Localisation de nouveau autorisée");
    C.loadApp();
    await appReady();
  }],
];

export function initTests(ctx) {
  C = ctx;
  const list = document.getElementById("test-list");
  list.innerHTML = SCENARIOS.map(([id, label]) => `<li><button class="btn small" data-test="${id}">▶</button><span>${label}</span></li>`).join("");
  list.onclick = e => { const b = e.target.closest("[data-test]"); if (b) run([b.dataset.test]); };
  document.getElementById("test-all").onclick = () => run(SCENARIOS.map(s => s[0]));
  document.getElementById("test-stop").onclick = () => { T.stop = true; };
  const want = new URLSearchParams(location.search).get("tests");
  if (want) setTimeout(() => run(want === "tout" || want === "all" ? SCENARIOS.map(s => s[0]) : want.split(",")), 800);
}
async function run(ids) {
  if (T.running) return;
  Object.assign(T, {running: true, stop: false, passed: 0, failed: 0, lines: [], done: false});
  document.getElementById("test-out").innerHTML = "";
  document.body.classList.add("testing");
  for (const id of ids) {
    const sc = SCENARIOS.find(s => s[0] === id);
    if (!sc) continue;
    line("▶", sc[1]);
    try { await sc[2](); } catch (e) { check("Le scénario va jusqu'au bout", false, e.message); if (T.stop) break; }
  }
  line(T.failed ? "✖" : "✔", `Terminé : ${T.passed} réussi${T.passed > 1 ? "s" : ""}, ${T.failed} échoué${T.failed > 1 ? "s" : ""}`);
  Object.assign(T, {running: false, done: true});
  document.body.classList.remove("testing");
}
