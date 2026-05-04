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
  const sample = document.getElementById('immoscoutSample');
  const statusBox = document.getElementById('immoscoutStatus');
  const statusTitle = document.getElementById('immoscoutStatusTitle');
  const resultsBody = document.getElementById('immoscoutResults');
  const downloadLink = document.getElementById('immoscoutDownload');

  const sampleUrl = 'https://www.immobilienscout24.de/expose/167403944?referrer=HYBRID_VIEW_LISTING&searchId=761baa5c-d17b-3d16-89d8-384c3e0620ba&searchType=district&fairPrice=FAIR_OFFER#/';
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
      if (authenticated) await loadCaptures();
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
    const code = `(async()=>{const p={url:location.href,title:document.title,text:document.body?document.body.innerText:""};const b=JSON.stringify(p);try{const r=await fetch(${JSON.stringify(endpoint)}+"?token="+${JSON.stringify(token)},{method:"POST",mode:"cors",headers:{"Content-Type":"application/json"},body:b});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));alert("ImmoScout importiert: "+(d.id||"OK"))}catch(e){p.captureToken=${JSON.stringify(token)};const f=JSON.stringify(p);try{await navigator.clipboard.writeText(f);alert("Direktimport blockiert. Capture wurde kopiert; im Tool einfügen.")}catch(_){prompt("Capture kopieren und im Tool einfügen:",f)}}})()`;
    return `javascript:${code}`;
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
        <td>${formatTextLength(item.textLength)}</td>
        <td>${formatDate(item.updatedAt || item.createdAt)}</td>
      `;
      capturesBody.appendChild(tr);
    }
  }

  function setUrlBusy(isBusy) {
    submit.disabled = isBusy;
    sample.disabled = isBusy;
    textarea.disabled = isBusy;
    submit.textContent = isBusy ? 'Export läuft ...' : 'Export erstellen';
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
