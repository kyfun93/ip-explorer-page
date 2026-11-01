(function (root) {
  const MODEL_KEY = "Xenova/multilingual-e5-small/q8";
  const SENSE_BEST = 0.835;
  const SENSE_WINDOW = 0.02;
  const SENSE_STRONG = 0.86;
  const vectors = new Map();
  const status = { phase: "idle", done: 0, total: 0, percent: null, note: "" };
  let repo = null;
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  let chain = Promise.resolve();
  let queuedRecords = null;
  let running = false;
  let listener = function () {};
  let modelWarm = false;

  function emit(justReady) {
    listener({
      phase: status.phase,
      done: status.done,
      total: status.total,
      text: statusText(),
      ready: status.phase === "ready",
      justReady: !!justReady
    });
  }

  function statusText() {
    if (status.phase === "download") {
      const percent = status.percent === null ? "" : " (" + status.percent + " %)";
      return "Recherche par le sens : téléchargement du modèle français, environ 140 Mo, une seule fois sur cet appareil" + percent + ".";
    }
    if (status.phase === "index") {
      return "Recherche par le sens : index " + status.done + " sur " + status.total + ". Les mots-clés fonctionnent déjà.";
    }
    if (status.phase === "loading") return status.note || "Chargement du modèle déjà enregistré sur cet appareil.";
    if (status.phase === "unavailable") return status.note || "La recherche par le sens n’a pas pu se charger. Les mots-clés restent disponibles.";
    if (status.note) return status.note;
    return "";
  }

  function passageBody(record) {
    const question = String(record.question || "").replace(/\s+/g, " ").trim();
    const answer = String(record.answer || "").replace(/\s+/g, " ").trim();
    const body = answer ? question + ". " + answer : question;
    return body.length > 1500 ? body.slice(0, 1500) : body;
  }

  function passageHash(record) {
    return MODEL_KEY + "\n" + passageBody(record);
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("js/semantic-worker.js?v=sens", { type: "module" });
    worker.onmessage = function (event) {
      const message = event.data || {};
      if (message.type === "progress") {
        const file = String(message.file || "");
        if (file.indexOf(".onnx") !== -1 && message.status === "progress" && message.total) {
          status.phase = status.phase === "ready" ? "loading" : "download";
          status.percent = Math.round((message.loaded / message.total) * 100);
          emit(false);
        }
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.type === "error") waiter.reject(new Error(message.message));
      else waiter.resolve(message.vectors || []);
    };
    worker.onerror = function () {
      status.phase = "unavailable";
      status.note = "La recherche par le sens n’a pas pu se charger. Les mots-clés restent disponibles.";
      emit(false);
    };
    return worker;
  }

  function embedTexts(texts) {
    const run = chain.then(function () {
      const id = ++requestId;
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        try {
          ensureWorker().postMessage({ type: "embed", id: id, texts: texts });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
    chain = run.then(function () {}, function () {});
    return run;
  }

  function dot(left, right) {
    let score = 0;
    const width = Math.min(left.length, right.length);
    for (let i = 0; i < width; i += 1) score += left[i] * right[i];
    return score;
  }

  async function sync(records) {
    const list = records || [];
    const byId = {};
    list.forEach(function (record) { byId[record.id] = record; });
    let stored = [];
    try {
      stored = await repo.allEmbeddings();
    } catch (error) {
      status.phase = "unavailable";
      status.note = "L’index local n’est pas disponible. Les mots-clés restent disponibles.";
      emit(false);
      return;
    }
    const stale = [];
    stored.forEach(function (item) {
      const record = byId[item.id];
      if (!record || item.model !== MODEL_KEY || item.hash !== passageHash(record)) {
        stale.push(item.id);
        return;
      }
      vectors.set(item.id, item.vector);
    });
    if (stale.length) {
      stale.forEach(function (id) { vectors.delete(id); });
      await repo.deleteEmbeddings(stale);
    }
    const todo = list.filter(function (record) { return !vectors.has(record.id); });
    status.total = list.length;
    status.done = list.length - todo.length;
    if (!todo.length) {
      status.phase = "ready";
      status.percent = null;
      status.note = "";
      emit(true);
      return;
    }
    status.phase = "index";
    emit(false);
    try {
      for (let i = 0; i < todo.length; i += 4) {
        const batch = todo.slice(i, i + 4);
        const texts = batch.map(function (record) { return "passage: " + passageBody(record); });
        const rows = await embedTexts(texts);
        modelWarm = true;
        const saving = batch.map(function (record, index) {
          const vector = new Float32Array(rows[index] || []);
          vectors.set(record.id, vector);
          return { id: record.id, model: MODEL_KEY, hash: passageHash(record), vector: vector };
        });
        await repo.putEmbeddings(saving);
        status.done += batch.length;
        status.phase = "index";
        emit(false);
      }
      status.phase = "ready";
      status.percent = null;
      status.note = "";
      emit(true);
    } catch (error) {
      status.phase = "unavailable";
      status.note = "La recherche par le sens n’a pas pu se charger. Les mots-clés restent disponibles.";
      emit(false);
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queuedRecords) {
        const records = queuedRecords;
        queuedRecords = null;
        await sync(records);
      }
    } finally {
      running = false;
      if (queuedRecords) pump();
    }
  }

  function attach(repository, onChange) {
    repo = repository;
    listener = onChange || listener;
  }

  function schedule(records) {
    queuedRecords = records;
    pump();
  }

  async function embedQuery(query) {
    if (!modelWarm) {
      status.note = "Chargement du modèle sur cet appareil.";
      if (status.phase === "ready") status.phase = "loading";
      emit(false);
    }
    const rows = await embedTexts(["query: " + String(query || "").replace(/\s+/g, " ").trim().slice(0, 400)]);
    modelWarm = true;
    status.note = "";
    if (status.phase === "loading" || status.phase === "download") status.phase = "ready";
    emit(false);
    return new Float32Array(rows[0] || []);
  }

  function blend(query, records, keywordHits) {
    if (status.phase !== "ready" || !vectors.size) return Promise.resolve(null);
    return embedQuery(query).then(function (queryVector) {
      const byId = new Map();
      keywordHits.forEach(function (hit) { byId.set(hit.record.id, hit); });
      const extra = [];
      records.forEach(function (record) {
        const stored = vectors.get(record.id);
        if (!stored) return;
        const cosine = dot(queryVector, stored);
        const hit = byId.get(record.id);
        if (hit) {
          hit.semantic = cosine;
          hit.blend = hit.score + Math.max(0, cosine - 0.72) * 20;
          return;
        }
        extra.push({
          record: record,
          kind: "sens",
          score: cosine >= SENSE_STRONG ? 70 + cosine * 20 : cosine * 30,
          semantic: cosine,
          stems: {},
          excerpt: "",
          blend: cosine >= SENSE_STRONG ? 70 + cosine * 20 : cosine * 30
        });
      });
      extra.sort(function (a, b) { return b.semantic - a.semantic; });
      const best = extra.length ? extra[0].semantic : 0;
      const kept = best >= SENSE_BEST
        ? extra.filter(function (hit) { return hit.semantic >= best - SENSE_WINDOW; }).slice(0, 5)
        : [];
      const merged = keywordHits.concat(kept);
      merged.sort(function (a, b) { return (b.blend || b.score) - (a.blend || a.score); });
      merged.tooVague = !!keywordHits.tooVague;
      return merged;
    }).catch(function () { return null; });
  }

  function inspect(query, records) {
    return embedQuery(query).then(function (queryVector) {
      const ranked = [];
      records.forEach(function (record) {
        const stored = vectors.get(record.id);
        if (!stored) return;
        ranked.push({
          cosine: Math.round(dot(queryVector, stored) * 1000) / 1000,
          service: record.serviceId || record.serviceMention || "",
          question: String(record.question || "").replace(/\s+/g, " ").slice(0, 110)
        });
      });
      ranked.sort(function (a, b) { return b.cosine - a.cosine; });
      return ranked.slice(0, 5);
    });
  }

  function dropIndex() {
    vectors.clear();
    queuedRecords = null;
    status.phase = "idle";
    status.done = 0;
    status.total = 0;
    status.percent = null;
    status.note = "";
    if (worker) {
      worker.terminate();
      worker = null;
    }
    modelWarm = false;
  }

  root.IPSemantic = {
    attach: attach,
    dropIndex: dropIndex,
    schedule: schedule,
    blend: blend,
    inspect: inspect,
    isReady: function () { return status.phase === "ready"; },
    statusText: statusText,
    modelKey: MODEL_KEY
  };
})(globalThis);
