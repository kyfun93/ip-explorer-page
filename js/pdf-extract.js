(function (root) {
  function ensureWorker() {
    if (!root.pdfjsLib) throw new Error("La lecture PDF n’est pas disponible dans cette page.");
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
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
      pages.push({
        page: number,
        width: viewport.width,
        height: viewport.height,
        items: items
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
