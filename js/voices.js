// Voix du guidage : Hermès (voix d'homme) et Séléna (voix de femme), deux voix naturelles Piper choisies par
// l'usager (25/10), qui marchent sur le téléphone, sans internet, une fois téléchargées ; ou la voix du téléphone.
// Le calcul se fait dans js/voice-worker.js ; ici : la liste des voix, le texte rendu prononçable (« 140 m » ->
// « 140 mètres »), la lecture (élément audio, débloqué pendant un appui de l'usager, comme l'exige l'iPhone) et une
// petite mémoire des phrases déjà dites (une consigne répétée part tout de suite).
export const VOICES = {
  hermes: {name: "Hermès", desc: "Voix d'homme naturelle", model: "fr/fr_FR/mls/medium/fr_FR-mls-medium", speaker: 7,
    sample: "voices/hermes.wav", credit: "voix Piper « mls », locuteur 8778 (données Multilingual LibriSpeech, CC BY 4.0)"},
  selena: {name: "Séléna", desc: "Voix de femme naturelle", model: "fr/fr_FR/upmc/medium/fr_FR-upmc-medium", speaker: 0,
    sample: "voices/selena.wav", credit: "voix Piper « upmc », locutrice Jessica (données UPMC, CC BY-SA 4.0)"},
};
export const VOICE_DOWNLOAD_MB = 95;                       // règles de prononciation (18 Mo) + voix (77 Mo)
export const SAMPLE_TEXT = "Dans 50 mètres, tournez à droite sur l'avenue Claude Debussy.";

// Texte -> phrase prononçable par la voix (eSpeak lit « m » comme la lettre « èm ») ; puis phrases séparées, pour
// commencer à parler dès que la première est prête
// (?!\p{L}) et non \b : « \b » ignore les lettres accentuées (« 50 mètres » devenait « 50 mètresètres »)
const UNITS = [[/(\d)\s?km(?!\p{L})/gu, "$1 kilomètres"], [/(\d)\s?m(?!\p{L})/gu, "$1 mètres"], [/(\d)\s?min(?!\p{L})/gu, "$1 minutes"],
  [/(\d)\s?%/g, "$1 pour cent"], [/(\d),(\d)/g, "$1 virgule $2"]];
export function normalizeFr(text) {
  let t = String(text || "");
  for (const [re, by] of UNITS) t = t.replace(re, by);
  t = t.replace(/(?<![\d,]|virgule )1 (mètres|kilomètres|minutes)(?!\p{L})/gu, (_, u) => `1 ${u.slice(0, -1)}`)   // « 1 mètre »
    .replace(/\s*[·•|]\s*/g, ", ").replace(/\s*:\s*/g, ", ").replace(/\s+/g, " ").trim();
  return t;
}
export function sentences(text) {
  return normalizeFr(text).split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
}
// Son PCM (nombres de -1 à 1) -> fichier WAV 16 bits
export function wavBlob(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], {type: "audio/wav"});
}
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";

export function makeVoiceEngine() {
  let worker = null, seq = 0, audio = null, current = null;
  const waiting = new Map(), ready = new Set(), memory = new Map();
  const call = (msg, onProgress) => new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL("./voice-worker.js", import.meta.url));
      worker.onmessage = ({data}) => {
        const w = waiting.get(data.id);
        if (!w) return;
        if (data.type === "progress") return w.onProgress?.(data.pct);
        waiting.delete(data.id);
        data.type === "error" ? w.reject(new Error(data.message)) : w.resolve(data);
      };
    }
    const id = ++seq;
    waiting.set(id, {resolve, reject, onProgress});
    worker.postMessage({...msg, id});
  });
  const voiceOf = key => ({model: VOICES[key].model, speaker: VOICES[key].speaker});
  async function synth(key, text, speed) {                 // une phrase -> son (mémoire des 40 dernières)
    const k = `${key}|${speed}|${text}`;
    if (memory.has(k)) { const r = memory.get(k); memory.delete(k); memory.set(k, r); return r; }
    const r = await call({type: "speak", voice: voiceOf(key), text, speed});
    memory.set(k, r);
    if (memory.size > 40) memory.delete(memory.keys().next().value);
    return r;
  }
  let endPlay = null;                                     // termine la lecture en cours (fin normale ou coupure)
  function play(blob) {
    return new Promise(resolve => {
      audio ||= new Audio();
      const url = URL.createObjectURL(blob);
      const done = () => { if (endPlay !== done) return; endPlay = null; audio.onended = audio.onerror = null; URL.revokeObjectURL(url); resolve(); };
      endPlay?.();
      endPlay = done;
      audio.onended = done; audio.onerror = done;
      audio.src = url;
      audio.play().catch(done);
    });
  }
  return {
    /** iPhone : à appeler pendant un appui de l'usager, avant la première lecture */
    unlock() { audio ||= new Audio(); audio.src = SILENT; audio.play().catch(() => {}); },
    isReady: key => ready.has(key),
    /** voix déjà sur le téléphone ? (sans rien télécharger) */
    async downloaded(key) { try { return (await call({type: "status", voice: voiceOf(key)})).downloaded; } catch { return false; } },
    /** télécharge (une fois) et prépare la voix ; onProgress(pourcentage) */
    async prepare(key, onProgress) {
      if (ready.has(key)) return;
      await call({type: "load", voice: voiceOf(key)}, onProgress);
      ready.add(key);
    },
    /** dit le texte ; renvoie {done: Promise, cancel()}. Les phrases sont calculées une à une et dites à la suite. */
    speak(key, text, {speed = 1} = {}) {
      const job = {cancelled: false};
      job.started = new Promise(r => { job.start = r; });  // résolue quand la voix commence à parler
      current?.cancel();
      const parts = sentences(text), pending = parts.map(() => null);
      const get = i => pending[i] ||= synth(key, parts[i], speed);
      job.done = (async () => {
        for (let i = 0; i < parts.length && !job.cancelled; i++) {
          const r = await get(i);
          if (i + 1 < parts.length) get(i + 1);            // la phrase suivante se calcule pendant la lecture
          if (job.cancelled) break;
          job.start();
          await play(wavBlob(r.pcm, r.rate));
        }
      })();
      job.cancel = () => { job.cancelled = true; if (current === job) { audio?.pause(); endPlay?.(); current = null; } };
      current = job;
      job.done.finally(() => { if (current === job) current = null; });
      return job;
    },
    /** calcule à l'avance (la phrase partira tout de suite quand elle sera dite) */
    prefetch(key, text, speed = 1) { if (ready.has(key)) for (const s of sentences(text)) synth(key, s, speed).catch(() => {}); },
    /** son d'une phrase, sans le jouer : {pcm, rate, ms} (échantillons, tests) */
    synthesize: (key, text, speed = 1) => synth(key, normalizeFr(text), speed),
    /** échantillon enregistré (pour écouter une voix avant de la télécharger) */
    playSample(key) { audio ||= new Audio(); audio.src = VOICES[key].sample; return audio.play(); },
    stop() { current?.cancel(); audio?.pause(); endPlay?.(); },
  };
}
