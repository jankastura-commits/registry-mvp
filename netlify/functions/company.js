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

  const $ = cheerio.load(html);

  // Pomůcka: vyčistit text
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  // Detailové "dl" seznamy ve stránce – projdeme všechny dt/dd
  let soud = null, spisova = null, jednani = null, kapital = null;
  $("dt").each((_, el) => {
    const label = clean($(el).text()).toLowerCase();
    const val = clean($(el).next("dd").text());
    if (/rejstříkový soud|zapsaná.*u/i.test(label + " " + val) && !soud) {
      // často bývá jen v textu "Zapsaná u ..." → zkus vyzobnout po "u"
      const m = val.match(/u\s+(.+?)(?:,|$)/i);
      soud = m ? m[1].trim() : (val || null);
    }
    if (/spisová značka/i.test(label) && !spisova) spisova = val || null;
    if (/způsob jednání/i.test(label) && !jednani) jednani = val || null;
    if (/základní kapitál/i.test(label) && !kapital) {
      const n = Number((val || "").replace(/[^\d]/g, ""));
      kapital = Number.isFinite(n) ? n : null;
    }
  });

  // Statutární orgán – vyzobneme jména (často jsou v seznamech/tabulkách)
  const statutarni = [];
  const statBlok = $("h3,h2")
    .filter((_, h) => /Statutární orgán/i.test($(h).text()))
    .first().nextUntil("h2, h3");
  const statText = clean(statBlok.text());
  if (statText) {
    const names = statText.match(/[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,}\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,}(?:\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^\d,;()]{1,})?/g);
    if (names) names.slice(0, 8).forEach(j => statutarni.push({ jmeno: j.trim() }));
  }

  // Společníci – mezi nadpisem "Společníci" a dalším nadpisem h2/h3
  const spolBlok = $("h3,h2")
    .filter((_, h) => /Společníci|Akcionáři/i.test($(h).text()))
    .first().nextUntil("h2, h3");
  const spolText = clean(spolBlok.text());
  const vlastnici = [];
  if (spolText) {
    // rozsekej na odstavce/položky
    const items = spolText.split(/(?:;|\n|\r| {2,})/).map(x => x.trim()).filter(Boolean);
    items.forEach(it => {
      const jmeno = (it.match(/[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^0-9,;()]{1,}\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^0-9,;()]{1,}(?:\s+[A-ZÁČĎÉĚÍĹĽŇÓŘŠŤÚŮÝŽ][^0-9,;()]{1,})?/) || [null])[0];
      const vklad = it.match(/vklad\s*([0-9\s\.]+)\s*Kč/i);
      if (jmeno || vklad) {
        vlastnici.push({
          jmeno: jmeno ? jmeno.trim() : null,
          vklad: vklad ? Number(vklad[1].replace(/[^\d]/g, "")) : null
        });
      }
    });
  }

  return { soud, spisova_znacka: spisova, zpusob_jednani: jednani, kapital, statutarni_organ: statutarni, vlastnici };
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
