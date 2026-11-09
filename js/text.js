(function (root) {
  const MONTHS = {
    janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12
  };

  const MONTH_NAMES = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre"
  ];

  function normalize(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collapse(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function fingerprint(record) {
    return [
      record.serviceId || record.serviceMention || "",
      record.meetingDate || "",
      record.number || "",
      collapse(record.question),
      collapse(record.answer)
    ].join("\u0001");
  }

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  function expandYear(year) {
    const value = String(year);
    const number = Number(value);
    if (value.length >= 4) return number;
    return number <= 69 ? 2000 + number : 1900 + number;
  }

  function isoDate(year, month, day) {
    const y = expandYear(year);
    const m = Number(month);
    const d = Number(day);
    if (!y || !m || !d || m > 12 || d > 31 || y < 1990 || y > 2099) return null;
    return y + "-" + pad(m) + "-" + pad(d);
  }

  function parseFrenchDate(value) {
    const text = collapse(value).replace(/\b1er\b/gi, "1").replace(/\s*([\/.\-])\s*/g, "$1");
    const numeric = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
    if (numeric) return isoDate(numeric[3], numeric[2], numeric[1]);
    const written = text.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{2}|\d{4})$/);
    if (!written) return null;
    const month = MONTHS[normalize(written[2])];
    if (!month) return null;
    return isoDate(written[3], month, written[1]);
  }

  function findMeetingDate(preamble) {
    const lines = String(preamble || "").split(/\n/);
    let calendar = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/(\d)\s*ª/g, "$1er");
      if (/calendrier/i.test(line)) {
        calendar = true;
        continue;
      }
      if (calendar) continue;
      const match = line.match(/Date(?:\s+de\s+la\s+r[ée]union)?\s*:?\s*(?:[A-Za-zÀ-ÿ]+\s+)?(\d{1,2}(?:er)?\s+[A-Za-zÀ-ÿ]+(?:\s+\d{2,4})?|\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4})/i);
      if (!match) continue;
      const token = match[1];
      if (!/\d{2,4}$/.test(token)) continue;
      const parsed = parseFrenchDate(token);
      if (parsed) return parsed;
    }
    return null;
  }

  function findSignedDate(source) {
    const match = String(source || "").match(/\bLe\s+(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})\b/i);
    return match ? parseFrenchDate(match[1]) : null;
  }

  function organizationHeading(value) {
    const match = collapse(value).match(/^ip\s*[–-]\s*(cgt|unsa|cfe(?:[\s-]*cgc)?|cfdt|sud|fo|solidaires)\b/i);
    if (!match) return null;
    return detectOrganization(match[1]);
  }

  function formatMeetingDate(iso) {
    if (!iso) return "Date de réunion à compléter";
    const parts = String(iso).split("-");
    if (parts.length !== 3) return "Date de réunion à compléter";
    const month = MONTH_NAMES[Number(parts[1]) - 1];
    if (!month) return "Date de réunion à compléter";
    return Number(parts[2]) + " " + month + " " + parts[0];
  }

  function formatAddedAt(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  }

  function detectOrganization(question) {
    const text = collapse(question);
    const match = text.match(/(CFE(?:[\s-]*CGC)|UNSA|CFDT|SOLIDAIRES|SUD|\bFO\b|IPCGT|IP\s*CGT|\bCGT\b)/i);
    if (!match) return null;
    const token = match[1].toUpperCase().replace(/[\s-]+/g, "");
    if (token.indexOf("CFE") === 0) return "CFE-CGC";
    if (token === "SOLIDAIRES") return "Solidaires";
    if (token === "IPCGT" || token === "IPCGT") return "CGT";
    if (/^IP\s*CGT$/i.test(match[1]) || token === "IPCGT") return "CGT";
    if (token === "CGT" || /CGT/i.test(match[1])) return "CGT";
    if (token === "UNSA") return "UNSA";
    if (token === "CFDT") return "CFDT";
    if (token === "SUD") return "SUD";
    if (token === "FO") return "FO";
    return null;
  }

  function detectServiceId(text) {
    const source = String(text || "");
    const rules = [
      ["voie", /\bVOIE\b/i],
      ["tde", /\bunit[ée]\s+TDE\b/i],
      ["eso", /\bESO\b/i],
      ["lem", /\bLEM\b/i],
      ["gigp", /\bGIGP\b/i],
      ["ct", /\bunit[ée]\s+CT\b/i]
    ];
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i][1].test(source)) return rules[i][0];
    }
    return null;
  }

  function excerpt(text, max) {
    const clean = collapse(text);
    const limit = max || 180;
    if (!clean) return "";
    if (clean.length <= limit) return clean;
    return clean.slice(0, limit - 1).trim() + "…";
  }

  function createId() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  root.IPText = {
    normalize: normalize,
    collapse: collapse,
    fingerprint: fingerprint,
    parseFrenchDate: parseFrenchDate,
    findMeetingDate: findMeetingDate,
    findSignedDate: findSignedDate,
    organizationHeading: organizationHeading,
    formatMeetingDate: formatMeetingDate,
    formatAddedAt: formatAddedAt,
    detectOrganization: detectOrganization,
    detectServiceId: detectServiceId,
    excerpt: excerpt,
    createId: createId
  };
})(globalThis);
