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
