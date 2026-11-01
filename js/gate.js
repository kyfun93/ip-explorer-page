(function (root) {
  const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
  const IDLE_MS = 30 * 60 * 1000;

  function createServer() {
    let generation = 1;
    let allowedUser = null;
    let sequence = 0;
    const sessions = new Map();
    const questions = new Map();
    const files = new Map();
    let chain = Promise.resolve();

    function enqueue(work) {
      const run = chain.then(work, work);
      chain = run.then(function () { return null; }, function () { return null; });
      return run;
    }

    function snapshot(session) {
      return {
        id: session.id,
        userId: session.userId,
        deviceLabel: session.deviceLabel,
        generation: session.generation,
        openedAt: session.openedAt,
        expiresAt: session.expiresAt,
        lastSeen: session.lastSeen
      };
    }

    function deny(reason) {
      return { ok: false, sessionExpired: reason !== "forbidden", reason: reason };
    }

    function live(session, userId, now) {
      if (!session || !allowedUser || userId !== allowedUser || session.userId !== allowedUser) return false;
      if (session.generation !== generation) return false;
      if (now >= session.expiresAt) return false;
      if (now - session.lastSeen >= IDLE_MS) return false;
      return true;
    }

    function openSession(userId, deviceLabel, now) {
      if (!allowedUser || userId !== allowedUser) return deny("forbidden");
      sequence += 1;
      const session = {
        id: "session-" + sequence,
        userId: userId,
        deviceLabel: String(deviceLabel || "appareil").slice(0, 120),
        generation: generation,
        openedAt: now,
        expiresAt: now + ABSOLUTE_MS,
        lastSeen: now
      };
      sessions.set(session.id, session);
      return { ok: true, session: snapshot(session), sessions: sessions.size };
    }

    function touch(userId, sessionId, now) {
      const session = sessions.get(sessionId);
      if (!live(session, userId, now)) return deny("expired");
      session.lastSeen = now;
      return { ok: true, session: snapshot(session) };
    }

    function allow(userId, sessionId, now) {
      return live(sessions.get(sessionId), userId, now);
    }

    function close(userId, sessionId, now) {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId || userId !== allowedUser) return { ok: false };
      sessions.delete(sessionId);
      return { ok: true, closed: sessionId, at: now, sessions: sessions.size };
    }

    function revoke() {
      generation += 1;
      sessions.clear();
      return { generation: generation, sessions: 0 };
    }

    function importPair(userId, sessionId, now, pair) {
      return enqueue(async function () {
        if (!live(sessions.get(sessionId), userId, now)) return deny("expired");
        const fingerprint = pair.fingerprint;
        const existing = questions.get(fingerprint);
        if (existing) {
          const seen = {};
          existing.provenance.concat(pair.provenance || []).forEach(function (item) {
            seen[JSON.stringify(item)] = item;
          });
          existing.provenance = Object.keys(seen).map(function (key) { return seen[key]; });
          return { ok: true, added: 0, duplicates: 1, questions: questions.size };
        }
        questions.set(fingerprint, {
          id: "q-" + questions.size,
          fingerprint: fingerprint,
          question: pair.question,
          answer: pair.answer || "",
          provenance: (pair.provenance || []).slice()
        });
        return { ok: true, added: 1, duplicates: 0, questions: questions.size };
      });
    }

    function readTable(userId, sessionId, now) {
      if (!live(sessions.get(sessionId), userId, now)) return { ok: false, rows: [] };
      return { ok: true, rows: Array.from(questions.values()) };
    }

    function readPdf(userId, sessionId, now, sha) {
      if (!live(sessions.get(sessionId), userId, now)) return { ok: false, sessionExpired: true };
      return { ok: true, file: files.get(sha) || null };
    }

    function storePdf(userId, sessionId, now, sha) {
      if (!live(sessions.get(sessionId), userId, now)) return deny("expired");
      files.set(sha, true);
      return { ok: true };
    }

    return {
      bindUser: function (userId) { allowedUser = userId; },
      openSession: openSession,
      touch: touch,
      allow: allow,
      close: close,
      revoke: revoke,
      importPair: importPair,
      readTable: readTable,
      readPdf: readPdf,
      storePdf: storePdf,
      session: function (id) {
        const session = sessions.get(id);
        return session ? snapshot(session) : null;
      },
      count: function () { return { sessions: sessions.size, questions: questions.size, generation: generation }; }
    };
  }

  function bootDecision(config, sessionAlive) {
    const remote = Boolean(config && config.url && config.anonKey);
    if (!remote) return { loadFonds: true, wipe: false, login: false };
    if (!sessionAlive) return { loadFonds: false, wipe: true, login: true };
    return { loadFonds: false, wipe: false, login: false };
  }

  function codeChangeSteps() {
    return ["verify-session", "verify-current-code", "update-password", "revoke-sessions", "sign-out-global"];
  }

  root.IPGate = {
    ABSOLUTE_MS: ABSOLUTE_MS,
    IDLE_MS: IDLE_MS,
    createServer: createServer,
    bootDecision: bootDecision,
    codeChangeSteps: codeChangeSteps
  };
})(globalThis);
