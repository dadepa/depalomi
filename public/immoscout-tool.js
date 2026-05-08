document.addEventListener('DOMContentLoaded', () => {
  const authBox = document.getElementById('immoscoutAuth');
  const captureTool = document.getElementById('immoscoutCaptureTool');
  if (!captureTool) return;

  const copyBookmarklet = document.getElementById('immoscoutCopyBookmarklet');
  const exportCaptures = document.getElementById('immoscoutExportCaptures');
  const refreshCaptures = document.getElementById('immoscoutRefreshCaptures');
  const clearCaptures = document.getElementById('immoscoutClearCaptures');
  const capturesBody = document.getElementById('immoscoutCaptures');
  const sourcePreview = document.getElementById('immoscoutSourcePreview');
  const sourceTitle = document.getElementById('immoscoutSourceTitle');
  const sourceText = document.getElementById('immoscoutSourceText');
  const copySource = document.getElementById('immoscoutCopySource');
  const closeSource = document.getElementById('immoscoutCloseSource');
  const statusBox = document.getElementById('immoscoutStatus');
  const statusTitle = document.getElementById('immoscoutStatusTitle');
  const resultsBody = document.getElementById('immoscoutResults');
  const downloadLink = document.getElementById('immoscoutDownload');

  let bookmarklet = '';
  let exportStream = null;
  let captureIds = [];

  checkAuth();

  copyBookmarklet.addEventListener('click', async () => {
    if (!bookmarklet) return;
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setStatusTitle('Bookmarklet kopiert');
    } catch {
      setStatusTitle('Bookmarklet konnte nicht kopiert werden');
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

  capturesBody.addEventListener('click', event => {
    const button = event.target.closest('[data-source-id]');
    if (!button) return;
    showCaptureSource(button.dataset.sourceId);
  });

  copySource.addEventListener('click', async () => {
    if (!sourceText.value) return;
    try {
      await navigator.clipboard.writeText(sourceText.value);
      setStatusTitle('Quelltext kopiert');
    } catch {
      setStatusTitle('Quelltext kann im Textfeld kopiert werden');
    }
  });

  closeSource.addEventListener('click', () => {
    sourcePreview.hidden = true;
    sourceText.value = '';
  });

  exportCaptures.addEventListener('click', async () => {
    const ids = captureIds.slice();
    setCaptureBusy(true);
    showStatus('Excel-Export startet ...', []);
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');

    try {
      if (window.EventSource) {
        await exportCapturesWithProgress(ids);
      } else {
        await exportCapturesWithFetch(ids);
      }
    } catch (err) {
      showStatus(err.message || 'Excel-Export fehlgeschlagen', []);
    } finally {
      setCaptureBusy(false);
    }
  });

  function exportCapturesWithProgress(ids) {
    return new Promise(resolve => {
      if (exportStream) exportStream.close();

      const progressItems = new Map();
      const params = new URLSearchParams();
      ids.forEach(id => params.append('id', id));
      const url = `/api/immoscout/captures/export/events${params.toString() ? `?${params}` : ''}`;
      exportStream = new EventSource(url);
      let finished = false;

      const finish = () => {
        finished = true;
        if (exportStream) exportStream.close();
        exportStream = null;
        resolve();
      };

      exportStream.addEventListener('progress', event => {
        const progress = parseEventData(event);
        if (!progress) return;
        updateExportProgress(progress, progressItems);
      });

      exportStream.addEventListener('complete', event => {
        const data = parseEventData(event) || {};
        const items = data.items || Array.from(progressItems.values());
        const total = Number(data.captureCount || data.rowCount || items.length) || items.length;
        showStatus(`Excel-Export fertig: ${items.length}/${total} Objekte`, items);
        downloadLink.href = data.downloadUrl;
        downloadLink.hidden = false;
        if (data.downloadUrl) window.location.href = data.downloadUrl;
        finish();
      });

      exportStream.addEventListener('export-error', event => {
        const data = parseEventData(event) || {};
        showStatus(data.error || 'Excel-Export fehlgeschlagen', Array.from(progressItems.values()));
        finish();
      });

      exportStream.onerror = () => {
        if (finished) return;
        showStatus('Verbindung zum Export verloren', Array.from(progressItems.values()));
        finish();
      };
    });
  }

  async function exportCapturesWithFetch(ids) {
    const response = await fetch('/api/immoscout/captures/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Capture-Export fehlgeschlagen');

    const items = data.items || [];
    const total = Number(data.captureCount || data.rowCount || items.length) || items.length;
    showStatus(`Excel-Export fertig: ${items.length}/${total} Objekte`, items);
    downloadLink.href = data.downloadUrl;
    downloadLink.hidden = false;
    window.location.href = data.downloadUrl;
  }

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
      renderCaptures(data.captures || []);
      if (!(data.captures || []).length) {
        sourcePreview.hidden = true;
        sourceText.value = '';
      }
    } catch (err) {
      renderCaptures([]);
      sourcePreview.hidden = true;
      sourceText.value = '';
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
      'try{await navigator.clipboard.writeText(f);alert("Direktimport blockiert. Capture wurde in die Zwischenablage kopiert. Bitte Seite neu laden und erneut versuchen.")}catch(_){alert("Direktimport blockiert. Bitte Seite neu laden und erneut versuchen.")}',
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
      setStatusTitle('Direktimport wurde blockiert');
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
    captureIds = items.map(item => String(item.id || '')).filter(Boolean);
    exportCaptures.disabled = items.length === 0;
    clearCaptures.disabled = items.length === 0;

    if (!items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5">Keine Captures vorhanden.</td>';
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
        <td><button class="btn btn-outline source-btn" type="button" data-source-id="${escapeHtml(item.id || '')}">Quelltext</button></td>
      `;
      capturesBody.appendChild(tr);
    }
  }

  async function showCaptureSource(id) {
    if (!id) return;
    sourcePreview.hidden = false;
    sourceTitle.textContent = `Capture ${id}`;
    sourceText.value = 'Quelltext wird geladen ...';

    try {
      const response = await fetch(`/api/immoscout/captures/${encodeURIComponent(id)}/source`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Quelltext konnte nicht geladen werden');
      sourceTitle.textContent = `Capture ${data.id || id}`;
      sourceText.value = data.sourceText || '[Kein Quelltext gespeichert]';
      sourceText.focus();
    } catch (err) {
      const message = err.message || 'Quelltext konnte nicht geladen werden';
      sourceText.value = `Fehler: ${message}\n\nBitte Seite neu laden und erneut versuchen. Wenn das bleibt, ist der Backend-Endpunkt noch nicht deployed oder der Capture wurde nicht gefunden.`;
      setStatusTitle(message);
    }
  }

  function setCaptureBusy(isBusy) {
    if (!isBusy && exportStream) {
      exportStream.close();
      exportStream = null;
    }
    exportCaptures.disabled = isBusy;
    refreshCaptures.disabled = isBusy;
    clearCaptures.disabled = isBusy;
    exportCaptures.textContent = isBusy ? 'Export läuft ...' : 'Captures exportieren';
  }

  function showStatus(title, items) {
    statusBox.hidden = false;
    setStatusTitle(title);
    renderStatusItems(items);
  }

  function renderStatusItems(items) {
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
        <td><span class="status-pill ${statusClass(item.status)}">${statusLabel(item.status)}</span></td>
        <td>${escapeHtml(item.message || '')}</td>
      `;
      resultsBody.appendChild(tr);
    }
  }

  function updateExportProgress(progress, progressItems) {
    const index = Number(progress.index) || 0;
    const completed = Number(progress.completed) || 0;
    const total = Number(progress.total) || 0;
    const id = progress.id || '';

    if (progress.phase === 'start') {
      setStatusTitle(`Excel-Export startet: 0/${total} Objekte`);
      renderStatusItems(Array.from(progressItems.values()));
      return;
    }

    if (progress.phase === 'processing') {
      setStatusTitle(`Excel-Export läuft: Objekt ${index}/${total} - ID ${id}`);
      progressItems.set(id, {
        id,
        status: 'pending',
        message: `Wird verarbeitet (${index}/${total})`,
      });
      renderStatusItems(Array.from(progressItems.values()));
      return;
    }

    if (progress.phase === 'done') {
      setStatusTitle(`Excel-Export läuft: ${completed || index}/${total} Objekte fertig - ID ${id}`);
      progressItems.set(id, {
        id,
        status: progress.status || 'ok',
        message: progress.message || `Fertig (${index}/${total})`,
      });
      renderStatusItems(Array.from(progressItems.values()));
      return;
    }

    if (progress.phase === 'writing') {
      setStatusTitle(`Excel-Datei wird erstellt: ${total}/${total} Objekte`);
      renderStatusItems(Array.from(progressItems.values()));
    }
  }

  function setStatusTitle(title) {
    statusBox.hidden = false;
    statusTitle.textContent = title;
  }

  function statusLabel(status) {
    if (status === 'ok') return 'ok';
    if (status === 'pending') return 'läuft';
    if (status === 'blocked') return 'blockiert';
    if (status === 'partial') return 'teilweise';
    if (status === 'failed') return 'fehler';
    return status || 'offen';
  }

  function statusClass(status) {
    if (status === 'ok') return 'ok';
    if (status === 'pending') return 'pending';
    if (status === 'blocked' || status === 'failed') return 'blocked';
    if (status === 'empty') return 'empty';
    return 'partial';
  }

  function parseEventData(event) {
    try {
      return JSON.parse(event.data || '{}');
    } catch {
      return null;
    }
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
