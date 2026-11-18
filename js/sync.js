// Partage des signalements d'obstacles entre les téléphones.
//
// Jusqu'au 18/11/2026, un obstacle signalé restait dans le localStorage de celui qui l'avait vu :
// personne d'autre n'en profitait. Ce module fait les deux sens, automatiquement.
//
// CE QU'IL NE FAIT PAS, ET C'EST VOULU
// Il ne décide rien du calcul d'itinéraire ni des annonces. Un signalement venu du serveur entre
// simplement dans la liste que `reports()` rend, et tout le reste suit de lui-même : routing.js
// applique déjà OBSTACLE_PENALTY_M (80 m, et arc infranchissable pour un fauteuil si l'obstacle
// bloque), la carte le dessine, et hazardsOn l'annonce à l'approche. Le partage n'avait donc
// rien à réinventer.
//
// SANS SERVEUR, RIEN NE CHANGE
// `apiBase()` est vide par défaut. Toutes les fonctions réseau d'ici rendent alors la main sans
// rien faire, et l'appli se comporte exactement comme avant — hors ligne d'abord, c'est une des
// trois promesses du produit.
//
// AUCUNE PERTE
// Un envoi raté ne supprime rien : le signalement reste marqué « à envoyer » et repartira à la
// synchronisation suivante. C'est la règle des images de relevé (js/upload.js) : on ne retire du
// téléphone que ce que le serveur a accusé.
import {haversineM} from "./routing.js";

export const PERIODE_MS = 60000;      // une synchronisation par minute pendant le guidage
export const MARGE_BBOX_M = 400;      // on récupère les obstacles un peu au large de l'itinéraire
export const RAYON_CHEMIN_M = 15;     // même rayon que OBSTACLE_RADIUS_M de routing.js
export const PAS_ECHANTILLON_M = 10;  // finesse de l'échantillonnage du chemin restant

const METRE_LAT = 1 / 111320;

/** Le signalement local, dans la forme attendue par POST /reports. */
export function versServeur(r) {
  return {lat: r.lat, lon: r.lon, kind: r.kind, blocking: r.blocking !== false, source: "user"};
}

/**
 * Le signalement du serveur, dans la forme des signalements locaux.
 * `distant` le distingue des siens : on ne le renvoie jamais au serveur.
 */
export function depuisServeur(r) {
  const expires = Date.parse(r?.expires_at);
  if (!Number.isFinite(expires)) return null;
  const created = Date.parse(r.created_at);
  return {
    id: `s${r.id}`, serverId: r.id, distant: true,
    kind: r.kind, blocking: r.blocking !== false,
    lat: r.lat, lon: r.lon,
    created: Number.isFinite(created) ? created : Date.now(),
    expires,
    confirmations: r.confirmations ?? 0,
  };
}

/**
 * La liste que voit le reste de l'appli : les siens et ceux des autres, sans doublon.
 *
 * Un signalement que l'on a envoyé revient du serveur avec son identifiant : on garde alors la
 * version locale, parce que c'est elle que l'usager peut retirer de son téléphone.
 */
export function fusionner(locaux, distants) {
  const miens = new Set((locaux || []).map(r => r.serverId).filter(id => id != null));
  return [...(locaux || []), ...(distants || []).filter(r => !miens.has(r.serverId))];
}

/** Ceux qui restent à envoyer : les siens, pas encore accusés, pas encore périmés. */
export function aEnvoyer(locaux, maintenant = Date.now()) {
  return (locaux || []).filter(r => !r.distant && r.serverId == null && r.expires > maintenant);
}

/**
 * L'emprise à interroger autour d'une suite de points, élargie de `marge` mètres.
 * null si aucun point exploitable : on n'interroge pas le serveur pour rien.
 */
export function emprise(points, marge = MARGE_BBOX_M) {
  const vrais = (points || []).filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (!vrais.length) return null;
  const lats = vrais.map(p => p.lat), lons = vrais.map(p => p.lon);
  const dLat = marge * METRE_LAT;
  const dLon = dLat / Math.max(0.2, Math.cos(lats[0] * Math.PI / 180));
  return {
    south: Math.min(...lats) - dLat, north: Math.max(...lats) + dLat,
    west: Math.min(...lons) - dLon, east: Math.max(...lons) + dLon,
  };
}

/** L'obstacle est-il assez près du chemin qui reste à parcourir pour le gêner ? */
export function surLeChemin(obstacle, pointsRestants, rayonM = RAYON_CHEMIN_M) {
  if (!Number.isFinite(obstacle?.lat) || !Number.isFinite(obstacle?.lon)) return false;
  return (pointsRestants || []).some(p => haversineM(obstacle.lat, obstacle.lon, p.lat, p.lon) <= rayonM);
}

/**
 * Parmi ce que la synchronisation vient de rapporter, ce qui oblige à prévenir et à recalculer :
 * un obstacle BLOQUANT, inconnu jusque-là, posé sur le chemin qu'il reste à faire.
 *
 * Un obstacle gênant ne déclenche rien ici : il renchérit l'itinéraire au prochain calcul et sera
 * annoncé à l'approche. Couper la marche de quelqu'un pour une bordure serait pire que le mal.
 */
export function aSignalerALUsager(avant, apres, pointsRestants) {
  const connus = new Set((avant || []).map(r => r.id));
  return (apres || []).filter(r => !connus.has(r.id) && r.blocking !== false
                                   && surLeChemin(r, pointsRestants));
}

// ---- Réseau. Ni l'une ni l'autre ne lève : une panne ne doit pas interrompre un guidage. ----

/**
 * Envoie les signalements en attente. Rend la liste des accusés, chacun avec son identifiant
 * serveur, pour que l'appelant les marque et cesse de les renvoyer.
 * `merged` : le serveur avait déjà cet obstacle ; l'envoi l'a confirmé au lieu de le dupliquer.
 */
export async function envoyer(locaux, {url, device, reseau = globalThis.fetch, maintenant = Date.now()} = {}) {
  const attente = aEnvoyer(locaux, maintenant);
  if (!url || !attente.length) return {accuses: [], echecs: []};
  const accuses = [], echecs = [];
  for (const r of attente) {
    try {
      const rep = await reseau(`${url.replace(/\/+$/, "")}/reports`, {
        method: "POST",
        headers: {"Content-Type": "application/json", ...(device ? {"X-Device-Id": device} : {})},
        body: JSON.stringify(versServeur(r)),
      });
      if (!rep.ok) { echecs.push({id: r.id, raison: `HTTP ${rep.status}`}); continue; }
      const corps = await rep.json();
      accuses.push({id: r.id, serverId: corps.id, merged: corps.merged === true});
    } catch (e) {
      echecs.push({id: r.id, raison: String(e?.message || e)});
    }
  }
  return {accuses, echecs};
}

/** Récupère les signalements actifs dans une emprise. Rend [] en cas d'échec, jamais d'erreur. */
export async function recuperer(bbox, {url, reseau = globalThis.fetch} = {}) {
  if (!url || !bbox) return [];
  const q = new URLSearchParams({south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east});
  try {
    const rep = await reseau(`${url.replace(/\/+$/, "")}/reports?${q}`);
    if (!rep.ok) return [];
    const corps = await rep.json();
    return (Array.isArray(corps) ? corps : []).map(depuisServeur).filter(Boolean);
  } catch {
    return [];
  }
}


/**
 * « Il n'est plus là », ou « toujours là », sur un signalement venu du serveur.
 *
 * On ne peut pas effacer l'obstacle de quelqu'un d'autre : on le dément, et il faut DEUX démentis
 * pour le retirer à tout le monde. C'est la règle de va_report, inchangée — une seule personne ne
 * doit pas pouvoir faire disparaître un obstacle que d'autres ont vu.
 *
 * Ne lève jamais. Rend true si le serveur a pris le vote.
 */
export async function voter(serverId, {url, device, encore = false, reseau = globalThis.fetch} = {}) {
  if (!url || serverId == null || !device) return false;
  try {
    const rep = await reseau(`${url.replace(/\/+$/, "")}/reports/${serverId}/vote`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Device-Id": device},
      body: JSON.stringify({still_there: encore === true}),
    });
    return rep.ok === true;
  } catch {
    return false;
  }
}
