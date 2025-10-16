// netlify/functions/company.js
// Stabilní verze: ARES (základní údaje) + Hlídač státu (skuteční majitelé)
// Node 20, CommonJS, bez fetch/undici (používáme https.request)

const https = require("node:https");
const http = require("node:http");

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
        else reject(new Error(`${code}`));
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
  // Nové veřejné ARES API (ekonomicke-subjekty)
  const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${encodeURIComponent(ico)}`;
  const j = await httpJSON(url);

  // ARES vrací např. { ico, obchodniJmeno, sidlo:{ uliceNazev, cisloDomovni, cisloOrientacni, obecNazev, psc, statNazev } ... }
  const addr = j?.sidlo || {};
  const adresa = [
    addr.uliceNazev,
    addr.cisloDomovni,
    addr.cisloOrientacni,
    addr.obecNazev,
    addr.psc,
    addr.statNazev
  ].filter(Boolean).join(", ") || null;

  // ARES negarantuje rejstříkový soud ani spisovku – ty necháme prázdné (UI to zvládne)
  return {
    nazev: pick(j?.obchodniJmeno, j?.obchodniJmenoText, j?.obchodniJmenoZkracene),
    ico: j?.ico || null,
    sidlo: adresa,
    datum_vzniku: pick(j?.datumVzniku, j?.vznik) || null,
    soud: null,
    spisova_znacka: null,
    kapital: null,                         // ARES kapitál většinou nemá
    statutarni_organ_label: "Statutární orgán",
    statutarni_organ: [],
    zpusob_jednani: null,
    odkazy: (j?.ico ? {
      or_platny: `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(j.ico)}`,
      or_uplny:  `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(j.ico)}&typ=plny`,
      sbirka_listin: `https://or.justice.cz/ias/ui/sbirka-listin?ico=${encodeURIComponent(j.ico)}`,
      isir: "https://isir.justice.cz/isir/ueu/vysledek_lustrace.do"
    } : {})
  };
}

// ---------- Hlídač státu: skuteční majitelé ----------
function hsHeaders() {
  const t = process.env.HLIDAC_TOKEN || "";
  if (!t) throw new Error("Chybí HLIDAC_TOKEN v Netlify → Environment variables.");
  return { Authorization: `Token ${t}` };
}

// Dataset „skutecni-majitele“ – jednoduchý dotaz přes IČO
async function hsBeneficialOwners(ico) {
  // zkusíme 'dotaz' i 'q' (API používá obě varianty dle datasetu)
  const base = `https://api.hlidacstatu.cz/api/v2/datasety/skutecni-majitele/hledat`;
  let data;
  try {
    data = await httpJSON(`${base}?dotaz=${encodeURIComponent(`ICO.keyword:${ico}`)}&strana=1`, hsHeaders());
  } catch {
    data = await httpJSON(`${base}?q=${encodeURIComponent(`ICO.keyword:${ico}`)}&strana=1`, hsHeaders());
  }
  const rows = data?.results || data?.zaznamy || data?.Items || [];
  const owners = [];
  rows.forEach(r => {
    const jmeno = pick(
      r?.majitel?.jmeno, r?.Majitel?.Jmeno, r?.osoba?.jmeno, r?.jmeno, r?.nazevSubjektu, r?.nazev
    );
    const vklad = typeof r?.vklad === "number" ? r.vklad
               : (typeof r?.Vklad === "number" ? r.Vklad
               : (typeof r?.podil?.vklad === "number" ? r.podil.vklad : null));
    if (jmeno) owners.push({ jmeno, vklad: vklad ?? null });
  });
  // odstraň duplikáty jmen
  const seen = new Set();
  return owners.filter(o => (seen.has(o.jmeno) ? false : (seen.add(o.jmeno), true)));
}

// ---------- HTTP handler ----------
exports.handler = async (event) => {
  const ico = (event.queryStringParameters && event.queryStringParameters.q)
    ? String(event.queryStringParameters.q).trim() : "";

  if (!/^\d{8}$/.test(ico)) {
    return json(400, { error: "Zadejte IČO ve formátu 8 číslic." });
  }

  try {
    const firm = await aresFirm(ico);          // spolehlivé základy z ARES
    try {
      firm.vlastnici = await hsBeneficialOwners(ico);   // skuteční majitelé z Hlídače
    } catch (e) {
      firm.vlastnici = [];
      firm._warning = "Nepodařilo se načíst skutečné majitele z Hlídače.";
    }
    return json(200, firm);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return json(502, { error: `Načtení selhalo: ${msg}` });
  }
};

function json(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
