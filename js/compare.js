// Itinéraires à pied proposés côte à côte, comme Citymapper (« Rapide », « Rues principales ») :
// « Le plus accessible » pour le profil, et « Le plus rapide » quand il fait vraiment gagner du temps, avec ce
// que l'un évite et ce que l'autre fait gagner, en mots simples.
// Le moteur (js/routing.js, copie du serveur) n'est pas modifié : on part de sa réponse et on la présente.
import {arcCost} from "./routing.js";

// Mêmes revêtements que ROUGH_SURFACES de js/routing.js (cost.py)
const ROUGH = new Set(["sett", "cobblestone", "gravel", "unpaved", "grass", "sand", "dirt"]);
export const minutes = r => Math.ceil(r.duration_s / 60);

// Ce que contient un itinéraire : mètres sur la chaussée, traversées (et sans feu sonore), marches, pente, revêtement
export function routeFacts(route, net, profile) {
  let road = 0, crossings = 0, noSignal = 0, rough = 0, unknown = 0;
  for (const id of route.edge_ids || []) {
    const e = net?.edges[id];
    if (!e) continue;
    if (e.beside_sidewalk) road += e.length_m;
    if (e.is_crossing) { crossings++; if (e.sound_signal !== true) noSignal++; }
    if (ROUGH.has(e.surface)) rough += e.length_m;
    if (profile && arcCost(e, profile, true).reasons.includes("données incomplètes")) unknown += e.length_m;
  }
  return {road, crossings, noSignal, rough, unknown, steps: route.steps_count || 0, slope: route.max_slope_pct || 0};
}

const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const pct = x => `${x.toFixed(1).replace(".", ",")} %`;
const listFr = items => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} et ${items.at(-1)}`;
// Ce que l'itinéraire `more` a de plus que `less`, pour ce profil (le plus important d'abord)
export function extras(more, less, profile) {
  const out = [];
  if (more.steps > less.steps) out.push(plural(more.steps - less.steps, "marche"));
  if (profile.prefers_sound_signals && more.noSignal > less.noSignal)
    out.push(plural(more.noSignal - less.noSignal, "traversée sans feu sonore", "traversées sans feu sonore"));
  else if (more.crossings > less.crossings) out.push(plural(more.crossings - less.crossings, "traversée"));
  if (more.road - less.road >= 10) out.push(`${Math.round((more.road - less.road) / 5) * 5} m sur la chaussée`);
  if (more.slope - less.slope >= 1) out.push(`une pente à ${pct(more.slope)} (au lieu de ${pct(less.slope)})`);
  if (profile.avoid_rough_surfaces && more.rough - less.rough >= 10) out.push(`${Math.round((more.rough - less.rough) / 5) * 5} m de revêtement irrégulier`);
  if (!out.length && more.unknown - less.unknown >= 30) out.push("des passages mal connus (largeur, pente, bordures)");
  return out;
}

// Réponse du moteur -> itinéraires à afficher, au plus trois : « Le plus accessible », « Le plus rapide » (s'il
// fait gagner au moins une minute) et le plus court sans adaptation quand il n'est PAS praticable (il montre
// pourquoi on ne passe pas par là). Ajoute à chacun : kind ("accessible", "fastest", "unadapted"), short (nom
// court pour la carte), note (la différence expliquée) et alsoFastest. Tous les temps sont comptés à la vitesse
// du profil (le moteur compte le trajet « sans adaptation » à la vitesse d'un piéton : pas comparable).
const MAX_ITEMS = 2;                                       // explication courte : les 2 différences les plus importantes
export function walkingChoices(routes, net, profile) {
  if (!routes.length) return [];
  const atSpeed = r => ({...r, duration_s: Math.round(r.length_m / profile.speed_m_s)});
  const ids = r => (r.edge_ids || []).join(",");
  const best = {...routes[0], kind: "accessible", short: "Accessible", note: "", alsoFastest: false};
  const out = [best];
  const raw = routes.find(r => r.label === "Le plus court, sans adaptation");
  // candidats praticables avec ce profil ; le plus rapide des deux, s'il fait gagner au moins une minute affichée
  // (sinon deux cartes à la même durée embrouillent : le plus accessible est alors aussi le plus rapide)
  const cands = [routes.find(r => r.label === "Le plus court accessible"), raw?.accessible ? raw : null]
    .filter(r => r && ids(r) !== ids(best)).map(atSpeed).sort((a, b) => a.duration_s - b.duration_s);
  if (cands.length && minutes(cands[0]) < minutes(best)) {
    const fast = {...cands[0], label: "Le plus rapide", kind: "fastest", short: "Rapide", note: "", alsoFastest: false};
    const d = minutes(best) - minutes(fast);
    const items = extras(routeFacts(fast, net, profile), routeFacts(best, net, profile), profile).slice(0, MAX_ITEMS);
    best.note = items.length ? `${d} min de plus pour éviter ${listFr(items)}.` : `${d} min de plus, mais moins d'efforts pour votre profil.`;
    fast.note = items.length ? `${d} min de moins, mais ${listFr(items)} en plus.` : `${d} min de moins, un peu plus fatigant pour votre profil.`;
    out.push(fast);
  } else best.alsoFastest = true;
  if (raw && !raw.accessible) out.push({...atSpeed(raw), kind: "unadapted", short: "Sans adaptation", note: "", alsoFastest: false});
  return out;
}

// Où poser l'étiquette d'un itinéraire sur la carte : là où il s'écarte le plus des autres (comme Citymapper),
// entre 20 % et 80 % du trajet. Itinéraires confondus partout : étiquettes décalées le long du trajet.
const local = (lat0, p) => [(p.lon - lat0.lon) * Math.cos(lat0.lat * Math.PI / 180) * 111320, (p.lat - lat0.lat) * 111320];
function distToLine(p, line, o) {
  const [x, y] = local(o, p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = local(o, line[i - 1]), [bx, by] = local(o, line[i]);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}
export function labelPoints(geometries) {
  const o = geometries[0]?.[0];
  return geometries.map((g, i) => {
    const others = geometries.filter((_, j) => j !== i), n = g.length;
    if (n < 2) return g[0];
    let best = null;
    for (let k = Math.floor(n * 0.2); k <= Math.ceil(n * 0.8) && k < n; k++) {
      const d = others.length ? Math.min(...others.map(h => distToLine(g[k], h, o))) : 0;
      if (!best || d > best.d + 1) best = {d, p: g[k]};
    }
    if (!others.length || best.d >= 25) return best.p;
    // confondus : 35 %, 65 %, 50 %… du trajet, pour que les étiquettes ne se recouvrent pas
    const f = [0.35, 0.65, 0.5, 0.8][i % 4];
    return g[Math.min(n - 1, Math.round((n - 1) * f))];
  });
}
