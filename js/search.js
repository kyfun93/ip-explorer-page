(function (root) {
  const text = root.IPText;
  const PAGE_HINT = 20;
  const STOP = {
    le: 1, la: 1, les: 1, un: 1, une: 1, des: 1, de: 1, du: 1, au: 1, aux: 1,
    et: 1, ou: 1, en: 1, dans: 1, pour: 1, par: 1, sur: 1, avec: 1, sans: 1,
    que: 1, qui: 1, dont: 1, ce: 1, se: 1, ne: 1, pas: 1, plus: 1, est: 1, sont: 1,
    a: 1, ont: 1, d: 1, l: 1, n: 1, y: 1, il: 1, elle: 1, ils: 1, elles: 1,
    nous: 1, vous: 1, leur: 1, leurs: 1, cette: 1, ces: 1, cet: 1,
    mon: 1, ma: 1, mes: 1, son: 1, sa: 1, ses: 1, nos: 1, vos: 1,
    etre: 1, avoir: 1, ete: 1, comme: 1, tout: 1, tous: 1, toute: 1, toutes: 1,
    aussi: 1, tres: 1, bien: 1, peu: 1, lui: 1, si: 1, car: 1, mais: 1, donc: 1,
    ni: 1, or: 1, lorsque: 1, quand: 1, pendant: 1, avant: 1, apres: 1,
    sous: 1, vers: 1, chez: 1, entre: 1, cela: 1, ceci: 1, afin: 1, ainsi: 1,
    alors: 1, autre: 1, autres: 1, meme: 1, quel: 1, quelle: 1, quels: 1, quelles: 1,
    comment: 1, pourquoi: 1, quoi: 1, estce: 1, peut: 1, font: 1, fait: 1, faire: 1
  };

  function stem(token) {
    let word = String(token || "");
    if (word.length < 4) return word;
    if (/eaux$/.test(word)) word = word.slice(0, -1);
    else if (word.length > 4 && /s$/.test(word) && !/ss$/.test(word)) word = word.slice(0, -1);
    if (word.length > 6 && /ent$/.test(word)) word = word.slice(0, -3);
    else if (word.length > 5 && /er$/.test(word)) word = word.slice(0, -2);
    if (word.length > 4 && /e$/.test(word)) word = word.slice(0, -1);
    return word.length >= 3 ? word : token;
  }

  function tokensOf(query) {
    return text.normalize(query).split(" ").filter(function (token) {
      return token.length >= 3 || /^\d+$/.test(token);
    });
  }

  function contentTokens(query) {
    return tokensOf(query).filter(function (token) { return !STOP[token]; });
  }

  function distance(left, right) {
    if (!left || !right || left[0] !== right[0]) return 9;
    if (Math.abs(left.length - right.length) > 2) return 9;
    const rows = left.length + 1;
    const cols = right.length + 1;
    const grid = [];
    for (let i = 0; i < rows; i += 1) {
      grid[i] = [];
      grid[i][0] = i;
    }
    for (let j = 0; j < cols; j += 1) grid[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
        let best = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && left.charAt(i - 1) === right.charAt(j - 2) && left.charAt(i - 2) === right.charAt(j - 1)) {
          best = Math.min(best, grid[i - 2][j - 2] + 1);
        }
        grid[i][j] = best;
      }
    }
    return grid[left.length][right.length];
  }

  function fuzzyLimit(token) {
    if (/^\d+$/.test(token) || token.length < 5) return 0;
    return token.length >= 8 ? 2 : 1;
  }

  function wordsOf(value) {
    const source = String(value || "");
    const words = [];
    const pattern = /[A-Za-zÀ-ÿ0-9'’-]+/g;
    let found = pattern.exec(source);
    while (found) {
      const norm = text.normalize(found[0]);
      norm.split(" ").forEach(function (piece) {
        if (!piece) return;
        words.push({ norm: piece, stem: stem(piece), index: found.index });
      });
      found = pattern.exec(source);
    }
    return words;
  }

  function meetingYear(record) {
    const date = record && record.meetingDate ? String(record.meetingDate) : "";
    return /^\d{4}/.test(date) ? date.slice(0, 4) : "";
  }

  function inPeriod(record, period) {
    if (!period || (!period.from && !period.to)) return true;
    const year = meetingYear(record);
    if (!year) return false;
    if (period.from && year < period.from) return false;
    if (period.to && year > period.to) return false;
    return true;
  }

  function filterService(records, serviceId) {
    if (!serviceId || serviceId === "all") return records.slice();
    return records.filter(function (record) { return record.serviceId === serviceId; });
  }

  function meetingRank(record) {
    return record.meetingDate || "";
  }

  function compareMeetingDesc(a, b) {
    const left = meetingRank(a);
    const right = meetingRank(b);
    if (left && right && left !== right) return left < right ? 1 : -1;
    if (left && !right) return -1;
    if (!left && right) return 1;
    return 0;
  }

  function compareAddedDesc(a, b) {
    const left = a.addedAt || "";
    const right = b.addedAt || "";
    if (left !== right) return left < right ? 1 : -1;
    return compareMeetingDesc(a, b);
  }

  function compareMeetingAsc(a, b) {
    const left = meetingRank(a);
    const right = meetingRank(b);
    if (left && right && left !== right) return left < right ? -1 : 1;
    if (left && !right) return -1;
    if (!left && right) return 1;
    return 0;
  }

  function asList(records, compare) {
    const listed = records.slice().sort(compare).map(function (record) {
      return { record: record, kind: "liste", score: 0, stems: {}, excerpt: "" };
    });
    listed.tooVague = false;
    return listed;
  }

  function listByMeeting(records, serviceId, period, order) {
    const scoped = filterService(records, serviceId).filter(function (record) {
      return inPeriod(record, period);
    });
    return asList(scoped, order === "asc" ? compareMeetingAsc : compareMeetingDesc);
  }

  function listByAdded(records, serviceId) {
    return asList(filterService(records, serviceId), compareAddedDesc);
  }

  let cachedRecords = null;
  let cachedDocs = null;
  let cachedBuckets = null;

  function asMap(words) {
    const stems = {};
    const norms = {};
    words.forEach(function (word, index) {
      function add(map, key) {
        if (!key) return;
        if (!map[key]) map[key] = [];
        map[key].push(index);
      }
      add(stems, word.stem);
      add(norms, word.norm);
    });
    return { stems: stems, norms: norms };
  }

  function documentsOf(records) {
    if (records === cachedRecords && cachedDocs) return cachedDocs;
    cachedRecords = records;
    cachedBuckets = null;
    cachedDocs = records.map(function (record) {
      const question = asMap(wordsOf(record.question));
      const answer = asMap(wordsOf(record.answer));
      return {
        record: record,
        qStems: question.stems,
        qNorms: question.norms,
        aStems: answer.stems,
        aNorms: answer.norms,
        qNorm: text.normalize(record.question),
        aNorm: text.normalize(record.answer),
        allNorm: text.normalize((record.question || "") + " " + (record.answer || ""))
      };
    });
    return cachedDocs;
  }

  function stemBuckets(docs) {
    if (docs === cachedDocs && cachedBuckets) return cachedBuckets;
    const buckets = {};
    const seen = {};
    docs.forEach(function (doc) {
      Object.keys(doc.qStems).concat(Object.keys(doc.aStems)).forEach(function (candidate) {
        if (!candidate || candidate.length < 4 || seen[candidate]) return;
        seen[candidate] = 1;
        const key = candidate.charAt(0) + candidate.length;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(candidate);
      });
    });
    cachedBuckets = buckets;
    return buckets;
  }

  function nearby(buckets, tokenStem, limit) {
    const found = [];
    const min = Math.max(4, tokenStem.length - limit);
    const max = tokenStem.length + limit;
    for (let len = min; len <= max; len += 1) {
      const list = buckets[tokenStem.charAt(0) + len] || [];
      for (let i = 0; i < list.length; i += 1) {
        const candidate = list[i];
        if (candidate === tokenStem) continue;
        if (distance(tokenStem, candidate) <= limit) found.push(candidate);
      }
    }
    return found;
  }

  function phraseBonus(doc, tokens) {
    if (tokens.length < 2) return 0;
    const phrase = tokens.join(" ");
    if (doc.qNorm.indexOf(phrase) !== -1) return 40;
    if (doc.allNorm.indexOf(phrase) !== -1) return 22;
    return 0;
  }

  function windowAround(source, stemSet) {
    const value = String(source || "");
    if (!value) return "";
    const limit = 180;
    let at = -1;
    const pattern = /[A-Za-zÀ-ÿ0-9'’-]+/g;
    let found = pattern.exec(value);
    while (found) {
      const pieces = text.normalize(found[0]).split(" ");
      if (pieces.some(function (piece) { return stemSet[stem(piece)] || stemSet[piece]; })) {
        at = found.index;
        break;
      }
      found = pattern.exec(value);
    }
    if (at < 0) return value.length > limit ? value.slice(0, limit - 1).trim() + "…" : value;
    const start = Math.max(0, at - 48);
    const end = Math.min(value.length, start + limit);
    let slice = value.slice(start, end).trim();
    if (start > 0) slice = "… " + slice;
    if (end < value.length) slice += "…";
    return slice;
  }

  function positionsOf(doc, token, tokenStem, fuzzyList, field) {
    const norms = field === "q" ? doc.qNorms : doc.aNorms;
    const stems = field === "q" ? doc.qStems : doc.aStems;
    const exact = norms[token] || stems[tokenStem] || [];
    if (exact.length) return exact;
    let found = [];
    fuzzyList.forEach(function (candidate) {
      if (stems[candidate]) found = found.concat(stems[candidate]);
    });
    return found;
  }

  function tokensAreClose(doc, tokens, fuzzyTargets) {
    function fieldOk(field) {
      const lists = tokens.map(function (token) {
        return positionsOf(doc, token, stem(token), fuzzyTargets[token], field);
      });
      if (lists.some(function (list) { return !list.length; })) return false;
      const span = Math.max(6, tokens.length * 3);
      const anchor = lists[0];
      for (let i = 0; i < anchor.length; i += 1) {
        const at = anchor[i];
        const close = lists.every(function (list) {
          return list.some(function (pos) { return Math.abs(pos - at) <= span; });
        });
        if (close) return true;
      }
      return false;
    }
    return fieldOk("q") || fieldOk("a");
  }

  function searchQuestions(records, query, serviceId, period) {
    const scoped = filterService(records, serviceId).filter(function (record) {
      return inPeriod(record, period);
    });
    const typed = text.collapse(query);
    if (!typed) {
      const listed = scoped.slice().sort(compareAddedDesc).map(function (record) {
        return { record: record, kind: "liste", score: 0, stems: {}, excerpt: "" };
      });
      listed.tooVague = false;
      return listed;
    }
    const tokens = contentTokens(typed);
    if (!tokens.length) {
      const empty = [];
      empty.tooVague = true;
      return empty;
    }
    const allowed = new Set(scoped);
    const docs = documentsOf(records).filter(function (doc) {
      return allowed.has(doc.record);
    });
    const documentFrequency = {};
    docs.forEach(function (doc) {
      const seen = {};
      Object.keys(doc.qStems).concat(Object.keys(doc.aStems)).forEach(function (key) {
        if (!key || seen[key]) return;
        seen[key] = 1;
        documentFrequency[key] = (documentFrequency[key] || 0) + 1;
      });
    });
    const total = Math.max(docs.length, 1);
    function weight(token) {
      const key = stem(token);
      const frequency = documentFrequency[key] || 0;
      return Math.log((total + 1) / (frequency + 1)) + 1;
    }
    const buckets = stemBuckets(documentsOf(records));
    const fuzzyTargets = {};
    tokens.forEach(function (token) {
      const limit = fuzzyLimit(token);
      fuzzyTargets[token] = limit ? nearby(buckets, stem(token), limit) : [];
    });
    const ranked = tokens.map(function (token) {
      return { token: token, weight: weight(token) };
    }).sort(function (a, b) { return b.weight - a.weight; });
    const rarest = ranked[0].token;
    const found = [];
    docs.forEach(function (doc) {
      let score = phraseBonus(doc, tokens);
      let matched = 0;
      let fuzzyUsed = false;
      let questionHits = 0;
      const stemSet = {};
      let rareHit = false;
      tokens.forEach(function (token) {
        const tokenStem = stem(token);
        const importance = weight(token);
        let gained = 0;
        let inQuestion = false;
        if (doc.qNorms[token]) {
          gained = 10 * importance;
          inQuestion = true;
        } else if (doc.qStems[tokenStem]) {
          gained = 7 * importance;
          inQuestion = true;
        } else if (fuzzyTargets[token].some(function (candidate) { return doc.qStems[candidate]; })) {
          gained = 4 * importance;
          fuzzyUsed = true;
          inQuestion = true;
        } else if (doc.aNorms[token]) gained = 6 * importance;
        else if (doc.aStems[tokenStem]) gained = 4 * importance;
        else if (fuzzyTargets[token].some(function (candidate) { return doc.aStems[candidate]; })) {
          gained = 2 * importance;
          fuzzyUsed = true;
        }
        if (!gained) return;
        matched += 1;
        score += gained;
        stemSet[tokenStem] = 1;
        stemSet[token] = 1;
        fuzzyTargets[token].forEach(function (candidate) {
          if (doc.qStems[candidate] || doc.aStems[candidate]) stemSet[candidate] = 1;
        });
        if (inQuestion) questionHits += 1;
        if (token === rarest) rareHit = true;
      });
      if (!matched) return;
      if (tokens.length >= 2 && !rareHit) return;
      if (tokens.length >= 2 && matched / tokens.length < 0.6) return;
      if (tokens.length >= 2 && !tokensAreClose(doc, tokens, fuzzyTargets)) return;
      if (questionHits === tokens.length) score += 12;
      const answerText = doc.record.answer || "";
      found.push({
        record: doc.record,
        kind: fuzzyUsed ? "variante" : "mots",
        score: score,
        stems: stemSet,
        excerpt: answerText ? windowAround(answerText, stemSet) : ""
      });
    });
    found.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      return compareMeetingDesc(a.record, b.record);
    });
    found.tooVague = false;
    return found;
  }

  function highlightFragment(value, stemSet) {
    const source = String(value || "");
    const fragment = root.document.createDocumentFragment();
    if (!source) return fragment;
    const pattern = /[A-Za-zÀ-ÿ0-9'’-]+/g;
    let cursor = 0;
    let found = pattern.exec(source);
    while (found) {
      if (found.index > cursor) fragment.appendChild(root.document.createTextNode(source.slice(cursor, found.index)));
      const pieces = text.normalize(found[0]).split(" ");
      const marked = stemSet && pieces.some(function (piece) { return stemSet[stem(piece)] || stemSet[piece]; });
      if (marked) {
        const mark = root.document.createElement("mark");
        mark.textContent = found[0];
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(root.document.createTextNode(found[0]));
      }
      cursor = found.index + found[0].length;
      found = pattern.exec(source);
    }
    if (cursor < source.length) fragment.appendChild(root.document.createTextNode(source.slice(cursor)));
    return fragment;
  }

  function searchStatus(hitCount, phase, vague) {
    if (vague) {
      return {
        pending: false,
        empty: "Aucun résultat : les mots saisis sont trop généraux.",
        hint: "Cette recherche est trop vague pour isoler une question. Ajoutez un mot plus précis.",
        count: "Aucun résultat"
      };
    }
    const waiting = phase === "download" || phase === "loading" || phase === "index" || phase === "pending";
    if (waiting && !hitCount) {
      return {
        pending: true,
        empty: "Recherche par le sens en cours.",
        hint: "Les mots-clés n’ont rien isolé pour le moment. Le résultat par le sens arrive dès que le modèle est prêt.",
        count: "Recherche en cours"
      };
    }
    if (waiting && hitCount) {
      return {
        pending: true,
        hint: "Les résultats par mots-clés sont affichés. La recherche par le sens se poursuit."
      };
    }
    if (phase === "unavailable" && !hitCount) {
      return {
        pending: false,
        empty: "Aucun résultat par mots-clés. La recherche par le sens n’est pas disponible sur cet appareil.",
        hint: "La recherche par le sens n’est pas disponible sur cet appareil. Les mots-clés restent utilisables.",
        count: "Aucun résultat"
      };
    }
    if (!hitCount) {
      return {
        pending: false,
        empty: "Aucun résultat pertinent.",
        hint: "",
        count: "Aucun résultat"
      };
    }
    return { pending: false, hint: "", empty: "", count: "" };
  }

  root.IPSearch = {
    searchQuestions: searchQuestions,
    listByMeeting: listByMeeting,
    listByAdded: listByAdded,
    compareMeetingDesc: compareMeetingDesc,
    compareAddedDesc: compareAddedDesc,
    filterService: filterService,
    stem: stem,
    contentTokens: contentTokens,
    meetingYear: meetingYear,
    highlightFragment: highlightFragment,
    searchStatus: searchStatus,
    pageSize: PAGE_HINT
  };
})(globalThis);
