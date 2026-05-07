document.addEventListener('DOMContentLoaded', () => {
  const authBox = document.getElementById('immoscoutAuth');
  const captureTool = document.getElementById('immoscoutCaptureTool');
  if (!captureTool) return;

  const bookmarkletLink = document.getElementById('immoscoutBookmarklet');
  const copyBookmarklet = document.getElementById('immoscoutCopyBookmarklet');
  const exportCaptures = document.getElementById('immoscoutExportCaptures');
  const refreshCaptures = document.getElementById('immoscoutRefreshCaptures');
  const clearCaptures = document.getElementById('immoscoutClearCaptures');
  const capturePaste = document.getElementById('immoscoutCapturePaste');
  const importCapture = document.getElementById('immoscoutImportCapture');
  const capturesBody = document.getElementById('immoscoutCaptures');
  const statusBox = document.getElementById('immoscoutStatus');
  const statusTitle = document.getElementById('immoscoutStatusTitle');
  const resultsBody = document.getElementById('immoscoutResults');
  const downloadLink = document.getElementById('immoscoutDownload');

  let bookmarklet = '';

  checkAuth();

  copyBookmarklet.addEventListener('click', async () => {
    if (!bookmarklet) return;
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setStatusTitle('Bookmarklet kopiert');
    } catch {
      setStatusTitle('Bookmarklet kann im Link kopiert werden');
    }
  });

  refreshCaptures.addEventListener('click', () => {
    loadCaptures();
  });

  clearCaptures.addEventListener('click', async () => {
    if (!confirm('Alle Captures löschen?')) return;
    await fetch('/api/immoscout/captures', { method: 'DELETE' });
    await loadCaptures();
  });

  importCapture.addEventListener('click', async () => {
    let data;
    try {
      data = JSON.parse(capturePaste.value.trim());
    } catch {
      setStatusTitle('Capture JSON ist ungültig');
      return;
    }

    try {
      const response = await fetch('/api/immoscout/captures/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Import fehlgeschlagen');
      capturePaste.value = '';
      await loadCaptures();
      setStatusTitle(`Capture ${result.capture.id} importiert`);
    } catch (err) {
      setStatusTitle(err.message || 'Import fehlgeschlagen');
    }
  });

  exportCaptures.addEventListener('click', async () => {
    setCaptureBusy(true);
    showStatus('Excel-Export läuft ...', []);
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');

    try {
      const response = await fetch('/api/immoscout/captures/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Capture-Export fehlgeschlagen');

      showStatus('Excel-Export fertig', data.items || []);
      downloadLink.href = data.downloadUrl;
      downloadLink.hidden = false;
      window.location.href = data.downloadUrl;
    } catch (err) {
      showStatus(err.message || 'Excel-Export fehlgeschlagen', []);
    } finally {
      setCaptureBusy(false);
    }
  });

  async function checkAuth() {
    try {
      const response = await fetch('/api/admin/me');
      const data = await response.json();
      const authenticated = Boolean(data.authenticated);
      captureTool.hidden = !authenticated;
      authBox.hidden = authenticated;
      if (authenticated) {
        await loadCaptures();
        handleCaptureReturn();
      }
    } catch {
      captureTool.hidden = true;
      authBox.hidden = false;
    }
  }

  async function loadCaptures() {
    try {
      const response = await fetch('/api/immoscout/captures');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Captures konnten nicht geladen werden');
      bookmarklet = createBookmarklet(data.token);
      bookmarkletLink.href = bookmarklet;
      renderCaptures(data.captures || []);
    } catch (err) {
      renderCaptures([]);
      setStatusTitle(err.message || 'Captures konnten nicht geladen werden');
    }
  }

  function createBookmarklet(token) {
    const endpoint = `${window.location.origin}/api/immoscout/capture`;
    const returnUrl = `${window.location.origin}/immoscout-tool/?captureReturn=1`;
    const code = [
      '(async()=>{',
      'const m=location.href.match(/\\/expose\\/(\\d+)/),id=m&&m[1],pu=id?location.origin+"/expose/"+id+"/print":"";',
      'let pt="",ph="",pw=null,printed=false,closed=false,h="";',
      'const esc=s=>String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");',
      'if(pu){',
      'try{pw=open("about:blank","_blank");if(pw){pw.document.open();pw.document.write("<!doctype html><title>"+esc(id||"ImmoScout")+"</title><body style=\\"font-family:sans-serif;padding:24px\\">Druckversion wird geladen ...</body>");pw.document.close();}}catch(_){}',
      'try{const pr=await fetch(pu,{credentials:"include"});h=await pr.text();const d2=new DOMParser().parseFromString(h,"text/html");ph=d2.title||"";pt=d2.body?d2.body.innerText:"";if(pw&&h){const base="<base href=\\""+esc(pu)+"\\">",out=/<head[\\s>]/i.test(h)?h.replace(/<head([^>]*)>/i,"<head$1>"+base):"<!doctype html><html><head>"+base+"<title>"+esc(ph||id||"ImmoScout")+"</title></head><body>"+(d2.body?d2.body.innerHTML:esc(pt))+"</body></html>";pw.document.open();pw.document.write(out);pw.document.close();}}catch(_){try{if(pw)pw.location.href=pu}catch(__){}}',
      '}',
      'const cp=()=>{if(closed||!pw)return;closed=true;setTimeout(()=>{try{pw&&!pw.closed&&pw.close()}catch(_){}},900)};',
      'const dop=()=>{if(printed||!pw)return;printed=true;try{pw.addEventListener("afterprint",cp,{once:true});pw.onafterprint=cp}catch(_){}try{pw.document.title=id||"immoscout";pw.focus();pw.print()}catch(_){}setTimeout(cp,30000)};',
      'try{if(pw){pw.addEventListener("load",()=>setTimeout(dop,600),{once:true});setTimeout(dop,2400)}}catch(_){}',
      'const p={url:location.href,title:document.title,text:document.body?document.body.innerText:"",printUrl:pu,printTitle:ph,printText:pt};',
      'const b=JSON.stringify(p);',
      `try{const r=await fetch(${JSON.stringify(endpoint)}+"?token="+${JSON.stringify(token)},{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:b});`,
      'const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));',
      `location.href=${JSON.stringify(returnUrl)}+"&captured="+encodeURIComponent(d.id||id||"")}`,
      `catch(e){p.captureToken=${JSON.stringify(token)};const f=JSON.stringify(p);`,
      'try{await navigator.clipboard.writeText(f);alert("Direktimport blockiert. Capture wurde kopiert; im Tool einfuegen.")}catch(_){prompt("Capture kopieren und im Tool einfuegen:",f)}',
      `location.href=${JSON.stringify(returnUrl)}+"&manual=1"}`,
      '})()',
    ].join('');
    return `javascript:${code}`;
  }

  function handleCaptureReturn() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('captureReturn')) return;

    const captured = params.get('captured');
    const manual = params.get('manual');
    const cleanUrl = `${window.location.origin}/immoscout-tool/`;
    history.replaceState(null, '', cleanUrl);

    if (manual) {
      setStatusTitle('Capture wurde kopiert');
      return;
    }

    if (captured) {
      setStatusTitle(`Capture ${captured} gespeichert`);
      return;
    }

    setStatusTitle('Zurück im Tool');
  }

  function renderCaptures(items) {
    capturesBody.innerHTML = '';
    exportCaptures.disabled = items.length === 0;
    clearCaptures.disabled = items.length === 0;

    if (!items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4">Keine Captures vorhanden.</td>';
      capturesBody.appendChild(tr);
      return;
    }

    for (const item of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.id || '')}</td>
        <td>${escapeHtml(item.title || '')}</td>
        <td>${formatTextLength((Number(item.textLength) || 0) + (Number(item.printTextLength) || 0))}</td>
        <td>${formatDate(item.updatedAt || item.createdAt)}</td>
      `;
      capturesBody.appendChild(tr);
    }
  }

  function setCaptureBusy(isBusy) {
    exportCaptures.disabled = isBusy;
    refreshCaptures.disabled = isBusy;
    clearCaptures.disabled = isBusy;
    importCapture.disabled = isBusy;
    exportCaptures.textContent = isBusy ? 'Export läuft ...' : 'Captures exportieren';
  }

  function showStatus(title, items) {
    statusBox.hidden = false;
    setStatusTitle(title);
    resultsBody.innerHTML = '';

    if (!items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="3">Noch keine Ergebnisse.</td>';
      resultsBody.appendChild(tr);
      return;
    }

    for (const item of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.id || '')}</td>
        <td><span class="status-pill ${item.status === 'ok' ? 'ok' : item.status === 'blocked' ? 'blocked' : 'partial'}">${statusLabel(item.status)}</span></td>
        <td>${escapeHtml(item.message || '')}</td>
      `;
      resultsBody.appendChild(tr);
    }
  }

  function setStatusTitle(title) {
    statusBox.hidden = false;
    statusTitle.textContent = title;
  }

  function statusLabel(status) {
    if (status === 'ok') return 'ok';
    if (status === 'blocked') return 'blockiert';
    if (status === 'partial') return 'teilweise';
    if (status === 'failed') return 'fehler';
    return status || 'offen';
  }

  function formatTextLength(value) {
    const length = Number(value) || 0;
    return `${length.toLocaleString('de-DE')} Zeichen`;
  }

  function formatDate(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value));
    } catch {
      return value;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
});
