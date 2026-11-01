(function (root) {
  const text = root.IPText;
  const EXTRACTOR = "2026-10-31-cellules";

  function nowIso() {
    return new Date().toISOString();
  }

  function pairRecord(pair, meeting, document, forcedServiceId) {
    const record = {
      id: text.createId(),
      origin: "import",
      question: pair.question,
      answer: pair.answer || "",
      number: pair.number || null,
      organization: pair.organization || null,
      serviceId: forcedServiceId || meeting.serviceId || null,
      serviceMention: meeting.serviceMention || null,
      subEntityId: null,
      place: null,
      meetingDate: meeting.meetingDate || null,
      signedDate: meeting.signedDate || null,
      addedAt: nowIso(),
      updatedAt: nowIso(),
      provenance: [{
        documentId: document.id,
        fileName: document.fileName,
        pages: pair.pages.slice()
      }],
      readingCaution: pair.readingCaution || null
    };
    record.fingerprint = text.fingerprint(record);
    return record;
  }

  function createRepository(storage) {
    let chain = Promise.resolve();

    function enqueue(work) {
      const run = chain.then(work, work);
      chain = run.then(function () { return null; }, function () { return null; });
      return run;
    }

    async function importParsed(fileName, sha256, pageCount, parsed, blob, forcedServiceId) {
      return enqueue(async function () {
        if (await storage.hasDocument(sha256)) {
          return {
            fileName: fileName,
            added: 0,
            duplicates: 0,
            skippedFile: true,
            anomalies: [],
            notes: ["Ce fichier est déjà importé. Aucune paire n’a été recréée."]
          };
        }
        const document = {
          id: text.createId(),
          sha256: sha256,
          fileName: fileName,
          pageCount: pageCount,
          importedAt: nowIso()
        };
        let added = 0;
        let duplicates = 0;
        const written = [];
        for (let i = 0; i < parsed.pairs.length; i += 1) {
          const record = pairRecord(parsed.pairs[i], parsed, document, forcedServiceId || null);
          const existing = await storage.findByFingerprint(record.fingerprint);
          if (existing) {
            await storage.addProvenance(existing.id, record.provenance[0]);
            duplicates += 1;
          } else {
            await storage.putQuestion(record);
            written.push(record);
            added += 1;
          }
        }
        await storage.putDocument(document, blob || null);
        return {
          fileName: fileName,
          added: added,
          duplicates: duplicates,
          skippedFile: false,
          anomalies: parsed.anomalies || [],
          notes: parsed.notes || [],
          meetingDate: parsed.meetingDate,
          serviceId: forcedServiceId || parsed.serviceId,
          serviceMention: forcedServiceId ? null : parsed.serviceMention
        };
      });
    }

    function questionWasEdited(question) {
      return question.origin === "manual" || question.manuallyEdited === true;
    }

    async function reimportParsed(fileName, sha256, pageCount, parsed, blob, forcedServiceId, force) {
      return enqueue(async function () {
        const existing = await storage.findDocument(sha256);
        if (existing && existing.extractor === EXTRACTOR && !force) {
          return {
            fileName: fileName,
            added: 0,
            duplicates: 0,
            preserved: 0,
            skippedFile: true,
            reprocessed: false,
            anomalies: [],
            notes: ["Ce fichier est déjà importé avec la lecture actuelle. Aucune paire n’a été recréée."]
          };
        }
        const document = {
          id: text.createId(),
          sha256: sha256,
          fileName: fileName,
          pageCount: pageCount,
          importedAt: nowIso(),
          extractor: EXTRACTOR
        };
        const keptByNumber = {};
        const reusable = [];
        let preserved = 0;
        if (existing) {
          const all = await storage.allQuestions();
          for (let i = 0; i < all.length; i += 1) {
            const question = all[i];
            const sources = question.provenance || [];
            if (!sources.some(function (source) { return source.documentId === existing.id; })) continue;
            if (questionWasEdited(question)) {
              const key = question.number || "";
              keptByNumber[key] = (keptByNumber[key] || 0) + 1;
              question.provenance = sources.map(function (source) {
                if (source.documentId !== existing.id) return source;
                return { documentId: document.id, fileName: fileName, pages: source.pages || [] };
              });
              await storage.putQuestion(question);
              preserved += 1;
              continue;
            }
            reusable.push(question);
          }
          await storage.deleteDocument(existing.id);
        }
        const consumedIds = {};
        function sameOpening(left, right) {
          const a = text.collapse(left);
          const b = text.collapse(right);
          if (!a || !b) return false;
          if (a === b) return true;
          const limit = Math.min(a.length, b.length, 90);
          return limit >= 40 && a.slice(0, limit) === b.slice(0, limit);
        }
        function takeReusable(pair) {
          const key = pair.number || "";
          for (let i = 0; i < reusable.length; i += 1) {
            const current = reusable[i];
            if (consumedIds[current.id]) continue;
            if ((current.number || "") !== key) continue;
            if (!key && !sameOpening(current.question, pair.question)) continue;
            consumedIds[current.id] = true;
            return current;
          }
          let best = null;
          let bestLen = 0;
          for (let i = 0; i < reusable.length; i += 1) {
            const current = reusable[i];
            if (consumedIds[current.id]) continue;
            if (!sameOpening(current.question, pair.question)) continue;
            const len = Math.min(text.collapse(current.question).length, text.collapse(pair.question).length);
            if (len > bestLen) {
              best = current;
              bestLen = len;
            }
          }
          if (!best) return null;
          consumedIds[best.id] = true;
          return best;
        }
        let added = 0;
        let duplicates = 0;
        const createdIds = [];
        const consumedNumbers = {};
        for (let i = 0; i < parsed.pairs.length; i += 1) {
          const pair = parsed.pairs[i];
          const key = pair.number || "";
          const used = consumedNumbers[key] || 0;
          if ((keptByNumber[key] || 0) > used) {
            consumedNumbers[key] = used + 1;
            continue;
          }
          const record = pairRecord(pair, parsed, document, forcedServiceId || null);
          const current = takeReusable(pair);
          if (current) {
            const otherSources = (current.provenance || []).filter(function (source) {
              return source.documentId !== existing.id;
            });
            record.id = current.id;
            record.addedAt = current.addedAt;
            record.origin = current.origin || "import";
            record.provenance = otherSources.concat(record.provenance);
            record.fingerprint = text.fingerprint(record);
            const clash = await storage.findByFingerprint(record.fingerprint);
            if (clash && clash.id !== current.id) {
              await storage.addProvenance(clash.id, record.provenance[record.provenance.length - 1]);
              if (!otherSources.length) await storage.removeQuestion(current.id);
              else {
                current.provenance = otherSources;
                await storage.putQuestion(current);
              }
              duplicates += 1;
            } else {
              await storage.putQuestion(record);
            }
            continue;
          }
          const same = await storage.findByFingerprint(record.fingerprint);
          if (same) {
            await storage.addProvenance(same.id, record.provenance[0]);
            duplicates += 1;
          } else {
            await storage.putQuestion(record);
            createdIds.push(record.id);
            added += 1;
          }
        }
        for (let i = 0; i < reusable.length; i += 1) {
          const current = reusable[i];
          if (consumedIds[current.id]) continue;
          const rest = (current.provenance || []).filter(function (source) {
            return !existing || source.documentId !== existing.id;
          });
          if (!rest.length) await storage.removeQuestion(current.id);
          else {
            current.provenance = rest;
            await storage.putQuestion(current);
          }
        }
        await storage.putDocument(document, blob || null);
        return {
          fileName: fileName,
          added: added,
          duplicates: duplicates,
          preserved: preserved,
          skippedFile: false,
          createdIds: createdIds,
          reprocessed: Boolean(existing),
          anomalies: parsed.anomalies || [],
          notes: parsed.notes || [],
          meetingDate: parsed.meetingDate,
          serviceId: forcedServiceId || parsed.serviceId,
          serviceMention: forcedServiceId ? null : parsed.serviceMention
        };
      });
    }

    async function addManual(input) {
      return enqueue(async function () {
        const record = {
          id: text.createId(),
          origin: "manual",
          question: text.collapse(input.question),
          answer: String(input.answer || "").trim(),
          number: text.collapse(input.number) || null,
          organization: input.organization || null,
          serviceId: input.serviceId,
          serviceMention: null,
          subEntityId: input.subEntityId || null,
          place: text.collapse(input.place) || null,
          meetingDate: input.meetingDate || null,
          addedAt: nowIso(),
          updatedAt: nowIso(),
          provenance: []
        };
        record.fingerprint = text.fingerprint(record);
        const existing = await storage.findByFingerprint(record.fingerprint);
        if (existing) {
          return { ok: false, reason: "Une question identique existe déjà pour ce service et cette date de réunion." };
        }
        await storage.putQuestion(record);
        return { ok: true, record: record };
      });
    }

    async function updateQuestion(id, input) {
      return enqueue(async function () {
        const current = await storage.getQuestion(id);
        if (!current) return { ok: false, reason: "Question introuvable." };
        const next = {
          id: current.id,
          origin: current.origin,
          question: text.collapse(input.question),
          answer: String(input.answer || "").trim(),
          number: text.collapse(input.number) || null,
          organization: input.organization || null,
          serviceId: input.serviceId || null,
          serviceMention: current.serviceMention || null,
          subEntityId: input.subEntityId || null,
          place: text.collapse(input.place) || null,
          meetingDate: input.meetingDate || null,
          signedDate: current.signedDate || null,
          addedAt: current.addedAt,
          updatedAt: nowIso(),
          provenance: current.provenance || [],
          readingCaution: null,
          manuallyEdited: current.manuallyEdited || false
        };
        const textChanged = text.collapse(next.question) !== text.collapse(current.question) || next.answer !== String(current.answer || "").trim();
        if (textChanged) next.manuallyEdited = true;
        if (text.collapse(next.question) === text.collapse(current.question) && next.answer === String(current.answer || "").trim()) {
          next.readingCaution = current.readingCaution || null;
        }
        next.fingerprint = text.fingerprint(next);
        const existing = await storage.findByFingerprint(next.fingerprint);
        if (existing && existing.id !== id) {
          return { ok: false, reason: "Une autre question a déjà exactement ce texte, ce service et cette date." };
        }
        await storage.putQuestion(next);
        return { ok: true, record: next };
      });
    }

    async function removeQuestion(id) {
      return enqueue(function () { return storage.removeQuestion(id); });
    }

    async function loadDemos(demos) {
      return enqueue(async function () {
        await storage.removeQuestionsByOrigin("demo");
        for (let i = 0; i < demos.length; i += 1) {
          const record = Object.assign({}, demos[i], { fingerprint: text.fingerprint(demos[i]) });
          await storage.putQuestion(record);
        }
      });
    }

    async function clearDemos() {
      return enqueue(function () { return storage.removeQuestionsByOrigin("demo"); });
    }

    function foldMention(value) {
      return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    async function classifyConfirmedMention(mention, serviceId) {
      return enqueue(async function () {
        const all = await storage.allQuestions();
        let updated = 0;
        let left = 0;
        for (let i = 0; i < all.length; i += 1) {
          const question = all[i];
          if (foldMention(question.serviceMention).indexOf(foldMention(mention)) === -1) continue;
          if (question.serviceId && question.serviceId !== serviceId) {
            left += 1;
            continue;
          }
          if (question.serviceId === serviceId) continue;
          question.serviceId = serviceId;
          question.fingerprint = text.fingerprint(question);
          await storage.putQuestion(question);
          updated += 1;
        }
        return { updated: updated, left: left };
      });
    }

    async function assignMeetingDate(fileName, meetingDate) {
      return enqueue(async function () {
        if (!meetingDate) return { updated: 0 };
        const all = await storage.allQuestions();
        let updated = 0;
        for (let i = 0; i < all.length; i += 1) {
          const question = all[i];
          const names = (question.provenance || []).map(function (source) { return source.fileName; });
          if (names.indexOf(fileName) === -1) continue;
          if (question.meetingDate) continue;
          question.meetingDate = meetingDate;
          question.fingerprint = text.fingerprint(question);
          await storage.putQuestion(question);
          updated += 1;
        }
        return { updated: updated };
      });
    }

    async function removeQuestionByText(questionText) {
      return enqueue(async function () {
        const all = await storage.allQuestions();
        const target = text.collapse(questionText);
        let removed = 0;
        for (let i = 0; i < all.length; i += 1) {
          const question = all[i];
          if (question.origin !== "manual") continue;
          if (text.collapse(question.question) !== target) continue;
          await storage.removeQuestion(question.id);
          removed += 1;
        }
        return { removed: removed };
      });
    }

    async function installFondsIfEmpty(payload) {
      return enqueue(async function () {
        const existing = await storage.allQuestions();
        if (existing.length) return { installed: false, questions: existing.length };
        const questions = (payload && payload.questions) || [];
        const documents = (payload && payload.documents) || [];
        for (let i = 0; i < questions.length; i += 1) {
          const record = questions[i];
          if (!record.fingerprint) record.fingerprint = text.fingerprint(record);
          await storage.putQuestion(record);
        }
        for (let i = 0; i < documents.length; i += 1) {
          await storage.putDocument(documents[i], null);
        }
        return { installed: true, questions: questions.length, documents: documents.length };
      });
    }

    function copyProvenance(source) {
      return (source.provenance || []).map(function (item) {
        return {
          documentId: item.documentId,
          fileName: item.fileName,
          pages: (item.pages || []).slice()
        };
      });
    }

    function recoveredRecord(source, question, answer, number) {
      const record = {
        id: text.createId(),
        origin: "import",
        question: text.collapse(question),
        answer: String(answer || "").trim(),
        number: number || null,
        organization: source.organization || null,
        serviceId: source.serviceId || null,
        serviceMention: source.serviceMention || null,
        subEntityId: source.subEntityId || null,
        place: source.place || null,
        meetingDate: source.meetingDate || null,
        signedDate: source.signedDate || null,
        addedAt: nowIso(),
        updatedAt: nowIso(),
        provenance: copyProvenance(source),
        readingCaution: null
      };
      record.fingerprint = text.fingerprint(record);
      return record;
    }

    async function mergeShared(rows) {
      return enqueue(async function () {
        const all = await storage.allQuestions();
        const incoming = rows || [];
        const seen = {};
        let added = 0;
        let updated = 0;
        for (let i = 0; i < incoming.length; i += 1) {
          const row = incoming[i];
          if (!row || !row.fingerprint) continue;
          seen[row.fingerprint] = true;
          const existing = all.find(function (item) { return item.fingerprint === row.fingerprint; });
          if (!existing) {
            await storage.putQuestion(row);
            all.push(row);
            added += 1;
            continue;
          }
          const remoteStamp = row.updatedAt || row.addedAt || "";
          const localStamp = existing.updatedAt || existing.addedAt || "";
          if (remoteStamp && localStamp && remoteStamp < localStamp) continue;
          if (existing.id !== row.id) await storage.removeQuestion(existing.id);
          if (existing.addedAt && (!row.addedAt || existing.addedAt < row.addedAt)) row.addedAt = existing.addedAt;
          await storage.putQuestion(row);
          updated += 1;
        }
        if (incoming.length) {
          for (let i = all.length - 1; i >= 0; i -= 1) {
            if (seen[all[i].fingerprint]) continue;
            await storage.removeQuestion(all[i].id);
          }
        }
        return { added: added, updated: updated };
      });
    }

    async function separateMergedPairs() {
      return enqueue(async function () {
        const all = await storage.allQuestions();
        const marker = /([\s\S]{40,}?[.?!])\s+(Retour sur (?:la|les) questions?\s+n[°o]?\s*\d+\b[\s\S]*)/i;
        let separated = 0;
        for (let i = 0; i < all.length; i += 1) {
          const question = all[i];
          if (questionWasEdited(question)) continue;
          const match = String(question.question || "").match(marker);
          if (!match) continue;
          const introQuestion = text.collapse(match[1]);
          const numberedQuestion = text.collapse(match[2]);
          if (introQuestion.length < 40 || numberedQuestion.length < 20) continue;
          const answer = String(question.answer || "").trim();
          const sentence = answer.match(/^(.{8,140}?[.?!])\s+(\S[\s\S]+)$/);
          question.question = numberedQuestion;
          question.answer = sentence ? sentence[2].trim() : answer;
          question.updatedAt = nowIso();
          question.fingerprint = text.fingerprint(question);
          await storage.putQuestion(question);
          const intro = recoveredRecord(question, introQuestion, sentence ? sentence[1] : "", null);
          const existingIntro = await storage.findByFingerprint(intro.fingerprint);
          if (!existingIntro) await storage.putQuestion(intro);
          separated += 1;
        }
        return { separated: separated };
      });
    }

    return {
      importParsed: importParsed,
      reimportParsed: reimportParsed,
      separateMergedPairs: separateMergedPairs,
      addManual: addManual,
      updateQuestion: updateQuestion,
      removeQuestion: removeQuestion,
      loadDemos: loadDemos,
      clearDemos: clearDemos,
      installFondsIfEmpty: installFondsIfEmpty,
      mergeShared: mergeShared,
      clearConfidential: function () { return storage.clearConfidential(); },
      attachFile: function (documentId, blob) { return storage.putFile(documentId, blob); },
      classifyConfirmedMention: classifyConfirmedMention,
      assignMeetingDate: assignMeetingDate,
      removeQuestionByText: removeQuestionByText,
      allQuestions: function () { return storage.allQuestions(); },
      getQuestion: function (id) { return storage.getQuestion(id); },
      getFile: function (documentId) { return storage.getFile(documentId); },
      allEmbeddings: function () { return storage.allEmbeddings(); },
      putEmbeddings: function (rows) { return storage.putEmbeddings(rows); },
      deleteEmbeddings: function (ids) { return storage.deleteEmbeddings(ids); }
    };
  }

  function createMemoryStorage() {
    const questions = new Map();
    const documents = new Map();
    const files = new Map();
    const embeddings = new Map();
    return {
      async allQuestions() { return Array.from(questions.values()); },
      async getQuestion(id) { return questions.get(id) || null; },
      async putQuestion(record) { questions.set(record.id, record); },
      async removeQuestion(id) { questions.delete(id); },
      async findByFingerprint(fingerprint) {
        for (const record of questions.values()) {
          if (record.fingerprint === fingerprint) return record;
        }
        return null;
      },
      async addProvenance(id, provenance) {
        const record = questions.get(id);
        record.provenance = (record.provenance || []).concat([provenance]);
      },
      async hasDocument(sha256) {
        for (const document of documents.values()) {
          if (document.sha256 === sha256) return true;
        }
        return false;
      },
      async putDocument(document, blob) {
        documents.set(document.id, document);
        if (blob) files.set(document.id, blob);
      },
      async findDocument(sha256) {
        for (const document of documents.values()) {
          if (document.sha256 === sha256) return document;
        }
        return null;
      },
      async deleteDocument(id) {
        documents.delete(id);
        files.delete(id);
      },
      async getFile(documentId) { return files.get(documentId) || null; },
      async removeQuestionsByOrigin(origin) {
        for (const record of Array.from(questions.values())) {
          if (record.origin === origin) questions.delete(record.id);
        }
      },
      async allEmbeddings() { return Array.from(embeddings.values()); },
      async putEmbeddings(rows) {
        rows.forEach(function (row) { embeddings.set(row.id, row); });
      },
      async deleteEmbeddings(ids) {
        ids.forEach(function (id) { embeddings.delete(id); });
      },
      async putFile(documentId, blob) { files.set(documentId, blob); },
      async clearConfidential() {
        questions.clear();
        documents.clear();
        files.clear();
        embeddings.clear();
      }
    };
  }

  function createIndexedDbStorage() {
    const dbPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open("ip-explorer", 2);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains("questions")) db.createObjectStore("questions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("documents")) db.createObjectStore("documents", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
        if (!db.objectStoreNames.contains("embeddings")) db.createObjectStore("embeddings", { keyPath: "id" });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });

    function tx(storeNames, mode, work) {
      return dbPromise.then(function (db) {
        return new Promise(function (resolve, reject) {
          const transaction = db.transaction(storeNames, mode);
          const stores = {};
          storeNames.forEach(function (name) { stores[name] = transaction.objectStore(name); });
          let resultPromise;
          try { resultPromise = Promise.resolve(work(stores, transaction)); }
          catch (error) { reject(error); return; }
          transaction.oncomplete = function () { resultPromise.then(resolve, reject); };
          transaction.onerror = function () { reject(transaction.error); };
          transaction.onabort = function () { reject(transaction.error); };;
        });
      });
    }

    function requestToPromise(request) {
      return new Promise(function (resolve, reject) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }

    return {
      async allQuestions() {
        return tx(["questions"], "readonly", function (stores) {
          return requestToPromise(stores.questions.getAll());
        });
      },
      async getQuestion(id) {
        return tx(["questions"], "readonly", function (stores) {
          return requestToPromise(stores.questions.get(id));
        });
      },
      async putQuestion(record) {
        await tx(["questions"], "readwrite", function (stores) { stores.questions.put(record); });
      },
      async removeQuestion(id) {
        await tx(["questions"], "readwrite", function (stores) { stores.questions.delete(id); });
      },
      async findByFingerprint(fingerprint) {
        const all = await this.allQuestions();
        return all.find(function (record) { return record.fingerprint === fingerprint; }) || null;
      },
      async addProvenance(id, provenance) {
        const record = await this.getQuestion(id);
        record.provenance = (record.provenance || []).concat([provenance]);
        await this.putQuestion(record);
      },
      async hasDocument(sha256) {
        const documents = await tx(["documents"], "readonly", function (stores) {
          return requestToPromise(stores.documents.getAll());
        });
        return documents.some(function (document) { return document.sha256 === sha256; });
      },
      async putDocument(document, blob) {
        await tx(["documents", "files"], "readwrite", function (stores) {
          stores.documents.put(document);
          if (blob) stores.files.put(blob, document.id);
        });
      },
      async findDocument(sha256) {
        const documents = await tx(["documents"], "readonly", function (stores) {
          return requestToPromise(stores.documents.getAll());
        });
        return documents.find(function (document) { return document.sha256 === sha256; }) || null;
      },
      async deleteDocument(id) {
        await tx(["documents", "files"], "readwrite", function (stores) {
          stores.documents.delete(id);
          stores.files.delete(id);
        });
      },
      async getFile(documentId) {
        return tx(["files"], "readonly", function (stores) {
          return requestToPromise(stores.files.get(documentId));
        });
      },
      async removeQuestionsByOrigin(origin) {
        const all = await this.allQuestions();
        const ids = all.filter(function (record) { return record.origin === origin; }).map(function (record) { return record.id; });
        await tx(["questions"], "readwrite", function (stores) {
          ids.forEach(function (id) { stores.questions.delete(id); });
        });
      },
      async allEmbeddings() {
        return tx(["embeddings"], "readonly", function (stores) {
          return requestToPromise(stores.embeddings.getAll());
        });
      },
      async putEmbeddings(rows) {
        await tx(["embeddings"], "readwrite", function (stores) {
          rows.forEach(function (row) { stores.embeddings.put(row); });
        });
      },
      async deleteEmbeddings(ids) {
        await tx(["embeddings"], "readwrite", function (stores) {
          ids.forEach(function (id) { stores.embeddings.delete(id); });
        });
      },
      async putFile(documentId, blob) {
        await tx(["files"], "readwrite", function (stores) { stores.files.put(blob, documentId); });
      },
      async clearConfidential() {
        await tx(["questions", "documents", "files", "embeddings"], "readwrite", function (stores) {
          stores.questions.clear();
          stores.documents.clear();
          stores.files.clear();
          stores.embeddings.clear();
        });
      }
    };
  }

  root.IPRepository = {
    createRepository: createRepository,
    createMemoryStorage: createMemoryStorage,
    createIndexedDbStorage: createIndexedDbStorage,
    pairRecord: pairRecord
  };
})(globalThis);
