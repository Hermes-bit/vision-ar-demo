// Relevé systématique : décider s'il faut photographier maintenant, pendant qu'on marche.
//
// But : constituer une base d'images géolocalisées de référence, pour que les obstacles soient
// repérés AU BUREAU (hors ligne, sans contrainte de temps réel) et annoncés ensuite depuis la
// base, 50 m à l'avance, caméra éteinte. Voir docs/strategie-materiel-et-modele.md, partie 3.
//
// Ce module ne touche ni à la caméra ni au stockage : il répond seulement « oui / non, et
// pourquoi ». La capture elle-même reste captureSample() dans obstacles.js, qui floute déjà
// les visages et les plaques.
import {haversineM} from "./routing.js";

export const RELEVE = {
  pasM: 25,               // en ligne droite : une image tous les 25 m (100 m laisse passer un potelet)
  pasVirageM: 10,         // après un changement de cap, la scène change vite : on resserre
  virageDeg: 35,          // au-delà, on considère qu'on a tourné
  intervalleMinMs: 2000,  // jamais deux images coup sur coup, même si le GPS saute
  precisionMaxM: 20,      // au-delà, la position est trop floue pour servir de référence
  maxImages: 300,         // ~1280 px en JPEG : garde-fou de stockage sur le téléphone
};

// Écart de cap en degrés, toujours entre 0 et 180.
export function ecartCap(a, b) {
  if (a == null || b == null || a < 0 || b < 0) return 0;
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Crée un relevé. Appeler decider() à chaque position reçue ; noter() après une capture réussie.
 * Pas de test de vitesse : à l'arrêt, la règle de distance suffit à ne rien capturer, et le
 * filtre de précision écarte les sauts de GPS qui simuleraient un déplacement.
 * @param {object} reglages surcharge partielle de RELEVE
 */
export function creerReleve(reglages = {}) {
  const R = {...RELEVE, ...reglages};
  let dernier = null;           // dernière image prise : {lat, lon, cap, at}
  let images = 0;

  /**
   * @param {{lat:number, lon:number, acc:number, cap:number, at:number}} fix
   * @returns {{capturer:boolean, raison:string, distance:number}}
   */
  function decider(fix) {
    const non = (raison, distance = 0) => ({capturer: false, raison, distance});
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return non("sans-position");
    if (images >= R.maxImages) return non("plein");
    if (Number.isFinite(fix.acc) && fix.acc > R.precisionMaxM) return non("position-trop-floue");
    if (!dernier) return {capturer: true, raison: "premiere", distance: 0};

    if (Number.isFinite(fix.at) && Number.isFinite(dernier.at) && fix.at - dernier.at < R.intervalleMinMs) {
      return non("trop-tot");
    }
    const d = haversineM(dernier.lat, dernier.lon, fix.lat, fix.lon);
    const tourne = ecartCap(fix.cap, dernier.cap) >= R.virageDeg;
    if (tourne && d >= R.pasVirageM) return {capturer: true, raison: "virage", distance: d};
    if (d >= R.pasM) return {capturer: true, raison: "pas", distance: d};
    return non(tourne ? "virage-trop-pres" : "pas-assez-avance", d);
  }

  function noter(fix) {
    dernier = {lat: fix.lat, lon: fix.lon, cap: fix.cap, at: fix.at};
    images += 1;
  }

  // Une rue photographiée hier n'a pas besoin de l'être aujourd'hui : on repart à zéro par relevé.
  function reprendre() { dernier = null; }

  const etat = () => ({images, reste: Math.max(0, R.maxImages - images), dernier});

  return {decider, noter, reprendre, etat, reglages: R};
}
