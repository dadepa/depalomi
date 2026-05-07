document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('immoscoutForm');
  if (!form) return;

  const authBox = document.getElementById('immoscoutAuth');
  const captureTool = document.getElementById('immoscoutCaptureTool');
  const bookmarkletLink = document.getElementById('immoscoutBookmarklet');
  const copyBookmarklet = document.getElementById('immoscoutCopyBookmarklet');
  const exportCaptures = document.getElementById('immoscoutExportCaptures');
  const refreshCaptures = document.getElementById('immoscoutRefreshCaptures');
  const clearCaptures = document.getElementById('immoscoutClearCaptures');
  const capturePaste = document.getElementById('immoscoutCapturePaste');
  const importCapture = document.getElementById('immoscoutImportCapture');
  const capturesBody = document.getElementById('immoscoutCaptures');
  const textarea = document.getElementById('immoscoutUrls');
  const submit = document.getElementById('immoscoutSubmit');
  const serverExport = document.getElementById('immoscoutServerExport');
  const sample = document.getElementById('immoscoutSample');
  const statusBox = document.getElementById('immoscoutStatus');
  const statusTitle = document.getElementById('immoscoutStatusTitle');
  const resultsBody = document.getElementById('immoscoutResults');
  const downloadLink = document.getElementById('immoscoutDownload');

  const sampleUrl = 'https://www.immobilienscout24.de/expose/167403944?referrer=HYBRID_VIEW_LISTING&searchId=761baa5c-d17b-3d16-89d8-384c3e0620ba&searchType=district&fairPrice=FAIR_OFFER#/';
  const queueKey = 'dpImmoscoutUrlQueue';
  const captureWindowName = 'dp-immoscout-capture';
  let bookmarklet = '';

  checkAuth();

  sample.addEventListener('click', () => {
    textarea.value = textarea.value.trim()
      ? `${textarea.value.trim()}\n${sampleUrl}`
      : sampleUrl;
    textarea.focus();
  });

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
    showStatus('Capture-Export läuft ...', []);
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

      showStatus('Capture-Export fertig', data.items || []);
      downloadLink.href = data.downloadUrl;
      downloadLink.hidden = false;
      window.location.href = data.downloadUrl;
    } catch (err) {
      showStatus(err.message || 'Capture-Export fehlgeschlagen', []);
    } finally {
      setCaptureBusy(false);
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const urls = parseUrls(textarea.value);
    if (!urls.length) {
      showStatus('Bitte mindestens eine ImmoScout-URL einfügen.', []);
      return;
    }

    saveQueue({ urls, index: 0, startedAt: new Date().toISOString() });
    const captureWindow = window.open(urls[0], captureWindowName);
    if (captureWindow) {
      captureWindow.focus();
      showStatus(`URL 1 von ${urls.length} wurde in einem zweiten Tab geöffnet.`, []);
    } else {
      showStatus('Pop-up blockiert. Bitte Pop-ups für diese Seite erlauben und erneut starten.', []);
    }
  });

  serverExport.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) {
      showStatus('Bitte mindestens eine URL einfügen.', []);
      return;
    }

    setUrlBusy(true);
    showStatus('Export läuft ...', []);
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');

    try {
      const response = await fetch('/api/immoscout/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Export fehlgeschlagen');

      showStatus('Export fertig', data.items || []);
      downloadLink.href = data.downloadUrl;
      downloadLink.hidden = false;
      window.location.href = data.downloadUrl;
    } catch (err) {
      showStatus(err.message || 'Export fehlgeschlagen', []);
    } finally {
      setUrlBusy(false);
    }
  });

  async function checkAuth() {
    try {
      const response = await fetch('/api/admin/me');
      const data = await response.json();
      const authenticated = Boolean(data.authenticated);
      form.hidden = !authenticated;
      captureTool.hidden = !authenticated;
      authBox.hidden = authenticated;
      if (authenticated) {
        await loadCaptures();
        resumeQueueIfNeeded();
      }
    } catch {
      form.hidden = true;
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
    const code = `(async()=>{const m=location.href.match(/\\/expose\\/(\\d+)/),id=m&&m[1],pu=id?location.origin+"/expose/"+id+"/print":"";let pt="",ph="",pw=null,printed=false,closed=false;if(pu){try{pw=open(pu,"_blank")}catch(_){ }try{const pr=await fetch(pu,{credentials:"include"}),h=await pr.text(),d2=new DOMParser().parseFromString(h,"text/html");ph=d2.title||"";pt=d2.body?d2.body.innerText:""}catch(_){}}const cp=()=>{if(closed||!pw)return;closed=true;setTimeout(()=>{try{pw&&!pw.closed&&pw.close()}catch(_){ }},900)};const dop=()=>{if(printed||!pw)return;printed=true;try{pw.addEventListener("afterprint",cp,{once:true});pw.onafterprint=cp}catch(_){ }try{pw.document.title=id||"immoscout";pw.focus();pw.print()}catch(_){ }setTimeout(cp,30000)};try{pw&&pw.addEventListener("load",dop,{once:true});setTimeout(dop,1800)}catch(_){ }const p={url:location.href,title:document.title,text:document.body?document.body.innerText:"",printUrl:pu,printTitle:ph,printText:pt};const b=JSON.stringify(p);try{const r=await fetch(${JSON.stringify(endpoint)}+"?token="+${JSON.stringify(token)},{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:b});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));location.href=${JSON.stringify(returnUrl)}+"&captured="+encodeURIComponent(d.id||id||"")}catch(e){p.captureToken=${JSON.stringify(token)};const f=JSON.stringify(p);try{await navigator.clipboard.writeText(f);alert("Direktimport blockiert. Capture wurde kopiert; im Tool einfügen.")}catch(_){prompt("Capture kopieren und im Tool einfügen:",f)}location.href=${JSON.stringify(returnUrl)}+"&manual=1"}})()`;
    return `javascript:${code}`;
  }

  function resumeQueueIfNeeded() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('captureReturn')) return;

    const queue = readQueue();
    const captured = params.get('captured');
    const manual = params.get('manual');
    const cleanUrl = `${window.location.origin}/immoscout-tool/`;
    history.replaceState(null, '', cleanUrl);

    if (!queue || !Array.isArray(queue.urls) || !queue.urls.length) {
      setStatusTitle(captured ? `Capture ${captured} gespeichert` : 'Zurück im Tool');
      loadCaptures();
      return;
    }

    if (captured) {
      queue.index = Math.min((Number(queue.index) || 0) + 1, queue.urls.length);
      saveQueue(queue);
    }

    if (manual) {
      setStatusTitle('Capture wurde kopiert');
      return;
    }

    if (queue.index >= queue.urls.length) {
      clearQueue();
      loadCaptures();
      showStatus(`Alle ${queue.urls.length} URLs gesammelt`, []);
      return;
    }

    const nextIndex = Number(queue.index) || 0;
    showStatus(`Öffne URL ${nextIndex + 1} von ${queue.urls.length} ...`, []);
    setTimeout(() => {
      window.location.href = queue.urls[nextIndex];
    }, 900);
  }

  function parseUrls(value) {
    const seen = new Set();
    return (String(value).match(/https?:\/\/[^\s<>"']+/gi) || [])
      .map(url => url.replace(/[),.;]+$/g, ''))
      .filter(url => {
        try {
          const parsed = new URL(url);
          const ok = /(^|\.)immobilienscout24\.de$/i.test(parsed.hostname) &&
            /\/expose\/\d{6,14}/i.test(parsed.pathname);
          if (!ok || seen.has(parsed.href)) return false;
          seen.add(parsed.href);
          return true;
        } catch {
          return false;
        }
      });
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(queueKey) || 'null');
    } catch {
      return null;
    }
  }

  function saveQueue(queue) {
    localStorage.setItem(queueKey, JSON.stringify(queue));
  }

  function clearQueue() {
    localStorage.removeItem(queueKey);
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

  function setUrlBusy(isBusy) {
    submit.disabled = isBusy;
    serverExport.disabled = isBusy;
    sample.disabled = isBusy;
    textarea.disabled = isBusy;
    submit.textContent = isBusy ? 'Lauf startet ...' : 'Automatisch sammeln';
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
      tr.innerHTML = '<td colspan="4">Noch keine Ergebnisse.</td>';
      resultsBody.appendChild(tr);
      return;
    }

    for (const item of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.id || '')}</td>
        <td><span class="status-pill ${item.pdf ? 'ok' : 'empty'}">${item.pdf ? escapeHtml(item.pdf) : 'leer'}</span></td>
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
