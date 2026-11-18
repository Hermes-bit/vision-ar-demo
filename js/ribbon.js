// Recentrage latéral du ruban.
//
// Le ruban est dessiné sur la ligne de l'itinéraire, vue depuis la position de l'usager
// (ar.js : enu(here, posAt(d))). Si cette ligne passe à trois mètres de lui — erreur de GPS,
// ou trottoir mal tracé dans OpenStreetMap — le ruban apparaît trois mètres sur le côté,
// posé sur un mur ou sur la chaussée. C'est ce qu'ont montré les captures du 14/11/2026.
//
// On translate donc le ruban pour que la route passe sous les pieds, en gardant sa forme et
// sa direction. Mais seulement jusqu'à une limite : au-delà, l'écart est sans doute réel
// (on marche dans une autre rue), et le masquer tromperait l'usager. Au-delà de la limite,
// on corrige de la limite seulement, et le reste de l'écart continue de se voir.

export const RECENTRAGE_MAX_M = 6;   // au-delà, l'écart n'est plus une imprécision mais une erreur de chemin

/**
 * @param {{x:number, y:number}} ancre  position de la route sous l'usager, en mètres locaux
 * @param {number} max                  correction maximale, en mètres
 * @returns {{x:number, y:number, reste:number}} translation à appliquer, et écart non corrigé
 */
export function recentrage(ancre, max = RECENTRAGE_MAX_M) {
  const x = Number(ancre?.x), y = Number(ancre?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {x: 0, y: 0, reste: 0};
  const d = Math.hypot(x, y);
  if (d === 0) return {x: 0, y: 0, reste: 0};
  const f = Math.min(1, max / d);
  return {x: x * f, y: y * f, reste: Math.max(0, d - max)};
}

/**
 * La vue caméra s'ouvre-t-elle d'office au départ du guidage ?
 *
 * `demandee` est le choix de l'usager (réglage « Ouvrir la caméra au départ », 18/11/2026) :
 * à faux, le guidage part toujours réduit, quel que soit le profil, et le navigateur ne
 * demande donc plus l'autorisation de la caméra. Jusque-là, la détection d'obstacles étant
 * active par défaut, la caméra s'ouvrait à chaque départ sans que personne puisse s'y opposer.
 *
 * Sans choix exprimé, la règle du profil s'applique. Pour la malvoyance, non : la flèche ne se
 * voit pas, et la caméra est le poste qui vide la batterie. Le guidage démarre alors « réduit »
 * — voix, vibrations et alertes, sans caméra. Une exception : si la détection d'obstacles est
 * activée, elle a besoin de la caméra, et c'est justement à un malvoyant qu'elle sert le plus.
 * On ne la lui retire pas.
 */
export function cameraDOffice({malvoyance = false, detection = false, demandee = true} = {}) {
  if (!demandee) return false;
  return !malvoyance || detection;
}
