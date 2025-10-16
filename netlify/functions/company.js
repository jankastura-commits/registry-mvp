// netlify/functions/company.js
// FINÁLNÍ: ARES (základ) + OR justice (soud, spis, jednání, statutáři, společníci)
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
    datum_vzniku: pick(j?.datumVzniku, j?.vznik) || null
  };
}

// ---- REGEX konstanty (bez /…/ literálů) ----
const RE_SPIS1 = new RegExp("spisová\\s+značka\\s*[:\\-]?\\s*([A-Z]\\s*\\d+(?:\\/[A-Z]+)?)", "i");
const RE_SPIS2 = new RegExp("oddíl\\s*([A-Z])\\s*,?\\s*vložka\\s*(\\d+)", "i");
const RE_COURT1 = new RegExp("Zapsan[áé]\\s+u\\s+([^,\\.]+?)(?:,|\\.)", "i");
const RE_COURT2 = new RegExp("veden[áé]\\s+u\\s+([^,\\.]+?)(?:,|\\.)", "i");
const RE_CAP   = new RegExp("Základní\\s+kapitál\\s*[:\\-]?\\s*([0-9][0-9\\s\\.]+)\\s*Kč", "i");
const RE_JED   = new RegExp("Způsob\\s+jednání(?:\\s+za\\s+společnost)?\\s*[:\\-]?\\s*(.+?)(?=\\s{2,}|Statutární|Jednatelé?|Společníci|Akcionáři|Základní\\s+kapitál|Předmět|$)", "i");
const RE_JED2  = new RegExp("Jednatel\\w*.*?(jednají|jedná)\\s+za\\s+společnost\\s*:?(.*?)(?=\\s{2,}|Statutární|Jednatelé?|Společníci|Akcionáři|Základní\\s+kapitál|Předmět|$)", "i");
const RE_NAME  = new RegExp("[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\\d,;()]{1,}\\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\\d,;()]{1,}(?:\\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\\d,;()]{1,})?", "g");
const RE_VKLAD = new RegExp("(?:vklad|výše\\s+vkladu)\\s*([0-9\\s\\.]+)\\s*Kč", "i");

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

  const $ = cheerio.load(html);
  const text = $("body").text()
    .replace(/\u00a0/g, " ")   // NBSP
    .replace(/\s+/g, " ")
    .trim();

  const out = {
    soud: null,
    spisova_znacka: null,
    zpusob_jednani: null,
    kapital: null,
    statutarni_organ: [],
    vlastnici: []
  };

  // Spisová značka
  const mSp1 = text.match(RE_SPIS1);
  if (mSp1) out.spisova_znacka = mSp1[1].replace(/\s+/g, " ").trim();
  if (!out.spisova_znacka) {
    const mSp2 = text.match(RE_SPIS2);
    if (mSp2) out.spisova_znacka = `${mSp2[1]} ${mSp2[2]}`;
  }

  // Rejstříkový soud (odstranit přívěsky "Den/Datum zápisu: …")
  const mC1 = text.match(RE_COURT1);
  const mC2 = text.match(RE_COURT2);
  const courtRaw = (mC1?.[1] || mC2?.[1] || "").trim();
  if (courtRaw) out.soud = courtRaw.replace(/\s*(Den|Datum)\s+zápisu.*$/i, "").trim() || null;

  // Základní kapitál
  const mCap = text.match(RE_CAP);
  if (mCap) out.kapital = Number(mCap[1].replace(/[^\d]/g, ""));

  // Způsob jednání
  const mJed = text.match(RE_JED);
  const mJedAlt = mJed ? null : text.match(RE_JED2);
  if (mJed) out.zpusob_jednani = mJed[1].trim();
  else if (mJedAlt) out.zpusob_jednani = (mJedAlt[2] || mJedAlt[0]).trim();

  // helper pro vyříznutí bloku (bez regex literálů)
  const between = (startStr, endStr) => {
    const start = text.search(new RegExp(startStr, "i"));
    if (start === -1) return "";
    const rest = text.slice(start);
    const end = rest.search(new RegExp(endStr, "i"));
    return end === -1 ? rest : rest.slice(0, end);
  };

  // Statutární orgán (Statutární orgán / Jednatelé / Představenstvo / Správní rada)
  const statSeg = between(
    "(Statutární\\s+orgán|Jednatelé?|Představenstvo|Správní\\s+rada)",
    "(Společníci?|Akcionáři|Základní\\s+kapitál|Předmět|Sídlo|Likvidace|$)"
  );
  const names = (statSeg.match(RE_NAME) || []).map(s => s.trim());
  out.statutarni_organ = Array.from(new Set(names)).slice(0, 8).map(j => ({ jmeno: j }));

  // Společníci / Akcionáři (+ fallbacky)
  const spolSeg = between(
    "(Společníci?|Akcionáři)",
    "(Základní\\s+kapitál|Statutární|Předmět|Likvidace|Sídlo|$)"
  );
  const pushOwnerFrom = (str) => {
    str.split(/(?:;|\s{2,})/).map(s => s.trim()).filter(Boolean).forEach(item => {
      const nm = item.match(RE_NAME);
      const vk = item.match(RE_VKLAD);
      if (nm || vk) {
        out.vlastnici.push({
          jmeno: nm ? nm[0].trim() : null,
          vklad: vk ? Number(vk[1].replace(/[^\d]/g, "")) : null
        });
      }
    });
  };
  if (spolSeg) pushOwnerFrom(spolSeg);

  if (!out.vlastnici.length) {
    const globalOwners = text.match(new RegExp("Společník[^\\.]*?(?:jméno|název)?[^\\.]*?(?:vklad|výše\\s+vkladu)\\s*[0-9\\s\\.]+(?:\\s*Kč)?", "ig")) || [];
    globalOwners.forEach(s => pushOwnerFrom(s));
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
    let a = {};
    try { a = await aresFirm(ico); } catch { a = {}; }   // když ARES vrátí 404, pokračuj jen s OR
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
