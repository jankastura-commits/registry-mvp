// netlify/functions/company.js – zdroj: Hlídač státu (API v2)
// Potřebuje env proměnnou HLIDAC_TOKEN (Netlify → Site settings → Environment variables)
const https = require("node:https");
const http = require("node:http");

// ---- pomocné I/O ------------------------------------------------------------
function reqText(url, headers = {}) {
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

async function reqJSON(url, headers = {}) {
  const txt = await reqText(url, headers);
  try { return JSON.parse(txt); } catch { throw new Error("Neplatná JSON odpověď"); }
}

const HS_BASE = "https://api.hlidacstatu.cz";
const HS_AUTH = () => {
  const t = process.env.HLIDAC_TOKEN || "";
  if (!t) throw new Error("Chybí HLIDAC_TOKEN (nastav v Netlify → Environment variables).");
  return { Authorization: `Token ${t}` };
};

// ---- normalizace dat pro UI -------------------------------------------------
function pick(...vals) { return vals.find(v => v != null && v !== "") ?? null; }
function toDateISO(x) {
  if (!x) return null;
  // Hlídač obvykle vrací ISO nebo „YYYY-MM-DDTHH:mm:ss“
  const m = String(x).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // fallback DD.MM.YYYY
  const m2 = String(x).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`;
  return null;
}

// převod adresního objektu → řádek textu
function formatAddress(sidlo) {
  if (!sidlo || typeof sidlo !== "object") return (typeof sidlo === "string" ? sidlo : null);
  const parts = [
    sidlo.ulice || sidlo.Ulice,
    sidlo.cp || sidlo.CisloDomu || sidlo.CisloPopisne,
    sidlo.co || sidlo.CisloOrientacni,
    sidlo.obec || sidlo.Obec || sidlo.Mesto,
    sidlo.psc || sidlo.PSC,
    sidlo.stat || sidlo.Stat
  ].filter(Boolean);
  return parts.join(", ") || sidlo.text || sidlo.Text || sidlo.Adresa || null;
}

// převod odpovědi /api/v2/firmy/ico/{ico} na UI objekt
function normalizeFirm(api) {
  const nazev = pick(api?.ObchodniJmeno, api?.Jmeno, api?.Nazev, api?.nazev);
  const ico = pick(api?.ICO, api?.Ico, api?.ico);
  const sidlo = pick(
    formatAddress(api?.Sidlo),
    api?.Sidlo?.AdresaTextem,
    api?.sidlo,
    api?.Adresa
  );
  const datum_vzniku = toDateISO(pick(api?.DatumVzniku, api?.Zalozeno, api?.Vznik));
  const soud = pick(api?.RejstrikovySoud, api?.Rejstrik?.Soud, api?.Soud);
  const spisova_znacka = pick(api?.SpisovaZnacka, api?.Rejstrik?.SpisovaZnacka, api?.spisovaZnacka);
  const kapital = (typeof api?.ZakladniKapital === "number")
    ? api.ZakladniKapital
    : (typeof api?.Kapital === "number" ? api.Kapital : null);

  // stat. orgán (vezmeme první rozumné jméno)
  const statutarni_organ = [];
  const orgSrcs = [
    api?.StatutarniOrgan, api?.StatutarniOrgany, api?.Organy, api?.Vedeni
  ].flat().filter(Boolean);

  orgSrcs.forEach((x) => {
    const jmeno = pick(
      x?.Jmeno, x?.jmeno, x?.Osoba?.Jmeno, x?.Osoba?.CeleJmeno, x?.CeleJmeno, x?.Name
    );
    const vznik_funkce = toDateISO(pick(x?.Od, x?.OdKdy, x?.VznikFunkce, x?.DatumOd));
    if (jmeno) statutarni_organ.push({ jmeno, vznik_funkce });
  });

  // způsob jednání
  const zpusob_jednani = pick(
    api?.ZpusobJednani,
    api?.ZpusobJednaniZaSpolecnost,
    api?.Jednani,
    api?.PopisJednani
  );

  // odkazy do OR
  const orBase = ico ? `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}` : null;

  return {
    nazev, ico, sidlo, datum_vzniku, soud, spisova_znacka, kapital,
    odkazy: orBase ? {
      or_platny: orBase,
      or_uplny: `${orBase}&typ=plny`,
      sbirka_listin: `https://or.justice.cz/ias/ui/sbirka-listin?ico=${encodeURIComponent(ico)}`,
      isir: "https://isir.justice.cz/isir/ueu/vysledek_lustrace.do"
    } : {},
    statutarni_organ_label: "Statutární orgán",
    statutarni_organ,
    zpusob_jednani,
    vlastnici: [] // doplníme níže skutečné majitele
  };
}

// ---- Hlídač: firmní profil + skuteční majitelé ------------------------------
async function hsFirmByIco(ico) {
  const url = `${HS_BASE}/api/v2/firmy/ico/${encodeURIComponent(ico)}`;
  return await reqJSON(url, HS_AUTH()); // /api/v2/firmy/ico/{ico} :contentReference[oaicite:3]{index=3}
}

// dataset „skutecni-majitele“: zkusíme oba názvy parametru dotazu (q|dotaz)
async function hsBeneficialOwners(ico) {
  const build = (param) =>
    `${HS_BASE}/api/v2/datasety/skutecni-majitele/hledat?${param}=${encodeURIComponent(`( ICO.keyword:${ico} )`)}&strana=1`;
  let data;
  try { data = await reqJSON(build("dotaz"), HS_AUTH()); }
  catch { data = await reqJSON(build("q"), HS_AUTH()); }
  // očekáváme strukturu { total, page/strana, results[] | zaznamy[] }
  const rows = data?.results || data?.zaznamy || data?.Items || [];
  const owners = [];
  rows.forEach(rec => {
    // pole se jmény a vklady se v datasetu liší podle období, uděláme „best effort“
    const part = {
      jmeno: pick(rec?.majitel?.jmeno, rec?.Majitel?.Jmeno, rec?.osoba?.jmeno, rec?.jmeno, rec?.nazevSubjektu),
      vklad: typeof rec?.vklad === "number" ? rec.vklad
           : (typeof rec?.Vklad === "number" ? rec.Vklad
           : (typeof rec?.podil?.vklad === "number" ? rec.podil.vklad : null))
    };
    if (part.jmeno) owners.push(part);
  });
  return owners;
}

// ---- HTTP handler -----------------------------------------------------------
exports.handler = async (event) => {
  try {
    const q = (event.queryStringParameters && event.queryStringParameters.q)
      ? String(event.queryStringParameters.q).trim() : "";

    if (!/^\d{8}$/.test(q)) {
      return json(400, { error: "Zadejte IČO ve formátu 8 číslic." });
    }

    const firmRaw = await hsFirmByIco(q);                   // Hlídač – detail firmy
    const firm = normalizeFirm(firmRaw);                    // převod na náš formát

    try {                                                   // Hlídač – skuteční majitelé (pokud jsou)
      firm.vlastnici = await hsBeneficialOwners(q);
    } catch {
      // když dataset není k dispozici, necháme prázdné a UI to zvládne
    }

    return json(200, firm);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    // nejčastější: 401 (špatný/missing token) nebo 4xx/5xx z API
    return json(502, { error: `Hlídač API: ${msg}` });
  }
};

function json(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
