(function () {
  // --- Pomocné funkce / výběr prvků (funguje s oběma sadami ID) ---
  const pick = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean) || null;
  const fmt = (d) => { if (!d) return ""; const t = new Date(d); return isNaN(t) ? d : t.toLocaleDateString("cs-CZ"); };
  const setLoading = (btn, on) => { if (!btn) return; if (on) { btn.dataset.prev = btn.innerHTML; btn.innerHTML = "Hledám…"; btn.disabled = true; } else { btn.innerHTML = btn.dataset.prev || "Hledat"; btn.disabled = false; } };

  // --- Elementy (zkoušíme více ID variant) ---
  const $input = pick("query", "q");
  const $btnSearch = pick("btn-search", "b");
  const $btnDemo = pick("btn-demo", "d");
  const $sentence = pick("sentence", "s");
  const $links = pick("links");
  const $details = pick("details");
  const $stat = pick("statutar", "stat");
  const $jed = pick("jednani", "jed");
  const $owners = pick("owners");
  const $ownersNote = pick("ownersNotice", "note");
  const $err = pick("err", "e");

  // --- Render ---
  const renderKeyVal = (wrap, label, value) => {
    if (!wrap) return;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="label">${label}</div><div class="value">${value ?? "—"}</div><div></div>`;
    wrap.appendChild(row);
  };

  const renderCompany = (c) => {
    // Sestavená věta
    if ($sentence) {
      const parts = [];
      if (c.nazev) parts.push(`Společnost ${c.nazev}`);
      if (c.ico) parts.push(`IČO ${c.ico}`);
      if (c.sidlo) parts.push(`se sídlem ${c.sidlo}`);
      if (c.soud || c.spisova_znacka) {
        const s = c.soud ? `u ${c.soud}` : "";
        const z = c.spisova_znacka ? `, spisová značka ${c.spisova_znacka}` : "";
        parts.push(`zapsaná ${s}${z}`);
      }
      if (c.datum_vzniku) parts.push(`vznikla dne ${fmt(c.datum_vzniku)}`);
      const jmena = (c.statutarni_organ || []).map(x => x.jmeno).filter(Boolean);
      if (jmena.length) parts.push(`statutární orgán: ${jmena.join(", ")}`);
      if (c.zpusob_jednani) parts.push(`kteří jednají: ${c.zpusob_jednani}`);
      $sentence.textContent = parts.join(", ") + ".";
      $sentence.classList.remove("muted");
    }

    // Odkazy
    if ($links) {
      $links.innerHTML = "";
      const add = (href, label) => {
        if (!href) return;
        const a = document.createElement("a");
        a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; a.style.marginRight = "12px";
        $links.appendChild(a);
      };
      if (c.odkazy) {
        add(c.odkazy.or_platny, "OR – Platný výpis");
        add(c.odkazy.or_uplny, "OR – Úplný výpis");
        add(c.odkazy.sbirka_listin, "Sbírka listin");
        add(c.odkazy.isir, "ISIR");
      }
    }

    // Podrobnosti
    if ($details) {
      $details.innerHTML = "";
      renderKeyVal($details, "Název", c.nazev);
      renderKeyVal($details, "IČO", c.ico);
      renderKeyVal($details, "Sídlo", c.sidlo);
      renderKeyVal($details, "Datum vzniku", fmt(c.datum_vzniku));
      renderKeyVal($details, "Rejstříkový soud", c.soud);
      renderKeyVal($details, "Spisová značka", c.spisova_znacka);
      if (c.kapital != null) renderKeyVal($details, "Základní kapitál (Kč)", String(c.kapital));
    }

    // Statutární orgán & jednání
    if ($stat) {
      $stat.innerHTML = "";
      (c.statutarni_organ || []).forEach(p => {
        const text = `${p.jmeno || "—"}${p.vznik_funkce ? " (od " + fmt(p.vznik_funkce) + ")" : ""}`;
        renderKeyVal($stat, "Člen orgánu", text);
      });
    }
    if ($jed) {
      $jed.innerHTML = "";
      renderKeyVal($jed, "Způsob jednání", c.zpusob_jednani || "—");
    }

    // Vlastníci
    if ($owners) {
      $owners.innerHTML = "";
      const t = document.createElement("table");
      t.innerHTML = `<thead><tr><th>Jméno / Název</th><th class="right">Vklad (Kč)</th><th class="right">Podíl (%)</th></tr></thead>`;
      const tb = document.createElement("tbody");
      let has = false;
      const pct = (a, b) => (!b || b === 0 || a == null) ? null : Math.round((a / b) * 10000) / 100;
      (c.vlastnici || []).forEach(o => {
        has = true;
        const tr = document.createElement("tr");
        const p = pct(o.vklad, c.kapital);
        tr.innerHTML = `<td>${o.jmeno || "—"}</td><td class="right">${o.vklad != null ? o.vklad.toLocaleString("cs-CZ") : "—"}</td><td class="right">${p != null ? p.toFixed(2) : "—"}</td>`;
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      $owners.appendChild(t);
      if ($ownersNote) {
        $ownersNote.textContent = has
          ? (c.kapital ? "" : "Základní kapitál není uveden – % jsou orientační.")
          : "U a.s. nemusí být vlastnictví veřejné; u s.r.o. se bere ze sekce Společníci.";
      }
    }
  };

  // --- Akce ---
  async function loadDemo() {
    try {
      const r = await fetch("./data/demo.json", { cache: "no-store" });
      const j = await r.json();
      renderCompany(j);
      if ($err) { $err.style.display = "none"; $err.textContent = ""; }
    } catch (e) {
      if ($err) { $err.textContent = "Demo se nepodařilo načíst (chybí data/demo.json)."; $err.style.display = "block"; }
    }
  }

  async function runSearch() {
    const q = ($input?.value || "").trim();
    if (!/^\d{8}$/.test(q)) { alert("Zadejte IČO ve formátu 8 číslic."); return; }
    setLoading($btnSearch, true);
    try {
      const res = await fetch(`/.netlify/functions/company?q=${encodeURIComponent(q)}`, { headers: { "Accept": "application/json" } });
      const text = await res.text();
      let data = {}; try { data = JSON.parse(text); } catch { throw new Error("Neplatná JSON odpověď."); }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      renderCompany(data);
      if ($err) { $err.style.display = "none"; $err.textContent = ""; }
    } catch (e) {
      await loadDemo();
      if ($err) { $err.textContent = "Vyhledání selhalo: " + (e?.message || e); $err.style.display = "block"; }
    } finally {
      setLoading($btnSearch, false);
    }
  }

  // --- Bezpečné připojení listenerů (jen když elementy existují) ---
  if ($btnDemo) $btnDemo.addEventListener("click", loadDemo);
  if ($btnSearch) $btnSearch.addEventListener("click", runSearch);
})();
