// « Balises » (TEST) : se repérer à l'intérieur, en toute autonomie, avec des autocollants imprimés.
//
// On imprime des balises (marqueurs ArUco, bibliothèque js-aruco2, dans vendor/) et on en colle une sur chaque
// porte. Installation, seul et à la voix : on scanne la balise, on dit le nom de l'endroit. Ensuite on choisit
// où aller et on balaie la pièce avec le téléphone : la caméra repère la balise de loin, l'appli dit où elle
// est (« Cuisine, 3 mètres, légèrement à droite ») et guide jusqu'à elle par un son qui vient du bon côté.
// Aucun pas à compter, pas d'internet, rien n'est envoyé : tout est calculé sur le téléphone.
import {icon} from "./icons.js";

const STORE = "va-beacons";                   // {id de balise: nom de l'endroit}
const MARKER_M = 0.135;                       // côté du carré noir imprimé (page d'impression à 100 %) : 1 balise par A4
const DICTIONARY = "ARUCO_4X4_1000";          // 4 x 4 cases : lisible de plus loin que les modèles 6 x 6 (essais : ~3 m)
const ARRIVED_M = 0.9;                        // « vous êtes devant » en dessous de cette distance
const SUGGESTED = ["Entrée", "Salon", "Cuisine", "Chambre", "Salle de bain", "Toilettes", "Bureau", "Ascenseur", "Accueil", "Sortie"];
let root = null, opts = {}, cam = null, audio = null, lib = null;

const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
};
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const say = (t, urgent = true) => opts.say?.(t, urgent);
const names = () => store.get(STORE, {});
export const beaconsOpen = () => !!root;

// Bibliothèque de détection, chargée seulement quand on ouvre les balises
function loadLib() {
  if (!lib) lib = ["vendor/js-aruco2/cv.js", "vendor/js-aruco2/aruco.js", "vendor/js-aruco2/dictionaries/aruco_4x4_1000.js"].reduce((p, src) => p.then(() => new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error(src));
    document.head.append(s);
  })), Promise.resolve()).catch(e => { lib = null; throw e; });
  return lib;
}

// ---- Sons -----------------------------------------------------------------------------------------
function beep(pan, freq, ms = 70, vol = 0.25) {
  if (!audio) return;
  const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain(), p = audio.createStereoPanner();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  p.pan.value = Math.max(-1, Math.min(1, pan));
  o.connect(g).connect(p).connect(audio.destination);
  o.start(t); o.stop(t + ms / 1000 + 0.02);
}

// ---- Caméra et détection ---------------------------------------------------------------------------
// Chaque balise vue : son id, sa direction (degrés, + = à droite) et sa distance estimée (mètres)
async function startCamera(onSeen) {
  await loadLib();
  const video = root.querySelector("video");
  const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}, width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
  video.srcObject = stream;
  await video.play().catch(() => {});
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", {willReadFrequently: true});
  const detector = new window.AR.Detector({dictionaryName: DICTIONARY});
  let timer = 0, busy = false;
  const loop = () => {
    if (busy || !video.videoWidth) return;
    busy = true;
    // image analysée en 1280 px sur le grand côté : une balise doit y faire au moins ~45 px pour être lue (essais),
    // soit environ 3 m pour un carré de 13,5 cm ; en dessous, la réduire empêchait la lecture
    const k = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight)), w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const markers = detector.detect(ctx.getImageData(0, 0, w, h));
    // champ de la caméra arrière : environ 65° sur le grand côté de l'image
    const f = (Math.max(w, h) / 2) / Math.tan(32.5 * Math.PI / 180);
    onSeen(markers.map(m => {
      const xs = m.corners.map(c => c.x), ys = m.corners.map(c => c.y);
      const cx = xs.reduce((a, b) => a + b) / 4;
      const side = (Math.hypot(xs[0] - xs[1], ys[0] - ys[1]) + Math.hypot(xs[1] - xs[2], ys[1] - ys[2]) +
                    Math.hypot(xs[2] - xs[3], ys[2] - ys[3]) + Math.hypot(xs[3] - xs[0], ys[3] - ys[0])) / 4;
      return {id: m.id, angle: Math.atan((cx - w / 2) / f) * 180 / Math.PI, dist: MARKER_M * f / Math.max(side, 1)};
    }));
    busy = false;
  };
  timer = setInterval(loop, 180);
  cam = {stop() { clearInterval(timer); stream.getTracks().forEach(t => t.stop()); }};
}
function stopCamera() { cam?.stop(); cam = null; }
const sideWords = a => Math.abs(a) < 8 ? "droit devant" : `${Math.abs(a) < 20 ? "légèrement " : ""}à ${a > 0 ? "droite" : "gauche"}`;
const meters = d => d < 1 ? "moins d'un mètre" : `${Math.round(d)} mètre${Math.round(d) > 1 ? "s" : ""}`;

// ---- Écrans ---------------------------------------------------------------------------------------
function shell(html, withCamera = false) {
  stopCamera();
  if (!root) {
    root = document.createElement("div");
    root.id = "home";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Balises");
    document.body.append(root);
  }
  root.innerHTML = `<header class="hm-head"><button class="icon-btn" data-bc="close" aria-label="Fermer">${icon("arrow-left")}</button>
    <b class="grow">Balises</b></header>
    ${withCamera ? `<video class="bc-video" playsinline muted autoplay aria-hidden="true"></video>` : ""}<div class="hm-body">${html}</div>`;
  root.querySelector("[data-bc=close]").onclick = closeBeacons;
}
function screenHome() {
  const n = names(), ids = Object.keys(n);
  shell(`${ids.length ? `<p class="hm-lead">Où voulez-vous aller ?</p>
      <div class="hm-rooms">${ids.map(id => `<button class="hm-big" data-go="${id}">${icon("navigation")}<span>${esc(n[id])}</span></button>`).join("")}</div>
      <button class="hm-big bc-explore" data-bc="explore">${icon("scan-eye")}<span>Qu'y a-t-il autour de moi ?</span></button>`
    : `<p class="hm-lead">Collez une balise sur chaque porte, scannez-la et dites le nom de l'endroit. Ensuite, choisissez où aller :
        le téléphone repère la balise et vous guide jusqu'à elle, à la voix et par le son.</p>`}
    <button class="hm-big ${ids.length ? "bc-quiet" : ""}" data-bc="add">${icon("plus")}<span>Ajouter une balise</span></button>
    <div class="hm-row"><button class="btn soft" data-bc="print">${icon("printer")} Imprimer des balises</button>
      ${ids.length ? `<button class="btn soft" data-bc="manage">${icon("tags")} Mes balises</button>` : ""}</div>
    <p class="fine">${icon("info")} Gratuit, sans internet ; l'image de la caméra reste sur le téléphone. Imprimez à 100 % (taille réelle).</p>`);
  root.querySelectorAll("[data-go]").forEach(b => b.onclick = () => screenFind(b.dataset.go));
  root.querySelector("[data-bc=explore]")?.addEventListener("click", () => screenFind(null));
  root.querySelector("[data-bc=add]").onclick = screenAdd;
  root.querySelector("[data-bc=print]").onclick = printSheet;
  root.querySelector("[data-bc=manage]")?.addEventListener("click", screenManage);
  say(ids.length ? `${ids.length} balise${ids.length > 1 ? "s" : ""}. Où voulez-vous aller ?` : "Aucune balise. Touchez Ajouter une balise.", false);
}

// Installation, seul : on pointe la balise, l'appli la reconnaît et demande son nom
function screenAdd() {
  ensureAudio();
  shell(`<p class="hm-now" aria-live="assertive" id="bcMsg">Pointez le téléphone vers la nouvelle balise, à un ou deux mètres.</p>
    <button class="btn soft" data-bc="back">${icon("arrow-left")} Retour</button>`, true);
  root.querySelector("[data-bc=back]").onclick = screenHome;
  say("Pointez le téléphone vers la nouvelle balise, à un ou deux mètres.");
  let lastKnown = 0, lastTick = 0;
  startCamera(seen => {
    const n = names(), now = Date.now();
    if (!seen.length) { if (now - lastTick > 1500) { beep(0, 440, 40, 0.08); lastTick = now; } return; }
    const fresh = seen.find(s => !(s.id in n));
    if (fresh) { opts.buzz?.("tick"); beep(0, 1046, 120); return askName(fresh.id); }
    if (now - lastKnown > 4000) { lastKnown = now; say(`Cette balise est déjà ${n[seen[0].id]}.`, false); }
  }).catch(cameraError);
}
function askName(id) {
  const list = SUGGESTED.filter(s => !Object.values(names()).includes(s));
  shell(`<p class="hm-lead" aria-live="assertive">Balise trouvée. Comment s'appelle cet endroit ?</p>
    <datalist id="bcNames">${list.map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <label class="hm-field"><span>Nom de l'endroit (vous pouvez dicter)</span><input id="bcName" list="bcNames" autocomplete="off"></label>
    <button class="hm-big" data-bc="save">${icon("check")}<span>Enregistrer</span></button>
    <div class="hm-rooms bc-sugg">${list.slice(0, 6).map(s => `<button class="btn soft" data-name="${esc(s)}">${esc(s)}</button>`).join("")}</div>
    <button class="btn soft" data-bc="back">${icon("arrow-left")} Annuler</button>`);
  say("Balise trouvée. Comment s'appelle cet endroit ?");
  const input = root.querySelector("#bcName");
  input.focus();
  const save = name => {
    name = (name || "").trim();
    if (!name) return say("Dites ou tapez un nom.");
    store.set(STORE, {...names(), [id]: name});
    opts.buzz?.("arrive");
    say(`Balise ${name} enregistrée.`);
    screenHome();
  };
  root.querySelector("[data-bc=save]").onclick = () => save(input.value);
  root.querySelectorAll("[data-name]").forEach(b => b.onclick = () => save(b.dataset.name));
  root.querySelector("[data-bc=back]").onclick = screenHome;
}

// Recherche guidée (targetId) ou exploration (null : annonce tout ce qui est vu)
function screenFind(targetId) {
  ensureAudio();
  const n = names(), target = targetId === null ? null : n[targetId];
  shell(`<p class="hm-now" aria-live="assertive" id="bcMsg">${target ? `Recherche de ${esc(target)}. Tournez lentement sur vous-même.`
      : "Tournez lentement sur vous-même : je vous dis ce que je vois."}</p>
    <p class="hm-left" id="bcInfo"></p>
    <button class="btn soft" data-bc="back">${icon("x")} Arrêter</button>`, true);
  root.querySelector("[data-bc=back]").onclick = () => { say("Arrêté.", false); screenHome(); };
  say(target ? `Recherche de ${target}. Tenez le téléphone devant vous et tournez lentement sur vous-même.`
    : "Tenez le téléphone devant vous et tournez lentement sur vous-même : je vous dis ce que je vois.");
  const msg = t => { const el = root?.querySelector("#bcMsg"); if (el) el.textContent = t; };
  const info = t => { const el = root?.querySelector("#bcInfo"); if (el) el.textContent = t; };
  let lastSeen = 0, lastSay = 0, lastBeep = 0, lastBuzz = 0, lastHint = Date.now(), smooth = null;
  const announced = {};
  startCamera(seen => {
    const now = Date.now();
    if (target) {
      const m = seen.find(s => String(s.id) === targetId);
      if (!m) {
        smooth = null;
        if (now - lastBeep > 900) { beep(0, 330, 40, 0.06); lastBeep = now; }           // tic discret : on cherche
        if (now - Math.max(lastSeen, lastHint) > 6000) { lastHint = now; say(`Tournez lentement pour chercher ${target}.`, false); }
        const other = seen.find(s => names()[s.id]);
        if (other && now - (announced[other.id] || 0) > 8000) { announced[other.id] = now; say(`Je vois ${names()[other.id]}, ${sideWords(other.angle)}.`, false); }
        return;
      }
      lastSeen = now;
      // distance lissée : l'estimation saute un peu d'une image à l'autre
      smooth = smooth === null ? m.dist : smooth * 0.7 + m.dist * 0.3;
      const t = `${target} : ${meters(smooth)}, ${sideWords(m.angle)}`;
      msg(t); info(`Visée : ${m.angle > 0 ? "+" : ""}${Math.round(m.angle)}°`);
      if (smooth < ARRIVED_M) {
        stopCamera();
        opts.buzz?.("arrive"); beep(0, 1046, 160); setTimeout(() => beep(0, 1318, 220), 180);
        say(`Vous êtes devant ${target}.`);
        shell(`<button class="hm-tap" data-bc="done"><span>Vous êtes devant ${esc(target)}.<br>Touchez pour choisir une autre destination.</span></button>`);
        root.querySelector("[data-bc=done]").onclick = screenHome;
        return;
      }
      // son : vient du côté de la balise ; plus aigu quand elle est droit devant ; plus rapide quand on s'approche
      const gap = Math.max(120, Math.min(900, smooth * 220));
      if (now - lastBeep > gap) { beep(m.angle / 30, Math.abs(m.angle) < 8 ? 1046 : 740); lastBeep = now; }
      if (Math.abs(m.angle) > 15 && now - lastBuzz > 2000) { opts.buzz?.(m.angle > 0 ? "right" : "left"); lastBuzz = now; }
      if (now - lastSay > 4000) { lastSay = now; say(t + ".", false); }
    } else {
      // exploration : chaque balise vue est annoncée, au plus toutes les 6 secondes
      const known = seen.filter(s => names()[s.id]);
      info(known.map(s => `${names()[s.id]} : ${meters(s.dist)}, ${sideWords(s.angle)}`).join(" · "));
      for (const s of known) if (now - (announced[s.id] || 0) > 6000) {
        announced[s.id] = now;
        beep(s.angle / 30, 880);
        say(`${names()[s.id]}, ${meters(s.dist)}, ${sideWords(s.angle)}.`, false);
      }
    }
  }).catch(cameraError);
}
function screenManage() {
  const n = names();
  shell(`<p class="hm-lead">Mes balises</p>
    <div class="hm-rooms">${Object.entries(n).map(([id, name]) => `<div class="hm-route"><span class="grow">${esc(name)}<small>Balise n° ${id}</small></span>
      <button class="icon-btn" data-del="${id}" aria-label="Supprimer la balise ${esc(name)}">${icon("trash-2")}</button></div>`).join("")}</div>
    <button class="btn soft" data-bc="back">${icon("arrow-left")} Retour</button>`);
  root.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    const all = names(); delete all[b.dataset.del]; store.set(STORE, all);
    say("Balise supprimée.", false);
    Object.keys(all).length ? screenManage() : screenHome();
  });
  root.querySelector("[data-bc=back]").onclick = screenHome;
}
// Balises à imprimer, affichées DANS l'appli (une nouvelle page était bloquée par l'appli installée sur iPhone) :
// chaque balise en grand, avec « Imprimer » (impression de cet écran seulement, à taille réelle) et
// « Enregistrer l'image » (Photos, Fichiers, AirDrop, e-mail…, pour imprimer ailleurs)
async function printSheet() {
  try { await loadLib(); } catch { return say("Impossible de préparer les balises : vérifiez la connexion, puis réessayez."); }
  const dict = new window.AR.Dictionary(DICTIONARY), used = Object.keys(names()).map(Number);
  const ids = [];
  for (let id = 0; ids.length < 6 && id < dict.codeList.length; id++) if (!used.includes(id)) ids.push(id);
  shell(`<p class="hm-lead">Voici vos balises. Imprimez-les à taille réelle (100 %), une par feuille, puis collez-en une sur chaque porte.</p>
    <div class="hm-row"><button class="hm-big" data-bc="doprint">${icon("printer")}<span>Imprimer</span></button></div>
    <div class="bc-sheet">${ids.map(id => `<figure class="bc-mark">${dict.generateSVG(id)}
      <figcaption>Balise Vision AR n° ${id}</figcaption>
      <button class="btn soft bc-save" data-save="${id}">${icon("share-2")} Enregistrer l'image</button></figure>`).join("")}</div>
    <button class="btn soft" data-bc="back">${icon("arrow-left")} Retour</button>`);
  root.querySelector("[data-bc=back]").onclick = screenHome;
  root.querySelector("[data-bc=doprint]").onclick = () => {
    document.documentElement.classList.add("bc-printing");
    window.print();
    setTimeout(() => document.documentElement.classList.remove("bc-printing"), 1000);
  };
  root.querySelectorAll("[data-save]").forEach(b => b.onclick = () => saveMarker(dict, +b.dataset.save));
  say(`${ids.length} balises prêtes à imprimer. Touchez Imprimer, ou enregistrez une image pour l'imprimer ailleurs.`, false);
}
// Image PNG de la balise (2 000 px, nette à l'impression), partagée ou téléchargée
async function saveMarker(dict, id) {
  const svg = dict.generateSVG(id), img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = 2000; c.height = 2240;
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 0, 0, 2000, 2000);
  x.fillStyle = "#000"; x.font = "bold 80px sans-serif"; x.textAlign = "center";
  x.fillText(`Balise Vision AR n° ${id}`, 1000, 2160);
  const blob = await new Promise(ok => c.toBlob(ok, "image/png"));
  const file = new File([blob], `balise-vision-ar-${id}.png`, {type: "image/png"});
  if (navigator.canShare?.({files: [file]})) {
    try { await navigator.share({files: [file], title: `Balise Vision AR n° ${id}`}); return; } catch { /* partage annulé */ return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function cameraError(e) {
  const msg = e?.name === "NotAllowedError" ? "L'accès à la caméra est refusé : autorisez-le dans les réglages du téléphone."
    : "La caméra ne s'ouvre pas sur cet appareil.";
  say(msg);
  shell(`<p class="hm-lead" role="alert">${esc(msg)}</p><button class="hm-big" data-bc="back">${icon("arrow-left")}<span>Retour</span></button>`);
  root.querySelector("[data-bc=back]").onclick = screenHome;
}
function ensureAudio() {
  if (!audio) { try { audio = new AudioContext(); } catch { audio = null; } }
  audio?.resume?.();
}

export function openBeacons(options = {}) { opts = options; screenHome(); }
export function closeBeacons() { stopCamera(); root?.remove(); root = null; }
