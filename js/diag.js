// Diagnostic de la vue AR, lisible sur le téléphone pendant la marche.
//
// POURQUOI MESURER AVANT DE CORRIGER
// Deux anomalies du terrain du 18/11/2026 restent sans cause prouvée :
//   — l'image se fige pendant la détection d'obstacles (bug 3). Suspect : `getImageData` dans
//     js/obstacles.js, un rapatriement mémoire bloquant, appelé jusqu'à trois fois par seconde ;
//   — la vidéo s'affiche parfois réduite et encadrée de noir pendant que le tracé occupe toute
//     la largeur (bug 4). Aucune explication tenable dans la CSS ni dans le calcul de focale.
// Réécrire la détection sur un soupçon risquerait de casser ce qui marche. Une sortie avec ces
// chiffres sous les yeux tranche les deux en quelques minutes.
//
// Ce fichier ne mesure rien lui-même : il reçoit des nombres déjà relevés et rend les lignes à
// afficher. C'est ce qui le rend vérifiable sans téléphone ni caméra.

/** Garde les dernières durées et en rend le minimum, la médiane et le maximum. */
export function creerMesureur(taille = 40) {
  const v = [];
  return {
    ajouter(ms) {
      if (!Number.isFinite(ms)) return;
      v.push(ms);
      if (v.length > taille) v.shift();
    },
    stats() {
      if (!v.length) return null;
      const t = [...v].sort((a, b) => a - b);
      return {n: t.length, min: t[0], med: t[t.length >> 1], max: t.at(-1)};
    },
  };
}

/**
 * La vidéo et le canevas occupent-ils la même boîte à l'écran ?
 *
 * C'est la mesure décisive du bug 4 : les deux portent la même règle CSS (plein écran,
 * `object-fit: cover`). S'ils diffèrent, l'anomalie est visible en chiffres au lieu d'être
 * devinée sur une capture.
 */
export function memeCadre(videoBox, canvasBox, tolerancePx = 2) {
  if (!videoBox || !canvasBox) return false;
  return Math.abs(videoBox.w - canvasBox.w) <= tolerancePx
      && Math.abs(videoBox.h - canvasBox.h) <= tolerancePx;
}

const ms = s => s ? `${Math.round(s.min)} / ${Math.round(s.med)} / ${Math.round(s.max)} ms` : "—";
const taille = b => b ? `${Math.round(b.w)}×${Math.round(b.h)}` : "—";

/**
 * Les lignes du panneau. `alerte` vaut vrai pour ce qui mérite d'être regardé :
 * c'est ce qui doit sauter aux yeux dans la rue, de nuit.
 * @returns {Array<{cle: string, texte: string, alerte: boolean}>}
 */
export function lignesDiag(etat = {}) {
  const {video, videoBox, canvasBox, canvas, dpr, piste, images, lecture, preparation, relances = 0} = etat;
  const cadreOk = memeCadre(videoBox, canvasBox);
  const l = [];
  l.push({cle: "video", texte: `Vidéo ${taille(video)} → ${taille(videoBox)}`, alerte: !video?.w});
  l.push({cle: "canevas", texte: `Canevas ${taille(canvas)} · écran ${taille(canvasBox)} · dpr ${dpr ?? "—"}`, alerte: false});
  l.push({cle: "cadre", texte: cadreOk ? "Cadre vidéo = cadre tracé" : "CADRE DÉCALÉ : le tracé ne couvre pas la vidéo",
          alerte: !cadreOk});
  if (piste) {
    const coupee = piste.muted === true;
    l.push({cle: "piste", texte: `Piste ${piste.readyState}${coupee ? " · COUPÉE" : ""}`
            + `${piste.w ? ` · ${piste.w}×${piste.h}` : ""}${piste.fps ? ` @${Math.round(piste.fps)}` : ""}`,
            alerte: coupee || piste.readyState !== "live"});
  } else {
    l.push({cle: "piste", texte: "Piste absente", alerte: true});
  }
  l.push({cle: "images", texte: `${images == null ? "—" : Math.round(images)} images/s`,
          alerte: images != null && images < 20});
  const st = lecture?.stats?.() ?? lecture ?? null;
  l.push({cle: "lecture", texte: `Lecture image ${ms(st)}${st ? ` (${st.n})` : ""}`,
          alerte: !!st && st.med > 25});
  const pr = preparation?.stats?.() ?? preparation ?? null;
  if (pr) l.push({cle: "preparation", texte: `Préparation ${ms(pr)}`, alerte: pr.med > 25});
  l.push({cle: "relances", texte: `Relances caméra ${relances}`, alerte: relances > 0});
  return l;
}
