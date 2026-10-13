// Moteur d'itinéraire Vision AR exécuté dans le navigateur.
//
// Traduction fidèle du serveur Python (server/app) : cost.py, engine.py,
// instructions.py et la route POST /route de main.py. La réponse a le même
// format que l'API. Toute modification du calcul se fait D'ABORD dans le
// Python ; le test server/tests/test_web_parity.py compare les deux moteurs.

// ---- Profils (profiles.py) ------------------------------------------------
const DEFAULT_PROFILE = {
  mobility: "pedestrian", max_slope_pct: null, max_cross_slope_pct: null, steps_allowed: true,
  min_width_m: null, needs_lowered_kerb: false, prefers_sound_signals: false,
  avoid_rough_surfaces: false, speed_m_s: 1.2,
};
export const PRESETS = {
  manual_wheelchair: {mobility: "manual_wheelchair", max_slope_pct: 5, max_cross_slope_pct: 2, steps_allowed: false,
    min_width_m: 0.9, needs_lowered_kerb: true, avoid_rough_surfaces: true, speed_m_s: 0.9},
  electric_wheelchair: {mobility: "electric_wheelchair", max_slope_pct: 8, max_cross_slope_pct: 3, steps_allowed: false,
    min_width_m: 0.9, needs_lowered_kerb: true, speed_m_s: 1.4},
  cane_or_walker: {mobility: "cane_or_walker", max_slope_pct: 8, max_cross_slope_pct: 4, steps_allowed: true,
    avoid_rough_surfaces: true, speed_m_s: 0.8},
  low_vision: {mobility: "low_vision", steps_allowed: true, prefers_sound_signals: true, speed_m_s: 1.0},
  hard_of_hearing: {mobility: "hard_of_hearing", speed_m_s: 1.2},
  pedestrian: {mobility: "pedestrian", speed_m_s: 1.2},
};
export function preset(mobility) {
  return {...DEFAULT_PROFILE, ...PRESETS[mobility]};
}
/** Préréglage + surcharges de l'usager (ProfileIn.resolve). */
export function resolveProfile(input = {}) {
  const p = preset(input.mobility || "pedestrian");
  for (const k of ["max_slope_pct", "max_cross_slope_pct", "steps_allowed", "min_width_m",
                   "prefers_sound_signals", "needs_lowered_kerb"]) {
    if (input[k] !== undefined && input[k] !== null) p[k] = input[k];
  }
  return p;
}
const isWheelchair = p => p.mobility === "manual_wheelchair" || p.mobility === "electric_wheelchair";

// ---- Arrondis identiques à Python ------------------------------------------------
// round() de Python arrondit les égalités exactes « au pair », toFixed « au-dessus ».
export function pyRound(x, d = 0) {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0, a = Math.abs(x);
  const exact = a.toFixed(Math.min(100, d + 60));          // développement décimal exact
  const [int, frac = ""] = exact.split(".");
  const kept = frac.slice(0, d), rest = frac.slice(d);
  let r;
  if (/^50*$/.test(rest)) {                                 // égalité exacte : au pair
    const lastDigit = Number((d === 0 ? int : kept).slice(-1));
    const truncated = Number(d === 0 ? int : `${int}.${kept}`);
    r = lastDigit % 2 === 0 ? truncated : Number((truncated + 10 ** -d).toFixed(d));
  } else {
    r = Number(a.toFixed(d));
  }
  return neg ? -r : r;
}
const fixed = (x, d) => pyRound(x, d).toFixed(d);

// sum() de Python (3.12+) : addition compensée de Neumaier, plus précise qu'une
// boucle « s += x ». Même algorithme que CPython, pour les mêmes arrondis.
export function pySum(values) {
  let s = 0.0, c = 0.0;
  for (const x of values) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return c !== 0 && Number.isFinite(c) ? s + c : s;
}

// ---- Géométrie (model.py) -------------------------------------------------------
const EARTH_RADIUS_M = 6371000.0;
const rad = deg => deg * Math.PI / 180;
export function haversineM(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(x, y) * 180 / Math.PI + 360.0) % 360.0;
}

// ---- Réseau (format de scripts/export_web_network.py) ----------------------------
export function loadNetwork(data) {
  const nodes = data.nodes.map(([lat, lon], id) => ({id, lat, lon}));
  const edges = data.edges.map((e, id) => ({
    id, source: e[0], target: e[1], length_m: e[2], slope_pct: e[3], cross_slope_pct: e[4], width_m: e[5],
    has_step: (e[6] & 1) !== 0, is_crossing: (e[6] & 2) !== 0, oneway: (e[6] & 4) !== 0,
    surface: data.surfaces[e[7]], kerb_lowered: e[8] === -1 ? null : e[8] === 1,
    sound_signal: e[9] === -1 ? null : e[9] === 1, name: data.names[e[10]], kind: data.kinds[e[11]],
    slope_source: data.slope_sources[e[12]] || null, shape: data.shapes[id],
  }));
  const adj = nodes.map(() => []);
  for (const e of edges) {
    adj[e.source].push([e, true]);
    adj[e.target].push([e, false]);
  }
  return {nodes, edges, adj, zone: data.zone, pois: data.pois, places: data.places || []};
}

// ---- Coût d'effort (cost.py) -----------------------------------------------------
const UPHILL_FACTOR = 0.12, DOWNHILL_FACTOR = 0.04, CROSS_SLOPE_FACTOR = 0.10;
const ROUGH_SURFACE_FACTOR = 0.5, UNKNOWN_DATA_FACTOR = 0.25;
const STEP_PENALTY_M = 40.0, NO_SOUND_SIGNAL_PENALTY_M = 30.0, OBSTACLE_PENALTY_M = 80.0;
const ROUGH_SURFACES = new Set(["sett", "cobblestone", "gravel", "unpaved", "grass", "sand", "dirt"]);

export function arcCost(edge, profile, forward = true, obstacleBlocking = false, obstacleNearby = false) {
  if (edge.oneway && !forward) return {cost: null, reasons: ["sens interdit"]};
  const reasons = [];
  let slope = edge.slope_pct;
  if (slope !== null && !forward) slope = -slope;

  if (edge.has_step && !profile.steps_allowed) return {cost: null, reasons: ["marche"]};
  if (profile.max_slope_pct !== null && slope !== null && Math.abs(slope) > profile.max_slope_pct)
    return {cost: null, reasons: [`pente ${fixed(Math.abs(slope), 1)} %`]};
  if (profile.max_cross_slope_pct !== null && edge.cross_slope_pct !== null && edge.cross_slope_pct > profile.max_cross_slope_pct)
    return {cost: null, reasons: [`dévers ${fixed(edge.cross_slope_pct, 1)} %`]};
  if (profile.min_width_m !== null && edge.width_m !== null && edge.width_m < profile.min_width_m)
    return {cost: null, reasons: [`passage de ${fixed(edge.width_m, 2)} m`]};
  if (edge.is_crossing && profile.needs_lowered_kerb && edge.kerb_lowered === false)
    return {cost: null, reasons: ["trottoir non abaissé"]};
  if (obstacleBlocking && isWheelchair(profile)) return {cost: null, reasons: ["obstacle signalé"]};

  let factor = 1.0;
  if (slope !== null) factor += UPHILL_FACTOR * Math.max(slope, 0.0) + DOWNHILL_FACTOR * Math.max(-slope, 0.0);
  if (edge.cross_slope_pct !== null) factor += CROSS_SLOPE_FACTOR * edge.cross_slope_pct;
  if (profile.avoid_rough_surfaces && ROUGH_SURFACES.has(edge.surface)) {
    factor += ROUGH_SURFACE_FACTOR;
    reasons.push("revêtement irrégulier");
  }
  let unknown = slope === null || (isWheelchair(profile) && (edge.width_m === null || edge.cross_slope_pct === null));
  if (edge.is_crossing && profile.needs_lowered_kerb && edge.kerb_lowered === null) unknown = true;
  if (unknown) {
    factor += UNKNOWN_DATA_FACTOR;
    reasons.push("données incomplètes");
  }
  let cost = edge.length_m * factor;
  if (edge.has_step) { cost += STEP_PENALTY_M; reasons.push("marche"); }
  if (profile.prefers_sound_signals && edge.is_crossing && edge.sound_signal !== true) {
    cost += NO_SOUND_SIGNAL_PENALTY_M;
    reasons.push("traversée sans feu sonore");
  }
  if (obstacleBlocking || obstacleNearby) { cost += OBSTACLE_PENALTY_M; reasons.push("obstacle signalé"); }
  return {cost, reasons};
}

// ---- Moteur (engine.py) ------------------------------------------------------------
export const SNAP_MAX_DISTANCE_M = 150.0;
const OBSTACLE_RADIUS_M = 15.0;

export class RoutingError extends Error {}

const legFrom = leg => leg.forward ? leg.edge.source : leg.edge.target;
const legTo = leg => leg.forward ? leg.edge.target : leg.edge.source;
const legSlope = leg => leg.edge.slope_pct === null ? null : (leg.forward ? leg.edge.slope_pct : -leg.edge.slope_pct);
const legShape = leg => leg.forward ? leg.edge.shape : [...leg.edge.shape].reverse();

export function nearestNode(net, lat, lon) {
  let best = null, bestD = Infinity;
  for (const n of net.nodes) {
    const d = haversineM(lat, lon, n.lat, n.lon);
    if (d < bestD) { best = n.id; bestD = d; }
  }
  if (best === null || bestD > SNAP_MAX_DISTANCE_M)
    throw new RoutingError("Ce point est trop loin d'un cheminement piéton connu.");
  return best;
}

function pointSegmentDistanceM(lat, lon, aLat, aLon, bLat, bLon) {
  const k = Math.cos(rad(lat));
  const ax = (aLon - lon) * k, ay = aLat - lat, bx = (bLon - lon) * k, by = bLat - lat;
  const dx = bx - ax, dy = by - ay, seg2 = dx * dx + dy * dy;
  const t = seg2 === 0 ? 0.0 : Math.max(0.0, Math.min(1.0, -(ax * dx + ay * dy) / seg2));
  return Math.hypot(ax + t * dx, ay + t * dy) * (Math.PI / 180.0) * 6371000.0;
}

function obstaclesOn(net, edge, reports) {
  const shape = edge.shape.length >= 2 ? edge.shape
    : [[net.nodes[edge.source].lat, net.nodes[edge.source].lon], [net.nodes[edge.target].lat, net.nodes[edge.target].lon]];
  let blocking = false, nearby = false;
  for (const r of reports) {
    let d = Infinity;
    for (let i = 1; i < shape.length; i++)
      d = Math.min(d, pointSegmentDistanceM(r.lat, r.lon, shape[i - 1][0], shape[i - 1][1], shape[i][0], shape[i][1]));
    if (d <= OBSTACLE_RADIUS_M) { if (r.blocking) blocking = true; else nearby = true; }
  }
  return [blocking, nearby];
}

// File de priorité ordonnée comme le heapq de Python : (distance, nœud).
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  less(i, j) { const x = this.a[i], y = this.a[j]; return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(v) {
    const a = this.a; a.push(v);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

export function engineRoute(net, origin, destination, profile, reports = []) {
  const active = reports.filter(r => r.active !== false);
  const start = nearestNode(net, origin[0], origin[1]);
  const goal = nearestNode(net, destination[0], destination[1]);
  if (start === goal) {
    return {legs: [], length_m: 0, effort: 0, duration_s: 0, max_slope_pct: 0, steps: 0,
            warnings: ["Vous êtes déjà arrivé."], nodes: {[start]: net.nodes[start]}};
  }
  const obstacleCache = new Map();
  const dist = new Map([[start, 0.0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new Heap();
  heap.push([0.0, start]);
  while (heap.size) {
    const [d, node] = heap.pop();
    if (done.has(node)) continue;
    if (node === goal) break;
    done.add(node);
    for (const [edge, forward] of net.adj[node]) {
      if (!obstacleCache.has(edge.id)) obstacleCache.set(edge.id, obstaclesOn(net, edge, active));
      const [blocking, nearby] = obstacleCache.get(edge.id);
      const c = arcCost(edge, profile, forward, blocking, nearby);
      if (c.cost === null) continue;
      const leg = {edge, forward, cost: c.cost, reasons: c.reasons};
      const nxt = legTo(leg), nd = d + c.cost;
      if (nd < (dist.has(nxt) ? dist.get(nxt) : Infinity)) {
        dist.set(nxt, nd);
        prev.set(nxt, leg);
        heap.push([nd, nxt]);
      }
    }
  }
  if (!prev.has(goal))
    throw new RoutingError("Aucun itinéraire accessible ne respecte vos réglages. " +
                           "Essayez d'assouplir la pente maximale ou signalez-nous le blocage.");
  const legs = [];
  for (let node = goal; node !== start;) {
    const leg = prev.get(node);
    legs.push(leg);
    node = legFrom(leg);
  }
  legs.reverse();
  const nodes = {};
  for (const l of legs) for (const n of [legFrom(l), legTo(l)]) nodes[n] = net.nodes[n];
  return summarise(legs, profile, nodes);
}

function summarise(legs, profile, nodes) {
  const length = pySum(legs.map(l => l.edge.length_m));
  const effort = pySum(legs.map(l => l.cost));
  const slopes = legs.map(legSlope).filter(s => s !== null).map(Math.abs);
  const warnings = [];
  for (const l of legs) for (const r of l.reasons) if (!warnings.includes(r)) warnings.push(r);
  return {
    legs, length_m: pyRound(length, 1), effort: pyRound(effort, 1),
    duration_s: pyRound(length / profile.speed_m_s), max_slope_pct: pyRound(slopes.length ? Math.max(...slopes) : 0.0, 1),
    steps: legs.filter(l => l.edge.has_step).length, warnings, nodes,
  };
}

// ---- Consignes (instructions.py) -------------------------------------------------
const STRAIGHT_MAX_DEG = 20, SLIGHT_MAX_DEG = 45, UTURN_MIN_DEG = 150, SLOPE_ALERT_PCT = 4.0;
const TEXT = {depart: "Partez", straight: "Continuez tout droit", slight_left: "Serrez à gauche", left: "Tournez à gauche",
  slight_right: "Serrez à droite", right: "Tournez à droite", uturn: "Faites demi-tour", arrive: "Vous êtes arrivé"};

const turnAngle = (bIn, bOut) => (bOut - bIn + 540.0) % 360.0 - 180.0;
function classify(angle) {
  const a = Math.abs(angle);
  if (a <= STRAIGHT_MAX_DEG) return "straight";
  if (a >= UTURN_MIN_DEG) return "uturn";
  if (a <= SLIGHT_MAX_DEG) return angle > 0 ? "slight_right" : "slight_left";
  return angle > 0 ? "right" : "left";
}
function legPoints(nodes, leg) {
  const pts = legShape(leg);
  if (pts.length >= 2) return pts;
  const a = nodes[legFrom(leg)], b = nodes[legTo(leg)];
  return [[a.lat, a.lon], [b.lat, b.lon]];
}
const startBearing = (nodes, leg) => { const [[a, b], [c, d]] = legPoints(nodes, leg).slice(0, 2); return bearingDeg(a, b, c, d); };
const endBearing = (nodes, leg) => { const [[a, b], [c, d]] = legPoints(nodes, leg).slice(-2); return bearingDeg(a, b, c, d); };
function legAlerts(leg) {
  const alerts = [];
  if (leg.edge.is_crossing) alerts.push("Traversée" + (leg.edge.sound_signal ? " avec feu sonore" : ""));
  if (leg.edge.has_step) alerts.push("Marche");
  if (leg.reasons.includes("données incomplètes")) alerts.push("Données à confirmer");
  return alerts;
}
const frPct = v => fixed(v, 1).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",") + " %";

export function buildSteps(route) {
  const nodes = route.nodes;
  if (!route.legs.length) return [];
  const steps = [];
  const first = route.legs[0], start = nodes[legFrom(first)];
  let current = {maneuver: "depart", distance_m: first.edge.length_m, street: first.edge.name,
                 lat: start.lat, lon: start.lon, text: "", alerts: legAlerts(first)};
  const slopes = [[]];
  const pushSlope = (bucket, leg) => { const s = legSlope(leg); if (s !== null) bucket.push(s); };
  pushSlope(slopes.at(-1), first);
  let prevBearing = endBearing(nodes, first);
  for (const leg of route.legs.slice(1)) {
    const m = classify(turnAngle(prevBearing, startBearing(nodes, leg)));
    const sameStreet = leg.edge.name && leg.edge.name === current.street;
    if (m === "straight" && (sameStreet || !leg.edge.name)) {
      current.distance_m += leg.edge.length_m;
      for (const a of legAlerts(leg)) if (!current.alerts.includes(a)) current.alerts.push(a);
      pushSlope(slopes.at(-1), leg);
    } else {
      steps.push(current);
      const node = nodes[legFrom(leg)];
      current = {maneuver: m, distance_m: leg.edge.length_m, street: leg.edge.name,
                 lat: node.lat, lon: node.lon, text: "", alerts: legAlerts(leg)};
      slopes.push([]);
      pushSlope(slopes.at(-1), leg);
    }
    prevBearing = endBearing(nodes, leg);
  }
  steps.push(current);
  const end = nodes[legTo(route.legs.at(-1))];
  steps.push({maneuver: "arrive", distance_m: 0.0, street: "", lat: end.lat, lon: end.lon, text: TEXT.arrive, alerts: []});

  steps.forEach((st, i) => {
    const stepSlopes = slopes[i];
    if (stepSlopes) {
      // max(..., key=abs) de Python : la première valeur de plus grande valeur absolue
      let steepest = 0.0;
      if (stepSlopes.length) steepest = stepSlopes.reduce((m, s) => Math.abs(s) > Math.abs(m) ? s : m);
      if (Math.abs(steepest) >= SLOPE_ALERT_PCT)
        st.alerts.unshift(`${steepest > 0 ? "Montée" : "Descente"} ${frPct(Math.abs(steepest))}`);
      st.distance_m = pyRound(st.distance_m, 1);
      st.text = st.street ? `${TEXT[st.maneuver]}, ${st.street}` : TEXT[st.maneuver];
    }
  });
  return steps;
}

// ---- Réponse identique à POST /route (main.py) ------------------------------------
function geometry(net, route) {
  const pts = [];
  for (const leg of route.legs) {
    let shape = legShape(leg);
    if (shape.length < 2) {
      const a = net.nodes[legFrom(leg)], b = net.nodes[legTo(leg)];
      shape = [[a.lat, a.lon], [b.lat, b.lon]];
    }
    pts.push(...(pts.length ? shape.slice(1) : shape));
  }
  return pts.map(([lat, lon]) => ({lat, lon}));
}
function out(net, route, label, accessible, issues) {
  return {
    label, accessible, length_m: route.length_m, duration_s: route.duration_s, max_slope_pct: route.max_slope_pct,
    steps_count: route.steps, warnings: route.warnings, blocking_issues: issues, geometry: geometry(net, route),
    steps: buildSteps(route).map(s => ({maneuver: s.maneuver, distance_m: s.distance_m, street: s.street,
                                        lat: s.lat, lon: s.lon, text: s.text, alerts: s.alerts})),
    edge_ids: route.legs.map(l => l.edge.id),
  };
}
function issuesFor(route, profile) {
  const issues = [];
  for (const leg of route.legs) {
    const c = arcCost(leg.edge, profile, leg.forward);
    if (c.cost === null) {
      const label = leg.edge.name ? `${c.reasons[0]} (${leg.edge.name})` : c.reasons[0];
      if (!issues.includes(label)) issues.push(label);
    }
  }
  return issues;
}

/** Équivalent de POST /route : {origin:{lat,lon}, destination:{lat,lon}, profile, compare_shortest}. */
export function computeRoutes(net, req, reports = []) {
  const profile = resolveProfile(req.profile || {});
  const origin = [req.origin.lat, req.origin.lon], dest = [req.destination.lat, req.destination.lon];
  const best = engineRoute(net, origin, dest, profile, reports);
  const routes = [out(net, best, "Le plus accessible", true, [])];
  if (req.compare_shortest !== false) {
    let shortest = null;
    try { shortest = engineRoute(net, origin, dest, preset("pedestrian"), reports); } catch (e) { if (!(e instanceof RoutingError)) throw e; }
    const ids = r => r.legs.map(l => l.edge.id).join(",");
    if (shortest && ids(shortest) !== ids(best)) {
      const issues = issuesFor(shortest, profile);
      routes.push(out(net, shortest, "Le plus court", issues.length === 0, issues));
    }
  }
  return {api_version: "1.0.0", routes};
}
