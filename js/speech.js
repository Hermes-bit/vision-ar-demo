// File d'annonces vocales par urgence (retour terrain : annonces trop nombreuses, qui se chevauchent).
//
// Trois niveaux : 0 = DANGER (obstacle sur le chemin, chaussée, traversée), 1 = CONSIGNE (virage, départ,
// arrivée), 2 = INFO (état du GPS, fiche d'arrivée, recalage).
// - un message plus urgent coupe celui en cours s'il est moins urgent ; sinon il attend son tour ;
// - la file garde un seul message par niveau (le plus récent) : on ne rattrape pas un retard ;
// - un message trop vieux pour être utile est abandonné (danger 4 s, consigne 6 s, info 10 s) ;
// - le même texte n'est pas répété dans les 10 s ;
// - après un danger, les infos se taisent 3 s (laisser l'usager réagir).
// Avec VoiceOver, l'appli parle déjà elle-même : les zones « aria-live » restent polies, pas assertives.
// Module sans dépendance au navigateur : le moteur de voix est injecté (testé par web/tests/speech.test.mjs).

export const DANGER = 0, CONSIGNE = 1, INFO = 2;
const MAX_AGE = [4000, 6000, 10000], REPEAT_MS = 10000, QUIET_AFTER_DANGER = 3000;

/**
 * engine : {speak(text, onEnd), cancel()} ; now : () => ms.
 * Renvoie {say(text, level), clear(), get speaking(), get queue()}.
 */
export function makeSpeech(engine, now = () => Date.now()) {
  let current = null, queue = [], recent = new Map(), lastDanger = -Infinity, seq = 0;
  function next() {
    current = null;
    const t = now();
    queue = queue.filter(m => t - m.at <= MAX_AGE[m.level]);
    queue.sort((a, b) => a.level - b.level || a.at - b.at);
    const m = queue.shift();
    if (m) start(m);
  }
  function start(m) {
    current = m;
    const id = m.id;
    engine.speak(m.text, () => { if (current?.id === id) next(); });
  }
  return {
    say(text, level = INFO) {
      if (!text) return false;
      const t = now();
      if (t - (recent.get(text) ?? -Infinity) < REPEAT_MS) return false;        // déjà dit il y a moins de 10 s
      if (level === INFO && t - lastDanger < QUIET_AFTER_DANGER) return false;
      recent.set(text, t);
      for (const [k, at] of recent) if (t - at > REPEAT_MS) recent.delete(k);
      if (level === DANGER) lastDanger = t;
      const m = {id: ++seq, text, level, at: t};
      if (!current) { start(m); return true; }
      if (level < current.level) {                                             // plus urgent : on coupe
        current = null;
        engine.cancel();
        start(m);
        return true;
      }
      queue = queue.filter(q => q.level !== level);                            // un seul message en attente par niveau
      queue.push(m);
      return true;
    },
    clear() { queue = []; current = null; engine.cancel(); },
    get speaking() { return current; },
    get queue() { return queue; },
  };
}
