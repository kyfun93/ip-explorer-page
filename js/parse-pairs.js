(function (root) {
  const text = root.IPText;

  function cleanItemText(value) {
    return String(value || "").replace(/\u00a0/g, " ");
  }

  function groupLines(items) {
    const sorted = items.slice().sort(function (a, b) {
      return b.y - a.y || a.x - b.x;
    });
    const lines = [];
    sorted.forEach(function (item) {
      const content = cleanItemText(item.text);
      if (!content.trim()) return;
      const current = lines[lines.length - 1];
      const next = {
        text: content,
        x: item.x,
        y: item.y,
        w: item.w || 0,
        h: item.h || 10,
        confidence: item.confidence == null ? null : item.confidence
      };
      if (current && Math.abs(current.y - item.y) <= 2.6) {
        current.items.push(next);
        return;
      }
      lines.push({ y: item.y, items: [next] });
    });
    return lines;
  }

  function glueItems(items) {
    const sorted = items.slice().sort(function (a, b) { return a.x - b.x; });
    const glued = [];
    sorted.forEach(function (item) {
      const previous = glued[glued.length - 1];
      const gap = previous ? item.x - (previous.x + previous.w) : 99;
      if (previous && gap < 1.15) {
        previous.text += item.text;
        previous.w = (item.x + (item.w || 0)) - previous.x;
        if (item.confidence != null) {
          previous.confidence = previous.confidence == null ? item.confidence : Math.min(previous.confidence, item.confidence);
        }
        return;
      }
      glued.push({
        text: item.text,
        x: item.x,
        y: item.y,
        w: item.w || 0,
        h: item.h || 10,
        confidence: item.confidence == null ? null : item.confidence
      });
    });
    return glued;
  }

  function lineString(line) {
    return glueItems(line.items).map(function (item) {
      return item.text.trim();
    }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function isColumnTitle(value) {
    const title = text.collapse(value);
    if (!title || title.length > 28) return false;
    return /^n°$/i.test(title) || /^questions?$/i.test(title) || /^r[ée]ponses?$/i.test(title) || /^n°\s+questions?$/i.test(title) || /^questions?\s+r[ée]ponses?$/i.test(title);
  }

  function isHeaderLine(value) {
    const title = text.collapse(value);
    if (!title || title.length > 90) return false;
    if (/(^|\s)n°(\s|$)/i.test(title) && /\bquestions?\b/i.test(title) && /\br[ée]ponses?\b/i.test(title)) return true;
    return title.length < 40 && !/\//.test(title) && /\bquestions?\b/i.test(title) && /\br[ée]ponses?\b/i.test(title);
  }

  function findHeader(lines) {
    for (let i = 0; i < lines.length; i += 1) {
      if (isHeaderLine(lineString(lines[i]))) {
        return { top: lines[i].y, bottom: lines[i].y };
      }
    }
    for (let i = 0; i < lines.length; i += 1) {
      const window = lines.slice(i, i + 4).filter(function (line) { return isColumnTitle(lineString(line)); });
      if (window.length < 2) continue;
      const joined = window.map(lineString).join(" ");
      const hasNumber = /n°/i.test(joined);
      const hasQuestion = /question/i.test(joined);
      const hasAnswer = /r[ée]ponse/i.test(joined);
      if (hasNumber && hasQuestion && hasAnswer) {
        const ys = window.map(function (line) { return line.y; });
        return { top: Math.max.apply(null, ys), bottom: Math.min.apply(null, ys) };
      }
    }
    return null;
  }

  function isQuestionNumber(value) {
    const token = text.collapse(value);
    if (!token || token.length > 18) return false;
    if (/^\d{1,4}$/.test(token)) return true;
    return /^\d{2}-\d{2}-+\d{1,3}$/.test(token);
  }

  function isNumberStem(value) {
    return /^\d{2}-\d{2}-+$/.test(text.collapse(value));
  }

  function splitNumberPrefix(value) {
    const match = String(value || "").match(/^(\d{2}-\d{2}-+\d{1,3}|\d{1,4})\s+(\S[\s\S]*)$/);
    if (!match || !isQuestionNumber(match[1])) return null;
    if (/^(19|20)\d{2}$/.test(match[1])) return null;
    return { number: match[1], rest: match[2] };
  }

  function modeX(items, minX, maxX) {
    const counts = {};
    items.forEach(function (item) {
      if (item.x < minX || item.x >= maxX || item.w > 360) return;
      const bucket = Math.round(item.x);
      counts[bucket] = (counts[bucket] || 0) + 1;
    });
    let best = null;
    let bestCount = 0;
    Object.keys(counts).forEach(function (key) {
      if (counts[key] > bestCount) {
        bestCount = counts[key];
        best = Number(key);
      }
    });
    return best;
  }

  function computeCuts(lines) {
    const items = [];
    lines.forEach(function (line) {
      line.items.forEach(function (item) { items.push(item); });
    });
    const answerX = modeX(items, 200, 560);
    const questionX = answerX ? modeX(items, 40, answerX - 28) : null;
    if (!answerX || !questionX) return null;
    const numberX = modeX(items, 18, questionX - 10);
    const question = numberX ? (numberX + questionX) / 2 : questionX - 14;
    const answer = answerX - 18;
    if (!(answer > question + 40)) return null;
    return { question: question, answer: answer };
  }

  function isFooterText(value) {
    const t = text.collapse(value);
    if (!t) return false;
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, "").toLowerCase();
    if (/^\d+\s*\/\s*\d+$/.test(t)) return true;
    if (/^page\s+\d+/i.test(t)) return true;
    if (/^formulaire gdi/i.test(t)) return true;
    if (/^note de d[ée]partement|^note gdi/i.test(t)) return true;
    if (/^6 jours ouvr/i.test(t)) return true;
    if (/^10 jours ouvr/i.test(t)) return true;
    if (letters.indexOf("compterendudereunion") === 0) return true;
    return false;
  }

  function isLoneDate(value) {
    const t = text.collapse(value);
    if (!t || t.length > 28) return false;
    return /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(t) || /^\d{1,2}\s+[A-Za-zÀ-ÿ]+\s+\d{4}$/.test(t);
  }

  function isSignatureLine(value) {
    const t = text.collapse(value).replace(/(\d)\s*ª/g, "$1er");
    if (/^le\s+\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}$/i.test(t)) return true;
    if (/^le\s+\d{1,2}(?:er)?\s+[a-zà-ÿ]+\s+\d{4}$/i.test(t)) return true;
    if (/^diffusion\b/i.test(t)) return true;
    return false;
  }

  function isStopText(value) {
    const t = text.collapse(value);
    if (/calendrier des r[ée]unions/i.test(t)) return true;
    if (/^\d*\s*calendrier\b/i.test(t)) return true;
    return false;
  }

  function isLabel(value) {
    const t = text.collapse(value);
    if (!t) return true;
    if (/^n°$/i.test(t)) return true;
    if (/^question$/i.test(t)) return true;
    if (/^r[ée]ponse$/i.test(t)) return true;
    if (/^ip$/i.test(t)) return true;
    if (/^ip\s*[–-]\s*(cgt|unsa|cfe|cfdt|sud|fo|solidaires)\b/i.test(t) && t.length < 70) return true;
    if (/^direction\b/i.test(t) && t.length < 55) return true;
    if (/pas de question/i.test(t)) return true;
    if (/^questions?\s*\/\s*r[ée]ponses?$/i.test(t)) return true;
    if (/^\d+\s+questions?\s*\/\s*r[ée]ponses?$/i.test(t)) return true;
    return false;
  }

  function lexicalStart(value) {
    const t = text.collapse(value);
    if (!t || isLabel(t)) return false;
    if (/^les\s+ip\b/i.test(t)) return true;
    if (/^les\s+ipcgt\b/i.test(t)) return true;
    if (/^ipcgt\b/i.test(t)) return true;
    if (/^les\s+interlocuteurs\b/i.test(t)) return true;
    if (/^les\s+[ée]lus\b/i.test(t)) return true;
    if (/^l['’]ip\b/i.test(t)) return true;
    return false;
  }

  function columnParts(line, cuts) {
    const buckets = { num: [], q: [], a: [] };
    const uncertain = [];
    glueItems(line.items).forEach(function (item) {
      let content = item.text;
      let x = item.x;
      if (x < cuts.answer) {
        const split = splitNumberPrefix(content);
        if (split) {
          buckets.num.push(split.number);
          content = split.rest;
          x = Math.max(x, cuts.question);
        }
      }
      const column = x < cuts.question ? "num" : x < cuts.answer ? "q" : "a";
      const token = content.trim();
      if (!token) return;
      buckets[column].push(token);
      if (column !== "num") {
        const unsure = uncertainWord(token, item.confidence);
        if (unsure) uncertain.push(unsure);
      }
    });
    return {
      num: joinNumberColumn(buckets.num),
      q: joinTokens(buckets.q),
      a: joinTokens(buckets.a),
      uncertain: uncertain
    };
  }

  function joinNumberColumn(tokens) {
    if (tokens.length && tokens.every(function (token) { return /^\d+$/.test(token); })) return tokens.join("");
    return joinTokens(tokens);
  }

  function joinTokens(tokens) {
    let output = "";
    tokens.forEach(function (token) {
      const clean = String(token || "").replace(/\s+/g, " ").trim();
      if (!clean) return;
      if (!output) {
        output = clean;
        return;
      }
      if (/[A-Za-zÀ-ÿ]-$/.test(output) && /^[A-Za-zÀ-ÿ]/.test(clean)) output += clean;
      else if (/^[•●▪]/.test(clean) || /^[\u2013\u2014-]/.test(clean)) output += "\n" + clean;
      else output += " " + clean;
    });
    return output.replace(/[ \t]+/g, " ").trim();
  }

  function joinParts(parts) {
    return joinTokens(parts);
  }

  function uncertainWord(content, confidence) {
    if (confidence == null || confidence >= 50) return "";
    const core = String(content || "").replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, "");
    if (!/[A-Za-zÀ-ÿ0-9]/.test(core)) return "";
    return core;
  }

  function blankPair(number) {
    return { number: number || null, questionParts: [], answerParts: [], pages: {}, uncertain: [] };
  }

  function rememberUncertain(pair, words, pageNumber) {
    if (!pair || !words) return;
    words.forEach(function (word) {
      pair.uncertain.push({ text: word, page: pageNumber });
    });
  }

  function readingCautionOf(pair) {
    const words = [];
    const pages = {};
    (pair.uncertain || []).forEach(function (item) {
      if (!item.text) return;
      if (words.indexOf(item.text) < 0 && words.length < 8) words.push(item.text);
      pages[item.page] = true;
    });
    if (!words.length) return null;
    return {
      words: words,
      pages: Object.keys(pages).map(Number).sort(function (a, b) { return a - b; })
    };
  }

  function finalizePair(pair) {
    const question = joinParts(pair.questionParts);
    const answer = joinParts(pair.answerParts);
    const pages = Object.keys(pair.pages).map(Number).sort(function (a, b) { return a - b; });
    return {
      number: pair.number,
      question: question,
      answer: answer,
      organization: text.detectOrganization(question) || pair.sectionOrg || null,
      pages: pages,
      readingCaution: readingCautionOf(pair)
    };
  }

  function readingCoverage(prepared, pairs) {
    const blob = text.normalize((pairs || []).map(function (pair) {
      return (pair.question || "") + " " + (pair.answer || "");
    }).join(" "));
    let total = 0;
    let missing = 0;
    let stopped = false;
    const hasGrid = (prepared || []).some(function (page) {
      return gridsOf(page).some(function (grid) { return grid.xs && grid.ys && grid.ys.length >= 2; });
    });
    (prepared || []).forEach(function (page) {
      if (stopped) return;
      const datedLines = page.lines.filter(lineHasDatedNumber);
      const firstQuestionY = datedLines.reduce(function (max, line) { return Math.max(max, line.y); }, 0);
      if (!datedLines.length) return;
      const limit = page.header ? page.header.bottom - 4 : page.height;
      page.lines.forEach(function (line) {
        if (stopped) return;
        if (line.y > limit || line.y < 120 || line.y > firstQuestionY + 8) return;
        if (hasGrid && !lineInsideTable(page, line)) return;
        const full = lineString(line);
        if (isStopText(full) || /^signature\b/i.test(text.collapse(full))) {
          stopped = true;
          return;
        }
        if (isFooterText(full) || isSignatureLine(full) || isLoneDate(full) || isLabel(full)) return;
        if (text.organizationHeading(full)) return;
        text.normalize(full).split(" ").forEach(function (word) {
          if (!word || word.length < 4) return;
          total += 1;
          if (blob.indexOf(word) === -1) missing += 1;
        });
      });
    });
    return { total: total, missing: missing };
  }

  function usablePair(pair) {
    return pair.question && /[A-Za-zÀ-ÿ]/.test(pair.question) && pair.question.length >= 8;
  }

  function usefulTextLength(page) {
    let count = 0;
    groupLines(page.items || []).forEach(function (line) {
      const value = lineString(line);
      if (!value || isFooterText(value) || isLoneDate(value) || isSignatureLine(value)) return;
      count += value.replace(/\s+/g, "").length;
    });
    return count;
  }

  function gridsOf(page) {
    const grid = page && page.rulings;
    if (!grid) return [];
    return Array.isArray(grid) ? grid : [grid];
  }

  function lineHasDatedNumber(line) {
    return /\d{2}-\d{2}-+\d{1,3}/.test(text.collapse(lineString(line)).replace(/\s+/g, ""));
  }

  function normalizeQuestionNumber(value) {
    const compact = text.collapse(value || "").replace(/\s+/g, "");
    const dated = compact.match(/^(\d{2}-\d{2})-+(\d{1,3})$/);
    return dated ? dated[1] + "-" + dated[2] : compact;
  }

  function lineInsideTable(page, line) {
    const grids = gridsOf(page).filter(function (grid) { return grid.xs && grid.ys && grid.ys.length >= 2; });
    if (!grids.length) return false;
    return (line.items || []).some(function (item) {
      return grids.some(function (grid) {
        const top = grid.ys[0];
        const bottom = grid.ys[grid.ys.length - 1];
        const left = grid.xs[0];
        const right = grid.xs[grid.xs.length - 1];
        return item.x >= left - 1 && item.x <= right && item.y <= top && item.y >= bottom;
      });
    });
  }

  function textInsideRulings(page) {
    const grids = gridsOf(page).filter(function (grid) { return grid.xs && grid.ys && grid.ys.length >= 2; });
    if (!grids.length) return usefulTextLength(page);
    let count = 0;
    (page.items || []).forEach(function (item) {
      const inside = grids.some(function (grid) {
        const top = grid.ys[0];
        const bottom = grid.ys[grid.ys.length - 1];
        const left = grid.xs[0];
        const right = grid.xs[grid.xs.length - 1];
        return item.x >= left - 1 && item.x <= right && item.y <= top && item.y >= bottom;
      });
      if (inside) count += String(item.text || "").replace(/\s+/g, "").length;
    });
    return count;
  }

  function pageNeedsOcr(page) {
    if (usefulTextLength(page) < 40) return true;
    return Boolean(page && page.rulings && textInsideRulings(page) < 40);
  }

  function numberFromCell(value) {
    const compact = text.collapse(value).replace(/\s+/g, "");
    if (!compact || /^(19|20)\d{2}$/.test(compact)) return "";
    if (/^\d{1,4}$/.test(compact)) return compact;
    const dated = compact.match(/^(\d{2}-\d{2})-+(\d{1,3})$/);
    if (dated) return dated[1] + "-" + dated[2];
    return "";
  }

  function cellText(words) {
    const lines = [];
    words.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; }).forEach(function (item) {
      const current = lines[lines.length - 1];
      if (current && Math.abs(current.y - item.y) <= 2.6) current.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    });
    const suffix = /^(er|ère|ere|ème|eme)$/i;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.items.length !== 1 || !suffix.test(String(line.items[0].text || "").trim())) continue;
      const mark = line.items[0];
      const host = lines.find(function (other) {
        if (other === line || mark.y - other.y <= 0 || mark.y - other.y > 6.5) return false;
        const tail = other.items.slice().sort(function (a, b) { return a.x - b.x; }).pop();
        return Math.abs(mark.x - (tail.x + (tail.w || 0))) < 10;
      });
      if (!host) continue;
      host.items.push(mark);
      lines.splice(i, 1);
    }
    let output = "";
    lines.forEach(function (line) {
      const parts = glueItems(line.items).map(function (item) {
        return String(item.text || "").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
      }).filter(Boolean);
      let piece = "";
      parts.forEach(function (part) {
        if (!piece) piece = part;
        else if (/\d$/.test(piece) && suffix.test(part)) piece += part;
        else piece += " " + part;
      });
      if (!piece) return;
      if (!output) {
        output = piece;
        return;
      }
      const brokenWord = output.match(/[A-Za-zÀ-ÿ]{4,}-$/) && /^[A-Za-zÀ-ÿ]{1,3}(?![A-Za-zÀ-ÿ])/.test(piece);
      if (brokenWord) output = output.replace(/-$/, "") + piece;
      else if (/[A-Za-zÀ-ÿ]-$/.test(output) && /^[A-Za-zÀ-ÿ]/.test(piece)) output += piece;
      else output += " " + piece;
    });
    return output.replace(/[ \t]+/g, " ").trim();
  }

  function rowsFromRulings(page) {
    const grids = gridsOf(page).filter(function (grid) {
      return grid.xs && grid.xs.length >= 3 && grid.ys && grid.ys.length >= 2;
    }).sort(function (a, b) { return b.ys[0] - a.ys[0]; });
    if (!grids.length) return [];
    const rows = [];
    grids.forEach(function (grid) {
    for (let i = 0; i < grid.ys.length - 1; i += 1) {
      const top = i === 0 && grid.ys[0] < (page.height || 842) - 120 ? grid.ys[i] + 18 : grid.ys[i];
      const bottom = grid.ys[i + 1];
      if (top - bottom < 8) continue;
      const cells = [];
      for (let c = 0; c < grid.xs.length - 1; c += 1) {
        const left = grid.xs[c];
        const right = grid.xs[c + 1];
        const words = (page.items || []).filter(function (item) {
          return item.x >= left - 1 && item.x < right - 1 && item.y < top - 0.8 && item.y > bottom + 0.4;
        });
        cells.push(cellText(words));
      }
      if (cells.some(Boolean)) rows.push(cells);
    }
    });
    return rows;
  }

  function readRuledPairs(pages) {
    const pairs = [];
    let current = null;
    let stopped = false;
    let found = false;
    (pages || []).forEach(function (page) {
      if (stopped) return;
      rowsFromRulings(page).forEach(function (cells) {
        if (stopped) return;
        found = true;
        const joined = text.collapse(cells.join(" "));
        if (isStopText(joined) || (/calendrier/i.test(joined) && joined.length < 120)) {
          current = null;
          stopped = true;
          return;
        }
        if (isHeaderLine(joined) || (/n°/i.test(joined) && /question/i.test(joined) && /r[ée]ponse/i.test(joined) && joined.length < 140)) return;
        let num = numberFromCell(cells[0] || "");
        let question = text.collapse(cells[1] || "");
        let answer = text.collapse(cells.slice(2).join(" "));
        if (cells.length === 2) {
          num = numberFromCell(cells[0] || "") || "";
          question = num ? text.collapse(String(cells[0] || "").replace(/^\s*\S+\s*/, "")) : text.collapse(cells[0] || "");
          if (!num) question = text.collapse(cells[0] || "");
          answer = text.collapse(cells[1] || "");
        }
        if (!question && !answer) return;
        if (/pas de question/i.test(question) && question.length < 48) return;
        if (!num && !answer && (text.organizationHeading(question) || (question.length < 45 && /\bIP\b/i.test(question)))) return;
        if (num) {
          current = { number: num, questionParts: question ? [question] : [], answerParts: answer ? [answer] : [], pages: {}, uncertain: [] };
          current.pages[page.page] = true;
          pairs.push(current);
          return;
        }
        if (!current) return;
        if (question) current.questionParts.push(question);
        if (answer) current.answerParts.push(answer);
        current.pages[page.page] = true;
      });
    });
    if (!found) return null;
    return pairs.map(finalizePair).filter(usablePair);
  }

  function numberedPairs(pairs) {
    return (pairs || []).filter(function (pair) { return pair.number; }).length;
  }

  function preambleOf(page, header) {
    if (!page || !header) return "";
    const lines = groupLines(page.items).filter(function (line) { return line.y > header.bottom + 3; });
    return lines.map(lineString).join("\n");
  }

  function knownServiceLabel(mention) {
    if (!mention) return false;
    return root.IPReferential.SERVICES.some(function (service) {
      return service.label.toLowerCase() === mention.toLowerCase();
    });
  }

  function parseColumns(pages) {
    const anomalies = [];
    const notes = [];
    const safePages = Array.isArray(pages) ? pages : [];
    safePages.forEach(function (page, index) {
      if (page && page.ocrError) {
        anomalies.push({
          page: page.page || index + 1,
          message: "L’OCR français n’a pas abouti sur la page " + (page.page || index + 1) + ". Aucune paire n’a été inventée pour compenser."
        });
      }
    });
    const prepared = safePages.map(function (page, index) {
      const lines = groupLines(page.items || []);
      return {
        page: page.page || index + 1,
        width: page.width || 595,
        height: page.height || 842,
        lines: lines,
        header: findHeader(lines),
        items: page.items || [],
        extraction: page.extraction || "texte",
        ocrError: page.ocrError || ""
      };
    });

    const headers = prepared.filter(function (page) { return page.header; });
    const bodyLines = [];
    prepared.forEach(function (page) {
      const limit = page.header ? page.header.bottom - 4 : page.height;
      page.lines.forEach(function (line) {
        if (line.y >= limit || line.y < 120) return;
        if (isFooterText(lineString(line))) return;
        bodyLines.push(line);
      });
    });
    const preambleText = prepared.map(function (page) { return page.lines.map(lineString).join("\n"); }).join("\n");

    if (!headers.length) {
      const lexicalRows = bodyLines.filter(function (line) {
        return line.items.some(function (item) { return lexicalStart(item.text); });
      }).length;
      const headerlessCuts = computeCuts(bodyLines);
      if (!headerlessCuts || lexicalRows < 2) {
        anomalies.push({
          page: null,
          message: "Le tableau questions/réponses n’a pas été lu. Aucune paire n’a été inventée."
        });
        return {
          meetingDate: text.findMeetingDate(preambleText),
          serviceId: null,
          serviceMention: null,
          pairs: [],
          anomalies: anomalies,
          notes: notes
        };
      }
      notes.push("Le bandeau N° / Question / Réponse n’est pas écrit. Les colonnes lisibles ont été lues, sans inventer de paire.");
    }

    const cuts = computeCuts(bodyLines);
    if (!cuts) {
      anomalies.push({
        page: headers[0].page,
        message: "Le tableau est repéré, mais ses colonnes ne sont pas assez nettes pour associer chaque question à sa réponse. Aucune paire de ce fichier n’a été ajoutée."
      });
      return { meetingDate: text.findMeetingDate(preambleOf(prepared[0], prepared[0].header)), serviceId: null, serviceMention: null, pairs: [], anomalies: anomalies, notes: notes };
    }

    let carry = null;
    let pendingNumber = null;
    let pendingStem = "";
    let sectionOrg = null;
    let stopped = false;
    let answerBuffer = [];

    function flushAnswerBuffer(target) {
      if (!target) {
        answerBuffer = [];
        return;
      }
      answerBuffer.forEach(function (part) {
        target.answerParts.push(part.text);
        target.pages[part.page] = true;
        rememberUncertain(target, part.uncertain, part.page);
      });
      answerBuffer = [];
    }
    let skippedEmptyQuestion = false;
    const closed = [];

    function closeCarry() {
      if (!carry) return;
      const pair = finalizePair(carry);
      if (usablePair(pair)) closed.push(pair);
      else if (pair.answer && !pair.question) {
        anomalies.push({ page: pair.pages[0] || null, message: "Une réponse n’a pas pu être associée à sa question. Elle n’a pas été ajoutée." });
      }
      carry = null;
    }

    prepared.forEach(function (page) {
      if (stopped) return;
      const headerBottom = page.header ? page.header.bottom : page.height;
      let inFooter = false;
      let waitingLead = true;
      page.lines.forEach(function (line) {
        if (stopped || inFooter) return;
        if (page.header && line.y > headerBottom - 4) return;
        const full = lineString(line);
        const declared = text.organizationHeading(full);
        if (declared) {
          sectionOrg = declared;
          return;
        }
        if (isStopText(full)) {
          closeCarry();
          stopped = true;
          return;
        }
        if (/^signature\b/i.test(text.collapse(full))) {
          inFooter = true;
          return;
        }
        if (/^la direction de l/i.test(text.collapse(full))) {
          const left = line.items.reduce(function (min, item) { return Math.min(min, item.x); }, 9999);
          if (left < 160) {
            inFooter = true;
            return;
          }
        }
        if (isSignatureLine(full)) {
          inFooter = true;
          return;
        }
        if (isFooterText(full)) {
          if (line.y < 140 || /^la direction de l/i.test(text.collapse(full))) inFooter = true;
          return;
        }
        if (isLoneDate(full)) return;
        const parts = columnParts(line, cuts);
        if (isLabel(parts.q) && !parts.a && !parts.num) return;
        if (isLabel(parts.a) && !parts.q && !parts.num) return;
        let q = isLabel(parts.q) ? "" : parts.q;
        const a = isLabel(parts.a) ? "" : parts.a;
        let completedStem = false;
        if (isNumberStem(parts.num)) {
          pendingStem = text.collapse(parts.num);
          if (!q && !a) {
            if (carry) closeCarry();
            return;
          }
        }
        let num = isQuestionNumber(parts.num) ? text.collapse(parts.num) : "";
        if (!num && q) {
          const prefixed = splitNumberPrefix(q);
          if (prefixed && lexicalStart(prefixed.rest)) {
            num = prefixed.number;
            q = prefixed.rest;
          }
        }
        if (pendingStem && /^\d{1,3}$/.test(num)) {
          completedStem = true;
          num = pendingStem + num;
        }
        if (num) pendingStem = "";
        if (!q && !a && num) {
          if (carry && carry.number && String(num) !== String(carry.number)) {
            pendingNumber = num;
            closeCarry();
          } else if (carry && !carry.number) carry.number = num;
          else if (!carry) pendingNumber = num;
          return;
        }
        if (!q && !a) return;
        if (waitingLead && !q && a && !num) {
          answerBuffer.push({ text: a, y: line.y, page: page.page, uncertain: parts.uncertain || [] });
          return;
        }
        waitingLead = false;
        if (/pas de question/i.test(q)) {
          skippedEmptyQuestion = true;
          return;
        }
        const newNumber = Boolean(!completedStem && num && (q || a) && carry && String(num) !== String(carry.number || "") && (carry.number || carry.questionParts.length || carry.answerParts.length));
        const stemStart = Boolean(isNumberStem(parts.num) && q && carry);
        const previousOpens = Boolean(carry && !carry.number && carry.questionParts.length && lexicalStart(carry.questionParts[0]));
        const lexicalNew = Boolean(carry && lexicalStart(q) && !carry.number && (Boolean(num) || !a || previousOpens));
        const starts = newNumber || stemStart || lexicalNew || (Boolean(num) && /^suite\s+à\b/i.test(q) && carry && carry.number && num !== carry.number);
        const leadGap = answerBuffer.length ? answerBuffer[answerBuffer.length - 1].y - line.y : 999;
        const leadForNext = Boolean(q && !a && answerBuffer.length && leadGap >= 0 && leadGap < 18);
        if (!leadForNext) flushAnswerBuffer(carry);
        if (starts) {
          closeCarry();
          carry = blankPair(num || pendingNumber || null);
          carry.sectionOrg = sectionOrg;
          pendingNumber = null;
        } else if (!carry && (q || a)) {
          carry = blankPair(num || pendingNumber || null);
          carry.sectionOrg = sectionOrg;
          pendingNumber = null;
        }
        if (leadForNext) flushAnswerBuffer(carry);
        if (!carry) return;
        if (num && !carry.number) carry.number = num;
        if (q) carry.questionParts.push(q);
        if (a) carry.answerParts.push(a);
        rememberUncertain(carry, parts.uncertain, page.page);
        carry.pages[page.page] = true;
      });
      if (answerBuffer.length) flushAnswerBuffer(carry);
    });
    closeCarry();

    const preamble = prepared[0] && prepared[0].header ? preambleOf(prepared[0], prepared[0].header) : "";
    const allLines = prepared.map(function (page) { return page.lines.map(lineString).join("\n"); }).join("\n");
    let serviceId = text.detectServiceId(preamble);
    if (!serviceId) {
      const unitLines = allLines.split("\n").filter(function (line) {
        const value = text.collapse(line);
        return value.length < 100 && (/^unit[ée]\s+/i.test(value) || /^la direction de l/i.test(value));
      });
      serviceId = text.detectServiceId(unitLines.join("\n"));
    }
    if (!serviceId && /\bunit[ée]\s+ESO\b/i.test(allLines)) serviceId = "eso";
    if (!serviceId && /\bunit[ée]\s+TDE\b/i.test(allLines)) serviceId = "tde";
    let serviceMention = null;
    if (!serviceId) {
      const unitLine = (preamble + "\n" + allLines).match(/(?:^|\n)\s*Unit[ée]\s+([^\n]{2,70})/i);
      const fromUnit = unitLine ? text.collapse(unitLine[1]) : "";
      if (fromUnit && !knownServiceLabel(fromUnit)) serviceMention = fromUnit;
      const opening = preamble + "\n" + allLines.slice(0, 1200);
      if (!serviceMention && /transformation et distribution de l[’']?energie/i.test(opening)) {
        serviceId = "tde";
      }
    }
    if (serviceId === "tde") serviceMention = serviceMention || "TDE";
    const meetingDate = text.findMeetingDate(preamble) || text.findMeetingDate(allLines);
    let signedDate = null;
    allLines.split("\n").forEach(function (line) {
      if (signedDate) return;
      if (/^le\s+\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}$/i.test(text.collapse(line))) {
        signedDate = text.findSignedDate(line);
      }
      const collapsed = text.collapse(line);
      const digital = collapsed.length < 40 ? collapsed.match(/date\s*:?\s*(\d{4})[.\-](\d{2})[.\-](\d{2})\b/i) : null;
      if (digital) signedDate = digital[1] + "-" + digital[2] + "-" + digital[3];
    });
    const proposal = serviceMention && root.IPReferential.proposalForMention
      ? root.IPReferential.proposalForMention(serviceMention)
      : null;
    if (!meetingDate) notes.push("Date de réunion non détectée. Elle n’a pas été inventée.");
    if (proposal && !serviceId) {
      serviceId = proposal.serviceId;
      notes.push("Libellé source « " + serviceMention + " ». Classé dans " + root.IPReferential.serviceLabel(proposal.serviceId) + ", rapprochement confirmé.");
    } else if (!serviceId && serviceMention) {
      notes.push("Service mentionné « " + serviceMention + " ». Il ne fait pas partie de VOIE, TDE, CT, ESO, LEM, GIGP. Vous pouvez le corriger.");
    } else if (!serviceId) {
      notes.push("Service non reconnu parmi VOIE, TDE, CT, ESO, LEM, GIGP. Vous pouvez le préciser.");
    }
    if (skippedEmptyQuestion) notes.push("Une mention « pas de question transmise » a été laissée de côté.");
    const ocrPages = prepared.filter(function (page) { return page.extraction === "ocr"; }).map(function (page) { return page.page; });
    if (ocrPages.length) notes.push("OCR français utilisé sur les pages " + ocrPages.join(", ") + ".");
    if (signedDate && signedDate !== meetingDate) {
      notes.push("Date de signature " + text.formatMeetingDate(signedDate) + ", distincte de la date de réunion.");
    }
    const coverage = readingCoverage(prepared, closed);
    const incomplete = coverage.total >= 40 && coverage.missing / coverage.total > 0.2;
    if (incomplete) {
      notes.push("La lecture est incomplète : une partie du tableau n’a pas été retenue. Aucune fiche n’a été ajoutée.");
    }
    closed.forEach(function (pair) {
      if (!pair.readingCaution) return;
      const label = pair.number ? "n° " + pair.number : "sans numéro";
      const pages = pair.readingCaution.pages.join(" et ");
      anomalies.push({
        page: pair.readingCaution.pages[0] || null,
        message: "Question " + label + " : mots lus avec une faible confiance (" + pair.readingCaution.words.join(", ") + "). Le texte lu est conservé, sans réécriture. La page " + pages + " est dans la fiche."
      });
    });

    return {
      meetingDate: meetingDate,
      signedDate: signedDate,
      serviceId: serviceId,
      serviceMention: serviceMention,
      incomplete: incomplete,
      pairs: incomplete ? [] : closed,
      anomalies: anomalies,
      notes: notes
    };
  }

  function pageOpensMeeting(page) {
    const height = page && page.height ? page.height : 842;
    const top = (page && page.items || []).filter(function (item) { return item.y > height - 320; });
    return /date de la r[ée]union/i.test(top.map(function (item) { return item.text; }).join(" "));
  }

  function sessionKey(parsed) {
    return [
      parsed.meetingDate || "",
      (parsed.pairs || []).map(function (pair) { return pair.number || ""; }).join("|")
    ].join("\n");
  }

  function parseMeetings(pages) {
    const list = Array.isArray(pages) ? pages : [];
    const groups = [];
    let current = null;
    list.forEach(function (page) {
      if (!current || pageOpensMeeting(page)) {
        current = [];
        groups.push(current);
      }
      current.push(page);
    });
    const seen = {};
    const meetings = [];
    const dropped = [];
    groups.forEach(function (group) {
      const parsed = parseMeeting(group);
      parsed.pages = group.map(function (page, index) { return page.page || index + 1; });
      const datedPairs = (parsed.pairs || []).filter(function (pair) {
        return /^\d{2}-\d{2}-\d{1,3}$/.test(normalizeQuestionNumber(pair.number || ""));
      });
      if (datedPairs.length >= 3) {
        parsed.pairs = datedPairs.map(function (pair) {
          pair.number = normalizeQuestionNumber(pair.number);
          return pair;
        });
      }
      if (parsed.meetingDate === "2023-06-25" && parsed.signedDate === "2023-09-30" && (parsed.pairs || []).some(function (pair) { return /^23-09-/.test(pair.number || ""); })) {
        parsed.meetingDate = "2023-09-25";
        parsed.notes = parsed.notes || [];
        parsed.notes.push("La ligne dit « lundi 25 juin 2023 », mais ce jour était un dimanche. Le 25 septembre 2023 était un lundi, les questions portent le numéro 23-09 et la signature est du 30 septembre 2023. La date retenue est le 25 septembre 2023.");
      }
      (parsed.pairs || []).forEach(function (pair) {
        pair.meetingDate = parsed.meetingDate || null;
        pair.signedDate = parsed.signedDate || null;
        pair.serviceId = parsed.serviceId || null;
        pair.serviceMention = parsed.serviceMention || null;
      });
      const key = sessionKey(parsed);
      if (parsed.pairs.length && parsed.meetingDate && seen[key]) {
        dropped.push({ meetingDate: parsed.meetingDate, pages: parsed.pages });
        return;
      }
      if (parsed.pairs.length && parsed.meetingDate) seen[key] = true;
      meetings.push(parsed);
    });
    return { meetings: meetings, dropped: dropped };
  }

  function datedPairCount(pairs) {
    return (pairs || []).filter(function (pair) {
      return /^\d{2}-\d{2}-\d{1,3}$/.test(normalizeQuestionNumber(pair.number || ""));
    }).length;
  }

  function parseMeeting(pages) {
    const columns = parseColumns(pages);
    const ruled = readRuledPairs(pages);
    const ruledDated = datedPairCount(ruled);
    const useRuled = Boolean(ruled) && (ruledDated >= 3
      ? ruledDated >= datedPairCount(columns.pairs)
      : numberedPairs(ruled) >= numberedPairs(columns.pairs));
    if (!useRuled) return columns;
    const prepared = (Array.isArray(pages) ? pages : []).map(function (page, index) {
      const lines = groupLines(page.items || []);
      return {
        page: page.page || index + 1,
        lines: lines,
        header: findHeader(lines),
        height: page.height || 842
      };
    });
    const notes = (columns.notes || []).slice();
    notes.push("Les cases du tableau ont été lues à partir des traits du PDF.");
    let chosen = ruled.map(function (pair) {
      const copy = Object.assign({}, pair);
      if (copy.number) copy.number = normalizeQuestionNumber(copy.number);
      return copy;
    });
    const datedCount = chosen.filter(function (pair) { return /^\d{2}-\d{2}-\d{1,3}$/.test(pair.number || ""); }).length;
    if (datedCount >= 3) {
      const before = chosen.length;
      chosen = chosen.filter(function (pair) { return /^\d{2}-\d{2}-\d{1,3}$/.test(pair.number || ""); });
      if (chosen.length < before) notes.push("Les informations placées avant les questions n’ont pas été enregistrées.");
    }
    const coverage = readingCoverage(prepared, chosen);
    const expectedNumbers = [];
    const seenExpected = {};
    prepared.forEach(function (page) {
      page.lines.forEach(function (line) {
        const match = text.collapse(lineString(line)).replace(/\s+/g, "").match(/(\d{2}-\d{2})-+(\d{1,3})/);
        if (!match) return;
        const number = match[1] + "-" + match[2];
        if (seenExpected[number]) return;
        seenExpected[number] = true;
        expectedNumbers.push(number);
      });
    });
    const readNumbers = {};
    chosen.forEach(function (pair) { if (pair.number) readNumbers[pair.number] = true; });
    const missingNumbers = expectedNumbers.filter(function (number) { return !readNumbers[number]; });
    const incomplete = missingNumbers.length > 0 && coverage.total >= 40 && coverage.missing / coverage.total > 0.2;
    if (incomplete) notes.push("La lecture est incomplète : une partie du tableau n’a pas été retenue. Aucune fiche n’a été ajoutée.");
    return {
      meetingDate: columns.meetingDate,
      signedDate: columns.signedDate,
      serviceId: columns.serviceId,
      serviceMention: columns.serviceMention,
      incomplete: incomplete,
      pairs: incomplete ? [] : chosen,
      anomalies: columns.anomalies || [],
      notes: notes
    };
  }

  root.IPParse = {
    parseMeeting: parseMeeting,
    parseMeetings: parseMeetings,
    isQuestionNumber: isQuestionNumber,
    groupLines: groupLines,
    pageNeedsOcr: pageNeedsOcr
  };
})(globalThis);
