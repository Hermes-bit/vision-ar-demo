// Boussole du plan (bouton « Orienter la carte ») : direction du HAUT de l'écran, téléphone tenu à plat ou
// incliné comme pour lire une carte. iPhone : webkitCompassHeading (autorisation demandée dans le geste de
// l'usager) ; Android : alpha de l'événement absolu (cap = 360 − alpha). Lissée à chaque image.
// La vue caméra du guidage a ses propres capteurs (js/ar.js : direction visée par la caméra arrière).
const screenAngle = () => (screen.orientation?.angle ?? window.orientation ?? 0) % 360;

export function headingFrom(e) {
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) return e.webkitCompassHeading;
  if (e.absolute && typeof e.alpha === "number") return (360 - e.alpha) % 360;
  return null;
}
// Pas suivant du lissage : avance de `k` vers la cible par le plus court chemin (359° -> 1° = +2°, pas -358°)
export function smoothHeading(h, target, k = 0.2) {
  if (h === null) return target;
  const d = ((target - h + 540) % 360) - 180;
  return (h + d * k + 360) % 360;
}

// onHeading(degrés) à chaque image ; onFail() si refusée ou si rien n'arrive en 2,5 s. Renvoie une fonction d'arrêt.
export function startCompass(onHeading, onFail) {
  let h = null, target = null, stopped = false, raf = 0;
  const handler = e => {
    const v = headingFrom(e);
    if (v !== null) target = (v + screenAngle()) % 360;
  };
  const tick = () => {
    if (stopped) return;
    if (target !== null) { h = smoothHeading(h, target); onHeading(h); }
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    removeEventListener("deviceorientationabsolute", handler);
    removeEventListener("deviceorientation", handler);
  };
  const begin = () => {
    if (stopped) return;
    addEventListener("deviceorientationabsolute", handler);
    addEventListener("deviceorientation", handler);
    tick();
    setTimeout(() => { if (target === null && !stopped) { stop(); onFail?.(); } }, 2500);
  };
  const ask = typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission;
  // iPhone : la demande part tout de suite, encore dans le geste de l'usager
  if (typeof ask === "function") DeviceOrientationEvent.requestPermission()
    .then(r => { if (r === "granted") begin(); else { stop(); onFail?.(); } }).catch(() => { stop(); onFail?.(); });
  else begin();
  return stop;
}
