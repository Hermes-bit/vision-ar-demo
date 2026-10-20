// Départ « Ma position » vivant : quel relevé GPS utiliser comme départ, et quand recalculer le trajet.
//
// Retour terrain du 20/10 : le trajet partait du premier relevé GPS (souvent faux de 30 à 100 m près des
// immeubles, parfois vieux de 20 s) et n'était jamais corrigé ; il fallait « reculer » pour rejoindre son
// début. Règles, valables partout et pour tous les départs « Ma position » (recherche, favori, après un guidage) :
//  1. un relevé vieux de plus de 5 s, incomplet ou incohérent n'est jamais utilisé ;
//  2. premier départ (ou départ périmé) : un relevé précis (25 m ou mieux) est pris tout de suite ; sinon on
//     attend un meilleur relevé, puis on prend le meilleur reçu s'il est correct (65 m) au bout de 6 s, et le
//     meilleur reçu, quel qu'il soit, au bout de 15 s ;
//  3. ensuite, le départ suit la personne : il est corrigé dès qu'un relevé nettement plus précis le place
//     ailleurs, ou quand elle s'est vraiment déplacée (au-delà de 15 m et de l'incertitude du relevé) ;
//  4. pas plus d'un recalcul toutes les 2,5 s pour un déplacement (une correction de précision passe toujours) ;
//  5. un départ qu'aucun relevé n'a confirmé depuis 30 s est périmé : on revient à la règle 2.
// Module sans dépendance au navigateur : testé par web/tests/origin.test.mjs.

export const ORIGIN_RULES = {maxAgeMs: 5000, goodAccM: 25, acceptAccM: 65, waitMs: 6000, giveUpMs: 15000,
  moveM: 15, minGapMs: 2500, staleMs: 30000};

export const distM = (a, b) => {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * k);
};

/** Relevé utilisable : coordonnées et précision valides, daté, frais (et pas daté du futur). */
export function usableFix(fix, now, R = ORIGIN_RULES) {
  return !!fix && [fix.lat, fix.lon, fix.acc, fix.at].every(Number.isFinite) && fix.acc > 0 &&
    Math.abs(fix.lat) <= 90 && Math.abs(fix.lon) <= 180 && !(fix.lat === 0 && fix.lon === 0) &&
    now - fix.at <= R.maxAgeMs && fix.at <= now + 1000;
}

/** Départ GPS encore valable : confirmé par un relevé il y a moins de 30 s. */
export const originValid = (o, now, R = ORIGIN_RULES) => !!o && Number.isFinite(o.confirmedAt) && now - o.confirmedAt <= R.staleMs;

/**
 * Que faire de ce relevé ?
 * state : {origin: départ GPS actuel {lat, lon, acc, confirmedAt} ou null, searchSince: début de l'attente (ms),
 *          best: meilleur relevé reçu pendant l'attente, lastUseAt: heure du dernier changement de départ (ms)}
 * Renvoie {action, fix?, best?} :
 *   « use »     ce relevé devient le départ (et le trajet est recalculé) ;
 *   « confirm » le départ actuel est toujours bon (on note l'heure) ;
 *   « wait »    pas encore de relevé assez bon : on garde le meilleur reçu (best) et on attend ;
 *   « ignore »  relevé inutilisable, ou déplacement à prendre en compte un peu plus tard (règle 4).
 */
export function decideOrigin(state, fix, now, R = ORIGIN_RULES) {
  if (!usableFix(fix, now, R)) return {action: "ignore"};
  const o = originValid(state.origin, now, R) ? state.origin : null;
  if (!o) {
    const prev = usableFix(state.best, now, R) ? state.best : null;
    const best = prev && prev.acc < fix.acc ? prev : fix;
    if (fix.acc <= R.goodAccM) return {action: "use", fix};
    const waited = now - (state.searchSince ?? now);
    if (waited >= R.giveUpMs || (waited >= R.waitMs && best.acc <= R.acceptAccM)) return {action: "use", fix: best};
    return {action: "wait", best};
  }
  const d = distM(o, fix), noise = Math.max(R.moveM, fix.acc);
  // nettement plus précis qu'avant, et il place la personne ailleurs : on corrige tout de suite
  if (fix.acc <= o.acc * 0.6 && d > Math.max(5, fix.acc / 2)) return {action: "use", fix};
  if (d <= noise) return {action: "confirm"};
  // vrai déplacement : au plus un recalcul toutes les 2,5 s
  return now - (state.lastUseAt ?? -Infinity) >= R.minGapMs ? {action: "use", fix} : {action: "ignore"};
}
