// netlify/functions/company.js — LIVE default + DEMO via MOCK=1
exports.handler = async (event) => {
  const q = (event.queryStringParameters && event.queryStringParameters.q) ? String(event.queryStringParameters.q).trim() : "";
  const MOCK = process.env.MOCK ?? "0"; // LIVE by default

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
    ],
    skutecni_majitele: [
      { typ: "Osoba", jmeno: "Ing. Miroslav Velát", popis: "Postavení ve vedení / podíl" },
      { typ: "Osoba", jmeno: "Renata Smržová", popis: "Postavení ve vedení / podíl" }
    ]
  };

  const normalize = (obj) => ({
    nazev: obj.nazev || obj.name || null,
    ico: obj.ico || obj.ic || null,
    sidlo: obj.sidlo || obj.address || null,
    datum_vzniku: obj.datum_vzniku || obj.incorporationDate || null,
    soud: obj.soud || obj.registryCourt || null,
    spisova_znacka: obj.spisova_znacka || obj.fileRef || null,
    kapital: typeof obj.kapital === "number" ? obj.kapital : (obj.registeredCapital || null),
    odkazy: obj.odkazy || {},
    statutarni_organ_label: obj.statutarni_organ_label || "Jednatelé",
    statutarni_organ: Array.isArray(obj.statutarni_organ) ? obj.statutarni_organ : [],
    zpusob_jednani: obj.zpusob_jednani || null,
    vlastnici: Array.isArray(obj.vlastnici) ? obj.vlastnici : [],
    skutecni_majitele: Array.isArray(obj.skutecni_majitele) ? obj.skutecni_majitele : []
  });

  if (!q) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalize(DEMO)) };
  if (MOCK === "1") return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalize(DEMO)) };

  if (!/^\d{8}$/.test(q)) return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Zadejte IČO ve formátu 8 číslic." }) };

  let cheerio; try { cheerio = require("cheerio"); } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Chybí modul 'cheerio' (nasazuj přes Git/CLI, aby proběhlo `npm i`)." }) };
  }

  async function fetchOR(ico){
    const headers = { "User-Agent":"Mozilla/5.0", "Accept-Language":"cs-CZ,cs;q=0.9,en;q=0.8" };
    const url = `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}`;
    const urlFull = `https://or.justice.cz/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}&typ=plny`;
    async function load(u){ const r=await fetch(u,{headers}); if(!r.ok) throw new Error("OR HTTP "+r.status); return await r.text(); }
    let html; try{ html = await load(url); } catch{ html = await load(urlFull); }
    const $ = cheerio.load(html); const text = $("body").text().replace(/\s+/g," ");
    const data = {
      nazev:null, ico, sidlo:null, datum_vzniku:null, soud:null, spisova_znacka:null, kapital:null,
      odkazy:{ or_platny:url, or_uplny:urlFull, sbirka_listin:`https://or.justice.cz/ias/ui/sbirka-listin?ico=${encodeURIComponent(ico)}`, isir:"https://isir.justice.cz/isir/ueu/vysledek_lustrace.do" },
      statutarni_organ_label:"Statutární orgán", statutarni_organ:[], zpusob_jednani:null, vlastnici:[]
    };
    const mName = text.match(/(Název|Obchodní firma)\s*[:\-]\s*(.+?)(?=\s{2,}|Zapsaná|Sídlo|$)/i); if(mName) data.nazev=mName[2].trim();
    const mAddr = text.match(/Sídlo\s*[:\-]\s*(.+?)(?=\s{2,}|Zapsaná|$)/i); if(mAddr) data.sidlo=mAddr[1].trim();
    const mCourt= text.match(/Zapsaná.*?u\s+(.+?)(?:,|\s{2,}|$)/i); if(mCourt) data.soud=mCourt[1].trim();
    const mFile = text.match(/spisová značka\s*[:\-]\s*([^\s,;]+)/i); if(mFile) data.spisova_znacka=mFile[1].trim();
    const mDate = text.match(/Datum vzniku\s*[:\-]\s*([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{4})/i);
    if(mDate){ const parts=mDate[1].split("."); const d=parts[0].trim().padStart(2,"0"), m=parts[1].trim().padStart(2,"0"), y=parts[2].trim(); data.datum_vzniku=`${y}-${m}-${d}`; }
    const mCap  = text.match(/Základní kapitál\s*[:\-]\s*([0-9\s\.]+)\s*Kč/i); if(mCap) data.kapital = Number(mCap[1].replace(/[^\d]/g,""))||null;
    const mJed  = text.match(/Způsob (jednání|jednání za společnost)\s*[:\-]\s*(.+?)(?:\s{2,}|Statutární|Společníci|$)/i); if(mJed) data.zpusob_jednani=mJed[2].trim();
    const mStat = text.match(/Statutární orgán(.+?)(Společníci|Akcionáři|Základní kapitál|Předmět podnikání|$)/i);
    if(mStat){ const names = mStat[1].match(/[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}\s+[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}/g); if(names) data.statutarni_organ = names.slice(0,8).map(n=>({ jmeno:n.trim() })); }
    const mSpol = text.match(/Společníci(.+?)(Základní kapitál|Statutární|Předmět|$)/i);
    if(mSpol){ const rows=mSpol[1].split(/;|\s{2,}/).map(s=>s.trim()).filter(Boolean); rows.forEach(r=>{ const nm=r.match(/[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}\s+[A-ZÁČĎÉĚÍĹĽŇÓÔŘŠŤÚŮÝŽ][^\d,;()]{2,}/); const vk=r.match(/vklad\s*([0-9\s\.]+)\s*Kč/i); if(nm) data.vlastnici.push({ jmeno:nm[0].trim(), vklad: vk? Number(vk[1].replace(/[^\d]/g,'')) : null }); }); }
    return data;
  }

  try{
    const data = await fetchOR(q);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalize(data)) };
  }catch(e){
    return { statusCode: 502, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};