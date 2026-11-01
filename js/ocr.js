(function (root) {
  const SCALE = 3;
  const FILE_DEADLINE_MS = 240000;
  let workerPromise = null;
  let activeEngine = null;

  function asset(fileName) {
    return new URL("vendor/tesseract/" + fileName, root.location.href).href;
  }

  function worker() {
    if (!root.Tesseract) {
      return Promise.reject(new Error("Le fichier d’OCR français est absent de la page."));
    }
    if (!workerPromise) {
      const langPath = new URL("vendor/tesseract/", root.location.href).href.replace(/\/$/, "");
      workerPromise = root.Tesseract.createWorker("fra", 1, {
        workerPath: asset("worker.min.js"),
        corePath: asset("tesseract-core-simd-lstm.wasm.js"),
        langPath: langPath,
        workerBlobURL: false,
        gzip: true
      }).then(async function (engine) {
        activeEngine = engine;
        await engine.setParameters({
          tessedit_pageseg_mode: "6",
          user_defined_dpi: String(72 * SCALE)
        });
        return engine;
      });
    }
    return workerPromise;
  }

  async function abandonWorker() {
    const engine = activeEngine;
    const pending = workerPromise;
    activeEngine = null;
    workerPromise = null;
    try {
      if (engine && engine.terminate) await engine.terminate();
      else if (pending) {
        const created = await pending;
        if (created && created.terminate) await created.terminate();
      }
    } catch (error) {
      return;
    }
  }

  function withDeadline(work, deadline) {
    if (!deadline) return work;
    let timer;
    const timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        abandonWorker().then(function () {
          reject(new Error("Délai dépassé pour ce fichier."));
        });
      }, Math.max(0, deadline - Date.now()));
    });
    return Promise.race([work, timeout]).finally(function () { clearTimeout(timer); });
  }

  function readPixels(canvas) {
    const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: image.data };
  }

  function isDark(pixels, x, y) {
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return false;
    const index = (y * pixels.width + x) * 4;
    return pixels.data[index] < 145 && pixels.data[index + 1] < 145 && pixels.data[index + 2] < 145;
  }

  function clusterPositions(values, gap) {
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const groups = [];
    sorted.forEach(function (value) {
      const last = groups[groups.length - 1];
      if (!last || value - last[last.length - 1] > gap) groups.push([value]);
      else last.push(value);
    });
    return groups.map(function (group) {
      return Math.round(group.reduce(function (sum, value) { return sum + value; }, 0) / group.length);
    });
  }

  function longestRun(pixels, fixed, vertical) {
    const limit = vertical ? pixels.height : pixels.width;
    let run = 0;
    let best = 0;
    let start = 0;
    let bestStart = 0;
    for (let cursor = 0; cursor <= limit; cursor += 1) {
      const hit = cursor < limit && (vertical ? isDark(pixels, fixed, cursor) : isDark(pixels, cursor, fixed));
      if (hit) {
        if (!run) start = cursor;
        run += 1;
      } else if (run) {
        if (run > best) {
          best = run;
          bestStart = start;
        }
        run = 0;
      }
    }
    return { length: best, start: bestStart, end: bestStart + best };
  }

  function clusterVerticals(verticals) {
    const sorted = verticals.slice().sort(function (a, b) { return a.x - b.x; });
    const groups = [];
    sorted.forEach(function (line) {
      const last = groups[groups.length - 1];
      if (!last || line.x - last.x > 6) {
        groups.push({ x: line.x, y0: line.y0, y1: line.y1, count: 1 });
        return;
      }
      last.x = Math.round(((last.x * last.count) + line.x) / (last.count + 1));
      last.y0 = Math.min(last.y0, line.y0);
      last.y1 = Math.max(last.y1, line.y1);
      last.count += 1;
    });
    return groups;
  }

  function detectGrid(pixels) {
    const verticals = [];
    for (let x = 0; x < pixels.width; x += 1) {
      const run = longestRun(pixels, x, true);
      if (run.length > pixels.height * 0.16) verticals.push({ x: x, y0: run.start, y1: run.end });
    }
    const columns = clusterVerticals(verticals);
    if (columns.length < 3 || columns.length > 8) return null;
    const horizontals = [];
    for (let y = 0; y < pixels.height; y += 1) {
      if (longestRun(pixels, y, false).length > pixels.width * 0.35) horizontals.push(y);
    }
    const ys = clusterPositions(horizontals, 4).filter(function (y) {
      const hits = columns.filter(function (column) { return column.y0 - 3 <= y && y <= column.y1 + 3; });
      return hits.length >= Math.min(3, columns.length);
    });
    if (ys.length < 3 || (ys.length - 1) * (columns.length - 1) > 80) return null;
    return { xs: columns.map(function (column) { return column.x; }), ys: ys };
  }

  function inkCount(pixels, left, top, width, height) {
    let count = 0;
    const right = Math.min(pixels.width, left + width);
    const bottom = Math.min(pixels.height, top + height);
    for (let y = top; y < bottom; y += 3) {
      for (let x = left; x < right; x += 3) {
        if (isDark(pixels, x, y)) count += 1;
      }
    }
    return count;
  }

  function cropCanvas(source, left, top, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, left, top, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function wordsToItems(words, left, top, width, baseHeight) {
    const kept = [];
    words.forEach(function (word) {
      const value = String(word.text || "").trim();
      const box = word.bbox;
      if (!value || !box || !/[A-Za-zÀ-ÿ0-9]/.test(value)) return;
      const confidence = word.confidence == null ? null : Number(word.confidence);
      const core = value.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, "");
      if (confidence != null && confidence < 30 && core.length < 3) return;
      kept.push({
        text: value,
        y: box.y0,
        bottom: box.y1,
        x0: box.x0,
        x1: box.x1,
        confidence: confidence
      });
    });
    const lines = [];
    kept.forEach(function (word) {
      const last = lines[lines.length - 1];
      if (!last || Math.abs(last.y - word.y) > 10) lines.push({ y: word.y, bottom: word.bottom, words: [word] });
      else {
        last.words.push(word);
        last.bottom = Math.max(last.bottom, word.bottom);
      }
    });
    const items = [];
      lines.forEach(function (line) {
        const lineY = baseHeight - ((top + line.bottom) / SCALE);
        line.words.forEach(function (word) {
          const wordX = word.x0 == null ? (left + 6) / SCALE : (left + word.x0) / SCALE;
          const wordW = word.x1 == null ? 4 : Math.max(0.4, (word.x1 - word.x0) / SCALE);
          items.push({
            text: word.text,
            x: wordX,
            y: lineY,
            w: wordW,
            h: 8,
            confidence: word.confidence
          });
        });
      });
    return items;
  }

  async function recognizeRegion(engine, source, left, top, width, height, baseHeight, deadline) {
    if (deadline && Date.now() > deadline) throw new Error("Délai dépassé pour ce fichier.");
    if (width < 12 || height < 12) return [];
    const canvas = cropCanvas(source, left, top, width, height);
    const result = await withDeadline(engine.recognize(canvas), deadline);
    const words = (result && result.data && result.data.words) || [];
    return wordsToItems(words, left, top, width, baseHeight);
  }

  function clearRulings(canvas) {
    const context = canvas.getContext("2d");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    const width = canvas.width;
    const height = canvas.height;
    const kill = new Uint8Array(width * height);
    function dark(x, y) {
      const index = (y * width + x) * 4;
      return data[index] < 90 && data[index + 1] < 90 && data[index + 2] < 90;
    }
    for (let y = 0; y < height; y += 1) {
      let run = 0;
      let start = 0;
      for (let x = 0; x <= width; x += 1) {
        if (x < width && dark(x, y)) {
          if (!run) start = x;
          run += 1;
        } else if (run >= 28) {
          for (let cursor = start; cursor < start + run; cursor += 1) kill[y * width + cursor] = 1;
          run = 0;
        } else run = 0;
      }
    }
    for (let x = 0; x < width; x += 1) {
      let run = 0;
      let start = 0;
      for (let y = 0; y <= height; y += 1) {
        if (y < height && dark(x, y)) {
          if (!run) start = y;
          run += 1;
        } else if (run >= 28) {
          for (let cursor = start; cursor < start + run; cursor += 1) kill[cursor * width + x] = 1;
          run = 0;
        } else run = 0;
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!kill[y * width + x]) continue;
        const index = (y * width + x) * 4;
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  async function recognizePage(buffer, pageNumber, deadline) {
    const pdf = await root.pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    const engine = await worker();
    const pixels = readPixels(canvas);
    const grid = detectGrid(pixels);
    if (!grid) {
      clearRulings(canvas);
      return recognizeRegion(engine, canvas, 0, 0, canvas.width, canvas.height, base.height, deadline);
    }
    const items = [];
    const top = grid.ys[0];
    const bottom = grid.ys[grid.ys.length - 1];
    if (top > 24) {
      const head = await recognizeRegion(engine, canvas, 0, 0, canvas.width, top - 2, base.height, deadline);
      head.forEach(function (item) { items.push(item); });
    }
    for (let row = 0; row < grid.ys.length - 1; row += 1) {
      for (let column = 0; column < grid.xs.length - 1; column += 1) {
        const pad = 2;
        const left = grid.xs[column] + pad;
        const cellTop = grid.ys[row] + pad;
        const width = grid.xs[column + 1] - grid.xs[column] - pad * 2;
        const height = grid.ys[row + 1] - grid.ys[row] - pad * 2;
        if (width < 16 || height < 10) continue;
        if (inkCount(pixels, left, cellTop, width, height) < 6) continue;
        const words = await recognizeRegion(engine, canvas, left, cellTop, width, height, base.height, deadline);
        words.forEach(function (item) { items.push(item); });
      }
    }
    if (canvas.height - bottom > 24) {
      const foot = await recognizeRegion(engine, canvas, 0, bottom + 2, canvas.width, canvas.height - bottom - 2, base.height, deadline);
      foot.forEach(function (item) { items.push(item); });
    }
    return items;
  }

  async function completePages(buffer, pages, deadline) {
    const output = [];
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      if (!root.IPParse.pageNeedsOcr(page)) {
        page.extraction = page.extraction || "texte";
        output.push(page);
        continue;
      }
      if (deadline && Date.now() > deadline) {
        page.extraction = "texte";
        page.ocrError = "Délai dépassé pour ce fichier.";
        output.push(page);
        continue;
      }
      try {
        const items = await recognizePage(buffer, page.page, deadline);
        output.push({
          page: page.page,
          width: page.width,
          height: page.height,
          items: items,
          extraction: "ocr"
        });
      } catch (error) {
        page.extraction = "texte";
        page.ocrError = error && error.message ? error.message : String(error || "OCR impossible");
        output.push(page);
      }
    }
    return output;
  }

  root.IPOcr = { completePages: completePages, fileDeadlineMs: FILE_DEADLINE_MS };
})(globalThis);
