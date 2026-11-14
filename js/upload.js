// Envoi des images de relevé vers le serveur (POST /samples).
//
// Découpé en deux : `lots()`, `descriptionDe()` et `deviceId()` sont des fonctions pures,
// testées sans réseau ; `envoyer()` fait les requêtes. Le serveur range les images, il ne
// les analyse pas (voir docs/strategie-materiel-et-modele.md).
//
// Règle qui compte : on n'efface du téléphone QUE les images dont le serveur a accusé
// réception. Un envoi coupé en route ne doit jamais perdre une image jamais arrivée.

export const LOT = 10;              // images par requête ; le serveur en accepte 50 au plus

/** Découpe une liste en lots de `taille`. */
export function lots(samples, taille = LOT) {
  const out = [];
  for (let i = 0; i < samples.length; i += taille) out.push(samples.slice(i, i + taille));
  return out;
}

/**
 * Traduit un échantillon d'IndexedDB vers le format attendu par le serveur.
 * Renvoie null si l'image n'a pas de position : le serveur la refuserait, et tout un lot
 * serait rejeté à cause d'une seule image prise sans GPS.
 */
export function descriptionDe(s) {
  if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lon)) return null;
  return {
    sample_id: String(s.id),
    captured_at: s.created,
    lat: s.lat,
    lon: s.lon,
    accuracy_m: Number.isFinite(s.accuracy) ? s.accuracy : null,
    heading_deg: Number.isFinite(s.heading) ? s.heading : null,
    pitch_deg: Number.isFinite(s.pitch) ? s.pitch : null,
    width_px: s.width,
    height_px: s.height,
    model: s.model || "",
    kind: s.kind || "releve",
    detections: s.detections || [],
  };
}

// Le serveur n'accepte que ce motif (app/reports.py : device_hash).
export const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Code de collecteur : tiré au hasard la première fois, gardé sur le téléphone.
 * Ce n'est PAS une identité — le serveur n'en garde qu'une empreinte SHA-256. Il sert
 * seulement à regrouper les envois d'une même personne, y compris depuis plusieurs
 * appareils si elle y recopie le même code.
 */
export function deviceId(store) {
  let id = store.get("va-device-id", null);
  if (!CODE_RE.test(id || "")) {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    id = [...b].map(x => x.toString(36).padStart(2, "0")).join("").slice(0, 40);
    store.set("va-device-id", id);
  }
  return id;
}

/**
 * Reprend un code existant sur un autre appareil : les envois se regroupent.
 * @returns {string|null} le code retenu, ou null si la saisie ne convient pas.
 */
export function setDeviceId(store, saisie) {
  const code = String(saisie ?? "").trim();
  if (!CODE_RE.test(code)) return null;
  store.set("va-device-id", code);
  return code;
}

/**
 * Envoie les images par lots.
 * @returns {Promise<{envoyes: string[], refuses: {id: string, raison: string}[]}>}
 *   `envoyes` : les sample_id acceptés OU déjà connus du serveur — dans les deux cas l'image
 *   est arrivée, donc effaçable du téléphone.
 */
export async function envoyer(samples, {url, device, onProgress = () => {}} = {}) {
  const envoyes = [], refuses = [], utiles = [];
  for (const s of samples) {
    const d = descriptionDe(s);
    if (d) utiles.push([s, d]);
    else refuses.push({id: String(s?.id ?? ""), raison: "sans position"});
  }
  let faits = 0;
  for (const lot of lots(utiles)) {
    const form = new FormData();
    form.append("metas", JSON.stringify(lot.map(([, d]) => d)));
    for (const [s, d] of lot) form.append("images", s.blob, `${d.sample_id}.jpg`);
    const r = await fetch(url, {method: "POST", body: form,
                                headers: device ? {"X-Device-Id": device} : {}});
    if (!r.ok) {
      for (const [, d] of lot) refuses.push({id: d.sample_id, raison: `serveur : ${r.status}`});
    } else {
      for (const a of await r.json()) envoyes.push(a.sample_id);
    }
    faits += lot.length;
    onProgress(faits, utiles.length);
  }
  return {envoyes, refuses};
}
