// « Jusqu'à la bonne porte » : l'arrivée dans un bâtiment.
//
// 1. Si le lieu a une entrée accessible connue (OpenStreetMap : entrance + wheelchair=yes), l'itinéraire va
//    jusqu'à ELLE, et non au centre du bâtiment ou à l'escalier principal.
// 2. Une fiche « À l'arrivée » dit en phrases simples comment entrer et ce qu'on trouve à l'intérieur :
//    données Acceslibre (fichier data/<zone>.acces.json, exporté par server/scripts/import_acceslibre.py,
//    Licence Ouverte), complétées par OpenStreetMap (accessibilité du lieu, toilettes, ascenseurs, places PMR).
//    Elle est affichée avec les itinéraires et lue à voix haute à l'arrivée. Tout est sur le téléphone (hors ligne).
import {haversineM} from "./routing.js";

const ENTRANCE_M = 50, ERP_M = 60, AROUND_M = 100;
let acces = [], accesSource = "", common = new Set();
const norm = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Établissements Acceslibre (ERP) : [nom, …, lat, lon, fiche] — affichés sur la carte avec « M'y guider »
export const erpList = () => acces;
export async function loadAcces(zoneId) {
  try {
    const d = await fetch(`data/${zoneId}.acces.json`).then(r => r.ok ? r.json() : null);
    acces = d?.erps || []; accesSource = d?.source || "";
    // mots trop fréquents (nom de la ville, « pharmacie »…) : ils ne suffisent pas à reconnaître un lieu
    const freq = new Map();
    for (const e of acces) for (const w of new Set(norm(e[0]).split(" "))) freq.set(w, (freq.get(w) || 0) + 1);
    common = new Set([...freq].filter(([, k]) => k >= Math.max(3, acces.length * 0.02)).map(([w]) => w));
  } catch { acces = []; }
}

// Les deux segments [a, b] et [c, d] se coupent-ils ? (points {lat, lon}, plan local)
function segmentsCross(a, b, c, d) {
  const k = Math.cos(a.lat * Math.PI / 180);
  const P = q => [(q.lon - a.lon) * k, q.lat - a.lat];
  const [A, B, C, D] = [P(a), P(b), P(c), P(d)];
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(A, B, C) * o(A, B, D) < 0 && o(C, D, A) * o(C, D, B) < 0;
}
// Y a-t-il une rue (chaussée ou passage piéton) entre l'adresse et l'entrée ?
export function streetBetween(net, a, b) {
  const pad = 0.0005, minLat = Math.min(a.lat, b.lat) - pad, maxLat = Math.max(a.lat, b.lat) + pad,
        minLon = Math.min(a.lon, b.lon) - pad, maxLon = Math.max(a.lon, b.lon) + pad;
  for (const e of net.edges) {
    if (e.kind !== "street" && !e.is_crossing) continue;
    const sh = e.shape;
    if (!sh?.length) continue;
    for (let i = 1; i < sh.length; i++) {
      const [la1, lo1] = sh[i - 1], [la2, lo2] = sh[i];
      if (Math.max(la1, la2) < minLat || Math.min(la1, la2) > maxLat || Math.max(lo1, lo2) < minLon || Math.min(lo1, lo2) > maxLon) continue;
      if (segmentsCross(a, b, {lat: la1, lon: lo1}, {lat: la2, lon: lo2})) return true;
    }
  }
  return false;
}
/**
 * Entrée accessible du bâtiment de l'adresse : la plus proche à moins de 50 m, SANS rue entre l'adresse et
 * elle (une entrée de l'autre côté de la rue est celle d'un autre bâtiment). Sinon : null, on va à l'adresse.
 * `note` signale une incohérence (entrée connue plus loin que 50 m, ou de l'autre côté de la rue).
 */
export function entranceFor(net, place) {
  const cands = [];
  for (const [kind, lat, lon, name] of net.pois) {
    if (kind !== "accessible_entrance") continue;
    const d = haversineM(place.lat, place.lon, lat, lon);
    if (d <= 2 * ENTRANCE_M) cands.push({lat, lon, name, d});
  }
  cands.sort((x, y) => x.d - y.d);
  let note = "";
  for (const c of cands) {
    if (c.d > ENTRANCE_M) { note ||= `Entrée accessible signalée à ${Math.round(c.d)} m de l'adresse : trop loin pour être sûre, guidage jusqu'à l'adresse`; continue; }
    if (streetBetween(net, place, c)) { note ||= "Une entrée accessible est signalée de l'autre côté de la rue : guidage jusqu'à l'adresse"; continue; }
    return {entrance: c, note: ""};
  }
  if (note) console.warn("Arrivée :", note, place.label);
  return {entrance: null, note};
}
// Compatibilité : seulement l'entrée retenue
export const accessibleEntrance = (net, place) => entranceFor(net, place).entrance;

// Établissement Acceslibre qui correspond au lieu : un mot distinctif du nom en commun à moins de 60 m,
// ou le plus proche à moins de 20 m
function matchErp(place) {
  const words = new Set(norm(place.label).split(" ").filter(w => w.length > 2 && !common.has(w)));
  let best = null;
  for (const e of acces) {
    const d = haversineM(place.lat, place.lon, e[2], e[3]);
    if (d > ERP_M) continue;
    const common = norm(e[0]).split(" ").filter(w => words.has(w)).length;
    const score = common * 100 - d;
    if ((common > 0 || d <= 20) && (!best || score > best.score)) best = {e, d, score};
  }
  return best?.e || null;
}

const EQUIP = {bim: "boucle magnétique", lsf: "langue des signes", lpc: "langage parlé complété", sts: "sous-titrage", autres: "autres aides"};
const n = v => Math.round(Number(v));
const plural = (k, w) => `${k} ${w}${k > 1 ? "s" : ""}`;

// Phrases de la fiche, chacune avec une icône et un ton (good : rassurant, bad : point d'attention, info)
function fromErp(f) {
  const L = [], add = (ic, text, tone = "info") => L.push({ic, text, tone});
  // dehors, jusqu'à la porte
  if (f.stationnement_pmr || f.stationnement_ext_pmr) add("accessibility", "Place de stationnement réservée à proximité", "good");
  if (f.cheminement_ext_plain_pied === false) {
    const m = n(f.cheminement_ext_nombre_marches || 0);
    add("stairs", `${m ? plural(m, "marche") : "Des marches"} avant l'entrée${f.cheminement_ext_rampe === "fixe" ? ", avec une rampe fixe" : f.cheminement_ext_rampe === "amovible" ? ", rampe amovible sur demande" : ""}`,
      f.cheminement_ext_rampe === "fixe" ? "info" : "bad");
  }
  if (f.cheminement_ext_ascenseur) add("elevator", "Ascenseur sur le chemin de l'entrée", "good");
  if (f.cheminement_ext_pente_presence) add("mountain", `Pente avant l'entrée${f.cheminement_ext_pente_degre_difficulte === "importante" ? ", importante" : ""}`,
    f.cheminement_ext_pente_degre_difficulte === "importante" ? "bad" : "info");
  if (f.cheminement_ext_retrecissement) add("narrow", "Passage rétréci avant l'entrée", "bad");
  if (f.cheminement_ext_terrain_stable === false) add("triangle-alert", "Sol instable avant l'entrée", "bad");
  if (f.cheminement_ext_bande_guidage) add("footprints", "Bande de guidage au sol jusqu'à l'entrée", "good");
  // l'entrée
  if (f.entree_plain_pied) add("door-open", "Entrée de plain-pied, sans marche", "good");
  else if (f.entree_plain_pied === false) {
    const m = n(f.entree_marches || 0);
    const ramp = f.entree_marches_rampe === "fixe" ? ", avec une rampe fixe" : f.entree_marches_rampe === "amovible" ? ", rampe amovible sur demande" : f.entree_marches_rampe === "aucune" ? ", sans rampe" : "";
    add("stairs", `Entrée avec ${m ? plural(m, "marche") : "des marches"}${ramp}`, f.entree_marches_rampe === "fixe" || f.entree_ascenseur ? "info" : "bad");
  }
  if (f.entree_ascenseur) add("elevator", "Ascenseur ou élévateur à l'entrée", "good");
  if (f.entree_largeur_mini) add("move-horizontal", `Porte de ${n(f.entree_largeur_mini)} cm de large`, n(f.entree_largeur_mini) >= 77 ? "good" : "bad");
  if (f.entree_porte_type === "automatique") add("door-open", `Porte automatique${f.entree_porte_manoeuvre === "coulissante" ? " coulissante" : ""}`, "good");
  else if (f.entree_porte_type === "manuelle") add("door-closed", `Porte à ouvrir soi-même${f.entree_porte_manoeuvre ? ` (${f.entree_porte_manoeuvre})` : ""}`, "info");
  if (f.entree_porte_manoeuvre === "tambour" || f.entree_porte_manoeuvre === "tourniquet") add("triangle-alert", `Porte ${f.entree_porte_manoeuvre} : difficile en fauteuil`, "bad");
  if (f.entree_dispositif_appel) {
    const types = (() => { try { return JSON.parse(String(f.entree_dispositif_appel_type || "[]").replace(/'/g, '"')); } catch { return []; } })();
    add("bell", `${types.length ? types.join(" ou ").replace(/^./, c => c.toUpperCase()) : "Sonnette"} à l'entrée pour demander de l'aide`, "good");
  }
  if (f.entree_balise_sonore) add("volume-2", "Balise sonore à l'entrée", "good");
  if (f.entree_aide_humaine) add("hand-helping", "Aide humaine possible à l'entrée", "good");
  if (f.entree_vitree && !f.entree_reperage) add("triangle-alert", "Entrée vitrée, peu repérable", "bad");
  // à l'intérieur
  if (f.accueil_cheminement_plain_pied) add("accessibility", "De l'entrée à l'accueil : de plain-pied", "good");
  else if (f.accueil_cheminement_plain_pied === false) {
    const m = n(f.accueil_cheminement_nombre_marches || 0);
    add("stairs", `Jusqu'à l'accueil : ${m ? plural(m, "marche") : "des marches"}${f.accueil_cheminement_rampe === "fixe" ? ", avec une rampe" : ""}${f.accueil_cheminement_ascenseur ? ", ou un ascenseur" : ""}`,
      f.accueil_cheminement_rampe === "fixe" || f.accueil_cheminement_ascenseur ? "info" : "bad");
  }
  if (f.accueil_retrecissement) add("narrow", "Passage rétréci à l'intérieur", "bad");
  if (f.accueil_personnels === "formés") add("user-round", "Personnel formé à l'accueil des personnes handicapées", "good");
  else if (f.accueil_personnels === "non-formés") add("user-round", "Personnel présent à l'accueil", "info");
  else if (f.accueil_personnels === "aucun") add("user-round", "Pas de personnel à l'accueil", "info");
  if (f.accueil_equipements_malentendants_presence) {
    const codes = (() => { try { return JSON.parse(String(f.accueil_equipements_malentendants || "[]").replace(/'/g, '"')); } catch { return []; } })();
    add("ear", `Pour les personnes sourdes ou malentendantes : ${codes.map(c => EQUIP[c] || c).join(", ") || "équipement disponible"}`, "good");
  }
  if (f.accueil_audiodescription_presence) add("volume-2", "Audiodescription disponible", "good");
  if (f.sanitaires_presence) add("accessibility", f.sanitaires_adaptes ? "Toilettes adaptées" : "Toilettes, non adaptées aux fauteuils", f.sanitaires_adaptes ? "good" : "bad");
  return L;
}

/**
 * Fiche d'arrivée : {name, lines: [{ic, text, tone}], sources: [...], entrance}.
 * `net` : réseau de la zone (pois, places) ; `place` : destination choisie ; `entrance` : entrée accessible retenue.
 */
export function arrivalFiche(net, place, entrance, note = "") {
  const lines = [], sources = new Set();
  if (note) lines.push({ic: "info", text: note, tone: "info"});
  if (entrance) { lines.push({ic: "door-open", text: `Itinéraire jusqu'à l'entrée accessible${entrance.name ? ` (${entrance.name})` : ""}`, tone: "good"}); sources.add("OpenStreetMap"); }
  const erp = matchErp(place);
  if (erp) { lines.push(...fromErp(erp[4])); sources.add(accesSource || "Acceslibre"); }
  // OpenStreetMap : accessibilité du lieu (si Acceslibre ne dit rien de l'entrée)
  const p = net.places.find(x => haversineM(place.lat, place.lon, x[1], x[2]) < 30 && norm(x[3]) && norm(place.label).includes(norm(x[3])));
  if (p && !erp) {
    const t = {yes: ["Lieu accessible en fauteuil", "good"], limited: ["Lieu en partie accessible en fauteuil", "info"], no: ["Lieu non accessible en fauteuil", "bad"]}[p[4]];
    if (t) { lines.push({ic: "accessibility", text: t[0], tone: t[1]}); sources.add("OpenStreetMap"); }
  }
  // Autour : toilettes adaptées, ascenseurs, places réservées (OpenStreetMap)
  const near = kind => net.pois.filter(q => q[0] === kind && haversineM(place.lat, place.lon, q[1], q[2]) <= AROUND_M);
  const hasLine = re => lines.some(l => re.test(l.text));
  if (near("accessible_toilet").length && !hasLine(/Toilettes/)) lines.push({ic: "accessibility", text: "Toilettes adaptées à moins de 100 m", tone: "good"});
  if (near("elevator").length && !hasLine(/Ascenseur/)) lines.push({ic: "elevator", text: "Ascenseur public à proximité", tone: "good"});
  if (near("disabled_parking").length && !hasLine(/stationnement/)) lines.push({ic: "accessibility", text: `${plural(near("disabled_parking").length, "place")} de stationnement réservée${near("disabled_parking").length > 1 ? "s" : ""} à moins de 100 m`, tone: "good"});
  if (near("accessible_toilet").length || near("elevator").length || near("disabled_parking").length) sources.add("OpenStreetMap");
  return {name: place.label, lines, sources: [...sources], erp: !!erp};
}

// Texte lu à l'arrivée : les points d'attention d'abord, puis l'essentiel (au plus 5 phrases)
export function arrivalSpeech(fiche) {
  if (!fiche?.lines.length) return "";
  const order = [...fiche.lines.filter(l => l.tone === "bad"), ...fiche.lines.filter(l => l.tone !== "bad")].slice(0, 5);
  return `À l'arrivée : ${order.map(l => l.text.charAt(0).toLowerCase() + l.text.slice(1)).join(". ")}.`;
}
