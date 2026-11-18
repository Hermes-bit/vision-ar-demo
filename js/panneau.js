// Le panneau du guidage, composé selon les besoins déclarés.
//
// LES PROFILS SE CUMULENT
// Quelqu'un peut être en fauteuil ET malentendant. Les maquettes du 18/11/2026 montraient sept
// écrans exclusifs, un par handicap ; l'appli, elle, garde `S.mobilities` dans un ensemble depuis
// toujours. Le panneau n'est donc pas un gabarit par handicap, mais une liste de sections dont
// chacune est réclamée par un besoin. Deux besoins, deux sections.
//
// OÙ IL S'AFFICHE, ET POURQUOI PAS AILLEURS
// Dans le panneau du guidage réduit, pas sous la caméra. Sous la caméra se trouve la carte en
// dôme, et la remplacer priverait tout le monde du plan pour satisfaire une maquette. Le guidage
// réduit est par ailleurs l'écran de qui n'a pas besoin de la caméra — un malentendant, ou
// quiconque a décoché son ouverture au départ.
import {DANGER} from "./speech.js";

export const MAX_CONSIGNES = 4;

const EN_FAUTEUIL = new Set(["manual_wheelchair", "electric_wheelchair"]);
const EFFORT = new Set([...EN_FAUTEUIL, "cane_or_walker"]);

const a = (mobilites, m) => !!mobilites && (mobilites.has ? mobilites.has(m) : [...mobilites].includes(m));

/**
 * Les sections à montrer, dans l'ordre où elles comptent.
 *
 * « consignes » vient en premier quand on n'entend pas : c'est ce qui remplace la voix, et le
 * reste peut attendre. L'effort suit, pour qui pousse ou s'appuie. La communication ferme la
 * marche : elle sert à l'arrêt, pas en marchant.
 */
export function sectionsPanneau(mobilites) {
  const out = [];
  if (a(mobilites, "hard_of_hearing")) out.push("consignes");
  if ([...(mobilites || [])].some(m => EFFORT.has(m))) out.push("effort");
  if (a(mobilites, "hard_of_hearing") || a(mobilites, "low_vision")) out.push("communication");
  return out;
}

/**
 * Les dernières consignes dites, la plus récente d'abord.
 *
 * Sans répétition : « Continuez tout droit » annoncé trois fois remplirait la liste et chasserait
 * le virage qu'on cherche. On garde la plus récente de chaque texte.
 * @param {Array<{texte: string, at: number}>} entrees
 */
export function historique(entrees, max = MAX_CONSIGNES) {
  const vues = new Set(), out = [];
  for (const e of [...(entrees || [])].sort((x, y) => y.at - x.at)) {
    if (!e?.texte || vues.has(e.texte)) continue;
    vues.add(e.texte);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Le message de la carte à montrer à un chauffeur ou à un passant.
 *
 * Le texte de la proposition donnait cette carte aux malvoyants, la maquette aux malentendants.
 * Les deux ont raison pour des raisons différentes : l'un ne peut pas entendre la réponse,
 * l'autre ne peut pas lire le panneau d'arrêt. Le message suit donc ce qui est déclaré.
 *
 * Rien n'est dit du handicap qui n'a pas été déclaré : le profil est une donnée de santé, et
 * cette carte est le seul endroit où l'usager choisit lui-même de la montrer.
 */
export function phraseCommunication(mobilites, destination = "") {
  const sourd = a(mobilites, "hard_of_hearing"), malvoyant = a(mobilites, "low_vision");
  if (!sourd && !malvoyant) return null;
  const qui = sourd && malvoyant ? "Je suis sourd(e) ou malentendant(e), et malvoyant(e)."
    : sourd ? "Je suis sourd(e) ou malentendant(e)." : "Je suis malvoyant(e).";
  const ou = destination ? ` Je vais à : ${destination}.` : "";
  const aide = sourd ? " Pouvez-vous me prévenir à l'arrêt, ou m'écrire votre réponse ?"
    : " Pouvez-vous me dire où je suis, ou m'indiquer le chemin ?";
  return `${qui}${ou}${aide}`;
}

/**
 * Faut-il faire clignoter le bord de l'écran pour cette annonce ?
 *
 * Seulement pour un danger, et seulement si l'on a déclaré ne pas entendre. Clignoter à chaque
 * consigne reviendrait à ne plus rien signaler du tout.
 */
export function clignoter(mobilites, niveau) {
  return a(mobilites, "hard_of_hearing") && niveau === DANGER;
}

// ---- Le contenu du panneau, d'après les maquettes du 18/11/2026 ------------------------------
//
// Les maquettes dessinent un écran par handicap. Comme les profils se cumulent, on produit des
// BLOCS que l'écran empile dans l'ordre : le besoin le plus contraignant d'abord.
//
// LA RÈGLE DU 18/11 : une valeur absente garde sa place et s'affiche « non renseigné ».
// Choix de l'usager, contre l'option de masquer la ligne. Masquer laisserait croire qu'il n'y a
// rien à signaler ; « non renseigné » dit qu'on ne sait pas, et montre à quoi sert le relevé.
// Jamais de zéro à la place : sur le réseau de Gennevilliers le dévers est connu sur 0,0 % des
// tronçons, et « Pavés : 0 m » y promettrait un sol lisse que personne n'a mesuré.

/** Une valeur mesurée, ou le constat qu'on ne la connaît pas. */
export function valeur(v, texte) {
  return v === null || v === undefined ? {texte: "non renseigné", connu: false}
                                       : {texte, connu: true};
}

const metres = m => `${Math.round(m)} m`;
const pct = v => `${String(Math.round(v * 10) / 10).replace(".", ",")} %`;

/**
 * Les blocs à afficher, dans l'ordre.
 *
 * @param {Set<string>} mobilites  les besoins déclarés (ils se cumulent)
 * @param {object} d               ce qu'on a pu mesurer ; chaque champ absent vaut « inconnu »
 * @returns {Array<object>} blocs : {type, ...}
 */
export function blocsPanneau(mobilites, d = {}) {
  const blocs = [];
  const sourd = a(mobilites, "hard_of_hearing"), malvoyant = a(mobilites, "low_vision");
  const fauteuil = [...(mobilites || [])].some(m => EN_FAUTEUIL.has(m));
  const electrique = a(mobilites, "electric_wheelchair");
  const appui = a(mobilites, "cane_or_walker");

  // Ne pas entendre passe avant tout : l'alerte et les consignes remplacent la voix.
  if (sourd) {
    if (d.alerte?.texte) blocs.push({type: "bandeau", texte: d.alerte.texte});
    blocs.push({type: "consignes", titre: "Dernières consignes", entrees: historique(d.consignes || []),
                note: "Le bord de l'écran clignote et le téléphone vibre à chaque alerte."});
  }

  if (fauteuil && !electrique) {
    const e = d.effort || {};
    blocs.push({type: "effort", libelle: "Effort estimé", niveau: e.niveau || null});
    blocs.push({type: "pastilles", items: [
      {cle: "pente", ...valeur(e.pente, `Pente max ${pct(e.pente)}${e.penteRaideM ? ` · ${metres(e.penteRaideM)}` : ""}`),
       alerte: !!e.penteRaideM},
      {cle: "devers", ...valeur(e.devers, `Dévers ${pct(e.devers)}`), alerte: false},
      {cle: "revetement", ...valeur(e.revetementM, `Pavés : ${metres(e.revetementM)}`), alerte: e.revetementM > 0},
      {cle: "bordures", ...valeur(e.bordureHaute, e.bordureHaute ? `${e.bordureHaute} bordure(s) haute(s)` : "Bordures abaissées"),
       alerte: !!e.bordureHaute},
    ]});
    blocs.push({type: "ligne", cle: "pause", icone: "pause", titre: "Pause possible avant la montée",
                detail: "Banc et palier plat", ...valeur(d.pause?.distanceM, metres(d.pause?.distanceM))});
  }

  if (electrique) {
    const f = d.fauteuil;
    blocs.push({type: "entete", texte: f
      ? `VOTRE FAUTEUIL · ${f.largeurCm} × ${f.longueurCm} cm · ${f.poidsKg} kg`
      : "VOTRE FAUTEUIL · dimensions non renseignées", connu: !!f});
    blocs.push({type: "ligne", cle: "passage", icone: "narrow", titre: "Passage entre potelets",
                detail: d.passageEtroit?.largeurM ? `Large de ${pct(d.passageEtroit.largeurM * 100).replace(" %", " cm")}` : "Largeur non mesurée",
                ...valeur(d.passageEtroit?.distanceM, metres(d.passageEtroit?.distanceM))});
    blocs.push({type: "ligne", cle: "ascenseur", icone: "elevator", titre: "Ascenseur",
                detail: "Dimensions de cabine non renseignées",
                ...valeur(d.ascenseur?.distanceM, metres(d.ascenseur?.distanceM))});
    blocs.push({type: "ligne", cle: "virage", icone: "corner-up-right", titre: "Virage serré",
                detail: "Rayon de demi-tour non mesuré",
                ...valeur(d.virageSerre?.distanceM, metres(d.virageSerre?.distanceM))});
  }

  if (appui) {
    blocs.push({type: "frise", etapes: d.frise || []});
    blocs.push({type: "ligne", cle: "banc", icone: "pause", titre: "Prochain banc",
                detail: d.banc?.minutes ? `environ ${d.banc.minutes} min` : "aucun banc cartographié ici",
                ...valeur(d.banc?.distanceM, metres(d.banc?.distanceM))});
    blocs.push({type: "ligne", cle: "escalier", icone: "stairs", titre: "Escalier",
                detail: d.escalier?.marches ? `${d.escalier.marches} marches` : "main courante non renseignée",
                ...valeur(d.escalier?.distanceM, metres(d.escalier?.distanceM))});
    if (d.traversee) {
      blocs.push({type: "traversee", distanceM: d.traversee.distanceM,
                  vert: valeur(d.traversee.dureeVertS, `${Math.round(d.traversee.dureeVertS)} s`),
                  moi: valeur(d.traversee.monTempsS, `${Math.round(d.traversee.monTempsS)} s`),
                  conseil: "Attendez le début du vert pour traverser"});
    }
  }

  if (malvoyant) {
    blocs.push({type: "titre", texte: "Ce qui vous attend"});
    blocs.push({type: "ligne", cle: "podotactile", icone: "stairs", titre: "Bande podotactile",
                detail: "Avant le passage piéton",
                ...valeur(d.podotactile?.distanceM, metres(d.podotactile?.distanceM))});
    blocs.push({type: "ligne", cle: "feu_sonore", icone: "volume-2", titre: "Feu sonore",
                detail: "Télécommande activable",
                ...valeur(d.feuSonore?.distanceM, metres(d.feuSonore?.distanceM))});
    blocs.push({type: "ligne", cle: "mur", icone: "layers", titre: "Mur à suivre",
                detail: "Contour des bâtiments non importé",
                ...valeur(d.mur?.distanceM, metres(d.mur?.distanceM))});
    blocs.push({type: "bouton", cle: "decrire", texte: "Décrire ce qui m'entoure", principal: true});
  }

  if (sourd || malvoyant) {
    const p = phraseCommunication(mobilites, d.destination || "");
    if (p) {
      blocs.push({type: "communication", entete: "À MONTRER AU CHAUFFEUR OU À UN PASSANT", texte: p,
                  boutons: [{cle: "ecrire", texte: "Écrire un message"},
                            {cle: "transcrire", texte: "Transcrire la parole"}]});
    }
  }
  return blocs;
}
