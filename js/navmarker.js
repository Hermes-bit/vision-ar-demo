// Où dessiner l'icône « ma position » pendant le guidage (testé par web/tests/navmarker.test.mjs : chaque
// règle ci-dessous correspond à un retour terrain, ne pas en changer une sans relancer les tests).
//
// 1. Sur l'itinéraire (phase « route », ni écarté ni hors itinéraire) : l'icône est POSÉE SUR LE TRACÉ, au point
//    le plus proche de la position GPS. Le GPS se trompe de 5 à 15 m en ville : afficher la position brute
//    mettait l'icône « de travers », à côté du chemin que l'on suit bien (retour du 19/10, v75).
// 2. Ce point suit la position GPS, en avant comme en arrière : accrochée à la progression (qui ne fait
//    qu'avancer), l'icône restait bloquée quand on s'arrêtait ou que le GPS hésitait (retour du 19/10, v74).
// 3. En approche du départ, à l'écart (intérieur, cour) ou hors itinéraire : la vraie position GPS.
// 4. Sans position GPS récente (15 s) : la dernière place connue, signalée comme ancienne (icône grisée).

export const STALE_MS = 15000;

/**
 * n : état du guidage {phase, away, offRoute, real: {lat, lon, acc, at}, here, pos, gapAlong} ;
 * posAt(d) : point de l'itinéraire à d mètres du départ. Renvoie {lat, lon, stale}.
 */
export function markerPosition(n, posAt, now = Date.now()) {
  const fresh = !!n.real && now - n.real.at < STALE_MS;
  if (!fresh) {
    const last = n.real || n.here;
    return {lat: last.lat, lon: last.lon, stale: true};
  }
  if (n.phase === "route" && !n.away && !n.offRoute) {
    const p = posAt(n.gapAlong ?? n.pos);
    return {lat: p.lat, lon: p.lon, stale: false};
  }
  return {lat: n.real.lat, lon: n.real.lon, stale: false};
}
