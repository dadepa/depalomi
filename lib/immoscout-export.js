import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const COLUMNS = [
  'Kennung',
  'Anbieter',
  'Monat',
  'Art',
  'Ort',
  'Ortteil',
  'Straße',
  'WohnFL',
  'GewerbeFL',
  'sonst.FL',
  'KP',
  'IST Mieteinnahmen',
  'Kaufpreisfaktor IST',
  'Kaufpreis pro m²',
  'BJ',
  'Zustand',
  'Bemerkungen',
  'Provision',
];

const MAX_URLS = 20;
const CHROME_TIMEOUT_MS = Number(process.env.IMMOSCOUT_CHROME_TIMEOUT_MS) || 30000;
const CHROME_WAIT_MS = Number(process.env.IMMOSCOUT_CHROME_WAIT_MS) || 14000;
const MAX_DOM_BYTES = 18 * 1024 * 1024;

const FIELD_LABELS = {
  'Anbieter': ['Anbieter', 'Ansprechperson', 'Ansprechpartner', 'Kontaktperson', 'Firma'],
  'Ortteil': ['Ortsteil', 'Stadtteil', 'Lage'],
  'Straße': ['Straße', 'Strasse', 'Adresse'],
  'WohnFL': ['WohnFL', 'Wohnfläche', 'Wohnflaeche', 'Wohnfläche ca.', 'Wohnfl.'],
  'GewerbeFL': ['GewerbeFL', 'Gewerbefläche', 'Gewerbeflaeche', 'Gewerbefl.', 'Ladenfläche', 'Bürofläche'],
  'sonst.FL': ['sonst.FL', 'Sonstige Fläche', 'Nutzfläche', 'Gesamtfläche', 'Grundstücksfläche'],
  'KP': ['KP', 'Kaufpreis', 'Preis', 'Gesamtkaufpreis'],
  'IST Mieteinnahmen': ['IST Mieteinnahmen', 'Ist-Miete', 'Ist Miete', 'Mieteinnahmen p.a.', 'Mieteinnahmen', 'Jahresnettokaltmiete', 'Nettokaltmiete'],
  'Kaufpreisfaktor IST': ['Kaufpreisfaktor IST', 'Faktor', 'Kaufpreisfaktor', 'Vervielfältiger'],
  'Kaufpreis pro m²': ['Kaufpreis pro m²', 'Preis/m²', 'Preis pro m²', 'Preis pro qm', 'Kaufpreis/m²'],
  'BJ': ['BJ', 'Baujahr'],
  'Zustand': ['Zustand', 'Objektzustand', 'Bauzustand'],
  'Bemerkungen': ['Bemerkungen', 'Beschreibung', 'Objektbeschreibung', 'Sonstiges'],
  'Provision': ['Provision', 'Käuferprovision', 'Provision für Käufer', 'Maklerprovision'],
};

const FIELD_PATTERNS = {
  'WohnFL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'GewerbeFL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'sonst.FL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'KP': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)|Preis auf Anfrage)/i,
  'IST Mieteinnahmen': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)(?:\s*(?:p\.a\.|pro Jahr|jährlich))?)/i,
  'Kaufpreisfaktor IST': /(\d{1,3}(?:[,.]\d{1,2})?)/i,
  'Kaufpreis pro m²': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)\s*(?:\/|pro)?\s*(?:m²|m2|qm))/i,
  'BJ': /\b(1[89]\d{2}|20\d{2})\b/,
};

export async function createImmoscoutExport({ input, runsDir }) {
  const items = parseImmoscoutInput(input);
  const chromePath = await findChromeExecutable();
  if (!chromePath) {
    throw httpError(
      500,
      'Chrome konnte nicht gefunden werden. Setze CHROME_PATH auf den Chrome/Chromium-Pfad.'
    );
  }

  const runId = generateRunId();
  const runDir = path.join(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const profile = await prepareChromeProfile();
  const rows = [];
  const results = [];
  const pdfEntries = [];

  try {
    for (const item of items) {
      const processed = await processImmoscoutItem({
        item,
        runDir,
        chromePath,
        profileDir: profile.dir,
      });
      rows.push(processed.row);
      results.push(processed.result);
      if (processed.pdfPath) {
        pdfEntries.push({
          name: `${item.id}.pdf`,
          data: await readFile(processed.pdfPath),
        });
      }
    }
  } finally {
    if (profile.cleanup) {
      await rm(profile.dir, { recursive: true, force: true });
    }
  }

  const xlsx = createXlsx(rows, COLUMNS);
  const notes = createNotes(items, results);
  const zip = createZip([
    { name: 'immoscout-export.xlsx', data: xlsx },
    ...pdfEntries,
    { name: 'hinweise.txt', data: Buffer.from(notes, 'utf-8') },
  ]);

  const zipFilename = `immoscout-export-${runId}.zip`;
  const zipPath = path.join(runDir, 'immoscout-export.zip');
  await writeFile(zipPath, zip);

  return {
    runId,
    zipFilename,
    downloadUrl: `/api/immoscout/export/${runId}/download`,
    items: results,
  };
}

export function normalizeImmoscoutCapturePayload(input) {
  const url = normalizeImmoscoutUrl(input?.url);
  const id = getImmoscoutId(url);
  if (!id) {
    throw httpError(400, 'Keine ImmoScout-Expose-ID in der Capture-URL gefunden.');
  }

  const text = normalizeCaptureText(input?.text);
  if (text.length < 40) {
    throw httpError(400, 'Der Capture-Text ist zu kurz.');
  }

  return {
    id,
    url,
    title: normalizeCell(input?.title).slice(0, 300),
    text,
    printUrl: normalizeOptionalPrintUrl(input?.printUrl, id),
    printTitle: normalizeCell(input?.printTitle).slice(0, 300),
    printText: normalizeCaptureText(input?.printText),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function createImmoscoutCaptureArchive({ captures, runsDir }) {
  const items = Array.isArray(captures) ? captures : [];
  if (!items.length) {
    throw httpError(400, 'Keine Browser-Captures vorhanden.');
  }

  const chromePath = await findChromeExecutable();
  if (!chromePath) {
    throw httpError(
      500,
      'Chrome konnte nicht gefunden werden. Setze CHROME_PATH auf den Chrome/Chromium-Pfad.'
    );
  }

  const runId = generateRunId();
  const runDir = path.join(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const profile = await prepareChromeProfile();
  const rows = [];
  const results = [];
  const pdfEntries = [];

  try {
    for (const capture of items) {
      const processed = await processCapturedItem({
        capture,
        runDir,
        chromePath,
        profileDir: profile.dir,
      });
      rows.push(processed.row);
      results.push(processed.result);
      if (processed.pdfPath) {
        pdfEntries.push({
          name: `${capture.id}.pdf`,
          data: await readFile(processed.pdfPath),
        });
      }
    }
  } finally {
    if (profile.cleanup) {
      await rm(profile.dir, { recursive: true, force: true });
    }
  }

  const xlsx = createXlsx(rows, COLUMNS);
  const notes = createNotes(items, results, 'Browser-Capture Export');
  const zip = createZip([
    { name: 'immoscout-export.xlsx', data: xlsx },
    ...pdfEntries,
    { name: 'hinweise.txt', data: Buffer.from(notes, 'utf-8') },
  ]);

  const zipFilename = `immoscout-browser-export-${runId}.zip`;
  const zipPath = path.join(runDir, 'immoscout-export.zip');
  await writeFile(zipPath, zip);

  return {
    runId,
    zipFilename,
    downloadUrl: `/api/immoscout/export/${runId}/download`,
    items: results,
  };
}

function parseImmoscoutInput(input) {
  const rawValues = [];
  if (Array.isArray(input?.urls)) {
    rawValues.push(...input.urls);
  }
  if (typeof input?.text === 'string') {
    rawValues.push(...extractUrlsFromText(input.text));
  }
  if (typeof input?.urlsText === 'string') {
    rawValues.push(...extractUrlsFromText(input.urlsText));
  }

  const seen = new Set();
  const items = [];
  const errors = [];

  for (const raw of rawValues) {
    const value = String(raw || '').trim().replace(/[),.;]+$/g, '');
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('nur http/https');
      }
      if (!/(^|\.)immobilienscout24\.de$/i.test(url.hostname)) {
        throw new Error('keine immobilienscout24.de URL');
      }
      const id = extractImmoscoutId(url);
      if (!id) throw new Error('keine Expose-ID gefunden');
      if (seen.has(id)) continue;
      seen.add(id);
      url.hash = '';
      items.push({ id, url: url.toString() });
    } catch (err) {
      errors.push(`${value}: ${err.message}`);
    }
  }

  if (items.length === 0) {
    const suffix = errors.length ? ` (${errors.slice(0, 3).join('; ')})` : '';
    throw httpError(400, `Keine gültige ImmoScout-Expose-URL gefunden.${suffix}`);
  }
  if (items.length > MAX_URLS) {
    throw httpError(400, `Bitte maximal ${MAX_URLS} URLs pro Export übergeben.`);
  }

  return items;
}

function normalizeImmoscoutUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw httpError(400, 'Ungültige ImmoScout-URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw httpError(400, 'Nur http/https URLs sind erlaubt.');
  }
  if (!/(^|\.)immobilienscout24\.de$/i.test(url.hostname)) {
    throw httpError(400, 'Die URL muss von immobilienscout24.de kommen.');
  }
  url.hash = '';
  return url.toString();
}

function getImmoscoutId(value) {
  try {
    return extractImmoscoutId(new URL(value));
  } catch {
    return '';
  }
}

function normalizeCaptureText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 220000);
}

function normalizeOptionalPrintUrl(value, id) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (!/(^|\.)immobilienscout24\.de$/i.test(url.hostname)) return '';
    if (!new RegExp(`/expose/${id}/print/?$`, 'i').test(url.pathname)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function extractUrlsFromText(text) {
  return String(text).match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function extractImmoscoutId(url) {
  const match = `${url.pathname}${url.search}`.match(/(?:^|\/)expose\/(\d{6,14})(?:[/?#]|$)/i);
  return match ? match[1] : null;
}

async function processImmoscoutItem({ item, runDir, chromePath, profileDir }) {
  const row = createEmptyRow(item.id);
  const result = {
    id: item.id,
    url: item.url,
    status: 'pending',
    pdf: '',
    message: '',
  };

  let html = '';
  try {
    html = await dumpDomWithChrome(chromePath, profileDir, item.url);
  } catch (err) {
    result.status = 'failed';
    result.message = `Seite konnte nicht geladen werden: ${err.message}`;
    return { row, result, pdfPath: null };
  }

  if (isBlockedImmoscoutPage(html)) {
    result.status = 'blocked';
    result.message = 'ImmoScout-Schutzseite/Captcha erkannt. Keine Inseratsdaten extrahiert.';
    return { row, result, pdfPath: null };
  }

  const visibleText = extractVisibleText(html);
  const heuristicData = extractListingData(html, visibleText, item);
  mergeRow(row, heuristicData);

  if (process.env.OPENAI_API_KEY && visibleText.length > 200) {
    try {
      const aiData = await extractWithOpenAI(visibleText, item);
      mergeRow(row, aiData);
    } catch (err) {
      result.message = `OpenAI-Extraktion übersprungen: ${err.message}`;
    }
  }

  const pdfPath = path.join(runDir, `${item.id}.pdf`);
  try {
    await printPdfWithChrome(chromePath, profileDir, item.url, pdfPath);
    const pdfStat = await stat(pdfPath);
    if (pdfStat.size <= 0) throw new Error('PDF ist leer');
    result.pdf = `${item.id}.pdf`;
    result.status = result.message ? 'partial' : 'ok';
    if (!result.message) result.message = 'Export erstellt.';
    return { row, result, pdfPath };
  } catch (err) {
    result.status = 'partial';
    result.message = `Daten extrahiert, aber PDF konnte nicht erstellt werden: ${err.message}`;
    try { await unlink(pdfPath); } catch { /* ignore */ }
    return { row, result, pdfPath: null };
  }
}

async function processCapturedItem({ capture, runDir, chromePath, profileDir }) {
  const row = createEmptyRow(capture.id);
  const result = {
    id: capture.id,
    url: capture.url,
    status: 'pending',
    pdf: '',
    message: '',
  };

  const visibleText = normalizeCaptureText(`${capture.text || ''}\n${capture.printText || ''}`);
  const heuristicData = extractListingData('', visibleText, capture);
  mergeRow(row, heuristicData);

  if (process.env.OPENAI_API_KEY && visibleText.length > 200) {
    try {
      const aiData = await extractWithOpenAI(visibleText, capture);
      mergeRow(row, aiData);
    } catch (err) {
      result.message = `OpenAI-Extraktion übersprungen: ${err.message}`;
    }
  }

  const htmlPath = path.join(runDir, `${capture.id}.html`);
  const pdfPath = path.join(runDir, `${capture.id}.pdf`);
  await writeFile(htmlPath, renderCapturePdfHtml(capture, row), 'utf-8');

  try {
    await printPdfWithChrome(chromePath, profileDir, pathToFileURL(htmlPath).href, pdfPath);
    const pdfStat = await stat(pdfPath);
    if (pdfStat.size <= 0) throw new Error('PDF ist leer');
    result.pdf = `${capture.id}.pdf`;
    result.status = result.message ? 'partial' : 'ok';
    if (!result.message) result.message = 'Browser-Capture exportiert.';
    return { row, result, pdfPath };
  } catch (err) {
    try {
      await writeFile(pdfPath, createCaptureTextPdf(capture, row));
      result.pdf = `${capture.id}.pdf`;
      result.status = result.message ? 'partial' : 'ok';
      result.message = result.message
        ? `${result.message}; PDF-Fallback erstellt.`
        : 'Browser-Capture exportiert (PDF-Fallback).';
      return { row, result, pdfPath };
    } catch (fallbackErr) {
      result.status = 'partial';
      result.message = `Excel erstellt, aber PDF konnte nicht erzeugt werden: ${err.message}; Fallback: ${fallbackErr.message}`;
      try { await unlink(pdfPath); } catch { /* ignore */ }
      return { row, result, pdfPath: null };
    }
  }
}

function renderCapturePdfHtml(capture, row) {
  const metaRows = COLUMNS
    .filter(column => column !== 'Kennung')
    .map(column => `<tr><th>${htmlEscape(column)}</th><td>${htmlEscape(row[column] || '')}</td></tr>`)
    .join('');
  const sourceText = capture.printText || capture.text;
  const text = normalizeCaptureText(sourceText)
    .split('\n')
    .slice(0, 1200)
    .map(line => `<p>${htmlEscape(line)}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"/>
  <title>${htmlEscape(capture.id)} - ImmoScout Capture</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:Arial,sans-serif;color:#111827;margin:32px;line-height:1.45}
    h1{font-size:26px;margin:0 0 8px}
    h2{font-size:15px;margin:28px 0 12px;text-transform:uppercase;letter-spacing:.08em;color:#475569}
    .muted{color:#64748b;font-size:12px;margin:0 0 4px;word-break:break-all}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border:1px solid #d7dce2;padding:8px 10px;text-align:left;vertical-align:top;font-size:12px}
    th{width:190px;background:#f4f6f8;color:#475569}
    p{font-size:12px;margin:0 0 6px;break-inside:avoid}
  </style>
</head>
<body>
  <p class="muted">Kennung</p>
  <h1>${htmlEscape(capture.id)}${capture.title ? ` - ${htmlEscape(capture.title)}` : ''}</h1>
  <p class="muted">${htmlEscape(capture.url)}</p>
  ${capture.printUrl ? `<p class="muted">Print: ${htmlEscape(capture.printUrl)}</p>` : ''}
  <p class="muted">Capture: ${htmlEscape(capture.updatedAt || capture.createdAt || '')}</p>
  <h2>Extrahierte Felder</h2>
  <table>${metaRows}</table>
  <h2>Seitentext</h2>
  ${text}
</body>
</html>`;
}

function createCaptureTextPdf(capture, row) {
  const lines = [
    `Kennung: ${capture.id}`,
    capture.title ? `Titel: ${capture.title}` : '',
    `URL: ${capture.url}`,
    capture.printUrl ? `Print: ${capture.printUrl}` : '',
    `Capture: ${capture.updatedAt || capture.createdAt || ''}`,
    '',
    'Extrahierte Felder',
    ...COLUMNS
      .filter(column => column !== 'Kennung')
      .map(column => `${column}: ${row[column] || ''}`),
    '',
    'Seitentext',
    ...normalizeCaptureText(capture.printText || capture.text).split('\n').slice(0, 1200),
  ].filter(line => line !== null && line !== undefined);

  return createSimplePdf(lines);
}

function createSimplePdf(rawLines) {
  const pageWidth = 595;
  const pageHeight = 842;
  const marginLeft = 46;
  const startY = 800;
  const lineHeight = 13;
  const maxLinesPerPage = 56;
  const wrapped = [];

  for (const raw of rawLines) {
    const line = pdfPlainText(raw);
    if (!line) {
      wrapped.push('');
      continue;
    }
    wrapped.push(...wrapPdfLine(line, 92));
  }

  const pages = [];
  for (let i = 0; i < wrapped.length; i += maxLinesPerPage) {
    pages.push(wrapped.slice(i, i + maxLinesPerPage));
  }
  if (!pages.length) pages.push(['']);

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const kids = [];
  pages.forEach((pageLines, idx) => {
    const pageObj = 4 + idx * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const content = createPdfPageContent(pageLines, marginLeft, startY, lineHeight);
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });

  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

function createPdfPageContent(lines, x, y, lineHeight) {
  const commands = [
    'BT',
    '/F1 10 Tf',
    `${lineHeight} TL`,
    `${x} ${y} Td`,
  ];

  lines.forEach((line, idx) => {
    if (idx > 0) commands.push('T*');
    commands.push(`(${pdfEscape(line)}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

function wrapPdfLine(line, maxLength) {
  const words = String(line).split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLength) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.length > maxLength ? word.slice(0, maxLength) : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function pdfPlainText(value) {
  return String(value ?? '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/€/g, 'EUR')
    .replace(/²/g, '2')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .trim();
}

function pdfEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

async function prepareChromeProfile() {
  if (process.env.IMMOSCOUT_CHROME_PROFILE_DIR) {
    await mkdir(process.env.IMMOSCOUT_CHROME_PROFILE_DIR, { recursive: true });
    return { dir: process.env.IMMOSCOUT_CHROME_PROFILE_DIR, cleanup: false };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'dp-immoscout-chrome-'));
  return { dir, cleanup: true };
}

async function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next path
    }
  }
  return null;
}

async function dumpDomWithChrome(chromePath, profileDir, url) {
  const { stdout } = await runChromeWithRetry(chromePath, profileDir, [
    `--virtual-time-budget=${CHROME_WAIT_MS}`,
    '--dump-dom',
    url,
  ]);
  return stdout;
}

async function printPdfWithChrome(chromePath, profileDir, url, pdfPath) {
  try { await unlink(pdfPath); } catch { /* ignore */ }
  try {
    await runChrome(chromePath, profileDir, [
      `--virtual-time-budget=${CHROME_WAIT_MS}`,
      '--print-to-pdf-no-header',
      `--print-to-pdf=${pdfPath}`,
      url,
    ], { timeoutMs: 16000 });
  } catch (err) {
    if (/Zeitlimit|timeout/i.test(err.message)) {
      try {
        const pdfStat = await stat(pdfPath);
        if (pdfStat.size > 0) return;
      } catch {
        // throw the original timeout below
      }
    }
    throw err;
  }
}

async function runChromeWithRetry(chromePath, profileDir, args) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runChrome(chromePath, profileDir, args);
    } catch (err) {
      lastError = err;
      if (!/Zeitlimit|timeout/i.test(err.message)) break;
    }
  }
  throw lastError;
}

function runChrome(chromePath, profileDir, extraArgs, options = {}) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-sync',
    '--disable-features=MediaRouter,OptimizationGuideModelDownloading,OptimizationHintsFetching,Translate',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1440,1800',
    `--user-data-dir=${profileDir}`,
  ];

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    args.push('--no-sandbox');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(chromePath, [...args, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || CHROME_TIMEOUT_MS);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_DOM_BYTES) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return reject(new Error('Chrome-Zeitlimit erreicht'));
      if (code !== 0) {
        return reject(new Error(cleanChromeError(stderr) || `Chrome beendet mit Code ${code}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanChromeError(stderr) {
  return String(stderr || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/DevTools listening|Created TensorFlow|WARNING|ERROR:CONSOLE/i.test(line))
    .slice(-3)
    .join(' ');
}

function createEmptyRow(id) {
  return Object.fromEntries(COLUMNS.map(column => [column, column === 'Kennung' ? id : '']));
}

function mergeRow(row, data) {
  for (const column of COLUMNS) {
    if (column === 'Kennung') continue;
    const value = normalizeCell(data?.[column]);
    if (value) row[column] = value;
  }
}

function normalizeCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([€])/g, ' $1')
    .trim()
    .slice(0, 500);
}

function isBlockedImmoscoutPage(html) {
  return /Ich bin kein Roboter|Gleich geht.?s weiter|awswaf|captcha|robot-logo/i.test(html);
}

function extractListingData(html, visibleText, item) {
  const data = {};
  const lines = visibleText
    .split('\n')
    .map(line => normalizeCell(line))
    .filter(Boolean);
  const meta = extractMeta(html);
  const jsonLdData = extractJsonLdData(html);

  mergePlain(data, jsonLdData);

  const titleText = [meta.title, meta.description, visibleText.slice(0, 5000)].filter(Boolean).join('\n');
  data.Art ||= detectArt(pickValue(lines, ['Objektart', 'Immobilienart', 'Haustyp', 'Kategorie']) || titleText);

  for (const [field, labels] of Object.entries(FIELD_LABELS)) {
    data[field] ||= pickValue(lines, labels, FIELD_PATTERNS[field]);
  }

  const addressData = extractAddress(lines, jsonLdData);
  mergePlain(data, addressData);

  data.Kennung = item.id;
  return data;
}

function mergePlain(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && !target[key]) target[key] = value;
  }
}

function extractMeta(html) {
  return {
    title: getMetaContent(html, 'og:title') || extractTagText(html, 'title'),
    description: getMetaContent(html, 'description') || getMetaContent(html, 'og:description'),
  };
}

function getMetaContent(html, name) {
  const escaped = escapeRegExp(name);
  const re = new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i');
  const reverse = new RegExp(`<meta\\s+[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
  const match = html.match(re) || html.match(reverse);
  return match ? decodeHtml(match[1]) : '';
}

function extractTagText(html, tag) {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeHtml(stripTags(match[1])) : '';
}

function extractJsonLdData(html) {
  const data = {};
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(decodeHtml(script[1]).trim());
      collectJsonLd(parsed, data);
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return data;
}

function collectJsonLd(node, data) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(item => collectJsonLd(item, data));
    return;
  }

  if (node.name && !data.Art) data.Art = detectArt(String(node.name));
  if (node.description && !data.Zustand) data.Zustand = pickCondition(String(node.description));

  const address = node.address;
  if (address && typeof address === 'object') {
    data.Ort ||= normalizeCell(address.addressLocality);
    data['Straße'] ||= normalizeCell(address.streetAddress);
  }

  const floorSize = node.floorSize || node.floorSizeValue;
  if (floorSize && !data.WohnFL) {
    data.WohnFL = typeof floorSize === 'object'
      ? normalizeCell(`${floorSize.value || ''} ${floorSize.unitText || 'm²'}`)
      : normalizeCell(floorSize);
  }

  const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  if (offers && typeof offers === 'object' && offers.price && !data.KP) {
    data.KP = normalizeCell(`${offers.price} ${offers.priceCurrency || 'EUR'}`);
  }

  for (const value of Object.values(node)) {
    collectJsonLd(value, data);
  }
}

function pickCondition(text) {
  const match = String(text).match(/(neubau|gepflegt|modernisiert|renoviert|sanierungsbedürftig|saniert|projektiert|erstbezug)/i);
  return match ? normalizeCondition(match[1]) : '';
}

function normalizeCondition(value) {
  const v = String(value).toLowerCase();
  if (v.includes('sanierungs')) return 'Sanierungsbedürftig';
  if (v.includes('neubau')) return 'Neubau';
  if (v.includes('gepflegt')) return 'Gepflegt';
  if (v.includes('modern')) return 'Modernisiert';
  if (v.includes('renov')) return 'Renoviert';
  if (v.includes('erstbezug')) return 'Erstbezug';
  if (v.includes('saniert')) return 'Saniert';
  return normalizeCell(value);
}

function pickValue(lines, labels, pattern) {
  const normalizedLabels = labels.map(label => normalizeForCompare(label));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const comparable = normalizeForCompare(line);
    const labelIndex = normalizedLabels.findIndex(label => comparable === label || comparable.includes(label));
    if (labelIndex === -1) continue;

    const rawLabel = labels[labelIndex];
    const candidates = [];
    const sameLine = line
      .replace(new RegExp(escapeRegExp(rawLabel), 'i'), '')
      .replace(/^[:\-\s]+|[:\-\s]+$/g, '');
    if (sameLine) candidates.push(sameLine);
    if (i + 1 < lines.length) candidates.push(lines[i + 1]);
    if (i + 2 < lines.length) candidates.push(lines[i + 2]);
    if (i > 0) candidates.push(lines[i - 1]);

    for (const candidate of candidates) {
      const value = cleanCandidate(candidate, pattern);
      if (value) return value;
    }
  }

  return '';
}

function cleanCandidate(candidate, pattern) {
  const value = normalizeCell(candidate);
  if (!value || value.length > 160) return '';
  if (isLikelyLabel(value)) return '';
  if (pattern) {
    const match = value.match(pattern);
    return match ? normalizeCell(match[1] || match[0]) : '';
  }
  return value;
}

function isLikelyLabel(value) {
  const cmp = normalizeForCompare(value);
  return Object.values(FIELD_LABELS).flat().some(label => cmp === normalizeForCompare(label));
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9€]+/g, ' ')
    .trim();
}

function detectArt(text) {
  const value = String(text || '');
  if (/wohn\s*[-/&und]+\s*geschäftshaus|wohn.?und.?geschaeftshaus|wgh/i.test(value)) return 'WGH';
  if (/mehrfamilienhaus|\bmfh\b/i.test(value)) return 'MFH';
  if (/zweifamilienhaus|\bzfh\b/i.test(value)) return 'ZFH';
  if (/einfamilienhaus|\befh\b/i.test(value)) return 'EFH';
  if (/reihenhaus/i.test(value)) return 'RH';
  if (/doppelhaushälfte|doppelhaushaelfte/i.test(value)) return 'DHH';
  if (/geschäftshaus|geschaeftshaus/i.test(value)) return 'GH';

  const direct = pickValue(
    value.split('\n').map(line => normalizeCell(line)).filter(Boolean),
    ['Objektart', 'Immobilienart', 'Haustyp', 'Kategorie']
  );
  return direct || '';
}

function extractAddress(lines, jsonLdData) {
  const data = {};
  data.Ort ||= jsonLdData.Ort || '';
  data['Straße'] ||= jsonLdData['Straße'] || '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const zipMatch = line.match(/\b\d{5}\s+([A-ZÄÖÜ][\p{L} .'-]{2,80})/u);
    if (zipMatch && !data.Ort) {
      data.Ort = normalizeCell(zipMatch[1].replace(/Deutschland.*$/i, ''));
    }

    if (!data['Ortteil'] && /stadtteil|ortsteil/i.test(line)) {
      data['Ortteil'] = pickValue(lines.slice(Math.max(0, i - 1), i + 3), ['Stadtteil', 'Ortsteil', 'Lage']);
    }

    if (!data['Straße'] && /(straße|strasse|str\.|weg|allee|platz|ring|damm|gasse|chaussee|ufer)\b/i.test(line)) {
      data['Straße'] = normalizeCell(line.replace(/\b\d{5}\b.*$/, ''));
    }
  }

  for (const line of lines.slice(0, 80)) {
    if (!data['Ortteil']) {
      const districtMatch = line.match(/^([\p{L} .'-]{2,60}),\s*([A-ZÄÖÜ][\p{L} .'-]{2,60})$/u);
      if (districtMatch) {
        data['Ortteil'] = normalizeCell(districtMatch[1]);
        data.Ort ||= normalizeCell(districtMatch[2]);
      }
    }
  }

  return data;
}

function extractVisibleText(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|li|tr|td|dt|dd|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

async function extractWithOpenAI(visibleText, item) {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const prompt = [
    `ImmoScout Expose-ID: ${item.id}`,
    `URL: ${item.url}`,
    '',
    'Extrahiere die folgenden Spalten aus dem sichtbaren Inseratstext.',
    'Wenn ein Wert nicht eindeutig vorhanden ist, verwende einen leeren String.',
    'Antworte ausschließlich als JSON-Objekt mit exakt diesen Keys:',
    COLUMNS.map(column => `"${column}"`).join(', '),
    '',
    visibleText.slice(0, 18000),
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Du bist ein präziser deutscher Immobilien-Datenextraktor. Du erfindest keine Werte.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('leere OpenAI-Antwort');

  const parsed = JSON.parse(content);
  const clean = {};
  for (const column of COLUMNS) {
    clean[column] = normalizeCell(parsed[column]);
  }
  clean.Kennung = item.id;
  return clean;
}

function createXlsx(rows, columns) {
  const worksheetRows = [columns, ...rows.map(row => columns.map(column => row[column] || ''))];
  const sheetData = worksheetRows.map((cells, rowIdx) => {
    const rowNum = rowIdx + 1;
    const xmlCells = cells.map((cell, colIdx) => {
      const ref = `${columnName(colIdx + 1)}${rowNum}`;
      const style = rowIdx === 0 ? ' s="1"' : '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(cell)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNum}">${xmlCells}</row>`;
  }).join('');

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columns.map((_, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${idx === 0 ? 16 : 22}" customWidth="1"/>`).join('')}</cols>
  <sheetData>${sheetData}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Objekte" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf-8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf-8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf-8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(worksheet, 'utf-8') },
  ]);
}

function columnName(index) {
  let name = '';
  while (index > 0) {
    const rem = (index - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function createNotes(items, results, title = 'ImmoScout Export') {
  const lines = [
    `${title}: ${new Date().toISOString()}`,
    '',
    'Hinweis: Die Verarbeitung umgeht keine Captchas oder Schutzmechanismen. Wenn ImmoScout eine Schutzseite liefert, bleiben die Excel-Felder leer und es wird kein Inserats-PDF erzeugt.',
    '',
  ];
  for (const item of items) {
    const result = results.find(entry => entry.id === item.id);
    lines.push(`${item.id}: ${result?.status || 'unbekannt'} - ${result?.message || ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function createZip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf-8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    files.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(now.time, 12);
    cd.writeUInt16LE(now.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...files, ...central, end]);
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateRunId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
