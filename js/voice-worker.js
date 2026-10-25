// Voix naturelles du guidage (Hermès, Séléna : voix Piper) dans un fil d'exécution à part, pour ne jamais bloquer
// l'écran. Deux étapes : la prononciation (eSpeak NG, module piper_phonemize) puis la voix (modèle ONNX, avec
// onnxruntime-web en WebAssembly, comme le détecteur d'obstacles). Les fichiers sont téléchargés une seule fois
// et gardés sur le téléphone (cache « va-voix », commun aux sites test, stable et présentation) : ensuite, la voix
// marche sans internet.
// Messages reçus : {type: "load", id, voice: {model, speaker}} puis {type: "speak", id, voice, text, speed}.
const ORT_DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const PHON_DIR = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/";
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const CACHE = "va-voix";
let rt = null, phon = null;                               // rt : onnxruntime-web (« ort » est déjà le nom global de la bibliothèque)
const models = new Map();
let lastPhonMs = 0;                                         // durée de la prononciation (mesure)                                 // chemin du modèle -> {session, config}

// Fichier gardé sur le téléphone, ou téléchargé (avec l'avancement) puis gardé
async function cached(url, onBytes) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  // Réseau coupé en route (téléphone en 4G, serveur qui ralentit) : jusqu'à 5 essais, en reprenant là où le
  // téléchargement s'était arrêté (demande « Range ») au lieu de tout recommencer (essais du 25/10 : « Failed to fetch »)
  const chunks = [];
  let got = 0, total = 0, type = "application/octet-stream";
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, got ? {headers: {Range: `bytes=${got}-`}} : {});
      if (got && res.status !== 206) { chunks.length = 0; got = 0; }   // reprise refusée : on repart du début
      if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);
      type = res.headers.get("content-type") || type;
      if (!total) total = res.status === 206 ? +(res.headers.get("content-range") || "").split("/")[1] || 0 : +res.headers.get("content-length") || 0;
      const reader = res.body.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        onBytes?.(got, total);
      }
      if (!total || got >= total) break;
      throw new Error("téléchargement incomplet");
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  const blob = new Blob(chunks);
  chunks.length = 0;
  await cache.put(url, new Response(blob, {headers: {"content-type": type}}));
  return blob.arrayBuffer();
}
async function isCached(url) { return !!(await (await caches.open(CACHE)).match(url)); }

// Prononciation : le module eSpeak NG (18 Mo de règles pour toutes les langues), chargé une fois
async function loadPhonemizer(progress) {
  if (phon) return phon;
  const [js, wasm, data] = await Promise.all([
    cached(PHON_DIR + "piper_phonemize.js"), cached(PHON_DIR + "piper_phonemize.wasm"),
    cached(PHON_DIR + "piper_phonemize.data", (g, t) => progress("data", g, t))]);
  importScripts(URL.createObjectURL(new Blob([js], {type: "text/javascript"})));   // définit createPiperPhonemize
  phon = {wasm, data};
  return phon;
}
// Texte -> numéros de sons (un nouveau module à chaque fois : son programme principal ne se relance pas)
// Le module est gardé d'une phrase à l'autre (le recréer coûtait jusqu'à 0,7 s) ; recréé seulement s'il échoue
let phonMod = null, phonLines = [];
async function phonemize(text, espeakVoice) {
  const run = mod => {
    phonLines = [];
    mod.callMain(["-l", espeakVoice, "--input", JSON.stringify([{text}]), "--espeak_data", "/espeak-ng-data"]);
    const ids = [];
    for (const l of phonLines) { try { ids.push(...JSON.parse(l).phoneme_ids); } catch { /* ligne sans sons */ } }
    return ids;
  };
  const create = () => self.createPiperPhonemize({
    print: s => phonLines.push(s), printErr: () => {}, noInitialRun: true,
    wasmBinary: phon.wasm, getPreloadedPackage: () => phon.data, locateFile: f => PHON_DIR + f,
  });
  if (phonMod) { try { const ids = run(phonMod); if (ids.length) return ids; } catch { /* module usé : on le recrée */ } }
  phonMod = await create();
  return run(phonMod);
}
async function loadVoice(voice, progress) {
  if (models.has(voice.model)) return models.get(voice.model);
  if (!rt) {
    // gardée avec la voix (marche sans internet) ; chargée depuis le cache plutôt que par importScripts direct, qui
    // échouait parfois pendant l'installation du mode hors connexion (essais du 25/10)
    const js = await cached(ORT_DIR + "ort.wasm.min.js");
    importScripts(URL.createObjectURL(new Blob([js], {type: "text/javascript"})));
    rt = self.ort;
    rt.env.wasm.wasmPaths = ORT_DIR;
    rt.env.wasm.numThreads = 1;                          // sans isolation cross-origin, un seul fil WebAssembly
  }
  await loadPhonemizer(progress);
  const config = JSON.parse(new TextDecoder().decode(await cached(VOICE_BASE + voice.model + ".onnx.json")));
  const bytes = await cached(VOICE_BASE + voice.model + ".onnx", (g, t) => progress("model", g, t));
  const session = await rt.InferenceSession.create(new Uint8Array(bytes), {executionProviders: ["wasm"], graphOptimizationLevel: "all"});
  const m = {session, config};
  models.set(voice.model, m);
  return m;
}
async function speak(voice, text, speed = 1) {
  const {session, config} = await loadVoice(voice, () => {});
  const t0 = performance.now(), ids = await phonemize(text, config.espeak?.voice || "fr");
  lastPhonMs = performance.now() - t0;
  if (!ids.length) return new Float32Array(0);
  const inf = config.inference || {};
  const feeds = {
    input: new rt.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new rt.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new rt.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3]),
  };
  if ((config.num_speakers || 1) > 1) feeds.sid = new rt.Tensor("int64", BigInt64Array.from([BigInt(voice.speaker || 0)]), [1]);
  const res = await session.run(feeds);
  return new Float32Array(res.output.data);
}

self.onmessage = async ({data: msg}) => {
  try {
    if (msg.type === "status") {
      const files = [PHON_DIR + "piper_phonemize.data", VOICE_BASE + msg.voice.model + ".onnx"];
      self.postMessage({type: "status", id: msg.id, downloaded: (await Promise.all(files.map(isCached))).every(Boolean)});
    } else if (msg.type === "load") {
      // avancement : règles de prononciation (18 Mo) puis voix (77 Mo), en un seul pourcentage
      const W = {data: 18, model: 77}, done = {data: 0, model: 0};
      let last = 0;
      await loadVoice(msg.voice, (part, got, total) => {
        done[part] = total ? got / total : 0;
        const pct = Math.floor(100 * (W.data * done.data + W.model * done.model) / (W.data + W.model));
        if (pct !== last) { last = pct; self.postMessage({type: "progress", id: msg.id, pct}); }
      });
      self.postMessage({type: "ready", id: msg.id, rate: models.get(msg.voice.model).config.audio?.sample_rate || 22050});
    } else if (msg.type === "speak") {
      const t0 = performance.now(), pcm = await speak(msg.voice, msg.text, msg.speed);
      self.postMessage({type: "audio", id: msg.id, pcm, rate: models.get(msg.voice.model).config.audio?.sample_rate || 22050,
        ms: performance.now() - t0, phonMs: lastPhonMs}, [pcm.buffer]);
    }
  } catch (e) {
    self.postMessage({type: "error", id: msg.id, message: String(e?.message || e)});
  }
};
