// Guidage à l'intérieur d'un bâtiment (TEST) : plan de chaque étage en image, trajet tracé dessus.
//
// Un bâtiment (data/indoor.json) = des étages (une image de plan chacun) et un petit réseau de points :
// pièces, couloirs, ascenseur, escalier, reliés entre eux et d'un étage à l'autre. Le plan est affiché
// avec Leaflet en coordonnées « image » (L.CRS.Simple) : on peut l'agrandir et le déplacer du doigt.
// Profil sans marches : l'escalier est exclu, le trajet passe par l'ascenseur.
// Les plans fournis sont FICTIFS : ils montrent le principe, pas les vrais bâtiments.
import {icon} from "./icons.js";

const ELEVATOR_M = 15, STAIRS_M = 10;           // « coût » d'un changement d'étage, en mètres équivalents
const PLACE_KINDS = new Set(["room", "toilets", "entrance", "elevator"]);
let root = null, map = null, layer = null, overlays = null, state = null;
let buildingsCache = null;

const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

export async function loadIndoor() {
  if (!buildingsCache) {
    try { buildingsCache = (await fetch("data/indoor.json").then(r => r.json())).buildings || []; }
    catch { buildingsCache = []; }
  }
  return buildingsCache;
}
export const indoorOpen = () => !!root;

// ---- Trajet : Dijkstra sur le petit réseau du bâtiment -------------------------------------
function graphOf(b, avoidStairs) {
  const nodes = new Map(b.nodes.map(([id, floor, x, y, label, kind]) => [id, {id, floor, x, y, label, kind}]));
  const adj = new Map([...nodes.keys()].map(k => [k, []]));
  for (const [a, c, how] of b.edges) {
    if (how === "stairs" && avoidStairs) continue;
    const A = nodes.get(a), C = nodes.get(c);
    const cost = how === "elevator" ? ELEVATOR_M : how === "stairs" ? STAIRS_M : Math.hypot(A.x - C.x, A.y - C.y) * b.metersPerPixel;
    adj.get(a).push({to: c, cost, how}); adj.get(c).push({to: a, cost, how});
  }
  return {nodes, adj};
}
function shortestPath(g, from, to) {
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  while (true) {
    let cur = null;
    for (const [k, d] of dist) if (!done.has(k) && (cur === null || d < dist.get(cur))) cur = k;
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const e of g.adj.get(cur)) {
      const nd = dist.get(cur) + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, {from: cur, how: e.how}); }
    }
  }
  const ids = [to];
  while (prev.has(ids[0])) ids.unshift(prev.get(ids[0]).from);
  // « how » de chaque point = comment on y arrive depuis le précédent (couloir, ascenseur, escalier)
  return ids.map((id, i) => ({...g.nodes.get(id), how: i ? prev.get(id).how || "" : ""}));
}
// Consignes : marche dans le couloir, changement d'étage, arrivée
function stepsOf(b, path) {
  const steps = [], floorName = f => b.floors[f].name.toLowerCase();
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], c = path[i];
    if (a.floor === c.floor) { walked += Math.hypot(a.x - c.x, a.y - c.y) * b.metersPerPixel; continue; }
    if (walked >= 1) steps.push({floor: a.floor, ic: "footprints", text: `Suivez le couloir sur ${Math.round(walked)} m jusqu'à ${c.how === "elevator" ? "l'ascenseur" : "l'escalier"}`});
    steps.push({floor: c.floor, ic: c.how === "elevator" ? "elevator" : "stairs",
                text: `Prenez ${c.how === "elevator" ? "l'ascenseur" : "l'escalier"} jusqu'au ${floorName(c.floor)}`});
    walked = 0;
  }
  const end = path.at(-1);
  steps.push({floor: end.floor, ic: "flag", text: walked >= 1 ? `Continuez sur ${Math.round(walked)} m : vous arrivez à ${end.label}` : `Vous arrivez à ${end.label}`});
  return steps;
}

// ---- Affichage ---------------------------------------------------------------------------
function shell(title, sub) {
  closeIndoor();
  root = document.createElement("div");
  root.id = "indoor";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", title);
  root.innerHTML = `<header class="in-head"><button class="icon-btn" data-in="close" aria-label="Fermer le plan">${icon("arrow-left")}</button>
      <div class="grow"><b>${esc(title)}</b><small>${esc(sub)}</small></div></header>
    <div class="in-floors" role="tablist" aria-label="Étages"></div>
    <div class="in-map"></div>
    <section class="in-sheet"></section>`;
  document.body.append(root);
  root.addEventListener("click", e => { if (e.target.closest("[data-in=close]")) closeIndoor(); });
  map = L.map(root.querySelector(".in-map"), {crs: L.CRS.Simple, minZoom: -3, maxZoom: 2, zoomSnap: 0, attributionControl: false,
    zoomControl: false});
  overlays = L.layerGroup().addTo(map);
}
function showFloor(f) {
  const b = state.b, bounds = [[0, 0], [b.height, b.width]];
  state.floor = f;
  layer?.remove();
  layer = L.imageOverlay(b.floors[f].image, bounds).addTo(map);
  map.setMaxBounds(L.latLngBounds(bounds).pad(0.3));
  if (!state.fitted) { map.fitBounds(bounds, {padding: [4, 4]}); state.fitted = true; }
  root.querySelectorAll("[data-floor]").forEach(t => t.setAttribute("aria-selected", +t.dataset.floor === f));
  drawOverlays();
}
const ll = (b, p) => [b.height - p.y, p.x];             // pixel du plan -> coordonnées Leaflet
function drawOverlays() {
  const {b, floor, path} = state;
  overlays.clearLayers();
  for (const [id, f, x, y, label, kind] of b.nodes) {
    if (f !== floor || !label) continue;
    // ascenseur, escalier, toilettes : une pastille-icône (les noms se chevauchaient) ; le nom reste lu par le lecteur d'écran
    const chip = {elevator: "elevator", stairs: "stairs", toilets: "accessibility"}[kind];
    const html = chip ? `<div class="in-chip in-${kind}" role="img" aria-label="${esc(label)}">${icon(chip)}</div>`
      : `<div class="in-label in-${kind}">${esc(label)}</div>`;
    L.marker(ll(b, {x, y}), {icon: L.divIcon({className: "", html, iconSize: null}), interactive: false, keyboard: false}).addTo(overlays);
  }
  if (!path) return;
  const here = path.filter(p => p.floor === floor);
  if (here.length > 1) L.polyline(here.map(p => ll(b, p)), {color: "#00AECC", weight: 7, opacity: .95, lineCap: "round", lineJoin: "round"}).addTo(overlays);
  const start = path[0], end = path.at(-1);
  if (start.floor === floor) L.marker(ll(b, start), {icon: L.divIcon({className: "", html: `<div class="in-pin start"></div>`, iconSize: [22, 22], iconAnchor: [11, 11]})}).addTo(overlays);
  if (end.floor === floor) L.marker(ll(b, end), {icon: L.divIcon({className: "", html: `<div class="in-pin end">${icon("flag")}</div>`, iconSize: [30, 30], iconAnchor: [15, 15]})}).addTo(overlays);
}
function renderSheet() {
  const {b, from, to, path, steps, avoidStairs} = state;
  const places = b.nodes.filter(n => n[4] && PLACE_KINDS.has(n[5]));
  const opt = sel => places.map(([id, f, , , label]) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(label)} · ${esc(b.floors[f].short)}</option>`).join("");
  root.querySelector(".in-sheet").innerHTML = `
    <div class="in-pick"><label><small>Je suis à</small><select id="inFrom">${opt(from)}</select></label>
      <button class="icon-btn" data-in="swap" aria-label="Inverser départ et arrivée">${icon("arrow-up-down")}</button>
      <label><small>Je vais à</small><select id="inTo">${opt(to)}</select></label></div>
    ${path ? `<ol class="in-steps">${steps.map(s => `<li><button data-in="floor" data-f="${s.floor}">${icon(s.ic)}<span>${esc(s.text)}</span>
        <em>${esc(b.floors[s.floor].short)}</em></button></li>`).join("")}</ol>`
      : `<p class="fine">${icon("info")} Aucun trajet ${avoidStairs ? "sans marches " : ""}entre ces deux points.</p>`}
    <p class="fine">${icon("info")} Plan fictif de démonstration${avoidStairs ? " · trajet sans escalier (votre profil)" : ""}.</p>`;
  root.querySelector("#inFrom").onchange = e => { state.from = e.target.value; route(); };
  root.querySelector("#inTo").onchange = e => { state.to = e.target.value; route(); };
}
function route(announce = true) {
  const g = graphOf(state.b, state.avoidStairs);
  state.path = state.from === state.to ? null : shortestPath(g, state.from, state.to);
  state.steps = state.path ? stepsOf(state.b, state.path) : [];
  renderSheet();
  showFloor(state.path ? state.path[0].floor : state.floor);
  if (announce && state.path) state.say?.(state.steps.map(s => s.text).join(". ") + ".");
}

// Bâtiment avec son réseau : trajet de l'entrée vers une pièce
export function openIndoor(b, {avoidStairs = false, say} = {}) {
  shell(b.name, b.demo ? "Plan intérieur · démonstration" : "Plan intérieur");
  const first = b.nodes.find(n => n[5] === "entrance") || b.nodes[0];
  const dest = b.nodes.find(n => n[5] === "room" && n[1] > 0) || b.nodes.find(n => n[5] === "room");
  state = {b, floor: 0, from: first[0], to: dest[0], avoidStairs, say, fitted: false};
  root.querySelector(".in-floors").innerHTML = b.floors.map((f, i) =>
    `<button role="tab" data-floor="${i}" aria-selected="false">${icon("layers")} ${esc(f.name)}</button>`).join("");
  root.addEventListener("click", e => {
    const t = e.target.closest("[data-floor], [data-in=floor], [data-in=swap]");
    if (!t) return;
    if (t.dataset.in === "swap") { [state.from, state.to] = [state.to, state.from]; return route(); }
    showFloor(+(t.dataset.floor ?? t.dataset.f));
  });
  setTimeout(() => { map.invalidateSize(); route(false); }, 0);
}

export function closeIndoor() {
  map?.remove(); map = null; layer = null; overlays = null; state = null;
  root?.remove(); root = null;
}
