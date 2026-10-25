// Cap de la caméra pour la vue de guidage : rapide ET juste, pour que le ruban reste collé au sol.
//
// Avant, la boussole seule était très lissée (elle tremble) : quand on tournait le téléphone, la rue bougeait
// tout de suite à l'écran mais le ruban suivait avec 0,3 à 1 s de retard et « glissait » sur le sol. Ici :
// - le gyroscope (orientation relative du téléphone, sans à-coups ni retard) donne les mouvements, immédiatement ;
// - la boussole (cap absolu, bruité) ne sert qu'à recaler doucement le nord : un décalage lissé sur ~2,5 s.
// Un écart soudain et important de la boussole (voiture, grille, ascenseur à côté) est suivi beaucoup plus
// lentement : le ruban ne part pas de travers à chaque perturbation magnétique.
const norm = a => ((a % 360) + 360) % 360;
export const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;   // a − b, dans [−180, 180[

export function makeHeadingFusion({tau = 2.5, startTau = 0.4, startS = 2, jumpDeg = 40, jumpSlow = 0.25} = {}) {
  let offset = null, lastT = null, firstT = null, solo = null;
  return {
    get offset() { return offset; },
    // rel : cap relatif donné par le gyroscope (référence quelconque, mais stable) ; comp : cap boussole ou null ;
    // t : secondes ; trust : 0 à 1 (boussole à calibrer : on la suit à peine). Renvoie le cap, ou null.
    update(rel, comp, t, trust = 1) {
      const dt = lastT === null ? 0 : Math.min(0.5, Math.max(0, t - lastT));
      lastT = t;
      if (rel === null || !Number.isFinite(rel)) return null;
      if (comp !== null && Number.isFinite(comp)) {
        const target = norm(comp - rel);
        if (offset === null) { offset = target; firstT = t; }
        else {
          const d = angleDiff(target, offset), T = t - firstT < startS ? startTau : tau;   // début : recalage rapide
          const k = (1 - Math.exp(-dt / T)) * trust * (Math.abs(d) > jumpDeg ? jumpSlow : 1);
          offset = norm(offset + d * k);
        }
      }
      return offset === null ? null : norm(rel + offset);
    },
    // Téléphone sans gyroscope : la boussole seule, légèrement lissée
    compassOnly(comp, t) {
      const dt = lastT === null ? 0 : Math.min(0.5, Math.max(0, t - lastT));
      lastT = t;
      if (comp === null || !Number.isFinite(comp)) return solo;
      solo = solo === null ? norm(comp) : norm(solo + angleDiff(comp, solo) * (1 - Math.exp(-dt / 0.25)));
      return solo;
    },
    reset() { offset = null; lastT = null; firstT = null; solo = null; },
  };
}
