// Couloir de marche : quels objets vus par la caméra sont VRAIMENT sur mon chemin, et comment l'annoncer.
//
// Couloir en 2D (pas de LiDAR dans un navigateur) : un trapèze au centre de la moitié basse de l'image,
// large en bas (près de soi), étroit vers le milieu de l'image (plus loin). Un obstacle compte si le MILIEU
// DU BAS de sa boîte (là où il touche le sol) est dans ce trapèze. Distance : plus le bas de la boîte est bas
// dans l'image, plus l'objet est proche (table DIST_CALIB, à calibrer sur le terrain avec le mode test).
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

// Classes du détecteur (models/detecteur_obstacles.onnx) -> nom prononcé. Une classe inconnue (modèle v2)
// est annoncée avec son nom, tiret bas remplacé par une espace.
export const OBSTACLE_LABELS = {
  barriere: "Barrière", deux_roues: "Vélo ou trottinette", mobilier: "Mobilier urbain", pieton_immobile: "Piéton arrêté",
  poteau: "Poteau", potelet: "Potelet", travaux: "Travaux", voiture_trottoir: "Voiture sur le trottoir",
  // classes prévues pour une version suivante du modèle
  denivele: "Dénivelé", obstacle_haut: "Obstacle en hauteur",
};
export const spokenName = cls => OBSTACLE_LABELS[cls] || String(cls).replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

// ---- Couloir 2D dans l'image --------------------------------------------------------------------------
// Coordonnées normalisées de l'image vidéo : x de 0 (gauche) à 1 (droite), y de 0 (haut) à 1 (bas).
// top : haut du trapèze (0,5 = milieu de l'image) ; topHalf / bottomHalf : demi-largeurs en haut et en bas.
export const TRAPEZE = {top: 0.5, topHalf: 0.12, bottomHalf: 0.45};
// [y du bas de la boîte, distance en mètres], du plus proche au plus loin. Valeurs de départ pour un téléphone
// tenu devant soi, légèrement incliné vers le sol : à ajuster sur le terrain (mode test : graduations affichées).
export const DIST_CALIB = [[1.0, 1.0], [0.9, 1.5], [0.8, 2.2], [0.7, 3.2], [0.62, 4.5], [0.56, 6], [0.5, 7]];
export const halfAt = (y, T = TRAPEZE) => T.topHalf + (T.bottomHalf - T.topHalf) * (y - T.top) / (1 - T.top);
export function distanceFromY(y, calib = DIST_CALIB) {
  if (y >= calib[0][0]) return calib[0][1];
  for (let i = 1; i < calib.length; i++) {
    const [y0, d0] = calib[i - 1], [y1, d1] = calib[i];
    if (y >= y1) return d0 + (d1 - d0) * (y0 - y) / (y0 - y1);
  }
  return calib.at(-1)[1];
}
/**
 * Boîte [x, y, w, h] (pixels de la vidéo vw × vh) -> position dans le couloir, ou null si le bas de la boîte
 * n'est pas dans le trapèze. lateral : décalage en mètres (couloir = ±0,75 m), halfWidth : demi-largeur estimée.
 */
export function corridor2D(box, vw, vh, T = TRAPEZE, calib = DIST_CALIB) {
  const [x, y, w, h] = box, nx = (x + w / 2) / vw, ny = Math.min(1, (y + h) / vh);
  if (ny < T.top) return null;                                              // moitié haute : pas sur mon chemin
  const half = halfAt(ny, T), t = (nx - 0.5) / half;                        // -1 bord gauche … +1 bord droit
  if (Math.abs(t) > 1) return null;
  return {dist: distanceFromY(ny, calib), lateral: t * CORRIDOR.halfWidth, halfWidth: Math.min(1.5, (w / vw / 2) / half * CORRIDOR.halfWidth), nx, ny};
}
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
        t.g = g;                                                              // dernière position (repère à l'écran)
        used.add(i); t.seen = true; t.last = now; t.hits++; t.score = Math.max(t.score, dets[i].score);
        t.dist += ALPHA * (g.dist - t.dist); t.lateral += ALPHA * (g.lateral - t.lateral);
        t.halfWidth += ALPHA * ((g.halfWidth || 0) - t.halfWidth);
      }
      dets.forEach((d, i) => {
        if (used.has(i) || !d.ground) return;
        tracks.push({id: nextId++, cls: d.cls, label: d.label, score: d.score, dist: d.ground.dist, lateral: d.ground.lateral,
                     halfWidth: d.ground.halfWidth || 0, g: d.ground, hits: 1, misses: 0, first: now, last: now, seen: true, announced: false});
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
// Côté : le tiers central du couloir est « devant », les tiers extérieurs « à gauche » / « à droite »
export function positionText(lateral) {
  return Math.abs(lateral) < CORRIDOR.halfWidth / 3 ? "devant" : lateral < 0 ? "à gauche" : "à droite";
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
/** « Potelet à droite, environ 3 mètres, passez à gauche » (+ avertissement fauteuil si trop étroit) */
export function announceText(t, others = [], {wheelchair = false, band = 1.8} = {}) {
  const m = Math.max(1, Math.round(t.dist)), free = freeSpace(t, others, band);
  const pass = free.left >= free.right ? "gauche" : "droite", room = Math.max(free.left, free.right);
  let text = `${t.label} ${positionText(t.lateral)}, environ ${m} mètre${m > 1 ? "s" : ""}, passez à ${pass}`;
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
