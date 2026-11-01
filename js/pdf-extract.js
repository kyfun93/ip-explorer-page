(function (root) {
  function ensureWorker() {
    if (!root.pdfjsLib) throw new Error("La lecture PDF n’est pas disponible dans cette page.");
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  async function rulingGrid(page) {
    const ops = await page.getOperatorList();
    const verts = [];
    const hors = [];
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] !== root.pdfjsLib.OPS.constructPath) continue;
      const args = ops.argsArray[i] || [];
      const codes = args[0];
      const data = args[1];
      if (!codes || !data) continue;
      let cursor = 0;
      let x = 0;
      let y = 0;
      let startX = 0;
      let startY = 0;
      for (let c = 0; c < codes.length; c += 1) {
        const code = codes[c];
        if (code === (root.pdfjsLib.OPS.rectangle || 19)) {
          if (cursor + 4 > data.length) break;
          const rx = data[cursor];
          const ry = data[cursor + 1];
          const rw = data[cursor + 2];
          const rh = data[cursor + 3];
          cursor += 4;
          if (Math.abs(rw) < 2.2 && Math.abs(rh) > 18) verts.push({ x: rx, y0: Math.min(ry, ry + rh), y1: Math.max(ry, ry + rh) });
          if (Math.abs(rh) < 2.2 && Math.abs(rw) > 40) hors.push({ y: ry, x0: Math.min(rx, rx + rw), x1: Math.max(rx, rx + rw) });
        } else if (code === 13) {
          if (cursor + 2 > data.length) break;
          x = data[cursor];
          y = data[cursor + 1];
          startX = x;
          startY = y;
          cursor += 2;
        } else if (code === 14 || code === 18) {
          const x2 = code === 18 ? startX : data[cursor];
          const y2 = code === 18 ? startY : data[cursor + 1];
          if (code === 14) cursor += 2;
          if (Math.abs(x2 - x) < 1.6 && Math.abs(y2 - y) > 18) verts.push({ x: (x + x2) / 2, y0: Math.min(y, y2), y1: Math.max(y, y2) });
          if (Math.abs(y2 - y) < 1.6 && Math.abs(x2 - x) > 40) hors.push({ y: (y + y2) / 2, x0: Math.min(x, x2), x1: Math.max(x, x2) });
          x = x2;
          y = y2;
        } else if (code === 15) {
          if (cursor + 6 > data.length) break;
          x = data[cursor + 4];
          y = data[cursor + 5];
          cursor += 6;
        } else break;
      }
    }
    const columns = [];
    verts.sort(function (a, b) { return a.x - b.x; }).forEach(function (seg) {
      const last = columns[columns.length - 1];
      if (!last || seg.x - last.x > 2.5) columns.push({ x: seg.x, y0: seg.y0, y1: seg.y1, n: 1 });
      else {
        last.x = ((last.x * last.n) + seg.x) / (last.n + 1);
        last.y0 = Math.min(last.y0, seg.y0);
        last.y1 = Math.max(last.y1, seg.y1);
        last.n += 1;
      }
    });
    if (columns.length < 3) return null;
    const top = Math.max.apply(null, columns.map(function (column) { return column.y1; }));
    const kept = columns.filter(function (column) {
      return column.y1 >= top - 18 && (column.y1 - column.y0) > 50;
    });
    if (kept.length < 3 || kept.length > 6) return null;
    const bottoms = kept.map(function (column) { return column.y0; }).sort(function (a, b) { return a - b; });
    const bottom = bottoms[Math.floor((bottoms.length - 1) / 2)];
    const xs = kept.map(function (column) { return column.x; }).sort(function (a, b) { return a - b; });
    const right = xs[xs.length - 1];
    const origin = xs[Math.min(1, xs.length - 1)];
    const bands = [];
    hors.filter(function (line) { return line.y >= bottom - 4 && line.y <= top + 4; })
      .sort(function (a, b) { return b.y - a.y; })
      .forEach(function (line) {
        const last = bands[bands.length - 1];
        if (!last || Math.abs(last.y - line.y) > 2.2) bands.push({ y: line.y, x0: line.x0, x1: line.x1 });
        else {
          last.x0 = Math.min(last.x0, line.x0);
          last.x1 = Math.max(last.x1, line.x1);
        }
      });
    const ys = bands.filter(function (band) {
      return band.x0 <= origin + 8 && band.x1 >= right - 30;
    }).map(function (band) { return band.y; });
    if (ys.length < 2) return null;
    return { xs: xs, ys: ys };
  }

  async function extractPages(buffer) {
    ensureWorker();
    const pdf = await root.pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      content.items.forEach(function (item) {
        if (!item.str || !String(item.str).trim()) return;
        items.push({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          w: item.width || 0,
          h: item.height || 10
        });
      });
      let rulings = null;
      try {
        rulings = await rulingGrid(page);
      } catch (error) {
        rulings = null;
      }
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        items: items,
        rulings: rulings
      });
    }
    return pages;
  }

  async function sha256(buffer) {
    if (!root.crypto || !root.crypto.subtle) {
      throw new Error("Ouvrez l’application via l’adresse locale indiquée : l’empreinte du fichier a besoin d’une page sécurisée.");
    }
    const digest = await root.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  async function renderPage(blob, pageNumber, canvas) {
    ensureWorker();
    const data = await blob.arrayBuffer();
    const pdf = await root.pdfjsLib.getDocument({ data: data }).promise;
    const safePage = Math.min(Math.max(pageNumber, 1), pdf.numPages);
    const page = await pdf.getPage(safePage);
    const viewport = page.getViewport({ scale: 1.25 });
    const context = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    return { page: safePage, pages: pdf.numPages };
  }

  root.IPPdf = {
    extractPages: extractPages,
    sha256: sha256,
    renderPage: renderPage
  };
})(globalThis);
