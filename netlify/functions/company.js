// netlify/functions/company.js — LIVE default + DEMO přes MOCK=1 (CommonJS, bez top-level await)
const cheerio = require("cheerio");

exports.handler = async (event) => {
  const q = (event.queryStringParameters && event.queryStringParameters.q)
    ? String(event.queryStringParameters.q).trim()
    : "";
  const MOCK = process.env.MOCK ?? "0"; // LIVE by default

  // Demo payload (pro rychlý fallback i bez backendu)
  const DEMO = {
    nazev: "Amazing Health Care s.r.o.",
    ico: "02597136",
    sidlo: "Riegrova 1874/14, České Budějovice 3, 370 01 České Budějovice",
    datum_vzniku: "2014-01-29",
    soud: "Krajský soud v Českých Budějovicích",
    spisova_znacka: "C 22439/KSCB",
    kapital: 200000,
    odkazy: {
      or_platny: "https://or.justice.cz/ias/ui/rejstrik-$firma?ico=02597136",
      or_uplny: "https://or.justice.cz/ias/ui/rejstrik-$firma?ico=02597136&typ=plny",
      sbirka_listin: "https://or.justice.cz/ias/ui/sbirka-listin?ico=02597136",
      isir: "https://isir.justice.cz/isir/ueu/vysledek_lustrace.do"
    },
    statutarni_organ_label: "Jednatelé",
    statutarni_organ: [
      { jmeno: "Ing. Miroslav Velát", vznik_funkce: "2015-11-16" },
      { jmeno: "Renata Smržová", vznik_funkce: "2023-01-17" }
    ],
    zpusob_jednani: "Jednatelé jednají za společnost každý samostatně.",
    vlastnici: [
      { jmeno: "Ing. Miroslav Velát", vklad: 100000 },
      { jmeno: "Renata Smržová", vklad: 100000 }
    ]
  };

  const normalize = (obj) => ({
    nazev: obj.nazev || null,
    ico: obj.ico || null,
    sidlo: obj.sidlo || null,
    datum_vzniku: obj.datum_vzniku || null,
    soud: obj.soud || null,
    spisova_znacka: obj.spisova_znacka || null,
    kapital: typeof obj.kapital === "number" ? obj.kapital : null,
    odkazy: obj.odkazy || {},
    statutarni_organ_label: obj.statutarni_organ_label || "Jednatelé",
    statutarni_organ: Array.isArray(obj.statutarni_organ) ? obj.statutarni_organ : [],
    zpusob_jednani: obj.zpusob_jednani || null,
    vlastnici: Array.isArray(obj.vlastnici) ? obj.vlastnici : []
  });

  if (!q) {
    return json200(normalize(DEMO));
  }

  if (MOCK === "1") {
    const demo = { ...DEMO };
    if (/^\d{8}$/.test(q)) demo.ico = q;
    if (q && !/^\d{8}$/.test(q)) demo.nazev = q;
    return json200(normalize(demo));
  }

  if (!/^\d{8}$/.test(q)) {
    return json(400, { error: "Zadejte IČO ve formátu 8 číslic." });
  }

  try {
    const data = await fetchOR(q);
    return json200(normalize(data));
  } catch (e) {
    return json(502, { error: String(e && e.message ? e.message : e) });
  }
};

// ————— helpery a parser (žádný top-level await) —————

function json200(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function json(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function fetchOR(ico) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  };
  const url = `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}`;
  const urlFull = `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}&typ=plny`;

  const load = async (u) => {
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error(`OR HTTP ${r.status}`);
    return await r.text();
  };

  let html;
  try { html = await load(url); } catch { html = await load(urlFull); }

  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  const data = {
    nazev: null, ico, sidlo: null, datum_vzniku: null,
    soud: null, spisova_znacka: null, kapital: null,
    odkazy: {
      or_platny: url, or_uplny: urlFull,
      sbirka_listin: `https://or.justice.cz/ias/ui/sbirka-listin?ico=${encodeURIComponent(ico)}`,
      isir: "https://isir.justice.cz/isir/ueu/vysledek_lustrace.do"
    },
    statutarni_organ_label: "Statutární orgán",
    statutarni_organ: [],
    zpusob_jednani: null,
    vlastnici: []
  };

  const mName = text.match(/(Název|Obchodní firma)\s*[:\-]\s*(.+?)(?=\s{2,}|Zapsaná|Sídlo|$)/i);
  if (mName) data.nazev = mName[2].trim();

  const mAddr = text.match(/Sídlo\s*[:\-]\s*(.+?)(?=\s{2,}|Zapsaná|$)/i);
  if (mAddr) data.sidlo = mAddr[1].trim();

  const mCourt = text.match(/Zapsaná.*?u\s+(.+?)(?:,|\s{2,}|$)/i);
  if (mCourt) data.soud = mCourt[1].trim();

  const mFile = text.match(/spisová značka\s*[:\-]\s*([^\s,;]+)/i);
  if (mFile) data.spisova_znacka = mFile[1].trim();

  const mDate = text.match(/Datum vzniku\s*[:\-]\s*([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})/i);
  if (mDate) {
    const [d, m, y] = mDate[1].split(".");
    data.datum_vzniku = `${y.trim()}-${m.trim().padStart(2,"0")}-${d.trim().padStart(2,"0")}`;
  }

  const mCap = text.match(/Základní kapitál\s*[:\-]\s*([0-9\s\.]+)\s*Kč/i);
  if (mCap) data.kapital = Number(mCap[1].replace(/[^\d]/g, "")) || null;

  const mJed = text.match(/Způsob (jednání|jednání za společnost)\s*[:\-]\s*(.+?)(?:\s{2,}|Statutární|Společníci|$)/i);
  if (mJed) data.zpusob_jednani = mJed[2].trim();

  const mStat = text.match(/Statutární orgán(.+?)(Společníci|Akcionáři|Základní kapitál|Předmět podnikání|$)/i);
  if (mStat) {
    const names = mStat[1].match(/[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}\s+[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}/g);
    if (names) data.statutarni_organ = names.slice(0, 8).map(n => ({ jmeno: n.trim() }));
  }

  const mSpol = text.match(/Společníci(.+?)(Základní kapitál|Statutární|Předmět|$)/i);
  if (mSpol) {
    const rows = mSpol[1].split(/;|\s{2,}/).map(s => s.trim()).filter(Boolean);
    rows.forEach(r => {
      const nm = r.match(/[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}\s+[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}/);
      const vk = r.match(/vklad\s*([0-9\s\.]+)\s*Kč/i);
      if (nm) data.vlastnici.push({ jmeno: nm[0].trim(), vklad: vk ? Number(vk[1].replace(/[^\d]/g, "")) : null });
    });
  }

  return data;
}
