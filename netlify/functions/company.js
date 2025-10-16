// netlify/functions/company.js
// FINÁLNÍ: ARES (základ) + OR justice (soud, spis, statutáři, jednání, společníci)
// Node 20, CommonJS, bez fetch/undici (používáme https.request)

const https = require("node:https");
const http = require("node:http");
const cheerio = require("cheerio");

// ---------- malá I/O vrstva ----------
function httpText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, { method: "GET", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) resolve(data);
        else reject(new Error(`HTTP ${code}`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}
async function httpJSON(url, headers = {}) {
  const t = await httpText(url, headers);
  try { return JSON.parse(t); } catch { throw new Error("Neplatná JSON odpověď"); }
}
const pick = (...xs) => xs.find(v => v !== null && v !== undefined && v !== "") ?? null;

// ---------- ARES: základní údaje ----------
async function aresFirm(ico) {
  // ARES BE API (veřejné)
  const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${encodeURIComponent(ico)}`;
  const j = await httpJSON(url, { "Accept": "application/json" });

  const s = j?.sidlo || {};
  const adresa = [
    s.uliceNazev || s.nazevUlice,
    s.cisloDomovni || s.cisloPopisne,
    s.cisloOrientacni,
    s.obecNazev || s.nazevObce || s.obec,
    s.psc || s.PSC,
    s.statNazev || s.stat
  ].filter(Boolean).join(", ") || null;

  return {
    nazev: pick(j?.obchodniJmeno, j?.obchodniJmenoText, j?.obchodniJmenoZkracene),
    ico: j?.ico || null,
    sidlo: adresa,
    datum_vzniku: pick(j?.datumVzniku, j?.vznik) || null,
  };
}

// ---------- OR: doplňky (soud, spis, jednání, statutáři, společníci, kapitál) ----------
async function orDetails(ico) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
  };
  const base = `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}`;
  let html;
  try { html = await httpText(base, headers); }
  catch { html = await httpText(`${base}&typ=plny`, headers); }

  const $ = require("cheerio").load(html);
  // zpracujeme CELÝ text (je to spolehlivější mezi různými verzemi stránky)
  const text = $("body").text().replace(/\s+/g, " ").trim();

  const out = {
    soud: null,
    spisova_znacka: null,
    zpusob_jednani: null,
    kapital: null,
    statutarni_organ: [],
    vlastnici: []
  };

  // Rejstříkový soud + spisová značka (2 pokusy: společný řádek a pak zvlášť)
  let m = text.match(/Zapsaná\s+u\s+(.+?)(?:,|\.)\s*spisová\s+značka\s*[:\-]?\s*([A-Z]\s*\d+(?:\/[A-Z]+)?)/i);
  if (m) { out.soud = m[1].trim(); out.spisova_znacka = m[2].replace(/\s+/g, " ").trim(); }
  if (!out.spisova_znacka) {
    const mS = text.match(/spisová\s+značka\s*[:\-]?\s*([A-Z]\s*\d+(?:\/[A-Z]+)?)/i);
    if (mS) out.spisova_znacka = mS[1].replace(/\s+/g, " ").trim();
  }
  if (!out.soud) {
    const mC = text.match(/Zapsaná\s+u\s+(.+?)(?:,|\s{2,}|\.|$)/i);
    if (mC) out.soud = mC[1].trim();
  }

  // Základní kapitál
  const mCap = text.match(/Základní\s+kapitál\s*[:\-]?\s*([0-9][0-9\s\.]*)\s*Kč/i);
  if (mCap) out.kapital = Number(mCap[1].replace(/[^\d]/g, ""));

  // Způsob jednání (vezmeme blok až po další sekci)
  const mJed = text.match(/Způsob\s+jednání(?:\s+za\s+společnost)?\s*[:\-]?\s*(.+?)(?=\s{2,}|Statutární|Společníci|Akcionáři|Základní\s+kapitál|Předmět|$)/i);
  if (mJed) out.zpusob_jednani = mJed[1].trim();

  // Pomocník pro vyříznutí bloku dle nadpisů
  const between = (startRe, endRe) => {
    const s = text.search(startRe);
    if (s === -1) return "";
    const rest = text.slice(s);
    const e = rest.search(endRe);
    return e === -1 ? rest : rest.slice(0, e);
  };

  // Statutární orgán → jména
  const statSeg = between(/Statutární\s+orgán/i, /Společníci|Akcionáři|Základní\s+kapitál|Předmět|Sídlo|Likvidace/i);
  const nameRe = /[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,}\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,}(?:\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,})?/g;
  const names = (statSeg.match(nameRe) || []).map(s => s.trim());
  const uniq = Array.from(new Set(names)).slice(0, 8);
  out.statutarni_organ = uniq.map(j => ({ jmeno: j }));

  // Společníci → jméno + vklad
  const spolSeg = between(/Společníci|Akcionáři/i, /Základní\s+kapitál|Statutární|Předmět|Likvidace|Sídlo|$|Likvidátor/i);
  if (spolSeg) {
    spolSeg.split(/(?:;|\s{2,})/).map(s => s.trim()).filter(Boolean).forEach(item => {
      const nm = item.match(nameRe);
      const vk = item.match(/vklad\s*([0-9\s\.]+)\s*Kč/i);
      if (nm || vk) {
        out.vlastnici.push({
          jmeno: nm ? nm[0].trim() : null,
          vklad: vk ? Number(vk[1].replace(/[^\d]/g, "")) : null
        });
      }
    });
  }

  return out;
}


// ---------- HTTP handler ----------
exports.handler = async (event) => {
  const ico = (event.queryStringParameters && event.queryStringParameters.q)
    ? String(event.queryStringParameters.q).trim() : "";

  if (!/^\d{8}$/.test(ico)) {
    return json(400, { error: "Zadejte IČO ve formátu 8 číslic." });
  }

  try {
    const a = await aresFirm(ico);
    const o = await orDetails(ico);

    const result = {
      nazev: a.nazev || null,
      ico: a.ico || ico,
      sidlo: a.sidlo || null,
      datum_vzniku: a.datum_vzniku || null,
      soud: o.soud || null,
      spisova_znacka: o.spisova_znacka || null,
      kapital: o.kapital ?? null,
      odkazy: {
        or_platny: `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}`,
        or_uplny:  `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}&typ=plny`,
        sbirka_listin: `https://or.justice.cz/ias/ui/sbirka-listin?ico=${encodeURIComponent(ico)}`,
        isir: "https://isir.justice.cz/isir/ueu/vysledek_lustrace.do"
      },
      statutarni_organ_label: "Statutární orgán",
      statutarni_organ: o.statutarni_organ || [],
      zpusob_jednani: o.zpusob_jednani || null,
      vlastnici: o.vlastnici || []
    };

    return json(200, result);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return json(502, { error: `Načtení selhalo: ${msg}` });
  }
};

function json(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
