(function(){
  const el=(id)=>document.getElementById(id);
  const fmt=(d)=>{if(!d)return'';const t=new Date(d);return isNaN(t)?d:t.toLocaleDateString('cs-CZ')};
  const copy=(t)=>navigator.clipboard.writeText(t).catch(()=>{});
  const buildSentence=(c)=>{
    const p=[]; if(c.nazev)p.push(`Společnost ${c.nazev}`);
    if(c.ico)p.push(`IČO ${c.ico}`);
    if(c.sidlo)p.push(`se sídlem ${c.sidlo}`);
    if(c.soud||c.spisova_znacka){const s=c.soud?`u ${c.soud}`:'';const z=c.spisova_znacka?`, spisová značka ${c.spisova_znacka}`:'';p.push(`zapsaná ${s}${z}`);}
    if(c.datum_vzniku)p.push(`vznikla dne ${fmt(c.datum_vzniku)}`);
    const j=(c.statutarni_organ||[]).map(x=>x.jmeno).filter(Boolean); if(j.length)p.push(`statutární orgán: ${j.join(', ')}`);
    if(c.zpusob_jednani)p.push(`kteří jednají: ${c.zpusob_jednani}`);
    return p.join(', ')+'.';
  };
  const row=(lab,val,copyable=true)=>{
    const wrap=document.createElement('div'); wrap.className='row';
    const l=document.createElement('div'); l.className='label'; l.textContent=lab;
    const v=document.createElement('div'); v.className='value'; v.textContent=val??'—';
    const c=document.createElement('div'); c.className='copy'; c.textContent=(copyable&&val)?'Copy':''; if(copyable&&val) c.onclick=()=>copy(val);
    wrap.append(l,v,c); return wrap;
  };
  const pct=(a,b)=>(!b||b===0||a==null)?null:Math.round((a/b)*10000)/100;

  const render=(c)=>{
    el('s').classList.remove('muted'); el('s').textContent=buildSentence(c); el('s').onclick=()=>copy(el('s').textContent);
    const links=el('links'); links.innerHTML='';
    const add=(href,label)=>{ if(!href)return; const a=document.createElement('a'); a.href=href;a.target='_blank';a.rel='noopener';a.textContent=label; a.style.marginRight='12px'; links.appendChild(a); };
    if(c.odkazy){ add(c.odkazy.or_platny,'OR – Platný výpis'); add(c.odkazy.or_uplny,'OR – Úplný výpis'); add(c.odkazy.sbirka_listin,'Sbírka listin'); add(c.odkazy.isir,'ISIR'); }

    const d=el('details'); d.innerHTML='';
    d.append(row('Název',c.nazev), row('IČO',c.ico), row('Sídlo',c.sidlo), row('Datum vzniku',fmt(c.datum_vzniku)), row('Rejstříkový soud',c.soud), row('Spisová značka',c.spisova_znacka), ...(c.kapital!=null?[row('Základní kapitál (Kč)',String(c.kapital))]:[]));
    const st=el('stat'); st.innerHTML='';
    (c.statutarni_organ||[]).forEach(x=>st.append(row('Člen orgánu', `${x.jmeno||'—'}${x.vznik_funkce?` (od ${fmt(x.vznik_funkce)})`:''}`)));
    const j=el('jed'); j.innerHTML=''; j.append(row('Způsob jednání', c.zpusob_jednani||'—', false));

    const own=el('owners'); own.innerHTML='';
    const t=document.createElement('table'); t.innerHTML='<thead><tr><th>Jméno / Název</th><th class=\"right\">Vklad (Kč)</th><th class=\"right\">Podíl (%)</th></tr></thead>';
    const tb=document.createElement('tbody');
    let has=false;
    (c.vlastnici||[]).forEach(o=>{ has=true; const tr=document.createElement('tr'); const p=pct(o.vklad,c.kapital); tr.innerHTML=`<td>${o.jmeno||'—'}</td><td class="right">${o.vklad!=null?o.vklad.toLocaleString('cs-CZ'):'—'}</td><td class="right">${p!=null?p.toFixed(2):'—'}</td>`; tb.appendChild(tr); });
    t.appendChild(tb); own.appendChild(t);
    el('note').textContent = has? (c.kapital? '' : 'Základní kapitál není uveden – procenta jsou orientační.') : 'U a.s. nemusí být vlastnictví veřejné; u s.r.o. se bere ze sekce Společníci.';
  };

  async function loadDemo(){
    const res=await fetch('./data/demo.json'); const data=await res.json(); render(data);
  }

  async function search(){
    const q=el('q').value.trim();
    if(!/^\d{8}$/.test(q)){ alert('Zadejte IČO (8 číslic).'); return; }
    const e=el('e'); e.style.display='none'; e.textContent='';
    try{
      const res=await fetch(`/.netlify/functions/company?q=${encodeURIComponent(q)}`);
      const text=await res.text(); let data={}; try{ data=JSON.parse(text);}catch{ throw new Error('Neplatná JSON odpověď.'); }
      if(!res.ok){ throw new Error(data.error||('HTTP '+res.status)); }
      render(data);
    }catch(err){
      await loadDemo();
      e.textContent='Vyhledání selhalo: '+(err&&err.message?err.message:String(err)); e.style.display='block';
    }
  }

  el('d').onclick=loadDemo;
  el('b').onclick=search;
})();