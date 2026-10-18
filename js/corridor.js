// Couloir de marche : quels objets vus par la caméra sont VRAIMENT sur mon chemin, et comment l'annoncer.
//
// Retour terrain (Gennevilliers, nuit) : « Voiture 72 % » pour chaque voiture garée le long de la rue. Désormais :
// - seuls comptent les objets dans le couloir : 1,5 m de large (0,75 m de chaque côté de l'axe de marche),
//   de 0,5 à 7 m devant. Un objet compte s'il mord sur le couloir (sa largeur est prise en compte) ;
// - une détection doit être confirmée sur plusieurs images (suivi + lissage) avant d'être annoncée : un
//   faux positif isolé ne dit rien ;
// - les véhicules (voitures, camions, bus) ne sont jamais annoncés avec le modèle généraliste : on ne sait
//   pas s'ils sont garés sur la chaussée ou sur le trottoir. Le modèle dédié a une classe « voiture_trottoir » ;
// - une annonce par obstacle (jamais répétée), la plus proche d'abord, avec le côté pour passer :
//   « Potelet légèrement à droite, 3 mètres, passez à gauche » ;
// - en fauteuil : avertissement si la place qui reste pour passer est trop étroite.
// Module sans dépendance au navigateur : testé par web/tests/corridor.test.mjs.

export const CORRIDOR = {halfWidth: 0.75, minDist: 0.5, maxDist: 7, minScore: 0.5};
export const WHEELCHAIR_WIDTH_M = 0.9;      // largeur utile minimale pour un fauteuil (arrêté du 15/01/2007 : 0,90 m)
export const MAX_SHOWN = 3;                 // au plus 3 obstacles affichés à l'écran

// Classes qui déclenchent une alerte -> nom prononcé. Modèle dédié (10 classes) et, à défaut, COCO.
export const OBSTACLE_LABELS = {
  // modèle dédié (docs/entrainement-obstacles.md)
  potelet: "Potelet", poteau: "Poteau", barriere: "Barrière", mobilier: "Mobilier urbain", deux_roues: "Deux-roues",
  voiture_trottoir: "Voiture sur le trottoir", travaux: "Travaux", denivele: "Dénivelé", obstacle_haut: "Obstacle en hauteur",
  pieton_immobile: "Personne arrêtée",
  // COCO-SSD (modèle généraliste) : seulement ce qui se trouve vraiment sur un trottoir, sans les véhicules
  bicycle: "Vélo", motorcycle: "Deux-roues", bench: "Banc", "fire hydrant": "Borne", "parking meter": "Horodateur",
  "stop sign": "Panneau", "potted plant": "Bac à plantes", chair: "Chaise de terrasse", "dining table": "Table de terrasse",
  suitcase: "Valise",
};
// Ordre d'urgence quand plusieurs obstacles sont à la même distance (plus petit = plus urgent)
const URGENCY = {denivele: 0, travaux: 1, obstacle_haut: 1, potelet: 2, poteau: 2, barriere: 2};

/**
 * Position d'une détection dans le couloir. `g` : {dist, lateral, halfWidth} (m) donné par groundPosition.
 * Renvoie true si une partie de l'objet est dans le couloir.
 */
export function inCorridor(g, c = CORRIDOR) {
  if (!g || g.dist < c.minDist || g.dist > c.maxDist) return false;
  return Math.abs(g.lateral) - (g.halfWidth || 0) < c.halfWidth;
}

// ---- Suivi d'une image à l'autre -------------------------------------------------------------------------
// Une piste = un objet réel. Elle est confirmée après 2 détections sur les 3 dernières images ; sa position
// est lissée (moyenne glissante) ; elle disparaît après 1,5 s sans être revue.
const MATCH_M = 1.2, CONFIRM_HITS = 2, LOST_MS = 1500, ALPHA = 0.5;
export function makeTracker() {
  let tracks = [], nextId = 1;
  return {
    get tracks() { return tracks; },
    reset() { tracks = []; },
    /** dets : [{cls, label, score, ground: {dist, lateral, halfWidth}}] ; now : ms */
    update(dets, now) {
      const used = new Set();
      for (const t of tracks) t.seen = false;
      // association gloutonne, la plus proche d'abord
      const pairs = [];
      dets.forEach((d, i) => tracks.forEach(t => {
        if (t.cls !== d.cls || !d.ground) return;
        const e = Math.hypot(t.dist - d.ground.dist, t.lateral - d.ground.lateral);
        if (e < MATCH_M + 0.15 * t.dist) pairs.push([e, i, t]);
      }));
      pairs.sort((a, b) => a[0] - b[0]);
      for (const [, i, t] of pairs) {
        if (used.has(i) || t.seen) continue;
        const g = dets[i].ground;
        used.add(i); t.seen = true; t.last = now; t.hits++; t.score = Math.max(t.score, dets[i].score);
        t.dist += ALPHA * (g.dist - t.dist); t.lateral += ALPHA * (g.lateral - t.lateral);
        t.halfWidth += ALPHA * ((g.halfWidth || 0) - t.halfWidth);
      }
      dets.forEach((d, i) => {
        if (used.has(i) || !d.ground) return;
        tracks.push({id: nextId++, cls: d.cls, label: d.label, score: d.score, dist: d.ground.dist, lateral: d.ground.lateral,
                     halfWidth: d.ground.halfWidth || 0, hits: 1, misses: 0, first: now, last: now, seen: true, announced: false});
      });
      for (const t of tracks) if (!t.seen) t.misses++;
      tracks = tracks.filter(t => now - t.last < LOST_MS);
      return this.confirmed();
    },
    /** Pistes confirmées et dans le couloir, la plus proche (puis la plus urgente) d'abord */
    confirmed() {
      return tracks.filter(t => t.hits >= CONFIRM_HITS && t.misses <= 1 && inCorridor(t))
        .sort((a, b) => (a.dist - b.dist) || ((URGENCY[a.cls] ?? 5) - (URGENCY[b.cls] ?? 5)));
    },
  };
}

// ---- Annonce -------------------------------------------------------------------------------------------
export function positionText(lateral) {
  const a = Math.abs(lateral), side = lateral < 0 ? "gauche" : "droite";
  return a < 0.25 ? "droit devant" : a < 0.6 ? `légèrement à ${side}` : `à ${side}`;
}
/**
 * Place libre de chaque côté de l'obstacle `t`, dans une bande de marche de `band` m centrée sur l'usager,
 * en tenant compte des autres obstacles proches (à moins de 1,5 m en profondeur).
 */
export function freeSpace(t, others, band = 1.8) {
  let left = (t.lateral - t.halfWidth) + band / 2, right = band / 2 - (t.lateral + t.halfWidth);
  for (const o of others) {
    if (o === t || Math.abs(o.dist - t.dist) > 1.5) continue;
    if (o.lateral < t.lateral) left = Math.min(left, (t.lateral - t.halfWidth) - (o.lateral + o.halfWidth));
    else right = Math.min(right, (o.lateral - o.halfWidth) - (t.lateral + t.halfWidth));
  }
  return {left: Math.max(0, left), right: Math.max(0, right)};
}
/** « Potelet légèrement à droite, 3 mètres, passez à gauche » (+ avertissement fauteuil si trop étroit) */
export function announceText(t, others = [], {wheelchair = false, band = 1.8} = {}) {
  const m = Math.max(1, Math.round(t.dist)), free = freeSpace(t, others, band);
  const pass = free.left >= free.right ? "gauche" : "droite", room = Math.max(free.left, free.right);
  let text = `${t.label} ${positionText(t.lateral)}, ${m} mètre${m > 1 ? "s" : ""}, passez à ${pass}`;
  if (wheelchair && room < WHEELCHAIR_WIDTH_M) text += ". Attention, passage peut-être trop étroit pour un fauteuil";
  return text + ".";
}
/**
 * Prochaine annonce : la piste confirmée la plus proche pas encore annoncée (une seule fois par obstacle),
 * au plus une toutes les `gapMs` millisecondes. Renvoie {track, text} ou null.
 */
export function nextAnnouncement(tracker, now, state, opts = {}) {
  if (now - (state.lastAt ?? -Infinity) < (opts.gapMs ?? 2500)) return null;
  const list = tracker.confirmed(), t = list.find(x => !x.announced);
  if (!t) return null;
  t.announced = true;
  // même sorte d'obstacle annoncée il y a moins de 6 s (rangée de potelets, objet perdu puis revu) : on se tait
  state.recent = (state.recent || []).filter(r => now - r.at < 6000);
  if (state.recent.some(r => r.cls === t.cls)) return null;
  state.recent.push({cls: t.cls, at: now});
  state.lastAt = now;
  return {track: t, text: announceText(t, list, opts)};
}
