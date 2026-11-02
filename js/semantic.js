(function (root) {
  const MODEL_KEY = "Xenova/multilingual-e5-small/q8";
  const SENSE_BEST = 0.835;
  const SENSE_WINDOW = 0.02;
  const SENSE_STRONG = 0.86;
  const vectors = new Map();
  const queryVectors = new Map();
  const status = { phase: "idle", done: 0, total: 0, percent: null, note: "" };
  let repo = null;
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  let chain = Promise.resolve();
  let queuedRecords = null;
  let listener = function () {};
  let modelWarm = false;
  let embedOverride = null;
  let queryWaiting = 0;
  let runToken = 0;
  const runStats = { reused: 0, embedded: 0, failed: 0, loadMs: 0, embedMs: 0, batches: 0 };

  function now() {
    return globalThis.performance && performance.now ? performance.now() : Date.now();
  }

  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

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
      return "Recherche par le sens : téléchargement du modèle de recherche, environ 140 Mo, une seule fois sur cet appareil" + percent + ".";
    }
    if (status.phase === "index") {
      return "Vous pouvez déjà rechercher. Préparation du sens en arrière-plan : " + status.done + "/" + status.total + ".";
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
    worker = new Worker("js/semantic-worker.js?v=sens2", { type: "module" });
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
    if (embedOverride) return Promise.resolve(embedOverride(texts));
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

  function planBatches(records) {
    const ordered = records.slice().sort(function (a, b) {
      return passageBody(a).length - passageBody(b).length;
    });
    const batches = [];
    let current = [];
    let base = 0;
    ordered.forEach(function (record) {
      const len = passageBody(record).length;
      const canJoin = current.length > 0 && len <= 280 && base <= 280 && len <= base * 1.15 && current.length < 4;
      if (current.length && !canJoin) {
        batches.push(current);
        current = [];
      }
      if (!current.length) base = len;
      current.push(record);
    });
    if (current.length) batches.push(current);
    return batches;
  }

  function dot(left, right) {
    let score = 0;
    const width = Math.min(left.length, right.length);
    for (let i = 0; i < width; i += 1) score += left[i] * right[i];
    return score;
  }

  function vectorOk(vector) {
    return vector && vector.length === 384;
  }

  async function saveBatch(batch, rows, token) {
    if (token !== runToken) return false;
    const saving = batch.map(function (record, index) {
      const vector = new Float32Array(rows[index] || []);
      vectors.set(record.id, vector);
      return { id: record.id, model: MODEL_KEY, hash: passageHash(record), vector: vector };
    });
    const started = now();
    await repo.putEmbeddings(saving);
    runStats.saveMs = (runStats.saveMs || 0) + (now() - started);
    if (token !== runToken) return false;
    status.done += batch.length;
    runStats.embedded += batch.length;
    status.phase = "index";
    emit(false);
    return true;
  }

  async function sync(records) {
    const token = runToken;
    const list = records || [];
    const byId = {};
    list.forEach(function (record) { byId[record.id] = record; });
    const loadStarted = now();
    let stored = [];
    try {
      stored = await repo.allEmbeddings();
    } catch (error) {
      status.phase = "unavailable";
      status.note = "L’index local n’est pas disponible. Les mots-clés restent disponibles.";
      emit(false);
      return;
    }
    runStats.loadMs = now() - loadStarted;
    if (token !== runToken) return;
    vectors.clear();
    const stale = [];
    stored.forEach(function (item) {
      const record = byId[item.id];
      if (!record || item.model !== MODEL_KEY || item.hash !== passageHash(record) || !vectorOk(item.vector)) {
        stale.push(item.id);
        return;
      }
      vectors.set(item.id, item.vector);
    });
    if (stale.length) {
      stale.forEach(function (id) { vectors.delete(id); });
      await repo.deleteEmbeddings(stale);
    }
    if (token !== runToken) return;
    const todo = list.filter(function (record) { return !vectors.has(record.id); });
    runStats.reused = list.length - todo.length;
    status.total = list.length;
    status.done = runStats.reused;
    if (!todo.length) {
      status.phase = "ready";
      status.percent = null;
      status.note = "";
      emit(true);
      return;
    }
    status.phase = "index";
    emit(false);
    const batches = planBatches(todo);
    let failed = 0;
    for (let i = 0; i < batches.length; i += 1) {
      if (token !== runToken) return;
      while (queryWaiting && token === runToken) await pause(20);
      await pause(0);
      if (token !== runToken) return;
      const batch = batches[i];
      const texts = batch.map(function (record) { return "passage: " + passageBody(record); });
      const started = now();
      try {
        const rows = await embedTexts(texts);
        runStats.embedMs += now() - started;
        runStats.batches += 1;
        modelWarm = true;
        if (!rows || rows.length !== batch.length || !vectorOk(rows[0])) throw new Error("vecteur incomplet");
        const saved = await saveBatch(batch, rows, token);
        if (!saved) return;
      } catch (error) {
        if (token !== runToken) return;
        if (batch.length === 1) {
          failed += 1;
          runStats.failed += 1;
          continue;
        }
        for (let j = 0; j < batch.length; j += 1) {
          if (token !== runToken) return;
          const record = batch[j];
          try {
            const oneStarted = now();
            const one = await embedTexts(["passage: " + passageBody(record)]);
            runStats.embedMs += now() - oneStarted;
            runStats.batches += 1;
            modelWarm = true;
            if (!one || !vectorOk(one[0])) throw new Error("vecteur incomplet");
            const saved = await saveBatch([record], one, token);
            if (!saved) return;
          } catch (again) {
            if (token !== runToken) return;
            failed += 1;
            runStats.failed += 1;
          }
        }
      }
    }
    if (token !== runToken) return;
    if (failed && runStats.embedded === 0 && runStats.reused === 0) {
      status.phase = "unavailable";
      status.note = "La recherche par le sens n’a pas pu se charger. Les mots-clés restent disponibles.";
      emit(false);
      return;
    }
    status.phase = "ready";
    status.percent = null;
    status.note = "";
    emit(true);
  }

  let tail = Promise.resolve();

  function schedule(records) {
    queuedRecords = records;
    const job = tail.then(function () { return drain(); });
    tail = job.then(function () {}, function () {});
    return job;
  }

  async function drain() {
    while (queuedRecords) {
      const records = queuedRecords;
      queuedRecords = null;
      runStats.reused = 0;
      runStats.embedded = 0;
      runStats.failed = 0;
      runStats.loadMs = 0;
      runStats.embedMs = 0;
      runStats.batches = 0;
      runStats.saveMs = 0;
      await sync(records);
    }
  }

  function attach(repository, onChange) {
    repo = repository;
    listener = onChange || listener;
  }

  async function embedQuery(query) {
    const normalized = String(query || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (queryVectors.has(normalized)) return queryVectors.get(normalized);
    queryWaiting += 1;
    try {
      if (!modelWarm) {
        status.note = "Chargement du modèle sur cet appareil.";
        if (status.phase === "ready") status.phase = "loading";
        emit(false);
      }
      const rows = await embedTexts(["query: " + normalized]);
      modelWarm = true;
      status.note = "";
      if (status.phase === "loading" || status.phase === "download") status.phase = "ready";
      emit(false);
      const vector = new Float32Array(rows[0] || []);
      if (queryVectors.size >= 30) queryVectors.delete(queryVectors.keys().next().value);
      queryVectors.set(normalized, vector);
      return vector;
    } finally {
      queryWaiting -= 1;
    }
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
    runToken += 1;
    vectors.clear();
    queryVectors.clear();
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
    stats: function () {
      return {
        reused: runStats.reused,
        embedded: runStats.embedded,
        failed: runStats.failed,
        loadMs: Math.round(runStats.loadMs),
        embedMs: Math.round(runStats.embedMs),
        saveMs: Math.round(runStats.saveMs || 0),
        batches: runStats.batches
      };
    },
    setEmbedder: function (fn) { embedOverride = fn; },
    isReady: function () { return status.phase === "ready"; },
    statusText: statusText,
    modelKey: MODEL_KEY
  };
})(globalThis);
