// Panneau du bas à 3 points d'arrêt : calculs du geste, sans dépendance au navigateur (web/tests/sheet.test.mjs).
// Positions exprimées en translateY (px) : 0 = plein, plus grand = plus bas.

export const STOPS = ["full", "mid", "collapsed"];

/** Résistance élastique au-delà des limites [min, max] : on avance de moins en moins (dim = course maximale). */
export function rubber(y, min, max, dim = 120) {
  if (y >= min && y <= max) return y;
  const over = y < min ? min - y : y - max, eased = dim * (1 - 1 / (over / dim * 0.55 + 1));
  return y < min ? min - eased : max + eased;
}

/** Vitesse en px/ms sur les ~80 dernières ms : samples = [{t, y}] (t en ms), dans l'ordre. */
export function velocity(samples, windowMs = 80) {
  if (samples.length < 2) return 0;
  const last = samples.at(-1);
  let first = samples[0];
  for (const s of samples) if (last.t - s.t <= windowMs) { first = s; break; }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/**
 * Point d'arrêt au relâcher, selon la position ET la vitesse : la position est projetée là où l'élan la mènerait
 * (200 ms), puis on prend l'arrêt le plus proche. Un geste vif (> 0,5 px/ms) passe au moins à l'arrêt voisin
 * dans son sens. ys = {full, mid, collapsed}.
 */
export function chooseStop(y, v, ys, from) {
  const order = STOPS.filter(k => ys[k] !== undefined).sort((a, b) => ys[a] - ys[b]);
  const projected = y + v * 200;
  let best = order[0];
  for (const k of order) if (Math.abs(ys[k] - projected) < Math.abs(ys[best] - projected)) best = k;
  if (Math.abs(v) > 0.5 && from && best === from) {
    const i = order.indexOf(from) + (v > 0 ? 1 : -1);
    if (i >= 0 && i < order.length) best = order[i];
  }
  return best;
}

/** Durée de l'animation de calage : proportionnelle à la distance, plus courte si le geste est rapide. */
export const snapDuration = (dist, v) => Math.round(Math.max(180, Math.min(420, 160 + Math.abs(dist) * 0.9 - Math.abs(v) * 60)));
