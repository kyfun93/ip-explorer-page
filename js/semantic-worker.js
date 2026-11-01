/* Le texte des questions reste dans ce fil. Seuls les fichiers publics du modèle
   sont téléchargés. Aucun compte rendu n’est envoyé. */
const MODEL = "Xenova/multilingual-e5-small";
let extractorPromise = null;

function report(info) {
  self.postMessage({
    type: "progress",
    status: info && info.status || "",
    file: info && info.file || "",
    progress: typeof info.progress === "number" ? info.progress : null,
    loaded: info && info.loaded || 0,
    total: info && info.total || 0
  });
}

function rowsOf(output, count) {
  const data = output.data;
  const dims = output.dims || [];
  const width = dims.length ? dims[dims.length - 1] : data.length / count;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * width;
    const row = [];
    for (let j = 0; j < width; j += 1) row.push(data[start + j]);
    rows.push(row);
  }
  return rows;
}

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm").then(function (lib) {
      const env = lib.env;
      if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      return lib.pipeline("feature-extraction", MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: report
      });
    });
  }
  return extractorPromise;
}

self.onmessage = function (event) {
  const message = event.data || {};
  if (message.type !== "embed") return;
  getExtractor().then(function (extractor) {
    return extractor(message.texts, { pooling: "mean", normalize: true }).then(function (output) {
      self.postMessage({
        type: "vectors",
        id: message.id,
        vectors: rowsOf(output, message.texts.length)
      });
    });
  }).catch(function (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: error && error.message ? error.message : "Le modèle local n’a pas démarré."
    });
  });
};
