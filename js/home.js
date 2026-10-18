// « Mon logement » (TEST) : se déplacer chez soi sans avoir à regarder l'écran.
//
// 1. La photo du plan est lue UNE fois par Claude (API Anthropic, appel direct depuis le téléphone avec la clé
//    de l'utilisateur). Elle n'est ni affichée ni gardée : seul le résultat (pièces, portes, passages, distances
//    en mètres) est enregistré sur le téléphone.
// 2. Calage : debout à l'entrée, face à l'intérieur du logement, on touche l'écran ; la boussole donne alors le
//    lien entre le haut du plan et le nord.
// 3. Guidage : position estimée en comptant les pas (accéléromètre) dans la direction de la boussole ; consignes
//    à la voix, vibrations gauche / droite, et bips qui viennent du côté où il faut aller (plus rapides quand on
//    est dans la bonne direction). Un grand bouton « J'y suis » permet toujours de passer à l'étape suivante.
import {icon} from "./icons.js";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
const MODEL = "claude-opus-5-5";
const KEY_STORE = "va-anthropic-key", PLAN_STORE = "va-home-plan";
const ROOM_TYPES = ["entree", "salon", "sejour", "cuisine", "chambre", "salle_de_bain", "wc", "couloir", "bureau", "balcon", "rangement", "autre"];

// Ce que Claude doit rendre : un petit réseau de points en mètres (origine en haut à gauche du plan, x vers la
// droite, y vers le bas), avec les liens « on peut marcher en ligne droite d'ici à là »
const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["rooms", "waypoints", "links", "entrance_id", "entrance_inward_angle_deg", "confidence", "notes"],
  properties: {
    rooms: {type: "array", items: {type: "object", additionalProperties: false, required: ["id", "name", "type", "x", "y"],
      properties: {id: {type: "string"}, name: {type: "string"}, type: {type: "string", enum: ROOM_TYPES}, x: {type: "number"}, y: {type: "number"}}}},
    waypoints: {type: "array", items: {type: "object", additionalProperties: false, required: ["id", "label", "kind", "x", "y"],
      properties: {id: {type: "string"}, label: {type: "string"}, kind: {type: "string", enum: ["entrance", "door", "corridor", "turn"]},
        x: {type: "number"}, y: {type: "number"}}}},
    links: {type: "array", items: {type: "object", additionalProperties: false, required: ["from", "to"],
      properties: {from: {type: "string"}, to: {type: "string"}}}},
    entrance_id: {type: "string"},
    entrance_inward_angle_deg: {type: "number"},
    confidence: {type: "string", enum: ["haute", "moyenne", "faible"]},
    notes: {type: "string"},
  },
};
const PROMPT = `Cette image est le plan d'un logement (un appartement). Il servira à guider pas à pas une personne aveugle
ou malvoyante, à la voix, d'une pièce à l'autre. Décris-le sous forme de réseau de déplacement, en mètres réels :
- repère : origine au coin haut gauche du plan, x vers la droite, y vers le bas, en mètres ;
- échelle : utilise les cotes ou surfaces écrites sur le plan ; à défaut, une porte intérieure mesure environ 0,8 m ;
- rooms : chaque pièce (nom en français tel qu'écrit sur le plan, sinon un nom simple), avec le point central où l'on se tient ;
- waypoints : la porte d'entrée du logement (kind « entrance »), chaque porte entre pièces (« door »), et les points
  de couloir ou de virage nécessaires (« corridor », « turn ») pour que chaque trajet soit fait de segments droits
  qui ne traversent pas de mur ;
- links : les segments droits praticables à pied (les deux sens), entre ids de rooms ou de waypoints ; chaque pièce
  doit être reliée à sa porte, et tout le logement doit être relié à l'entrée ;
- entrance_id : l'id du waypoint de la porte d'entrée ;
- entrance_inward_angle_deg : direction dans laquelle on regarde en entrant, sur le plan (0 = vers le haut de
  l'image, 90 = vers la droite, 180 = vers le bas, 270 = vers la gauche) ;
- confidence et notes : ta confiance, et en une phrase ce qui est incertain (échelle, porte mal lisible…).
Si l'image n'est pas un plan de logement, rends des listes vides, confidence « faible » et explique-le dans notes.`;

let root = null, opts = {}, sensors = null, guide = null, audio = null;
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* idem */ } },
};
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const say = (t, urgent = true) => opts.say?.(t, urgent);
export const homeOpen = () => !!root;

// ---- Lecture du plan par Claude --------------------------------------------------------------------
// Photo réduite à 1600 px (JPEG) : assez pour lire les cotes, léger à envoyer
function photoToBase64(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("Image illisible")); };
    img.src = url;
  });
}
async function readPlan(file, apiKey) {
  const {default: Anthropic} = await import(SDK_URL);
  // Test : la clé de l'utilisateur reste sur son téléphone et part directement chez Anthropic
  const client = new Anthropic({apiKey, dangerouslyAllowBrowser: true});
  const data = await photoToBase64(file);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",                    // si le modèle décline, l'API relance la demande sur le modèle conseillé
    output_config: {effort: "high", format: {type: "json_schema", schema: PLAN_SCHEMA}},
    messages: [{role: "user", content: [
      {type: "image", source: {type: "base64", media_type: "image/jpeg", data}},
      {type: "text", text: PROMPT},
    ]}],
  });
  if (response.stop_reason === "refusal") throw new Error("La lecture du plan a été refusée.");
  if (response.stop_reason === "max_tokens") throw new Error("Réponse incomplète : réessayez.");
  const text = response.content.find(b => b.type === "text")?.text;
  if (!text) throw new Error("Pas de réponse lisible.");
  return JSON.parse(text);
}

// ---- Réseau du logement ---------------------------------------------------------------------------
function buildGraph(plan) {
  const nodes = new Map();
  for (const r of plan.rooms) nodes.set(r.id, {id: r.id, x: r.x, y: r.y, label: r.name, room: true});
  for (const w of plan.waypoints) nodes.set(w.id, {id: w.id, x: w.x, y: w.y, label: w.label, kind: w.kind});
  const adj = new Map([...nodes.keys()].map(k => [k, []]));
  const link = (a, b) => {
    if (!nodes.has(a) || !nodes.has(b) || a === b || adj.get(a).some(e => e.to === b)) return;
    const d = Math.hypot(nodes.get(a).x - nodes.get(b).x, nodes.get(a).y - nodes.get(b).y);
    adj.get(a).push({to: b, d}); adj.get(b).push({to: a, d});
  };
  plan.links.forEach(l => link(l.from, l.to));
  // pièce oubliée par la lecture : reliée au point le plus proche, pour qu'on puisse toujours y aller
  for (const [id, n] of nodes) if (!adj.get(id).length) {
    let best = null;
    for (const [k, m] of nodes) if (k !== id && adj.get(k).length && (!best || Math.hypot(m.x - n.x, m.y - n.y) < best.d)) best = {k, d: Math.hypot(m.x - n.x, m.y - n.y)};
    if (best) link(id, best.k);
  }
  return {nodes, adj};
}
function shortest(g, from, to) {
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let cur = null;
    for (const [k, d] of dist) if (!done.has(k) && (cur === null || d < dist.get(cur))) cur = k;
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const e of g.adj.get(cur)) if (dist.get(cur) + e.d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, dist.get(cur) + e.d); prev.set(e.to, cur); }
  }
  const ids = [to];
  while (prev.has(ids[0])) ids.unshift(prev.get(ids[0]));
  return ids.map(id => g.nodes.get(id));
}
const planAngle = (a, b) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;   // 0 = haut du plan
const norm180 = d => ((d + 540) % 360) - 180;
function turnWords(delta) {
  const a = Math.abs(delta);
  if (a < 25) return "continuez tout droit";
  if (a > 150) return "faites demi-tour";
  return `${a < 60 ? "tournez légèrement" : "tournez"} à ${delta > 0 ? "droite" : "gauche"}`;
}

// ---- Capteurs : boussole et pas ---------------------------------------------------------------------
async function startSensors() {
  // iPhone : l'autorisation doit être demandée dans le geste de l'usager
  try { await window.DeviceOrientationEvent?.requestPermission?.(); } catch { /* refusé ou inutile */ }
  try { await window.DeviceMotionEvent?.requestPermission?.(); } catch { /* idem */ }
  sensors = {heading: null, steps: 0, lastStep: 0, smooth: 9.81, base: 9.81, peak: false};
  const onOrient = e => {
    const h = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : e.absolute && e.alpha !== null ? (360 - e.alpha) % 360 : null;
    if (h !== null) sensors.heading = sensors.heading === null ? h : (sensors.heading + norm180(h - sensors.heading) * 0.25 + 360) % 360;
  };
  const onMotion = e => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    const m = Math.hypot(a.x, a.y, a.z), now = performance.now();
    sensors.smooth = sensors.smooth * 0.8 + m * 0.2;
    sensors.base = sensors.base * 0.98 + m * 0.02;       // valeur de repos de CE téléphone (elle varie de 9,6 à 10,1)
    // un pas = un pic d'accélération nettement au-dessus du repos, au moins 300 ms après le précédent ;
    // le détecteur se réarme quand l'accélération redescend près du repos
    if (!sensors.peak && sensors.smooth > sensors.base + 1.2 && now - sensors.lastStep > 300) { sensors.peak = true; sensors.lastStep = now; sensors.steps++; guide?.onStep(); }
    else if (sensors.peak && sensors.smooth < sensors.base + 0.3) sensors.peak = false;
  };
  window.addEventListener("deviceorientationabsolute", onOrient);
  window.addEventListener("deviceorientation", onOrient);
  window.addEventListener("devicemotion", onMotion);
  sensors.stop = () => {
    window.removeEventListener("deviceorientationabsolute", onOrient);
    window.removeEventListener("deviceorientation", onOrient);
    window.removeEventListener("devicemotion", onMotion);
  };
}

// ---- Sons de direction (bip venant du côté où il faut aller) ------------------------------------------
function beep(pan, high) {
  if (!audio) return;
  const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain(), p = audio.createStereoPanner();
  o.frequency.value = high ? 1046 : 660;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  p.pan.value = Math.max(-1, Math.min(1, pan));
  o.connect(g).connect(p).connect(audio.destination);
  o.start(t); o.stop(t + 0.1);
}

// ---- Écrans ---------------------------------------------------------------------------------------
function shell(html) {
  if (!root) {
    root = document.createElement("div");
    root.id = "home";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Mon logement");
    document.body.append(root);
  }
  root.innerHTML = `<header class="hm-head"><button class="icon-btn" data-hm="close" aria-label="Fermer">${icon("arrow-left")}</button>
    <b class="grow">Mon logement</b></header><div class="hm-body">${html}</div>`;
  root.querySelector("[data-hm=close]").onclick = closeHome;
}
function screenAi() {
  const plan = store.get(PLAN_STORE, null), key = store.get(KEY_STORE, "");
  if (!plan) {
    shell(`<p class="hm-lead">Prenez en photo le plan de votre logement. Il ne sera pas affiché : il est lu une seule fois par
        l'intelligence artificielle, qui en tire les pièces, les portes et les distances.</p>
      <label class="hm-field"><span>Clé d'API Claude (test)</span>
        <input type="password" id="hmKey" value="${esc(key)}" autocomplete="off" placeholder="sk-ant-…"></label>
      <p class="fine">${icon("info")} Pour ce test, la clé reste sur ce téléphone et la photo part directement chez Anthropic.</p>
      <label class="hm-big" for="hmPhoto">${icon("camera")}<span>Prendre ou choisir la photo du plan</span>
        <input type="file" accept="image/*" id="hmPhoto" hidden></label>
      <button class="btn soft" data-hm="routes">${icon("footprints")} Trajets enregistrés en marchant (gratuit)</button>`);
    root.querySelector("[data-hm=routes]").onclick = screenStart;
    const keyInput = root.querySelector("#hmKey");
    keyInput.onchange = () => store.set(KEY_STORE, keyInput.value.trim());
    root.querySelector("#hmPhoto").onchange = e => { const f = e.target.files?.[0]; if (f) analyse(f, keyInput.value.trim()); };
    return;
  }
  const rooms = plan.rooms;
  const from = store.get("va-home-here", plan.entrance_id);
  const places = [{id: plan.entrance_id, name: "Entrée"}, ...rooms.filter(r => r.id !== plan.entrance_id)];
  shell(`<label class="hm-field"><span>Je suis à</span><select id="hmFrom">${places.map(p =>
        `<option value="${esc(p.id)}" ${p.id === from ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <p class="hm-lead">Où voulez-vous aller ?</p>
    <div class="hm-rooms">${rooms.map(r => `<button class="hm-big" data-room="${esc(r.id)}">${icon("navigation")}<span>${esc(r.name)}</span></button>`).join("")}</div>
    ${plan.calibration === undefined ? `<p class="fine">${icon("info")} Au premier trajet, l'appli vous demandera de vous placer à l'entrée pour caler la boussole.</p>` : ""}
    <div class="hm-row"><button class="btn soft" data-hm="recal">${icon("compass")} Recaler la boussole</button>
      <button class="btn soft" data-hm="reset">${icon("trash-2")} Autre plan</button></div>
    ${plan.notes ? `<p class="fine">${icon("info")} Lecture du plan (confiance ${esc(plan.confidence)}) : ${esc(plan.notes)}</p>` : ""}`);
  root.querySelector("#hmFrom").onchange = e => store.set("va-home-here", e.target.value);
  root.querySelectorAll("[data-room]").forEach(b => b.onclick = () => go(root.querySelector("#hmFrom").value, b.dataset.room));
  root.querySelector("[data-hm=recal]").onclick = () => calibrate(plan, null);
  root.querySelector("[data-hm=reset]").onclick = () => { store.del(PLAN_STORE); store.del("va-home-here"); screenAi(); };
  say(`Vous êtes à ${places.find(p => p.id === from)?.name || "l'entrée"}. Choisissez une pièce.`, false);
}
async function analyse(file, key) {
  if (!key) { say("Entrez d'abord la clé d'API."); return opts.toast?.("Entrez d'abord la clé d'API Claude."); }
  store.set(KEY_STORE, key);
  shell(`<div class="hm-wait" role="status" aria-live="polite"><span class="hm-spin" aria-hidden="true"></span>
    <p>Lecture du plan en cours…<br><small>Cela peut prendre une minute.</small></p></div>`);
  say("Lecture du plan en cours. Cela peut prendre une minute.");
  try {
    const plan = await readPlan(file, key);
    if (!plan.rooms.length) throw new Error(plan.notes || "Aucune pièce trouvée sur cette image.");
    store.set(PLAN_STORE, plan);
    store.set("va-home-here", plan.entrance_id);
    say(`J'ai trouvé ${plan.rooms.length} pièces : ${plan.rooms.map(r => r.name).join(", ")}.`);
    screenAi();
  } catch (e) {
    // Erreurs de l'API traduites en clair (le message brut, en anglais et en JSON, ne disait rien à l'usager)
    const raw = String(e?.message || "");
    const msg = /credit balance/i.test(raw)
        ? "Le compte Anthropic lié à cette clé n'a plus de crédit. Ajoutez des crédits dans la console Anthropic, rubrique Plans and Billing, puis réessayez."
      : e?.status === 401 ? "Clé d'API refusée : vérifiez-la ou créez-en une nouvelle dans la console Anthropic."
      : e?.status === 403 ? "Cette clé n'a pas le droit d'utiliser ce service."
      : e?.status === 429 ? "Trop de demandes en peu de temps : réessayez dans une minute."
      : e?.status === 529 || e?.status >= 500 ? "Le service est momentanément surchargé : réessayez dans quelques minutes."
      : /fetch|network|Failed to load/i.test(raw) ? "Pas de connexion internet : la lecture du plan demande le réseau."
      : raw && !raw.startsWith("4") && !raw.startsWith("{") ? raw : "Lecture du plan impossible. Réessayez avec une photo plus nette.";
    shell(`<p class="hm-lead" role="alert">${esc(msg)}</p><button class="hm-big" data-hm="retry">${icon("rotate-ccw")}<span>Réessayer</span></button>`);
    root.querySelector("[data-hm=retry]").onclick = screenAi;
    say(msg);
  }
}
// Calage de la boussole : à l'entrée, face à l'intérieur ; ensuite on part vers la destination demandée
function calibrate(plan, then) {
  shell(`<button class="hm-tap" data-hm="cal"><span>Placez-vous à la porte d'entrée, face à l'intérieur du logement,
    puis touchez l'écran.</span></button>`);
  say("Placez-vous à la porte d'entrée, face à l'intérieur du logement, puis touchez l'écran.");
  root.querySelector("[data-hm=cal]").onclick = async () => {
    if (!sensors) await startSensors();
    setTimeout(() => {                                   // laisser la boussole se stabiliser une seconde
      if (sensors.heading === null) {
        say("La boussole ne répond pas : le guidage se fera sans elle, avec les consignes et le bouton J'y suis.");
        plan.calibration = null;
      } else plan.calibration = sensors.heading - plan.entrance_inward_angle_deg;
      store.set(PLAN_STORE, plan);
      if (then) then(); else { say("Boussole calée."); screenAi(); }
    }, 1000);
  };
}
async function go(fromId, toId) {
  const plan = store.get(PLAN_STORE, null);
  if (!audio) { try { audio = new AudioContext(); } catch { audio = null; } }
  audio?.resume?.();
  if (plan.calibration === undefined) return calibrate(plan, () => go(fromId, toId));
  if (!sensors) await startSensors();
  const g = buildGraph(plan), path = shortest(g, fromId, toId);
  if (!path || path.length < 2) { say("Vous y êtes déjà."); return; }
  startGuide(plan, path, toId);
}

// ---- Moteur de guidage commun (plan lu par l'IA ou trajet enregistré) -------------------------------------
// legs[i] = {heading: cap à suivre (degrés, ou null), steps: nombre de pas (ou null), meters, to: nom du point visé}
function runGuide(legs, finalName, onArrive) {
  const stepM = opts.stepLength?.() ?? 0.65, wheel = opts.wheelchair?.() ?? false;
  let i = 0, startSteps = sensors.steps, timer = 0, lastBuzz = 0, lastSaid = 0, lastBeep = 0;
  const target = k => legs[k].steps ?? Math.max(1, Math.round(legs[k].meters / stepM));     // en pas
  const done = () => sensors.steps - startSteps;
  const unit = n => wheel ? `${Math.max(1, Math.round(n * stepM))} mètre${Math.round(n * stepM) > 1 ? "s" : ""}` : `${Math.max(1, n)} pas`;
  function instruction() {
    const h = legs[i].heading, prev = i ? legs[i - 1].heading : null;
    const turn = h !== null && sensors.heading !== null ? turnWords(norm180(h - sensors.heading))
      : h !== null && prev !== null ? turnWords(norm180(h - prev)) : i === 0 ? "partez" : "continuez";
    return `${turn.charAt(0).toUpperCase()}${turn.slice(1)}, puis avancez de ${unit(target(i))}${legs[i].to ? ` jusqu'à ${legs[i].to}` : ""}.`;
  }
  function render(text) {
    shell(`<div class="hm-guide"><p class="hm-now" aria-live="assertive">${esc(text)}</p>
        <p class="hm-left" id="hmLeft"></p>
        <button class="hm-tap" data-hm="next"><span>J'y suis</span></button>
        <button class="btn soft" data-hm="stop">${icon("x")} Arrêter le guidage</button></div>`);
    root.querySelector("[data-hm=next]").onclick = next;
    root.querySelector("[data-hm=stop]").onclick = () => { stopGuide(); say("Guidage arrêté."); onArrive(null); };
  }
  function announce() { const t = instruction(); render(t); say(t); lastSaid = Date.now(); }
  function next() {
    i++;
    startSteps = sensors.steps;
    if (i >= legs.length) {
      stopGuide();
      opts.buzz?.("arrive");
      beep(0, true); setTimeout(() => beep(0, true), 180);
      say(`Vous êtes arrivé : ${finalName}.`);
      shell(`<button class="hm-tap" data-hm="back"><span>Vous êtes arrivé : ${esc(finalName)}.<br>Touchez pour choisir une autre destination.</span></button>`);
      root.querySelector("[data-hm=back]").onclick = () => onArrive(finalName);
      return;
    }
    opts.buzz?.("tick");
    announce();
  }
  // boucle : distance restante, bips de direction, vibrations et rappels de correction
  function tick() {
    const left = target(i) - done();
    const el = root?.querySelector("#hmLeft");
    if (el) el.textContent = `Encore ${unit(Math.max(0, left))}`;
    if (!wheel && left <= 0) return next();             // pas comptés : le point est atteint
    const h = legs[i].heading;
    if (h === null || sensors.heading === null) return;
    const dev = norm180(h - sensors.heading), now = Date.now();
    const gap = Math.abs(dev) < 25 ? 300 : Math.abs(dev) < 60 ? 700 : 1300;
    if (now - lastBeep > gap) { beep(dev / 90, Math.abs(dev) < 25); lastBeep = now; }
    if (Math.abs(dev) > 35 && now - lastBuzz > 2500) { opts.buzz?.(Math.abs(dev) > 150 ? "uturn" : dev > 0 ? "right" : "left"); lastBuzz = now; }
    if (Math.abs(dev) > 60 && now - lastSaid > 6000) { say(`${turnWords(dev).charAt(0).toUpperCase()}${turnWords(dev).slice(1)}.`, false); lastSaid = now; }
  }
  guide = {onStep() { if (!wheel && target(i) - done() === 2) say("Encore 2 pas.", false); }};
  timer = setInterval(tick, 100);
  guide.stop = () => clearInterval(timer);
  say(`Trajet vers ${finalName} : ${legs.length} étape${legs.length > 1 ? "s" : ""}.`);
  setTimeout(announce, 1800);
}
function stopGuide() { guide?.stop?.(); guide = null; }

// Plan lu par l'IA -> étapes du moteur commun (cap réel = angle sur le plan + calage de la boussole)
function startGuide(plan, path, toId) {
  const legs = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const a = planAngle(path[k], path[k + 1]);
    legs.push({heading: plan.calibration === null ? null : (a + plan.calibration + 360) % 360, steps: null,
      meters: Math.hypot(path[k + 1].x - path[k].x, path[k + 1].y - path[k].y), to: path[k + 1].label || null});
  }
  runGuide(legs, path.at(-1).label, name => { if (name) store.set("va-home-here", toId); screenAi(); });
}

// ---- Trajets enregistrés en marchant (gratuit, sans photo, sans réseau) ------------------------------------
// On fait le trajet une fois : chaque pas est noté avec le cap de la boussole ; les pas de même direction
// forment une étape. Le retour est enregistré en même temps (étapes inversées, cap + 180°).
const ROUTES_STORE = "va-home-routes", HERE_STORE = "va-home-here-name";
const SUGGESTED = ["Entrée", "Salon", "Cuisine", "Chambre", "Salle de bain", "Toilettes", "Balcon", "Bureau"];
const routes = () => store.get(ROUTES_STORE, []);
const placesOf = list => [...new Set(list.flatMap(r => [r.from, r.to]))];
function segmentsOf(samples) {
  const segs = [];
  for (const h of samples) {
    const last = segs.at(-1);
    if (last && (h === null || last.heading === null || Math.abs(norm180(h - last.heading)) <= 30)) {
      if (h !== null && last.heading !== null) last.heading = (last.heading + norm180(h - last.heading) / (last.steps + 1) + 360) % 360;
      last.steps++;
    } else segs.push({heading: h, steps: 1});
  }
  // un pas isolé dans une autre direction = un écart de la main, pas un virage : on le rattache à ses voisins
  return segs.filter((g, k) => g.steps > 1 || segs.length === 1 || k === 0 || k === segs.length - 1).reduce((acc, g) => {
    const last = acc.at(-1);
    if (last && (g.heading === null || last.heading === null || Math.abs(norm180(g.heading - last.heading)) <= 30)) last.steps += g.steps;
    else acc.push({...g});
    return acc;
  }, []);
}
// Enchaînement de trajets enregistrés (A -> B puis B -> C) : recherche en largeur
function chainOf(from, to) {
  const list = routes(), prev = new Map([[from, null]]), queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const r of list.filter(x => x.from === cur && !prev.has(x.to))) { prev.set(r.to, r); queue.push(r.to); }
  }
  if (!prev.has(to) || from === to) return null;
  const chain = [];
  for (let k = to; prev.get(k); k = prev.get(k).from) chain.unshift(prev.get(k));
  return chain;
}
function screenStart() {
  const list = routes(), places = placesOf(list);
  const here = places.includes(store.get(HERE_STORE, "")) ? store.get(HERE_STORE, "") : places[0] || "";
  const reach = places.filter(p => p !== here && chainOf(here, p));
  shell(`${list.length ? `<label class="hm-field"><span>Je suis à</span><select id="hmHere">${places.map(p =>
        `<option ${p === here ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>
      <p class="hm-lead">Où voulez-vous aller ?</p>
      <div class="hm-rooms">${reach.map(p => `<button class="hm-big" data-to="${esc(p)}">${icon("navigation")}<span>${esc(p)}</span></button>`).join("")
        || `<p class="fine">${icon("info")} Aucun trajet enregistré ne part d'ici.</p>`}</div>`
    : `<p class="hm-lead">Enregistrez vos trajets en les faisant une fois, accompagné si besoin. L'appli retient vos pas et vos
        changements de direction, puis vous guide pour les refaire, à la voix, par vibrations et par sons.</p>`}
    <button class="hm-big" data-hm="record">${icon("footprints")}<span>Enregistrer un nouveau trajet</span></button>
    <div class="hm-row">${list.length ? `<button class="btn soft" data-hm="manage">${icon("route")} Mes trajets</button>` : ""}
      <button class="btn soft" data-hm="ai">${icon("camera")} Photo du plan (IA)</button></div>
    <p class="fine">${icon("info")} Gratuit, sans photo et sans internet. Le retour de chaque trajet est enregistré automatiquement.</p>`);
  root.querySelector("#hmHere")?.addEventListener("change", e => { store.set(HERE_STORE, e.target.value); screenStart(); });
  root.querySelectorAll("[data-to]").forEach(b => b.onclick = () => guideTo(here, b.dataset.to));
  root.querySelector("[data-hm=record]").onclick = screenRecordSetup;
  root.querySelector("[data-hm=manage]")?.addEventListener("click", screenManage);
  root.querySelector("[data-hm=ai]").onclick = screenAi;
  if (list.length) say(`Vous êtes à ${here}. ${reach.length ? "Choisissez votre destination." : "Aucun trajet enregistré ne part d'ici."}`, false);
}
function screenRecordSetup() {
  const known = placesOf(routes()), names = [...new Set([...known, ...SUGGESTED])];
  shell(`<p class="hm-lead">Nommez le départ et l'arrivée. Vous pouvez dicter avec le micro du clavier.</p>
    <datalist id="hmNames">${names.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <label class="hm-field"><span>Je pars de</span><input id="hmFrom" list="hmNames" value="${esc(store.get(HERE_STORE, known[0] || "Entrée"))}" autocomplete="off"></label>
    <label class="hm-field"><span>Je vais à</span><input id="hmTo" list="hmNames" autocomplete="off"></label>
    <button class="hm-big" data-hm="go">${icon("footprints")}<span>Démarrer l'enregistrement</span></button>
    <button class="btn soft" data-hm="back">${icon("arrow-left")} Retour</button>`);
  root.querySelector("[data-hm=back]").onclick = screenStart;
  root.querySelector("[data-hm=go]").onclick = async () => {
    const from = root.querySelector("#hmFrom").value.trim(), to = root.querySelector("#hmTo").value.trim();
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) { say("Indiquez un départ et une arrivée différents."); return; }
    if (!sensors) await startSensors();                 // autorisations demandées dans le geste de l'usager
    if (!audio) { try { audio = new AudioContext(); } catch { audio = null; } }
    record(from, to);
  };
}
function record(from, to) {
  const samples = [];
  shell(`<div class="hm-guide"><p class="hm-now" aria-live="polite">Enregistrement vers ${esc(to)}. Marchez normalement, téléphone
      tenu devant vous. Touchez l'écran en arrivant.</p><p class="hm-left" id="hmLeft">0 pas</p>
    <button class="hm-tap" data-hm="stop"><span>Je suis arrivé</span></button>
    <button class="btn soft" data-hm="cancel">${icon("x")} Annuler</button></div>`);
  say(`Enregistrement vers ${to}. Marchez normalement, téléphone tenu devant vous. Touchez l'écran en arrivant.`);
  guide = {onStep() {
    samples.push(sensors.heading);
    const el = root?.querySelector("#hmLeft");
    if (el) el.textContent = `${samples.length} pas`;
    beep(0, false);                                       // petit son à chaque pas : l'enregistrement fonctionne
  }};
  root.querySelector("[data-hm=cancel]").onclick = () => { guide = null; say("Enregistrement annulé."); screenStart(); };
  root.querySelector("[data-hm=stop]").onclick = () => {
    guide = null;
    if (samples.length < 2) {
      say("Je n'ai pas compté de pas. Tenez le téléphone en main en marchant, puis recommencez.");
      opts.toast?.("Aucun pas compté : tenez le téléphone en main en marchant. En fauteuil, ce test ne compte pas encore les déplacements.");
      return screenRecordSetup();
    }
    const segs = segmentsOf(samples);
    const back = segs.slice().reverse().map(g => ({heading: g.heading === null ? null : (g.heading + 180) % 360, steps: g.steps}));
    const list = routes().filter(r => !(r.from === from && r.to === to) && !(r.from === to && r.to === from));
    list.push({id: Date.now(), from, to, segments: segs}, {id: Date.now() + 1, from: to, to: from, segments: back});
    store.set(ROUTES_STORE, list);
    store.set(HERE_STORE, to);
    const turns = segs.length - 1;
    say(`Trajet enregistré : ${samples.length} pas, ${turns ? `${turns} virage${turns > 1 ? "s" : ""}` : "en ligne droite"}. Le retour vers ${from} est aussi enregistré.`);
    opts.buzz?.("arrive");
    screenStart();
  };
}
function guideTo(from, to) {
  const chain = chainOf(from, to);
  if (!chain) return;
  (async () => {
    if (!sensors) await startSensors();
    if (!audio) { try { audio = new AudioContext(); } catch { audio = null; } }
    audio?.resume?.();
    const legs = chain.flatMap(r => r.segments.map((g, k) => ({heading: g.heading, steps: g.steps, meters: null,
      to: k === r.segments.length - 1 ? r.to : null})));
    runGuide(legs, to, name => { if (name) store.set(HERE_STORE, name); screenStart(); });
  })();
}
function screenManage() {
  const list = routes();
  shell(`<p class="hm-lead">Mes trajets</p>
    <div class="hm-rooms">${list.map(r => `<div class="hm-route"><span class="grow">${esc(r.from)} → ${esc(r.to)}
      <small>${r.segments.reduce((n, g) => n + g.steps, 0)} pas, ${r.segments.length} étape${r.segments.length > 1 ? "s" : ""}</small></span>
      <button class="icon-btn" data-del="${r.id}" aria-label="Supprimer le trajet de ${esc(r.from)} à ${esc(r.to)}">${icon("trash-2")}</button></div>`).join("")}</div>
    <button class="btn soft" data-hm="back">${icon("arrow-left")} Retour</button>`);
  root.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    store.set(ROUTES_STORE, routes().filter(r => r.id !== +b.dataset.del));
    say("Trajet supprimé.", false);
    routes().length ? screenManage() : screenStart();
  });
  root.querySelector("[data-hm=back]").onclick = screenStart;
}

// ---- Ouverture / fermeture ------------------------------------------------------------------------
export function openHome(options = {}) {
  opts = options;
  screenStart();
}
export function closeHome() {
  stopGuide();
  sensors?.stop?.(); sensors = null;
  root?.remove(); root = null;
}
