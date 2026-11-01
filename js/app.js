(function () {
  const ref = IPReferential;
  const text = IPText;
  const repo = IPRepository.createRepository(IPRepository.createIndexedDbStorage());
  const remote = IPRemote.create(globalThis.IP_CONFIG);
  const state = {
    view: "recherche",
    query: "",
    serviceId: "all",
    yearFrom: "",
    yearTo: "",
    meetingOrder: "desc",
    visibleCount: IPSearch.pageSize,
    scrollY: 0,
    questions: [],
    editingId: null,
    page: "list"
  };
  const viewMemory = {
    recherche: { scrollY: 0, visibleCount: IPSearch.pageSize },
    toutes: { scrollY: 0, visibleCount: IPSearch.pageSize },
    nouveautes: { scrollY: 0, visibleCount: IPSearch.pageSize }
  };
  let restoreScroll = false;
  let queryTimer = 0;

  const els = {
    query: document.getElementById("query"),
    searchForm: document.getElementById("search-form"),
    filters: document.getElementById("service-filters"),
    sortFilters: document.getElementById("sort-filters"),
    period: document.getElementById("period-filters"),
    hint: document.getElementById("search-hint"),
    title: document.getElementById("list-title"),
    count: document.getElementById("list-count"),
    list: document.getElementById("list"),
    home: document.getElementById("home"),
    detail: document.getElementById("detail"),
    yearFrom: document.getElementById("year-from"),
    yearTo: document.getElementById("year-to"),
    importPanel: document.getElementById("import-panel"),
    importsToggle: document.getElementById("imports-toggle"),
    editor: document.getElementById("editor"),
    importer: document.getElementById("importer")
  };

  function readUrl() {
    const params = new URLSearchParams(location.search);
    const view = params.get("vue") || "recherche";
    state.view = view === "toutes" || view === "nouveautes" ? view : "recherche";
    state.meetingOrder = params.get("tri") === "ancien" ? "asc" : "desc";
    state.query = params.get("query") || "";
    const service = params.get("service") || "all";
    const known = service === "all" || ref.SERVICES.some(function (item) { return item.id === service; });
    state.serviceId = known ? service : "all";
    state.yearFrom = /^\d{4}$/.test(params.get("de") || "") ? params.get("de") : "";
    state.yearTo = /^\d{4}$/.test(params.get("a") || "") ? params.get("a") : "";
    if (state.yearFrom && state.yearTo && state.yearFrom > state.yearTo) {
      const swap = state.yearFrom;
      state.yearFrom = state.yearTo;
      state.yearTo = swap;
    }
    els.query.value = state.query;
  }

  function writeUrl() {
    const params = new URLSearchParams(location.search);
    function setParam(key, value) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    setParam("vue", state.view === "recherche" ? "" : state.view);
    setParam("tri", state.view === "toutes" && state.meetingOrder === "asc" ? "ancien" : "");
    setParam("query", text.collapse(state.query) ? state.query : "");
    setParam("service", state.serviceId && state.serviceId !== "all" ? state.serviceId : "");
    setParam("de", state.yearFrom || "");
    setParam("a", state.yearTo || "");
    const next = params.toString();
    const url = location.pathname + (next ? "?" + next : "") + location.hash;
    if (url !== location.pathname + location.search + location.hash) history.replaceState(null, "", url);
  }

  function periodOf() {
    return { from: state.yearFrom, to: state.yearTo };
  }

  function activeFilterLabel() {
    const bits = [];
    if (state.serviceId && state.serviceId !== "all") bits.push(ref.serviceLabel(state.serviceId));
    if (state.view === "nouveautes") return bits.join(" · ");
    if (state.yearFrom && state.yearTo) bits.push(state.yearFrom + "–" + state.yearTo);
    else if (state.yearFrom) bits.push("à partir de " + state.yearFrom);
    else if (state.yearTo) bits.push("jusqu’en " + state.yearTo);
    return bits.join(" · ");
  }

  function setImportsOpen(open) {
    els.importPanel.hidden = !open;
    els.importsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function serviceName(record) {
    if (record.serviceId) return ref.serviceLabel(record.serviceId);
    if (record.serviceMention) return record.serviceMention;
    return "Service à compléter";
  }

  function fillServiceSelect(select, includeBlank) {
    select.innerHTML = "";
    if (includeBlank) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = includeBlank;
      select.appendChild(blank);
    }
    ref.SERVICES.forEach(function (service) {
      const option = document.createElement("option");
      option.value = service.id;
      option.textContent = service.label;
      select.appendChild(option);
    });
  }

  function renderFilters() {
    els.filters.innerHTML = "";
    [{ id: "all", label: "Tous" }].concat(ref.SERVICES).forEach(function (service) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = service.label;
      button.setAttribute("aria-pressed", state.serviceId === service.id ? "true" : "false");
      button.addEventListener("click", function () {
        state.serviceId = service.id;
        state.visibleCount = IPSearch.pageSize;
        render();
      });
      els.filters.appendChild(button);
    });
  }

  function renderYears() {
    const years = {};
    state.questions.forEach(function (record) {
      const year = IPSearch.meetingYear(record);
      if (year) years[year] = 1;
    });
    const list = Object.keys(years).sort();
    [{ select: els.yearFrom, value: state.yearFrom }, { select: els.yearTo, value: state.yearTo }].forEach(function (item) {
      item.select.innerHTML = "";
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Toutes";
      item.select.appendChild(blank);
      list.forEach(function (year) {
        const option = document.createElement("option");
        option.value = year;
        option.textContent = year;
        item.select.appendChild(option);
      });
      if (item.value && list.indexOf(item.value) === -1) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.value;
        item.select.appendChild(option);
      }
      item.select.value = item.value || "";
    });
  }

  let listGeneration = 0;

  function scopedQuestions() {
    return state.questions.filter(function (record) {
      if (state.serviceId && state.serviceId !== "all" && record.serviceId !== state.serviceId) return false;
      const year = IPSearch.meetingYear(record);
      if ((state.yearFrom || state.yearTo) && !year) return false;
      if (state.yearFrom && year < state.yearFrom) return false;
      if (state.yearTo && year > state.yearTo) return false;
      return true;
    });
  }

  function viewTitle() {
    if (state.view === "toutes") return "Toutes les questions";
    if (state.view === "nouveautes") return "Nouveautés";
    return text.collapse(state.query) ? "Résultats" : "Recherche";
  }

  function drawHits(hits) {
    const hasQuery = state.view === "recherche" && text.collapse(state.query).length > 0;
    const filters = activeFilterLabel();
    const sense = hits.some(function (hit) { return hit.kind === "sens"; });
    els.title.textContent = viewTitle();
    if (state.view === "toutes") {
      els.hint.textContent = state.meetingOrder === "asc"
        ? "Classées de la réunion la plus ancienne à la plus récente."
        : "Classées de la réunion la plus récente à la plus ancienne.";
    } else if (state.view === "nouveautes") {
      els.hint.textContent = "Classées par date d’ajout. La date de réunion est indiquée à part.";
    } else if (hits.tooVague) {
      els.hint.textContent = "Cette recherche est trop vague pour isoler une question. Ajoutez un mot plus précis.";
    } else if (sense) {
      els.hint.textContent = "Les cartes « sens proche » viennent du modèle local. Ce rapprochement peut être imparfait.";
    } else if (!hasQuery) {
      els.hint.textContent = "Saisissez un mot ou une question. Les résultats s’affichent ensuite, classés par pertinence.";
    } else {
      els.hint.textContent = "";
    }
    const countLabel = hits.length > 1 ? hits.length + " questions" : (hits.length === 1 ? "1 question" : "Aucun résultat");
    els.count.textContent = filters ? countLabel + " · " + filters : countLabel;
    els.list.innerHTML = "";
    if (!hits.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = hits.tooVague
        ? "Aucun résultat : les mots saisis sont trop généraux."
        : (state.questions.length
          ? "Aucun résultat pertinent."
          : "Aucune question pour le moment. Ajoutez-en une, ou importez un compte rendu PDF.");
      els.list.appendChild(empty);
      return;
    }
    hits.slice(0, state.visibleCount).forEach(function (hit) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card";
      const meta = document.createElement("p");
      meta.className = "meta";
      const bits = [serviceName(hit.record), "Réunion : " + text.formatMeetingDate(hit.record.meetingDate)];
      meta.textContent = bits.join(" · ");
      let addedLine = null;
      if (state.view === "nouveautes") {
        addedLine = document.createElement("p");
        addedLine.className = "meta";
        addedLine.textContent = "Ajoutée le " + (text.formatAddedAt(hit.record.addedAt) || "date inconnue");
      }
      if (hit.kind === "sens") {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Sens proche";
        meta.appendChild(badge);
      }
      if (hit.record.readingCaution) {
        const caution = document.createElement("span");
        caution.className = "caution";
        caution.textContent = "Lecture incertaine";
        meta.appendChild(document.createTextNode(" · "));
        meta.appendChild(caution);
      }
      const title = document.createElement("h3");
      const excerpt = document.createElement("p");
      excerpt.className = "excerpt";
      const excerptText = hasQuery && hit.excerpt
        ? hit.excerpt
        : (hit.record.answer ? text.excerpt(hit.record.answer, 180) : "Sans réponse");
      if (hasQuery) {
        title.appendChild(IPSearch.highlightFragment(hit.record.question, hit.stems));
        excerpt.appendChild(IPSearch.highlightFragment(excerptText, hit.stems));
      } else {
        title.textContent = hit.record.question;
        excerpt.textContent = excerptText;
      }
      if (addedLine) button.append(meta, addedLine, title, excerpt);
      else button.append(meta, title, excerpt);
      button.addEventListener("click", function () { openDetail(hit.record.id); });
      els.list.appendChild(button);
    });
    if (hits.length > state.visibleCount) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "more";
      more.textContent = "Voir plus (" + (hits.length - state.visibleCount) + ")";
      more.addEventListener("click", function () {
        state.visibleCount += IPSearch.pageSize;
        render();
      });
      els.list.appendChild(more);
    }
  }

  function currentHits() {
    if (state.view === "toutes") return IPSearch.listByMeeting(state.questions, state.serviceId, periodOf(), state.meetingOrder);
    if (state.view === "nouveautes") return IPSearch.listByAdded(state.questions, state.serviceId);
    if (!text.collapse(state.query)) {
      const idle = [];
      idle.idle = true;
      idle.tooVague = false;
      return idle;
    }
    return IPSearch.searchQuestions(state.questions, state.query, state.serviceId, periodOf());
  }

  function renderList() {
    const hits = currentHits();
    const generation = ++listGeneration;
    const queryNow = state.query;
    const viewNow = state.view;
    if (hits.idle) {
      els.title.textContent = "Recherche";
      els.hint.textContent = "Saisissez un mot ou une question. Les résultats s’affichent ensuite, classés par pertinence.";
      els.count.textContent = "";
      els.list.innerHTML = "";
      return;
    }
    drawHits(hits);
    if (viewNow !== "recherche" || !text.collapse(queryNow) || hits.tooVague || !window.IPSemantic) return;
    IPSemantic.blend(queryNow, scopedQuestions(), hits).then(function (next) {
      if (!next || generation !== listGeneration) return;
      if (state.query !== queryNow || state.view !== "recherche" || state.page !== "list") return;
      const y = window.scrollY;
      drawHits(next);
      window.scrollTo(0, y);
    });
  }

  function renderChrome() {
    document.getElementById("tab-recherche").setAttribute("aria-selected", state.view === "recherche" ? "true" : "false");
    document.getElementById("tab-toutes").setAttribute("aria-selected", state.view === "toutes" ? "true" : "false");
    document.getElementById("tab-nouveautes").setAttribute("aria-selected", state.view === "nouveautes" ? "true" : "false");
    els.searchForm.hidden = state.view !== "recherche";
    els.period.hidden = state.view === "nouveautes";
    els.sortFilters.hidden = state.view !== "toutes";
    document.getElementById("sort-recent").setAttribute("aria-pressed", state.meetingOrder === "desc" ? "true" : "false");
    document.getElementById("sort-old").setAttribute("aria-pressed", state.meetingOrder === "asc" ? "true" : "false");
  }

  function render() {
    writeUrl();
    const showDetail = state.page === "detail";
    els.home.hidden = showDetail;
    els.detail.hidden = !showDetail;
    renderChrome();
    renderFilters();
    renderYears();
    if (!showDetail) {
      renderList();
      if (restoreScroll) {
        const y = state.scrollY || 0;
        restoreScroll = false;
        requestAnimationFrame(function () { window.scrollTo(0, y); });
      }
    }
  }

  async function refresh() {
    state.questions = await repo.allQuestions();
    render();
    if (window.IPSemantic) IPSemantic.schedule(state.questions);
  }

  async function openDetail(id) {
    const record = state.questions.find(function (item) { return item.id === id; }) || await repo.getQuestion(id);
    if (!record) return;
    state.scrollY = window.scrollY;
    state.page = "detail";
    state.editingId = id;
    document.getElementById("detail-meta").textContent = [
      serviceName(record),
      record.meetingDate ? "Réunion : " + text.formatMeetingDate(record.meetingDate) : "Date de réunion à compléter",
      record.number ? "n° " + record.number : ""
    ].filter(Boolean).join(" · ");
    document.getElementById("detail-question").textContent = record.question;
    const org = document.getElementById("detail-org");
    if (record.organization) {
      org.hidden = false;
      org.textContent = record.organization;
    } else {
      org.hidden = true;
      org.textContent = "";
    }
    document.getElementById("detail-answer").textContent = record.answer || "Sans réponse";
    const extra = [];
    if (record.serviceMention) extra.push("Libellé du document : " + record.serviceMention);
    if (record.signedDate) extra.push("Signature : " + text.formatMeetingDate(record.signedDate));
    if (record.subEntityId) extra.push("Sous-entité : " + ref.subEntityLabel(record.subEntityId));
    if (record.place) extra.push("Lieu : " + record.place);
    extra.push("Ajoutée le " + text.formatAddedAt(record.addedAt));
    const proposal = ref.proposalForMention(record.serviceMention);
    const proposalButton = document.getElementById("apply-proposal");
    if (proposal && record.serviceId !== proposal.serviceId) {
      proposalButton.hidden = false;
      proposalButton.textContent = "Classer ce compte rendu dans " + ref.serviceLabel(proposal.serviceId);
    } else {
      proposalButton.hidden = true;
    }
    if (record.origin === "demo") extra.push("Exemple fictif, pas un compte rendu réel.");
    document.getElementById("detail-extra").textContent = extra.join(" · ");
    const caution = record.readingCaution;
    const cautionBox = document.getElementById("detail-reading");
    const cautionText = document.getElementById("detail-reading-text");
    const cautionButton = document.getElementById("detail-reading-page");
    if (caution && caution.words && caution.words.length) {
      const pages = caution.pages && caution.pages.length ? caution.pages : [];
      cautionBox.hidden = false;
      cautionText.textContent = "Lecture incertaine. Ces mots ont été lus avec une faible confiance : " + caution.words.join(", ") + ". Le texte affiché est celui qui a été lu, sans réécriture.";
      cautionButton.hidden = !pages.length;
      cautionButton.textContent = pages.length ? "Voir la page " + pages[0] : "Voir la page source";
      cautionButton.onclick = function () {
        const box = document.getElementById("pdf-box");
        if (box) box.hidden = false;
        const target = document.querySelector("#pdf-pages button[data-page=\"" + pages[0] + "\"]");
        if (target) target.click();
        if (box) box.scrollIntoView({ block: "start" });
      };
    } else {
      cautionBox.hidden = true;
      cautionText.textContent = "";
      cautionButton.onclick = null;
    }
    await renderPdf(record);
    render();
    window.scrollTo(0, 0);
  }

  async function renderPdf(record) {
    const box = document.getElementById("pdf-box");
    const pages = document.getElementById("pdf-pages");
    const canvas = document.getElementById("pdf-canvas");
    pages.innerHTML = "";
    const source = (record.provenance || [])[0];
    if (!source) {
      box.hidden = true;
      return;
    }
    let file = await repo.getFile(source.documentId);
    if (!file && remote.enabled() && source.sha256) {
      const downloaded = await remote.downloadPdf(source.sha256);
      if (downloaded.sessionExpired) {
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return;
      }
      if (downloaded.blob) {
        file = downloaded.blob;
        await repo.attachFile(source.documentId, file);
      }
    }
    box.hidden = true;
    if (!file) return;
    const pageNumbers = source.pages && source.pages.length ? source.pages : [1];
    const cautionPages = record.readingCaution && record.readingCaution.pages ? record.readingCaution.pages : [];
    const preferred = cautionPages.filter(function (pageNumber) { return pageNumbers.indexOf(pageNumber) >= 0; })[0] || pageNumbers[0];
    async function show(pageNumber) {
      pages.querySelectorAll("button").forEach(function (button) {
        button.setAttribute("aria-pressed", button.dataset.page === String(pageNumber) ? "true" : "false");
      });
      await IPPdf.renderPage(file, pageNumber, canvas);
    }
    pageNumbers.forEach(function (pageNumber) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.page = String(pageNumber);
      button.textContent = "Page " + pageNumber;
      button.addEventListener("click", function () { show(pageNumber); });
      pages.appendChild(button);
    });
    await show(preferred);
  }

  function fillSubEntities(serviceId, selected) {
    const select = document.getElementById("field-sub");
    select.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Aucune";
    select.appendChild(blank);
    ref.subEntitiesFor(serviceId).forEach(function (item) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      select.appendChild(option);
    });
    select.value = selected || "";
  }

  function openEditor(record) {
    state.editingId = record ? record.id : null;
    document.getElementById("editor-title").textContent = record ? "Corriger la question" : "Ajouter une question";
    document.getElementById("delete-button").hidden = !record;
    document.getElementById("editor-error").hidden = true;
    document.getElementById("field-question").value = record ? record.question : "";
    document.getElementById("field-answer").value = record ? record.answer : "";
    document.getElementById("field-service").value = record && record.serviceId ? record.serviceId : "";
    fillSubEntities(document.getElementById("field-service").value, record && record.subEntityId);
    document.getElementById("field-place").value = record && record.place ? record.place : "";
    document.getElementById("field-date").value = record && record.meetingDate ? record.meetingDate : "";
    document.getElementById("field-number").value = record && record.number ? record.number : "";
    const org = document.getElementById("field-org");
    org.value = record && record.organization ? record.organization : "";
    if (record && record.organization && !org.value) {
      const option = document.createElement("option");
      option.value = record.organization;
      option.textContent = record.organization;
      org.appendChild(option);
      org.value = record.organization;
    }
    els.editor.showModal();
  }

  function formInput() {
    const organization = document.getElementById("field-org").value;
    return {
      question: document.getElementById("field-question").value,
      answer: document.getElementById("field-answer").value,
      serviceId: document.getElementById("field-service").value || null,
      subEntityId: document.getElementById("field-sub").value || null,
      place: document.getElementById("field-place").value,
      meetingDate: document.getElementById("field-date").value || null,
      number: document.getElementById("field-number").value,
      organization: organization || null
    };
  }

  function showEditorError(message) {
    const error = document.getElementById("editor-error");
    error.hidden = false;
    error.textContent = message;
  }

  fillServiceSelect(document.getElementById("field-service"), "À préciser");
  fillServiceSelect(document.getElementById("import-service"), "Détection automatique");
  fillSubEntities("");

  document.getElementById("field-service").addEventListener("change", function (event) {
    fillSubEntities(event.target.value, "");
  });
  document.getElementById("add-button").addEventListener("click", function () { openEditor(null); });
  document.getElementById("edit-button").addEventListener("click", function () {
    const record = state.questions.find(function (item) { return item.id === state.editingId; });
    if (record) openEditor(record);
  });
  document.getElementById("cancel-edit").addEventListener("click", function () { els.editor.close(); });
  document.getElementById("close-import").addEventListener("click", function () { els.importer.close(); });
  document.getElementById("import-button").addEventListener("click", function () {
    document.getElementById("import-report").innerHTML = "";
    els.importer.showModal();
  });
  document.getElementById("apply-proposal").addEventListener("click", async function () {
    const record = state.questions.find(function (item) { return item.id === state.editingId; });
    const proposal = record ? ref.proposalForMention(record.serviceMention) : null;
    if (!record || !proposal) return;
    const documentId = record.provenance && record.provenance[0] ? record.provenance[0].documentId : "";
    const targets = state.questions.filter(function (item) {
      if (item.serviceId === proposal.serviceId) return false;
      if (!ref.proposalForMention(item.serviceMention)) return false;
      if (!documentId) return item.id === record.id;
      return (item.provenance || []).some(function (source) { return source.documentId === documentId; });
    });
    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      await repo.updateQuestion(item.id, {
        question: item.question,
        answer: item.answer,
        serviceId: proposal.serviceId,
        subEntityId: item.subEntityId,
        place: item.place || "",
        meetingDate: item.meetingDate,
        number: item.number || "",
        organization: item.organization
      });
    }
    await refresh();
    await openDetail(record.id);
  });
  document.getElementById("back-button").addEventListener("click", function () {
    state.page = "list";
    restoreScroll = true;
    render();
  });
  function showView(next) {
    if (next !== "recherche" && next !== "toutes" && next !== "nouveautes") return;
    if (next === state.view && state.page === "list") return;
    viewMemory[state.view] = { scrollY: window.scrollY, visibleCount: state.visibleCount };
    state.view = next;
    state.page = "list";
    state.visibleCount = viewMemory[next].visibleCount;
    state.scrollY = viewMemory[next].scrollY;
    restoreScroll = true;
    render();
  }
  document.getElementById("tab-recherche").addEventListener("click", function () { showView("recherche"); });
  document.getElementById("tab-toutes").addEventListener("click", function () { showView("toutes"); });
  document.getElementById("tab-nouveautes").addEventListener("click", function () { showView("nouveautes"); });
  document.getElementById("sort-recent").addEventListener("click", function () {
    state.meetingOrder = "desc";
    state.visibleCount = IPSearch.pageSize;
    state.page = "list";
    render();
  });
  document.getElementById("sort-old").addEventListener("click", function () {
    state.meetingOrder = "asc";
    state.visibleCount = IPSearch.pageSize;
    state.page = "list";
    render();
  });
  document.getElementById("search-form").addEventListener("submit", function (event) {
    event.preventDefault();
    state.query = els.query.value;
    state.visibleCount = IPSearch.pageSize;
    state.page = "list";
    render();
  });
  els.query.addEventListener("input", function () {
    state.query = els.query.value;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(function () {
      state.visibleCount = IPSearch.pageSize;
      state.page = "list";
      render();
    }, 120);
  });
  function applyYears(from, to) {
    if (from && to && from > to) {
      state.yearFrom = to;
      state.yearTo = from;
    } else {
      state.yearFrom = from;
      state.yearTo = to;
    }
    state.visibleCount = IPSearch.pageSize;
    render();
  }
  els.yearFrom.addEventListener("change", function () {
    applyYears(els.yearFrom.value, state.yearTo);
  });
  els.yearTo.addEventListener("change", function () {
    applyYears(state.yearFrom, els.yearTo.value);
  });
  document.getElementById("reset-filters").addEventListener("click", function () {
    state.query = "";
    state.serviceId = "all";
    state.yearFrom = "";
    state.yearTo = "";
    state.visibleCount = IPSearch.pageSize;
    els.query.value = "";
    state.page = "list";
    render();
  });
  els.importsToggle.addEventListener("click", function () {
    setImportsOpen(els.importPanel.hidden);
  });
  document.getElementById("imports-close").addEventListener("click", function () {
    setImportsOpen(false);
  });

  document.getElementById("editor-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const input = formInput();
    if (!text.collapse(input.question)) {
      showEditorError("Écrivez la question.");
      return;
    }
    if (!state.editingId && !input.serviceId) {
      showEditorError("Choisissez un service.");
      return;
    }
    const result = state.editingId
      ? await repo.updateQuestion(state.editingId, input)
      : await repo.addManual(input);
    if (!result.ok) {
      showEditorError(result.reason);
      return;
    }
    if (remote.enabled()) {
      const shared = await remote.saveQuestion(result.record);
      if (shared.sessionExpired) {
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return;
      }
      if (!shared.ok) {
        if (!state.editingId) await repo.removeQuestion(result.record.id);
        showEditorError(shared.reason === "duplicate"
          ? "Une question identique existe déjà dans la base partagée."
          : "L’enregistrement partagé a échoué.");
        return;
      }
    }
    els.editor.close();
    await refresh();
    if (state.page === "detail") await openDetail(result.record.id);
  });

  document.getElementById("delete-button").addEventListener("click", async function () {
    if (!state.editingId) return;
    if (!window.confirm("Supprimer cette question ?")) return;
    if (remote.enabled()) {
      const shared = await remote.deleteQuestion(state.editingId);
      if (shared.sessionExpired) {
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return;
      }
      if (!shared.ok) {
        showEditorError("La suppression partagée a échoué.");
        return;
      }
    }
    await repo.removeQuestion(state.editingId);
    els.editor.close();
    state.page = "list";
    await refresh();
  });

  async function importBuffer(name, buffer, forced, options) {
    const status = document.getElementById("fonds-status");
    const sha = await IPPdf.sha256(buffer.slice(0));
    let pages = await IPPdf.extractPages(buffer.slice(0));
    const ocrPages = pages.filter(function (page) { return IPParse.pageNeedsOcr(page); }).length;
    if (status) {
      status.hidden = false;
      setImportsOpen(true);
      const progress = globalThis.__fondsProgress ? globalThis.__fondsProgress + " — " : "";
      status.textContent = progress + (ocrPages
        ? "Lecture de " + name + " (OCR français, " + ocrPages + " page" + (ocrPages > 1 ? "s" : "") + ")…"
        : "Lecture de " + name + "…");
    }
    const deadline = Date.now() + (IPOcr.fileDeadlineMs || 240000);
    pages = await IPOcr.completePages(buffer.slice(0), pages, deadline);
    const parsed = IPParse.parseMeeting(pages);
    if (options && options.keepIfFewer && parsed.pairs.length <= options.keepIfFewer) {
      return {
        fileName: name,
        ignored: parsed.pairs.length === 0,
        kept: true,
        pairs: parsed.pairs.length,
        reason: parsed.pairs.length ? "La nouvelle lecture n’ajoute pas de question. Les paires déjà enregistrées sont conservées." : (pages.map(function (page) { return page.ocrError; }).filter(Boolean)[0] || (parsed.anomalies[0] && parsed.anomalies[0].message) || "Aucun tableau questions/réponses n’a été lu."),
        added: 0,
        duplicates: 0,
        preserved: 0,
        skippedFile: false,
        meetingDate: parsed.meetingDate || null,
        anomalies: parsed.anomalies || [],
        notes: parsed.notes || []
      };
    }
    if (!parsed.pairs.length) {
      const failed = pages.map(function (page) { return page.ocrError; }).filter(Boolean)[0];
      const reason = failed || (parsed.anomalies[0] && parsed.anomalies[0].message) || "Aucun tableau questions/réponses n’a été lu.";
      return {
        fileName: name,
        ignored: true,
        reason: reason,
        added: 0,
        duplicates: 0,
        preserved: 0,
        skippedFile: false,
        anomalies: parsed.anomalies || [],
        notes: parsed.notes || []
      };
    }
    const bilan = await repo.reimportParsed(name, sha, pages.length, parsed, new Blob([buffer], { type: "application/pdf" }), forced || null, Boolean(options && options.force));
    bilan.ignored = false;
    if (remote.enabled()) {
      const shared = await remote.pushImport({
        sha256: sha,
        fileName: name,
        pageCount: pages.length,
        pairs: (parsed.pairs || []).map(function (pair) {
          const record = {
            question: pair.question,
            answer: pair.answer || "",
            number: pair.number || null,
            organization: pair.organization || null,
            serviceId: forced || parsed.serviceId || null,
            serviceMention: forced ? null : parsed.serviceMention || null,
            meetingDate: parsed.meetingDate || null,
            signedDate: parsed.signedDate || null,
            addedAt: new Date().toISOString(),
            provenance: [{ fileName: name, sha256: sha, pages: pair.pages || [] }]
          };
          record.fingerprint = text.fingerprint(record);
          return record;
        })
      });
      if (shared.sessionExpired) {
        bilan.sessionExpired = true;
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return bilan;
      }
      const uploaded = await remote.uploadPdf(sha, new Blob([buffer], { type: "application/pdf" }));
      if (uploaded.sessionExpired) {
        bilan.sessionExpired = true;
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return bilan;
      }
      bilan.sharedDuplicates = shared.duplicates || 0;
    }
    return bilan;
  }

  document.getElementById("import-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const input = document.getElementById("import-files");
    const files = Array.from(input.files || []);
    const report = document.getElementById("import-report");
    if (!files.length) {
      report.textContent = "Choisissez au moins un PDF.";
      return;
    }
    const button = document.getElementById("run-import");
    button.disabled = true;
    report.textContent = "Lecture des PDF…";
    const forced = document.getElementById("import-service").value || null;
    let added = 0;
    let duplicates = 0;
    let anomalies = 0;
    let already = 0;
    let ignored = 0;
    let preserved = 0;
    const lines = [];
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const buffer = await file.arrayBuffer();
        const bilan = await importBuffer(file.name, buffer, forced);
        added += bilan.added || 0;
        duplicates += bilan.duplicates || 0;
        preserved += bilan.preserved || 0;
        anomalies += (bilan.anomalies || []).length;
        if (bilan.ignored) {
          ignored += 1;
          lines.push(file.name + " : écarté. " + bilan.reason);
        } else {
          const bits = [file.name + " : " + bilan.added + " ajoutée" + (bilan.added > 1 ? "s" : "")];
          if (bilan.reprocessed) bits.push("ancienne lecture remplacée");
          if (bilan.skippedFile) {
            bits[0] = file.name + " : déjà importé avec la lecture actuelle";
            already += 1;
          }
          if (bilan.preserved) bits.push(bilan.preserved + " correction" + (bilan.preserved > 1 ? "s" : "") + " manuelle" + (bilan.preserved > 1 ? "s" : "") + " conservée" + (bilan.preserved > 1 ? "s" : ""));
          if (bilan.duplicates) bits.push(bilan.duplicates + " doublon" + (bilan.duplicates > 1 ? "s" : "") + " évité" + (bilan.duplicates > 1 ? "s" : ""));
          if (bilan.sharedDuplicates) bits.push(bilan.sharedDuplicates + " doublon" + (bilan.sharedDuplicates > 1 ? "s" : "") + " déjà dans la base partagée");
          if (bilan.sessionExpired) return;
          lines.push(bits.join(", "));
        }
        (bilan.notes || []).forEach(function (note) { lines.push(note); });
        (bilan.anomalies || []).forEach(function (issue) { lines.push("Anomalie : " + issue.message); });
        await refresh();
      }
      const summary = [
        added + " paire" + (added > 1 ? "s" : "") + " ajoutée" + (added > 1 ? "s" : ""),
        duplicates + " doublon" + (duplicates > 1 ? "s" : "") + " évité" + (duplicates > 1 ? "s" : ""),
        already + " fichier" + (already > 1 ? "s" : "") + " déjà à jour"
      ];
      if (preserved) summary.push(preserved + " correction" + (preserved > 1 ? "s" : "") + " manuelle" + (preserved > 1 ? "s" : "") + " conservée" + (preserved > 1 ? "s" : ""));
      if (ignored) summary.push(ignored + " document" + (ignored > 1 ? "s" : "") + " écarté" + (ignored > 1 ? "s" : ""));
      if (anomalies) summary.push(anomalies + " anomalie" + (anomalies > 1 ? "s" : "") + " de lecture ou d’association");
      lines.unshift(summary.join(", ") + ".");
      report.innerHTML = "";
      lines.forEach(function (line) {
        const p = document.createElement("p");
        p.textContent = line;
        report.appendChild(p);
      });
      input.value = "";
      await refresh();
    } catch (error) {
      report.textContent = "La lecture a échoué : " + (error && error.message ? error.message : "erreur inconnue");
    } finally {
      button.disabled = false;
    }
  });

  function renderFondsEtat(etat) {
    const root = document.getElementById("fonds-bilan");
    if (!root || !etat) return;
    const lists = {
      imported: document.getElementById("bilan-imported"),
      partial: document.getElementById("bilan-partial"),
      failed: document.getElementById("bilan-failed"),
      excluded: document.getElementById("bilan-excluded")
    };
    Object.keys(lists).forEach(function (key) {
      const list = lists[key];
      list.innerHTML = "";
      const rows = etat[key] || [];
      if (!rows.length) {
        const item = document.createElement("li");
        item.textContent = "Aucun";
        list.appendChild(item);
        return;
      }
      rows.forEach(function (row) {
        const item = document.createElement("li");
        item.textContent = row;
        list.appendChild(item);
      });
    });
  }

  IPSemantic.attach(repo, function (info) {
    const el = document.getElementById("semantic-status");
    if (!el) return;
    el.textContent = info.text || "";
    el.hidden = !info.text;
    if (info.justReady && state.page === "list" && state.view === "recherche" && text.collapse(state.query)) render();
  });

  readUrl();

  function showLogin(message) {
    document.body.classList.add("needs-login");
    document.getElementById("login-screen").hidden = false;
    document.getElementById("logout-button").hidden = true;
    document.getElementById("change-code-button").hidden = true;
    const error = document.getElementById("login-error");
    error.hidden = !message;
    error.textContent = message || "";
  }

  function showApp() {
    document.body.classList.remove("needs-login");
    document.getElementById("login-screen").hidden = true;
    document.getElementById("logout-button").hidden = !remote.enabled();
    document.getElementById("change-code-button").hidden = !remote.enabled();
  }

  async function lockOut(message) {
    try { await remote.logout(); } catch (error) {}
    remote.forget();
    await repo.clearConfidential();
    IPSemantic.dropIndex();
    state.questions = [];
    showLogin(message || "La session est terminée. Les questions de cet appareil ont été effacées.");
    if (els.list) els.list.innerHTML = "";
  }

  let watching = false;
  function watchSession() {
    if (watching) return;
    watching = true;
    async function check() {
      if (!remote.enabled() || document.body.classList.contains("needs-login")) return;
      try {
        const alive = await remote.status();
        if (alive.sessionExpired) {
          await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
          return;
        }
        if (!alive.ok) return;
        const pulled = await remote.pullQuestions();
        if (pulled.sessionExpired) {
          await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
          return;
        }
        const merged = await repo.mergeShared(pulled.rows || []);
        if (merged.added || merged.updated) await refresh();
      } catch (error) {}
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") check();
    });
    window.addEventListener("pageshow", function () { check(); });
    window.setInterval(check, 60000);
  }

  document.getElementById("login-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const code = document.getElementById("login-code").value;
    const error = document.getElementById("login-error");
    error.hidden = true;
    const signed = await remote.signIn(code);
    document.getElementById("login-code").value = "";
    if (!signed.ok) {
      error.hidden = false;
      error.textContent = "Code refusé.";
      return;
    }
    const pulled = await remote.pullQuestions();
    if (pulled.sessionExpired) {
      await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
      return;
    }
    await repo.mergeShared(pulled.rows || []);
    showApp();
    watchSession();
    await refresh();
  });

  document.getElementById("logout-button").addEventListener("click", function () {
    lockOut("Vous êtes déconnecté. Les questions de cet appareil ont été effacées.");
  });

  document.getElementById("change-code-button").addEventListener("click", function () {
    document.getElementById("code-change").showModal();
  });
  document.getElementById("cancel-code-change").addEventListener("click", function () {
    document.getElementById("code-change").close();
  });

  document.getElementById("change-code-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const currentCode = document.getElementById("current-code").value;
    const nextCode = document.getElementById("next-code").value;
    const confirmCode = document.getElementById("confirm-code").value;
    const error = document.getElementById("change-code-error");
    error.hidden = true;
    if (nextCode.length < 12 || nextCode !== confirmCode) {
      error.hidden = false;
      error.textContent = "Le nouveau code doit contenir au moins 12 caractères et être confirmé.";
      return;
    }
    const changed = await remote.changeCode(currentCode, nextCode);
    document.getElementById("current-code").value = "";
    document.getElementById("next-code").value = "";
    document.getElementById("confirm-code").value = "";
    if (!changed.ok) {
      error.hidden = false;
      error.textContent = "Le code n’a pas été changé.";
      return;
    }
    document.getElementById("code-change").close();
    await lockOut("Le code a été changé. Toutes les sessions ouvertes sont fermées, y compris celle-ci.");
  });

  async function boot() {
    if (remote.enabled()) {
      const restored = await remote.restore();
      if (!restored.sessionAlive) {
        if (restored.sessionExpired) await repo.clearConfidential();
        IPSemantic.dropIndex();
        showLogin(restored.sessionExpired ? "La session a expiré. Les questions de cet appareil ont été effacées." : "");
        return;
      }
      const pulled = await remote.pullQuestions();
      if (pulled.sessionExpired) {
        await lockOut("La session a expiré. Les questions de cet appareil ont été effacées.");
        return;
      }
      await repo.mergeShared(pulled.rows || []);
      showApp();
      watchSession();
    } else {
      showApp();
      try {
        const response = await fetch("data/fonds.json");
        if (response.ok) await repo.installFondsIfEmpty(await response.json());
        await repo.separateMergedPairs();
      } catch (error) {}
      try {
        const etat = await fetch("data/fonds-etat.json", { cache: "no-store" });
        if (etat.ok) renderFondsEtat(await etat.json());
      } catch (error) {}
    }
    await refresh();
  }

  boot().catch(function () {
    els.list.innerHTML = "<p class=\"empty\">La sauvegarde locale n’est pas disponible dans ce navigateur.</p>";
  });

  globalThis.IPExplorer = {
    importBuffer: importBuffer,
    applyRecovered: async function (name, buffer, parsed, pageCount) {
      const sha = await IPPdf.sha256(buffer.slice(0));
      const bilan = await repo.reimportParsed(
        name,
        sha,
        pageCount || (parsed && parsed.pageCount) || 0,
        parsed,
        new Blob([buffer], { type: "application/pdf" }),
        null,
        true
      );
      bilan.sha = sha;
      await refresh();
      return bilan;
    },
    refresh: refresh,
    classifyConfirmedMention: function (mention, serviceId) { return repo.classifyConfirmedMention(mention, serviceId); },
    assignMeetingDate: function (fileName, meetingDate) { return repo.assignMeetingDate(fileName, meetingDate); },
    removeQuestionByText: function (questionText) { return repo.removeQuestionByText(questionText); },
    renderFondsEtat: renderFondsEtat
  };
})();
