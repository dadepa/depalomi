document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('immoscoutForm');
  if (!form) return;

  const authBox = document.getElementById('immoscoutAuth');
  const textarea = document.getElementById('immoscoutUrls');
  const submit = document.getElementById('immoscoutSubmit');
  const sample = document.getElementById('immoscoutSample');
  const statusBox = document.getElementById('immoscoutStatus');
  const statusTitle = document.getElementById('immoscoutStatusTitle');
  const resultsBody = document.getElementById('immoscoutResults');
  const downloadLink = document.getElementById('immoscoutDownload');

  const sampleUrl = 'https://www.immobilienscout24.de/expose/167403944?referrer=HYBRID_VIEW_LISTING&searchId=761baa5c-d17b-3d16-89d8-384c3e0620ba&searchType=district&fairPrice=FAIR_OFFER#/';

  checkAuth();

  sample.addEventListener('click', () => {
    textarea.value = textarea.value.trim()
      ? `${textarea.value.trim()}\n${sampleUrl}`
      : sampleUrl;
    textarea.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const text = textarea.value.trim();
    if (!text) {
      showStatus('Bitte mindestens eine URL einfügen.', []);
      return;
    }

    setBusy(true);
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
      setBusy(false);
    }
  });

  async function checkAuth() {
    try {
      const response = await fetch('/api/admin/me');
      const data = await response.json();
      const authenticated = Boolean(data.authenticated);
      form.hidden = !authenticated;
      authBox.hidden = authenticated;
    } catch {
      form.hidden = true;
      authBox.hidden = false;
    }
  }

  function setBusy(isBusy) {
    submit.disabled = isBusy;
    sample.disabled = isBusy;
    textarea.disabled = isBusy;
    submit.textContent = isBusy ? 'Export läuft ...' : 'Export erstellen';
  }

  function showStatus(title, items) {
    statusBox.hidden = false;
    statusTitle.textContent = title;
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

  function statusLabel(status) {
    if (status === 'ok') return 'ok';
    if (status === 'blocked') return 'blockiert';
    if (status === 'partial') return 'teilweise';
    if (status === 'failed') return 'fehler';
    return status || 'offen';
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
