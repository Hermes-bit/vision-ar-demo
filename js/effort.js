// Résumé d'effort d'un itinéraire — honnête sur ce qu'on ignore.
//
// POURQUOI CE MODULE EXISTE
// Les maquettes du 18/11/2026 proposaient des pastilles « Dévers 2 % » et « Pavés : 0 m ».
// Mesuré sur le réseau de Gennevilliers, 8 946 tronçons : le dévers est connu sur 0,0 % d'entre
// eux, la largeur sur 0,9 %, le revêtement est « unknown » sur 69 %. « Pavés : 0 m » dirait donc
// « pas de pavés » là où la vérité est « on ne sait pas » — et pour un fauteuil manuel, c'est la
// différence entre un trajet et une sortie de route.
//
// LA RÈGLE : AUCUN CHIFFRE SANS SA COUVERTURE.
// Chaque mesure porte la part du trajet sur laquelle elle est établie. En dessous de
// COUVERTURE_MIN elle est marquée non fiable, et l'écran doit dire « on ne sait pas » plutôt
// qu'un chiffre rassurant. Le moteur est déjà honnête ainsi : il facture l'ignorance +25 %
// (UNKNOWN_DATA_FACTOR). Un écran affichant zéro contredirait le calcul qui, lui, s'en méfie.
//
// L'EFFORT N'EST PAS UNE INVENTION
// Le niveau vient du rapport entre le coût d'effort que le moteur a payé pour ce trajet et sa
// longueur réelle. 1,0 = plat, sans rien qui coûte. 1,5 = la moitié de peine en plus. C'est la
// mesure que le produit utilise déjà pour choisir l'itinéraire (PRODUCT.md, C2), pas une
// seconde échelle bricolée pour l'affichage.
import {arcCost, resolveProfile} from "./routing.js";

export const COUVERTURE_MIN = 0.6;     // en deçà, on ne montre pas un chiffre : on dit qu'on ignore
export const SEUIL_MODERE = 1.25;      // décisions produit, au même titre que les constantes de coût
export const SEUIL_SOUTENU = 1.8;
export const SEUIL_DOUTE = 0.4;        // au-delà, le niveau d'effort est surtout le prix de l'ignorance
const RAISON_INCOMPLET = "données incomplètes";   // mot pour mot celui de routing.js

/**
 * Le sens de parcours de chaque tronçon, déduit de l'enchaînement des nœuds.
 *
 * `slope_pct` est signé dans le sens source → target. Le prendre à l'envers transformerait une
 * montée en descente, et le moteur facture la montée trois fois plus que la descente (12 %
 * contre 4 %) : sans ce calcul, le niveau d'effort serait faux précisément dans les côtes.
 */
export function sensDesAretes(aretes) {
  const sens = [];
  for (let i = 0; i < aretes.length; i++) {
    const e = aretes[i];
    if (i > 0) {
      const finPrec = sens[i - 1] ? aretes[i - 1].target : aretes[i - 1].source;
      sens.push(e.source === finPrec);
      continue;
    }
    const suiv = aretes[1];                       // la première se lit sur celle qui la suit
    sens.push(!suiv || e.target === suiv.source || e.target === suiv.target);
  }
  return sens;
}

/**
 * Une valeur et ce qu'elle vaut : sur quelle part du trajet elle est établie.
 * @returns {{valeur: *, couverture: number, fiable: boolean}}
 */
export function mesure(valeur, connuM, totalM) {
  const couverture = totalM > 0 ? Math.min(1, connuM / totalM) : 0;
  return {valeur, couverture, fiable: couverture >= COUVERTURE_MIN};
}

/** « faible », « modéré » ou « soutenu », depuis le rapport coût d'effort / longueur réelle. */
export function niveauEffort(rapport) {
  if (!Number.isFinite(rapport) || rapport <= 0) return null;
  return rapport < SEUIL_MODERE ? "faible" : rapport < SEUIL_SOUTENU ? "modéré" : "soutenu";
}

/**
 * Résume un itinéraire calculé pour le profil donné.
 *
 * Chaque mesure est accompagnée de sa couverture. `incomplet` dit la part du trajet que le
 * MOTEUR lui-même a jugée mal renseignée : c'est son mot, pas une seconde appréciation.
 * @returns {object|null} null si l'itinéraire est vide ou introuvable dans le réseau
 */
export function resumeEffort(net, route, profil) {
  const total = route?.length_m || 0;
  const aretes = (route?.edge_ids || []).map(id => net?.edges?.[id]).filter(Boolean);
  if (!total || !aretes.length) return null;
  const p = resolveProfile(profil || {});
  const sens = sensDesAretes(aretes);

  let effort = 0, parcouru = 0, incompletM = 0;
  let penteM = 0, penteMax = 0, penteRaideM = 0;
  let deversM = 0, deversMax = 0;
  let surfaceM = 0, surfaceRugueuseM = 0;
  let largeurM = 0, largeurMin = Infinity;
  let marches = 0, traversees = 0, sansFeuSonor = 0, bordureHaute = 0;

  for (let i = 0; i < aretes.length; i++) {
    const e = aretes[i], L = e.length_m || 0;
    parcouru += L;
    const c = arcCost(e, p, sens[i]);
    effort += c.cost ?? L;                        // infranchissable : compté neutre, signalé ailleurs
    if (c.reasons.includes(RAISON_INCOMPLET)) incompletM += L;

    if (e.slope_pct != null) {
      penteM += L;
      penteMax = Math.max(penteMax, Math.abs(e.slope_pct));
      if (p.max_slope_pct != null && Math.abs(e.slope_pct) > p.max_slope_pct) penteRaideM += L;
    }
    if (e.cross_slope_pct != null) { deversM += L; deversMax = Math.max(deversMax, e.cross_slope_pct); }
    if (e.surface && e.surface !== "unknown") {
      surfaceM += L;
      if (c.reasons.includes("revêtement irrégulier")) surfaceRugueuseM += L;
    }
    if (e.width_m != null) { largeurM += L; largeurMin = Math.min(largeurMin, e.width_m); }
    if (e.has_step) marches++;
    if (e.is_crossing) {
      traversees++;
      if (e.sound_signal !== true) sansFeuSonor++;
      if (e.kerb_lowered === false) bordureHaute++;
    }
  }

  const base = parcouru || total;
  return {
    longueurM: total,
    dureeS: route.duration_s ?? null,
    niveau: niveauEffort(effort / base),
    rapport: effort / base,
    // Part du trajet facturée au tarif de l'ignorance. Au-delà de 40 %, le niveau d'effort est
    // surtout le prix du doute, et l'écran doit le dire au lieu de laisser croire à une mesure.
    incomplet: incompletM / base,
    pente: mesure(penteMax, penteM, base),
    penteRaideM,                                  // longueur au-delà de la pente que le profil tolère
    devers: mesure(deversM ? deversMax : null, deversM, base),
    revetementRugueux: mesure(surfaceRugueuseM, surfaceM, base),
    largeur: mesure(Number.isFinite(largeurMin) ? largeurMin : null, largeurM, base),
    marches,
    traversees,
    sansFeuSonor,
    bordureHaute,
  };
}

/**
 * Le niveau d'effort repose-t-il surtout sur du doute plutôt que sur des mesures ?
 * Si oui, l'écran doit le dire : un « effort faible » calculé sur un trajet inconnu aux deux
 * tiers n'est pas une bonne nouvelle, c'est une absence d'information.
 */
export function effortDouteux(resume) {
  return !!resume && resume.incomplet > SEUIL_DOUTE;
}

/**
 * Les lignes à montrer, et ce qu'on a le droit d'en dire.
 *
 * Deux règles, et ce sont elles que les tests protègent :
 *  1. on ne montre que ce qui concerne le profil déclaré — un piéton n'a que faire du dévers,
 *     et les profils se cumulent (quelqu'un peut être en fauteuil ET malvoyant) ;
 *  2. une mesure non fiable sort avec le ton « inconnu » et SANS valeur. Jamais un zéro.
 *
 * Rend des données, pas du texte : la mise en mots appartient à l'écran.
 * @returns {Array<{cle, ton, valeur, couverture, ...}>}
 */
export function lignesEffort(resume, profil) {
  if (!resume) return [];
  const p = resolveProfile(profil || {});
  const lignes = [];
  const ajouter = (cle, mes, extra = {}) => lignes.push(mes.fiable
    ? {cle, ton: "mesure", valeur: mes.valeur, couverture: mes.couverture, ...extra}
    : {cle, ton: "inconnu", valeur: null, couverture: mes.couverture});

  if (p.max_slope_pct != null) ajouter("pente", resume.pente, {auDelaM: resume.penteRaideM});
  if (p.max_cross_slope_pct != null) ajouter("devers", resume.devers);
  if (p.avoid_rough_surfaces) ajouter("revetement", resume.revetementRugueux);
  if (p.min_width_m != null) ajouter("largeur", resume.largeur);
  if (p.steps_allowed === false && resume.marches > 0) {
    lignes.push({cle: "marches", ton: "attention", valeur: resume.marches, couverture: 1});
  }
  if (p.prefers_sound_signals && resume.traversees > 0) {
    lignes.push({cle: "feu_sonore", ton: resume.sansFeuSonor ? "attention" : "mesure",
                 valeur: resume.sansFeuSonor, total: resume.traversees, couverture: 1});
  }
  return lignes;
}
