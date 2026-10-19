// Détecteur d'obstacles dans un fil d'exécution à part (Web Worker).
//
// Retour terrain du 19/10 (vidéo) : chargé dans la page, le détecteur (modèle de 11 Mo, première analyse en
// WebGPU) bloquait toute l'appli sur iPhone pendant de longues secondes : l'image de la caméra bougeait, mais
// plus aucun bouton ne répondait. Ici, tout le calcul se fait à côté : même lent, il ne gêne plus l'écran.
// Moteur : onnxruntime-web en WebAssembly (le plus prévisible sur iPhone). La page prépare l'image et décode
// le résultat (js/obstacles.js, js/yolo.js) ; ce fil ne fait que charger le modèle et l'exécuter.
const ORT_DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
let session = null;

self.onmessage = async ({data: msg}) => {
  try {
    if (msg.type === "init") {
      importScripts(ORT_DIR + "ort.wasm.min.js");
      const ort = self.ort;
      ort.env.wasm.wasmPaths = ORT_DIR;
      ort.env.wasm.numThreads = 1;                        // sans isolation cross-origin, un seul fil WebAssembly
      session = await ort.InferenceSession.create(new Uint8Array(msg.bytes), {executionProviders: ["wasm"], graphOptimizationLevel: "all"});
      // analyse « à vide » : la première exécution prépare les calculs
      const S = msg.size;
      await session.run({[session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * S * S), [1, 3, S, S])});
      self.postMessage({type: "ready"});
    } else if (msg.type === "run") {
      const ort = self.ort, S = msg.size, t0 = performance.now();
      const res = await session.run({[session.inputNames[0]]: new ort.Tensor("float32", msg.input, [1, 3, S, S])});
      const out = res[session.outputNames[0]], data = new Float32Array(out.data);
      self.postMessage({type: "result", id: msg.id, data, dims: out.dims, ms: performance.now() - t0, input: msg.input}, [data.buffer, msg.input.buffer]);
    }
  } catch (e) {
    self.postMessage({type: "error", id: msg.id, message: String(e?.message || e)});
  }
};
