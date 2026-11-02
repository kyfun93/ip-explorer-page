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

  const INDEX_MODEL = MODEL_KEY + "#p2";
  const PASSAGE_WINDOW = 1500;
  const PASSAGE_STRIDE = 1100;
  let sealKey = null;
  let sealEpoch = 0;

  function fullBody(record) {
    const question = String(record.question || "").replace(/\s+/g, " ").trim();
    const answer = String(record.answer || "").replace(/\s+/g, " ").trim();
    return answer ? question + ". " + answer : question;
  }

  function passagesOf(record) {
    const body = fullBody(record);
    if (body.length <= PASSAGE_WINDOW) return body ? [body] : [];
    const parts = [];
    for (let start = 0; start < body.length; start += PASSAGE_STRIDE) {
      parts.push(body.slice(start, start + PASSAGE_WINDOW));
      if (start + PASSAGE_WINDOW >= body.length) break;
    }
    return parts;
  }

  function legacyHash(textValue) {
    return MODEL_KEY + "\n" + textValue;
  }

  function fnvHex(value) {
    let hash = 0x811c9dc5;
    const textValue = String(value);
    for (let i = 0; i < textValue.length; i += 1) {
      hash ^= textValue.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function digest(value) {
    const subtle = globalThis.crypto && crypto.subtle;
    if (subtle && globalThis.TextEncoder) {
      const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
      return Array.from(new Uint8Array(bytes)).map(function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
    }
    return fnvHex(value);
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

  function planBatches(items) {
    const ordered = items.slice().sort(function (a, b) {
      return String(a.text || "").length - String(b.text || "").length;
    });
    const batches = [];
    let current = [];
    let base = 0;
    ordered.forEach(function (item) {
      const len = String(item.text || "").length;
      const canJoin = current.length > 0 && len <= 280 && base <= 280 && len <= base * 1.15 && current.length < 4;
      if (current.length && !canJoin) {
        batches.push(current);
        current = [];
      }
      if (!current.length) base = len;
      current.push(item);
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

  function putChunk(recordId, index, vector) {
    const list = vectors.get(recordId) || [];
    list[index] = vector;
    vectors.set(recordId, list);
  }

  function bestCosine(recordId, queryVector) {
    const list = vectors.get(recordId) || [];
    let best = null;
    for (let i = 0; i < list.length; i += 1) {
      if (!list[i]) continue;
      const score = dot(queryVector, list[i]);
      if (best === null || score > best) best = score;
    }
    return best;
  }

  async function saveBatch(batch, rows, token, missingCount) {
    if (token !== runToken) return false;
    const saving = [];
    for (let index = 0; index < batch.length; index += 1) {
      const job = batch[index];
      const vector = new Float32Array(rows[index] || []);
      putChunk(job.record.id, job.chunk, vector);
      saving.push({
        id: job.record.id + "#" + job.chunk,
        recordId: job.record.id,
        chunk: job.chunk,
        model: INDEX_MODEL,
        hash: job.hash,
        vector: vector
      });
    }
    const started = now();
    await repo.putEmbeddings(saving);
    runStats.saveMs = (runStats.saveMs || 0) + (now() - started);
    if (token !== runToken) {
      try { await repo.deleteEmbeddings(saving.map(function (row) { return row.id; })); } catch (error) {}
      return false;
    }
    batch.forEach(function (job) {
      missingCount[job.record.id] -= 1;
      runStats.embedded += 1;
      if (missingCount[job.record.id] === 0) status.done += 1;
    });
    status.phase = "index";
    emit(false);
    if (runStats.embedded % 20 === 0) {
      try { await persistSeal(); } catch (error) {}
    }
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
    const grouped = {};
    stored.forEach(function (item) {
      const recordId = item.recordId || item.id;
      if (!grouped[recordId]) grouped[recordId] = [];
      grouped[recordId].push(item);
    });
    const keep = {};
    const needed = [];
    const missingCount = {};
    for (let r = 0; r < list.length; r += 1) {
      const record = list[r];
      const parts = passagesOf(record);
      const hashes = [];
      for (let i = 0; i < parts.length; i += 1) hashes.push(await digest(INDEX_MODEL + "\n" + parts[i]));
      const have = new Array(parts.length);
      (grouped[record.id] || []).forEach(function (item) {
        if (!vectorOk(item.vector)) return;
        if (item.model === INDEX_MODEL && item.hash === hashes[item.chunk]) have[item.chunk] = item;
        if (item.model === MODEL_KEY && item.id === record.id && item.hash === legacyHash(parts[0])) have[0] = have[0] || item;
      });
      for (let i = 0; i < parts.length; i += 1) {
        if (have[i]) {
          putChunk(record.id, i, have[i].vector);
          const id = record.id + "#" + i;
          keep[id] = true;
          if (have[i].id !== id) {
            await repo.putEmbeddings([{
              id: id,
              recordId: record.id,
              chunk: i,
              model: INDEX_MODEL,
              hash: hashes[i],
              vector: have[i].vector
            }]);
          }
        } else {
          missingCount[record.id] = (missingCount[record.id] || 0) + 1;
          needed.push({ record: record, chunk: i, text: parts[i], hash: hashes[i] });
        }
      }
    }
    const stale = [];
    stored.forEach(function (item) {
      const recordId = item.recordId || item.id;
      if (byId[recordId] && !keep[item.id]) stale.push(item.id);
    });
    if (stale.length) await repo.deleteEmbeddings(stale);
    if (token !== runToken) return;
    runStats.reused = list.length - Object.keys(missingCount).length;
    status.total = list.length;
    status.done = runStats.reused;
    if (!needed.length) {
      status.phase = "ready";
      status.percent = null;
      status.note = "";
      try { await persistSeal(); } catch (error) {}
      emit(true);
      return;
    }
    status.phase = "index";
    emit(false);
    const batches = planBatches(needed);
    let failed = 0;
    for (let i = 0; i < batches.length; i += 1) {
      if (token !== runToken) return;
      while (queryWaiting && token === runToken) await pause(20);
      await pause(0);
      if (token !== runToken) return;
      const batch = batches[i];
      const texts = batch.map(function (job) { return "passage: " + job.text; });
      const started = now();
      try {
        const rows = await embedTexts(texts);
        runStats.embedMs += now() - started;
        runStats.batches += 1;
        modelWarm = true;
        if (!rows || rows.length !== batch.length || !vectorOk(rows[0])) throw new Error("vecteur incomplet");
        const saved = await saveBatch(batch, rows, token, missingCount);
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
          const job = batch[j];
          try {
            const oneStarted = now();
            const one = await embedTexts(["passage: " + job.text]);
            runStats.embedMs += now() - oneStarted;
            runStats.batches += 1;
            modelWarm = true;
            if (!one || !vectorOk(one[0])) throw new Error("vecteur incomplet");
            const saved = await saveBatch([job], one, token, missingCount);
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
    try { await persistSeal(); } catch (error) {}
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
        const cosine = bestCosine(record.id, queryVector);
        if (cosine === null) return;
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
        const cosine = bestCosine(record.id, queryVector);
        if (cosine === null) return;
        ranked.push({
          cosine: Math.round(cosine * 1000) / 1000,
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

  function lockSeal() {
    sealEpoch += 1;
    runToken += 1;
    sealKey = null;
    queuedRecords = null;
    if (globalThis.localStorage) localStorage.removeItem("ip-seal-jwk");
  }

  function writeSealKey(epoch, serialized) {
    if (epoch !== sealEpoch || !globalThis.localStorage) return false;
    localStorage.setItem("ip-seal-jwk", serialized);
    if (epoch !== sealEpoch) {
      localStorage.removeItem("ip-seal-jwk");
      sealKey = null;
      return false;
    }
    return true;
  }

  function bytesToB64(bytes) {
    let textValue = "";
    for (let i = 0; i < bytes.length; i += 1) textValue += String.fromCharCode(bytes[i]);
    return btoa(textValue);
  }

  function b64ToBytes(value) {
    const textValue = atob(value);
    const bytes = new Uint8Array(textValue.length);
    for (let i = 0; i < textValue.length; i += 1) bytes[i] = textValue.charCodeAt(i);
    return bytes;
  }

  async function rememberKey(key) {
    const epoch = sealEpoch;
    sealKey = key;
    if (!globalThis.localStorage || !globalThis.crypto || !crypto.subtle) return;
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (!writeSealKey(epoch, JSON.stringify(jwk))) sealKey = null;
  }

  async function loadRememberedKey() {
    const epoch = sealEpoch;
    if (sealKey || !globalThis.localStorage || !globalThis.crypto || !crypto.subtle) return;
    const raw = localStorage.getItem("ip-seal-jwk");
    if (!raw || epoch !== sealEpoch) return;
    try {
      const imported = await crypto.subtle.importKey("jwk", JSON.parse(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
      if (epoch !== sealEpoch) return;
      sealKey = imported;
    } catch (error) {
      sealKey = null;
    }
  }

  async function deriveKey(code, saltBytes) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations: 120000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function persistSeal() {
    const epoch = sealEpoch;
    try {
      await loadRememberedKey();
      if (epoch !== sealEpoch || !sealKey || !repo || !repo.allEmbeddings || !globalThis.crypto || !crypto.subtle) return;
      const rows = await repo.allEmbeddings();
      const safe = rows.filter(function (row) { return row.model === INDEX_MODEL; }).map(function (row) {
        return {
          id: row.id,
          recordId: row.recordId,
          chunk: row.chunk,
          model: row.model,
          hash: row.hash,
          vector: Array.from(row.vector || [])
        };
      });
      if (!safe.length) return;
      const existing = await repo.getSealed();
      const salt = existing && existing.salt ? b64ToBytes(existing.salt) : crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, sealKey, new TextEncoder().encode(JSON.stringify(safe)));
      if (epoch !== sealEpoch) return;
      await repo.putSealed({
        id: "current",
        salt: bytesToB64(salt),
        iv: bytesToB64(iv),
        data: bytesToB64(new Uint8Array(cipher))
      });
    } catch (error) {}
  }

  async function unlockSeal(code) {
    if (!repo || !code || !globalThis.crypto || !crypto.subtle) return { restored: 0 };
    const epoch = sealEpoch;
    const sealed = await repo.getSealed();
    if (epoch !== sealEpoch) return { restored: 0, locked: true };
    if (!sealed || !sealed.salt) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(code, salt);
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      await rememberKey(key);
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      await repo.putSealed({ id: "current", salt: bytesToB64(salt), iv: "", data: "" });
      return { restored: 0 };
    }
    try {
      const key = await deriveKey(code, b64ToBytes(sealed.salt));
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      if (!sealed.data) {
        await rememberKey(key);
        return { restored: 0 };
      }
      const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(sealed.iv) }, key, b64ToBytes(sealed.data));
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      const rows = JSON.parse(new TextDecoder().decode(clear));
      const saving = rows.map(function (row) {
        return {
          id: row.id,
          recordId: row.recordId,
          chunk: row.chunk,
          model: row.model,
          hash: row.hash,
          vector: new Float32Array(row.vector || [])
        };
      });
      if (saving.length) await repo.putEmbeddings(saving);
      if (epoch !== sealEpoch) {
        try { await repo.deleteEmbeddings(saving.map(function (row) { return row.id; })); } catch (error) {}
        return { restored: 0, locked: true };
      }
      await rememberKey(key);
      return { restored: saving.length };
    } catch (error) {
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      await repo.deleteSealed();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(code, salt);
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      await rememberKey(key);
      if (epoch !== sealEpoch) return { restored: 0, locked: true };
      await repo.putSealed({ id: "current", salt: bytesToB64(salt), iv: "", data: "" });
      return { restored: 0, reset: true };
    }
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
    passagesOf: passagesOf,
    unlockSeal: unlockSeal,
    lockSeal: lockSeal,
    persistSeal: persistSeal,
    phase: function () { return status.phase; },
    sealEpoch: function () { return sealEpoch; },
    writeSealKey: writeSealKey,
    isReady: function () { return status.phase === "ready"; },
    statusText: statusText,
    modelKey: MODEL_KEY
  };
})(globalThis);
