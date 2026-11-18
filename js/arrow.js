// Flèche de direction posée au sol — le repère visuel du guidage AR, à la place du ruban.
//
// POURQUOI UNE FLÈCHE PLUTÔT QU'UN RUBAN
// Un ruban doit coïncider avec le trottoir sur toute sa longueur : trois mètres d'erreur latérale
// de GPS le posent sur un mur ou sur la chaussée (captures du 14/11/2026), et aucun lissage ne
// rattrape ça, parce que ce qui manque est la position réelle, pas le dessin.
// Une flèche ne dit qu'une chose : de quel côté part l'itinéraire. Cette direction se mesure
// entre DEUX POINTS DU TRACÉ (ar.js : routeBearing), jamais entre l'usager et le tracé. Une erreur
// latérale de GPS ne la fausse donc pas : sur une ligne droite, le cap reste juste même avec un
// GPS à quinze mètres près. Sortie terrain du 16/11/2026 : c'est la représentation qui tient le
// mieux, et c'est la raison pour laquelle elle tient.
//
// CE QUI LA REND STABLE
// Elle est ancrée à la CAMÉRA, pas au sol géographique : toujours AVANT_M mètres devant l'axe de
// visée, à plat sur le plan du sol. Le GPS ne peut pas la déplacer, puisqu'il n'entre pas dans sa
// position. Seule sa ROTATION porte de l'information. En contrepartie elle ne marque plus un
// endroit précis du trottoir — c'est une direction, pas un emplacement, et c'est assumé.
//
// Ce fichier ne dessine rien : il ne contient que la géométrie et les décisions, pour qu'elles
// soient vérifiables sans canevas ni téléphone. Le tracé au canevas est dans ar.js.

export const AVANT_M = 6;           // posée à 6 m devant soi : assez loin pour ne pas masquer le trottoir proche
export const ZONE_MORTE_DEG = 4;    // en deçà, on ne bouge pas : c'est le tremblement de la boussole, pas un virage
export const SUIVI = 0.08;          // part de l'écart rattrapée par image (~0,5 s pour se poser)
export const PAS_MAX_DEG = 6;       // rotation maximale par image : un à-coup de boussole ne la fait jamais sauter
export const PRECISION_PLEINE_M = 25;   // jusque-là, pleine ; au-delà elle pâlit
export const PRECISION_MAX_M = 40;      // au-delà, on ne montre plus rien : le segment suivi devient douteux

/** Ramène un angle dans [-180, 180[. */
const tour = a => ((a % 360) + 540) % 360 - 180;

/**
 * De quel côté pointe la flèche, par rapport à l'axe de visée du téléphone.
 * @param {number} capItineraire  cap du tracé, en degrés depuis le nord
 * @param {number} capVise        cap de la caméra, en degrés depuis le nord
 * @returns {number|null} degrés dans [-180, 180[ — positif vers la droite ; null si une donnée manque
 */
export function capFleche(capItineraire, capVise) {
  if (!Number.isFinite(capItineraire) || !Number.isFinite(capVise)) return null;
  return tour(capItineraire - capVise);
}

/**
 * Rotation lissée, image par image. Trois garde-fous, dans cet ordre :
 * zone morte (le bruit ne bouge rien), suivi proportionnel (pas de saut), pas maximal (une
 * valeur de boussole aberrante ne peut pas faire pivoter la flèche d'un coup).
 * @param {number|null} courant  angle affiché à l'image précédente, null à la première
 * @param {number|null} cible    angle voulu
 * @returns {number|null}
 */
export function lisserCap(courant, cible, {suivi = SUIVI, zoneMorte = ZONE_MORTE_DEG, pasMax = PAS_MAX_DEG} = {}) {
  if (!Number.isFinite(cible)) return Number.isFinite(courant) ? courant : null;
  if (!Number.isFinite(courant)) return tour(cible);        // première image : elle se pose directement
  const ecart = tour(cible - courant);
  if (Math.abs(ecart) < zoneMorte) return courant;
  const pas = Math.max(-pasMax, Math.min(pasMax, ecart * suivi));
  return tour(courant + pas);
}

/**
 * La flèche vue de dessus, en mètres, dans son propre repère :
 * `a` le long de son axe (positif vers la pointe), `b` vers sa droite.
 * Polygone plein, dans l'ordre, pointe en premier.
 */
export function formeFleche({longueur = 1.8, largeurTete = 1.15, largeurTige = 0.46} = {}) {
  const demi = longueur / 2, tige = largeurTige / 2, tete = largeurTete / 2;
  const epaule = demi - largeurTete * 0.72;                 // là où la tête rejoint la tige
  return [
    {a: demi, b: 0},                                        // pointe
    {a: epaule, b: tete}, {a: epaule, b: tige},
    {a: -demi, b: tige}, {a: -demi, b: -tige},
    {a: epaule, b: -tige}, {a: epaule, b: -tete},
  ];
}

/**
 * Du repère de la flèche vers celui de la caméra.
 * @param {{a:number, b:number}} p  point de la flèche
 * @param {number} capDeg           de quel côté elle pointe (0 = droit devant, positif = à droite)
 * @returns {{avant:number, droite:number}} mètres devant l'objectif et sur sa droite
 */
export function placer({a, b}, capDeg, avantM = AVANT_M) {
  const r = capDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return {avant: avantM + a * c - b * s, droite: a * s + b * c};
}

/**
 * Faut-il la montrer, et à quelle opacité ?
 *
 * Plus permissive que le ruban, qui disparaissait au-delà de 25 m d'incertitude (ar.js,
 * ribbonTarget) : le ruban prétendait montrer OÙ est le trottoir, la flèche seulement de quel
 * côté part l'itinéraire. Un GPS à 30 m près situe encore correctement le segment que l'on suit.
 * Terrain de nuit du 19/10 : GPS à 14 m en permanence, le ruban ne s'affichait jamais.
 *
 * Ce qui la rendrait fausse, en revanche, la masque entièrement : une boussole non calibrée fait
 * tourner la flèche tout entière, et hors de l'itinéraire le cap du tracé ne veut plus rien dire.
 * @returns {number} opacité entre 0 et 1
 */
export function opaciteFleche({phase, offRoute = false, away = false, boussoleOk = true,
                               precisionM = null, recalage = false, arrive = false} = {}) {
  if (recalage || arrive || !boussoleOk) return 0;
  if (phase !== "route" || offRoute || away) return 0;
  if (precisionM === null) return 1;                        // pas de mesure (ordinateur, démonstration)
  if (precisionM > PRECISION_MAX_M) return 0;
  if (precisionM <= PRECISION_PLEINE_M) return 1;
  return 1 - 0.55 * (precisionM - PRECISION_PLEINE_M) / (PRECISION_MAX_M - PRECISION_PLEINE_M);
}
