// Le flux caméra est-il mort ?
//
// Terrain du 18/11/2026 : l'image se fige en pleine marche, et le recalcul d'itinéraire s'arrête
// avec elle. Le contrôle qui existait avait deux trous.
//
// 1. IL NE TOURNAIT QU'AU RETOUR DANS L'APPLI. La relance de la caméra vivait dans le gestionnaire
//    de `visibilitychange` (ar.js). Or un flux peut mourir sans que l'appli passe en arrière-plan :
//    capture d'écran, enregistrement vidéo, une autre appli qui prend l'objectif. Dans ces cas-là
//    rien ne le relançait, jusqu'à ce que l'usager quitte l'appli et y revienne. C'est le trou
//    certain, et c'est celui que la surveillance continue referme.
//
// 2. IL NE REGARDAIT QUE `ended` ET `paused`. Sur iPhone, une piste interrompue reste souvent
//    « live » et passe à `muted`. C'est l'hypothèse la plus probable pour l'image figée pendant
//    une capture d'écran — à confirmer sur le terrain, mais la tester ne coûte rien et ne peut
//    pas nuire : au pire on relance une caméra qui allait bien.
//
// Ce fichier ne relance rien : il répond à la question. La relance est dans ar.js, avec un verrou
// pour qu'elle ne parte jamais deux fois en même temps.

export const VERIF_MS = 1000;   // une vérification par seconde : on ne reste jamais figé longtemps

/**
 * @param {{readyState?: string, muted?: boolean}|null|undefined} piste  la piste vidéo du flux
 * @param {{paused?: boolean, ended?: boolean}|null|undefined} video     l'élément <video>
 * @returns {boolean} vrai s'il faut relancer la caméra
 */
export function cameraMorte(piste, video) {
  if (!piste || piste.readyState === "ended" || piste.muted === true) return true;
  if (!video) return true;
  return video.paused === true || video.ended === true;
}
