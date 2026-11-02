(function (root) {
  const gate = root.IPGate;

  function shouldLoadLocalFonds(config) {
    return gate.bootDecision(config, true).loadFonds;
  }

  function createOffline() {
    return {
      enabled: function () { return false; },
      shouldLoadLocalFonds: function () { return true; },
      restore: async function () { return { ok: true, sessionAlive: true }; },
      status: async function () { return { ok: true }; },
      logout: async function () { return { ok: true }; },
      forget: function () {}
    };
  }

  function create(config) {
    if (!config || !config.url || !config.anonKey) return createOffline();
    return createSupabaseRemote(config);
  }

  function storageKeys() {
    return ["ip-device-id", "ip-session-id", "ip-access-token", "ip-refresh-token"];
  }

  function createSupabaseRemote(config) {
    const base = String(config.url).replace(/\/$/, "");
    let accessToken = "";
    let refreshToken = "";
    let sessionId = "";

    function deviceId() {
      const store = root.localStorage;
      if (!store) return "appareil";
      let id = store.getItem("ip-device-id");
      if (!id) {
        id = "appareil-" + Math.random().toString(16).slice(2);
        store.setItem("ip-device-id", id);
      }
      return id;
    }

    function authHeaders() {
      return {
        apikey: config.anonKey,
        Authorization: "Bearer " + (accessToken || config.anonKey),
        "Content-Type": "application/json",
        "x-ip-session": sessionId
      };
    }

    async function request(path, options) {
      const response = await fetch(base + path, options);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, sessionExpired: true, status: response.status, body: null };
      }
      let body = null;
      try { body = await response.json(); } catch (error) { body = null; }
      return { ok: response.ok, sessionExpired: false, status: response.status, body: body };
    }

    function remember() {
      const store = root.localStorage;
      if (!store) return;
      if (accessToken) store.setItem("ip-access-token", accessToken);
      if (refreshToken) store.setItem("ip-refresh-token", refreshToken);
      if (sessionId) store.setItem("ip-session-id", sessionId);
    }

    function forget() {
      accessToken = "";
      refreshToken = "";
      sessionId = "";
      const store = root.localStorage;
      if (!store) return;
      storageKeys().forEach(function (key) {
        if (key !== "ip-device-id") store.removeItem(key);
      });
    }

    async function signIn(code) {
      const result = await request("/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { apikey: config.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email: config.sharedEmail, password: code })
      });
      if (!result.ok || !result.body || !result.body.access_token) {
        return { ok: false, sessionExpired: false };
      }
      accessToken = result.body.access_token;
      refreshToken = result.body.refresh_token || "";
      const opened = await request("/rest/v1/rpc/ip_open_session", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_device: deviceId() })
      });
      if (!opened.ok || !opened.body) return { ok: false, sessionExpired: opened.sessionExpired };
      sessionId = opened.body;
      remember();
      return { ok: true, sessionId: sessionId };
    }

    async function status() {
      if (!accessToken || !sessionId) return { ok: false, sessionExpired: true };
      const result = await request("/rest/v1/rpc/ip_touch_session", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_session: sessionId })
      });
      if (result.sessionExpired || result.body === false) return { ok: false, sessionExpired: true };
      return { ok: result.ok, sessionExpired: false };
    }

    function fromRow(row) {
      if (!row || row.serviceId || row.addedAt || !row.fingerprint) return row;
      return {
        id: row.id,
        fingerprint: row.fingerprint,
        question: row.question,
        answer: row.answer || "",
        number: row.number || null,
        organization: row.organization || null,
        serviceId: row.service_id || null,
        serviceMention: row.service_mention || null,
        subEntityId: row.sub_entity_id || null,
        place: row.place || null,
        meetingDate: row.meeting_date || null,
        signedDate: row.signed_date || null,
        addedAt: row.added_at || null,
        updatedAt: row.updated_at || null,
        provenance: row.provenance || [],
        origin: row.origin || "import",
        manuallyEdited: row.manually_edited === true,
        readingCaution: row.reading_caution || null
      };
    }

    async function pullQuestions() {
      const result = await request("/rest/v1/ip_questions?select=*&limit=2000", {
        method: "GET",
        headers: authHeaders()
      });
      if (result.sessionExpired) return { ok: false, sessionExpired: true, rows: [] };
      const rows = Array.isArray(result.body) ? result.body.map(fromRow) : [];
      return { ok: result.ok, sessionExpired: false, rows: rows };
    }

    async function saveQuestion(record) {
      const result = await request("/rest/v1/rpc/ip_save_question", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_session: sessionId, p_payload: record })
      });
      if (result.sessionExpired) return { ok: false, sessionExpired: true };
      const body = result.body || {};
      return { ok: result.ok && body.ok === true, sessionExpired: false, reason: body.reason || "" };
    }

    async function deleteQuestion(id) {
      const result = await request("/rest/v1/rpc/ip_delete_question", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_session: sessionId, p_id: id })
      });
      if (result.sessionExpired) return { ok: false, sessionExpired: true };
      return { ok: result.ok && result.body === true, sessionExpired: false };
    }

    async function pushImport(payload) {
      const result = await request("/rest/v1/rpc/ip_import_pairs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ p_session: sessionId, p_payload: payload })
      });
      if (result.sessionExpired) return { ok: false, sessionExpired: true, added: 0, duplicates: 0 };
      const body = result.body && typeof result.body === "object" ? result.body : {};
      const accepted = result.ok && (body.fileDuplicate === true || typeof body.added === "number");
      return {
        ok: accepted,
        sessionExpired: false,
        added: body.added || 0,
        duplicates: body.duplicates || 0,
        fileDuplicate: body.fileDuplicate === true
      };
    }

    async function uploadPdf(sha256, blob) {
      const response = await fetch(base + "/storage/v1/object/ip-pdfs/" + sha256 + ".pdf", {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: "Bearer " + accessToken,
          "x-ip-session": sessionId,
          "Content-Type": "application/pdf",
          "x-upsert": "true"
        },
        body: blob
      });
      if (response.status === 401 || response.status === 403) return { ok: false, sessionExpired: true };
      return { ok: response.ok, sessionExpired: false };
    }

    async function downloadPdf(sha256) {
      const response = await fetch(base + "/storage/v1/object/ip-pdfs/" + sha256 + ".pdf", {
        method: "GET",
        headers: {
          apikey: config.anonKey,
          Authorization: "Bearer " + accessToken,
          "x-ip-session": sessionId
        }
      });
      if (response.status === 401 || response.status === 403) return { ok: false, sessionExpired: true, blob: null };
      if (!response.ok) return { ok: false, sessionExpired: false, blob: null };
      return { ok: true, sessionExpired: false, blob: await response.blob() };
    }

    async function changeCode(currentCode, nextCode) {
      const result = await request("/functions/v1/ip-change-code", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ currentCode: currentCode, nextCode: nextCode })
      });
      return { ok: result.ok && result.body && result.body.ok, sessionExpired: result.sessionExpired };
    }

    return {
      enabled: function () { return true; },
      shouldLoadLocalFonds: function () { return false; },
      signIn: signIn,
      status: status,
      pullQuestions: pullQuestions,
      saveQuestion: saveQuestion,
      deleteQuestion: deleteQuestion,
      pushImport: pushImport,
      uploadPdf: uploadPdf,
      downloadPdf: downloadPdf,
      changeCode: changeCode,
      logout: async function () {
        if (sessionId) {
          await request("/rest/v1/rpc/ip_close_session", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ p_session: sessionId })
          });
        }
        await request("/auth/v1/logout?scope=local", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({})
        });
        forget();
        return { ok: true };
      },
      forget: forget,
      restore: async function () {
        const store = root.localStorage;
        if (!store) return { ok: false, sessionAlive: false };
        accessToken = store.getItem("ip-access-token") || "";
        refreshToken = store.getItem("ip-refresh-token") || "";
        sessionId = store.getItem("ip-session-id") || "";
        if (!accessToken || !sessionId) return { ok: false, sessionAlive: false };
        const alive = await status();
        return { ok: alive.ok, sessionAlive: alive.ok, sessionExpired: alive.sessionExpired };
      }
    };
  }

  async function mergeByFingerprint(repo, rows) {
    return repo.mergeShared(rows);
  }

  function sharedImportOutcome(shared, uploaded) {
    if (!shared || shared.sessionExpired) {
      return { sessionExpired: true, ok: false, sharedFailed: false, uploadFailed: false, fileDuplicate: false, message: "" };
    }
    if (shared.ok !== true) {
      return {
        sessionExpired: false,
        ok: false,
        sharedFailed: true,
        uploadFailed: false,
        fileDuplicate: false,
        message: "Les questions sont enregistrées sur cet appareil. Le partage a été refusé. Une nouvelle tentative ne crée pas de doublon."
      };
    }
    if (!uploaded || uploaded.ok !== true) {
      return {
        sessionExpired: !!(uploaded && uploaded.sessionExpired),
        ok: false,
        sharedFailed: false,
        uploadFailed: !(uploaded && uploaded.sessionExpired),
        fileDuplicate: shared.fileDuplicate === true,
        message: uploaded && uploaded.sessionExpired ? "" : "Les questions sont enregistrées. L’envoi du PDF n’a pas abouti. Vous pouvez réessayer : les questions déjà enregistrées ne seront pas dupliquées."
      };
    }
    return {
      sessionExpired: false,
      ok: true,
      sharedFailed: false,
      uploadFailed: false,
      fileDuplicate: shared.fileDuplicate === true,
      message: ""
    };
  }

  root.IPRemote = {
    create: create,
    createOffline: createOffline,
    shouldLoadLocalFonds: shouldLoadLocalFonds,
    mergeByFingerprint: mergeByFingerprint,
    sharedImportOutcome: sharedImportOutcome,
    storageKeys: storageKeys
  };
})(globalThis);
