import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

const FIELD_LABELS = {
  'Anbieter': ['Anbieter', 'Ansprechperson', 'Ansprechpartner', 'Kontaktperson', 'Firma'],
  'Ortteil': ['Ortsteil', 'Stadtteil'],
  'Straße': ['Straße', 'Strasse'],
  'WohnFL': ['WohnFL', 'Wohnfläche', 'Wohnflaeche', 'Wohnfläche ca.', 'Wohnfl.'],
  'GewerbeFL': ['GewerbeFL', 'Gewerbefläche', 'Gewerbeflaeche', 'Gewerbefl.', 'Ladenfläche', 'Bürofläche'],
  'sonst.FL': ['sonst.FL', 'Sonstige Fläche', 'Nutzfläche', 'Gesamtfläche', 'Grundstücksfläche'],
  'KP': ['KP', 'Kaufpreis', 'Gesamtkaufpreis'],
  'IST Mieteinnahmen': ['IST Mieteinnahmen', 'Ist-Miete', 'Ist Miete', 'Mieteinnahmen p.a.', 'Mieteinnahmen', 'Jahresnettokaltmiete', 'Nettokaltmiete'],
  'Kaufpreisfaktor IST': ['Kaufpreisfaktor IST', 'Faktor', 'Kaufpreisfaktor', 'Vervielfältiger'],
  'Kaufpreis pro m²': ['Kaufpreis pro m²', 'Preis/m²', 'Preis pro m²', 'Preis pro qm', 'Kaufpreis/m²'],
  'BJ': ['BJ', 'Baujahr'],
  'Zustand': ['Zustand', 'Objektzustand', 'Bauzustand'],
  'Bemerkungen': ['Bemerkungen', 'Beschreibung', 'Objektbeschreibung', 'Sonstiges'],
  'Provision': ['Käuferprovision', 'Provision für Käufer', 'Maklerprovision', 'Provision'],
};

const FIELD_PATTERNS = {
  'WohnFL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'GewerbeFL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'sonst.FL': /(\d[\d.,\s]*\s*(?:m²|m2|qm))/i,
  'KP': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)|Preis auf Anfrage)(?!\s*(?:\/|pro)?\s*(?:m²|m2|qm))/i,
  'IST Mieteinnahmen': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)(?:\s*(?:p\.a\.|pro Jahr|jährlich))?)/i,
  'Kaufpreisfaktor IST': /(\d{1,3}(?:[,.]\d{1,2})?)/i,
  'Kaufpreis pro m²': /((?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)\s*(?:\/|pro)?\s*(?:m²|m2|qm))/i,
  'BJ': /\b(1[89]\d{2}|20\d{2})\b/,
  'Zustand': /(neuwertig|neubau|gepflegt|modernisiert|renoviert|renovierungsbedürftig|sanierungsbedürftig|saniert|projektiert|erstbezug|nach vereinbarung)/i,
  'Provision': /((?:\d{1,2}(?:[,.]\d{1,2})?\s*%.*)|provisionsfrei|courtagefrei|keine provision|käuferprovision\s*[:\-]?\s*.+)/i,
};

const DEFAULT_EXPORT_CONCURRENCY = 3;
const MAX_EXPORT_CONCURRENCY = 8;
const DEFAULT_OPENAI_BATCH_SIZE = 3;
const MAX_OPENAI_BATCH_SIZE = 3;
const DEFAULT_OPENAI_CONCURRENCY = 3;
const MAX_OPENAI_CONCURRENCY = 3;
const OPENAI_TEXT_LIMIT_PER_OBJECT = 14000;

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

export async function createImmoscoutCaptureExcel({ captures, runsDir, onProgress }) {
  const items = Array.isArray(captures) ? captures : [];
  if (!items.length) {
    throw httpError(400, 'Keine Browser-Captures vorhanden.');
  }

  const runId = generateRunId();
  const runDir = path.join(runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const rows = new Array(items.length);
  const results = new Array(items.length);
  const contexts = new Array(items.length);
  const prepareConcurrency = getExportConcurrency(items.length);
  let cursor = 0;
  let completed = 0;

  async function finalizeContext(context) {
    sanitizeExtractedRow(context.row, context.extractionText);
    context.result.status = context.result.message ? 'partial' : 'ok';
    if (!context.result.message) {
      context.result.message = context.usedOpenAI ? 'Excel-Zeile mit GPT-Batch erstellt.' : 'Excel-Zeile erstellt.';
    }

    rows[context.itemIndex] = context.row;
    results[context.itemIndex] = context.result;
    completed += 1;

    await emitProgress(onProgress, {
      phase: 'done',
      index: context.index,
      completed,
      total: items.length,
      concurrency: prepareConcurrency,
      id: context.capture.id,
      status: context.result.status,
      message: context.result.message,
    });
  }

  async function prepareNext() {
    while (cursor < items.length) {
      const itemIndex = cursor++;
      const capture = items[itemIndex];
      const index = itemIndex + 1;
      await emitProgress(onProgress, {
        phase: 'processing',
        index,
        total: items.length,
        concurrency: prepareConcurrency,
        id: capture.id,
        title: capture.title || '',
        message: `Text wird vorbereitet (${index}/${items.length})`,
      });

      let context;
      try {
        context = prepareCapturedItem({ capture, itemIndex });
        contexts[itemIndex] = context;
      } catch (err) {
        context = {
          itemIndex,
          index,
          capture,
          row: createEmptyRow(capture.id),
          result: {
            id: capture.id,
            url: capture.url,
            status: 'failed',
            message: err.message || 'Excel-Zeile konnte nicht erstellt werden.',
          },
          extractionText: '',
          openAIText: '',
          usedOpenAI: false,
        };
        contexts[itemIndex] = context;
      }

      if (!shouldUseOpenAI(context)) {
        await finalizeContext(context);
      }
    }
  }

  await Promise.all(Array.from({ length: prepareConcurrency }, () => prepareNext()));

  const openAIContexts = contexts.filter(shouldUseOpenAI);
  if (openAIContexts.length) {
    const batches = chunkArray(openAIContexts, getOpenAIBatchSize());
    const openAIConcurrency = getOpenAIConcurrency(batches.length);
    let batchCursor = 0;

    async function processNextOpenAIBatch() {
      while (batchCursor < batches.length) {
        const batchIndex = batchCursor++;
        const batch = batches[batchIndex];
        const batchLabel = `${batchIndex + 1}/${batches.length}`;

        for (const context of batch) {
          await emitProgress(onProgress, {
            phase: 'processing',
            index: context.index,
            total: items.length,
            concurrency: openAIConcurrency,
            id: context.capture.id,
            title: context.capture.title || '',
            message: `GPT-Batch ${batchLabel} läuft (${batch.length} Objekte)`,
          });
        }

        try {
          const extractedRows = await extractBatchWithOpenAI(batch);
          for (const context of batch) {
            const aiData = extractedRows.get(context.capture.id);
            if (aiData) {
              mergeRow(context.row, aiData);
              context.usedOpenAI = true;
            } else {
              context.result.message = `OpenAI-Extraktion unvollständig: keine Antwort für ID ${context.capture.id}`;
            }
          }
        } catch (err) {
          for (const context of batch) {
            context.result.message = `OpenAI-Extraktion übersprungen: ${err.message}`;
          }
        }

        for (const context of batch) {
          await finalizeContext(context);
        }
      }
    }

    await Promise.all(Array.from({ length: openAIConcurrency }, () => processNextOpenAIBatch()));
  }

  await emitProgress(onProgress, {
    phase: 'writing',
    index: items.length,
    total: items.length,
    message: 'Excel-Datei wird geschrieben.',
  });

  const xlsx = createXlsx(rows.filter(Boolean), COLUMNS);
  const xlsxFilename = `immoscout-export-${runId}.xlsx`;
  const xlsxPath = path.join(runDir, 'immoscout-export.xlsx');
  await writeFile(xlsxPath, xlsx);

  return {
    runId,
    xlsxFilename,
    downloadUrl: `/api/immoscout/export/${runId}/download`,
    captureCount: items.length,
    rowCount: rows.filter(Boolean).length,
    items: results.filter(Boolean),
  };
}

function getExportConcurrency(total) {
  const configured = Number.parseInt(process.env.IMMOSCOUT_EXPORT_CONCURRENCY || '', 10);
  const value = Number.isFinite(configured) ? configured : DEFAULT_EXPORT_CONCURRENCY;
  return Math.max(1, Math.min(total, MAX_EXPORT_CONCURRENCY, value));
}

function getOpenAIBatchSize() {
  const configured = Number.parseInt(process.env.IMMOSCOUT_OPENAI_BATCH_SIZE || '', 10);
  const value = Number.isFinite(configured) ? configured : DEFAULT_OPENAI_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_OPENAI_BATCH_SIZE, value));
}

function getOpenAIConcurrency(totalBatches) {
  const configured = Number.parseInt(process.env.IMMOSCOUT_OPENAI_CONCURRENCY || '', 10);
  const value = Number.isFinite(configured) ? configured : DEFAULT_OPENAI_CONCURRENCY;
  return Math.max(1, Math.min(totalBatches, MAX_OPENAI_CONCURRENCY, value));
}

async function emitProgress(onProgress, progress) {
  if (typeof onProgress === 'function') {
    await onProgress(progress);
  }
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

function extractImmoscoutId(url) {
  const match = `${url.pathname}${url.search}`.match(/(?:^|\/)expose\/(\d{6,14})(?:[/?#]|$)/i);
  return match ? match[1] : null;
}

function prepareCapturedItem({ capture, itemIndex }) {
  const row = createEmptyRow(capture.id);
  const result = {
    id: capture.id,
    url: capture.url,
    status: 'pending',
    message: '',
  };

  const pageText = normalizeCaptureText(capture.text || '');
  const printText = normalizeCaptureText(capture.printText || '');
  const extractionText = normalizeCaptureText(`${printText}\n${pageText}`);
  const heuristicData = extractListingData('', extractionText, capture);
  mergeRow(row, heuristicData);

  return {
    itemIndex,
    index: itemIndex + 1,
    capture,
    row,
    result,
    extractionText,
    openAIText: createOpenAIListingText(capture, extractionText),
    usedOpenAI: false,
  };
}

function shouldUseOpenAI(context) {
  return Boolean(process.env.OPENAI_API_KEY) &&
    context &&
    !context.result?.message &&
    String(context.openAIText || '').length > 200;
}

function createEmptyRow(id) {
  return Object.fromEntries(COLUMNS.map(column => [column, column === 'Kennung' ? id : '']));
}

function mergeRow(row, data) {
  for (const column of COLUMNS) {
    if (column === 'Kennung') continue;
    const value = normalizeCell(data?.[column]);
    if (value && isAcceptableCellValue(column, value)) row[column] = value;
  }
}

function normalizeCell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([€])/g, ' $1')
    .trim()
    .slice(0, 500);
}

function sanitizeExtractedRow(row, visibleText) {
  const lines = visibleText
    .split('\n')
    .map(line => normalizeCell(line))
    .filter(Boolean);

  const strict = extractStrictCorrections(lines);
  for (const [field, value] of Object.entries(strict)) {
    if (value && isAcceptableCellValue(field, value)) row[field] = value;
  }

  for (const column of COLUMNS) {
    if (column === 'Kennung') continue;
    if (!isAcceptableCellValue(column, row[column])) row[column] = '';
  }

  if (row.KP && row['Kaufpreis pro m²'] && normalizePriceNumber(row.KP) === normalizePriceNumber(row['Kaufpreis pro m²'])) {
    row.KP = '';
  }
}

function extractStrictCorrections(lines) {
  const data = {};
  data.WohnFL = pickValue(lines, ['Wohnfläche', 'Wohnflaeche', 'Wohnfläche ca.', 'Wohnfl.'], FIELD_PATTERNS.WohnFL, 'WohnFL');
  data['sonst.FL'] = pickValue(lines, ['Nutzfläche', 'Sonstige Fläche', 'Gesamtfläche', 'Grundstücksfläche'], FIELD_PATTERNS['sonst.FL'], 'sonst.FL');
  data.KP = pickValue(lines, ['Kaufpreis', 'Gesamtkaufpreis', 'KP'], FIELD_PATTERNS.KP, 'KP');
  data['Kaufpreis pro m²'] = pickValue(lines, ['Kaufpreis pro m²', 'Preis/m²', 'Preis pro m²', 'Preis pro qm', 'Kaufpreis/m²'], FIELD_PATTERNS['Kaufpreis pro m²'], 'Kaufpreis pro m²');
  data.Provision = pickValue(lines, ['Käuferprovision', 'Provision für Käufer', 'Maklerprovision', 'Provision'], FIELD_PATTERNS.Provision, 'Provision');
  data.Zustand = pickValue(lines, ['Objektzustand', 'Zustand', 'Bauzustand'], FIELD_PATTERNS.Zustand, 'Zustand');
  mergePlain(data, extractAddress(lines, {}));
  return data;
}

function isAcceptableCellValue(column, value) {
  const text = normalizeCell(value);
  if (!text) return false;
  if (isJunkCandidate(text)) return false;

  if (column === 'Anbieter') {
    return !/adresse.*erhalten|anbieter kontaktieren|kontakt aufnehmen/i.test(text);
  }
  if (column === 'Ortteil') {
    return !/\d{5}/.test(text) && text.length <= 80;
  }
  if (column === 'Straße') {
    return isStreetLike(text);
  }
  if (column === 'WohnFL') {
    return isArea(text) && !/grundstück|grundstueck|nutzfläche|nutzflaeche|gewerbe|laden|büro|buero/i.test(text);
  }
  if (column === 'GewerbeFL' || column === 'sonst.FL') {
    return isArea(text);
  }
  if (column === 'KP') {
    return (/preis auf anfrage/i.test(text) || isMoney(text)) && !isAreaPrice(text);
  }
  if (column === 'IST Mieteinnahmen') {
    return isMoney(text);
  }
  if (column === 'Kaufpreisfaktor IST') {
    return /^\d{1,3}(?:[,.]\d{1,2})?$/.test(text);
  }
  if (column === 'Kaufpreis pro m²') {
    return isMoney(text) && isAreaPrice(text);
  }
  if (column === 'BJ') {
    return /^(1[89]\d{2}|20\d{2})$/.test(text);
  }
  if (column === 'Zustand') {
    return !/^objekt$/i.test(text) && text.length <= 80;
  }
  if (column === 'Bemerkungen') {
    return text.length >= 25 && !/^objekt$/i.test(text);
  }
  if (column === 'Provision') {
    return /%|provisionsfrei|courtagefrei|keine provision/i.test(text) && !/^für käufer$/i.test(text);
  }

  return true;
}

function isArea(value) {
  return /\d[\d.,\s]*\s*(?:m²|m2|qm)/i.test(value);
}

function isMoney(value) {
  return /(?:\d[\d.\s]*,\d{2}|\d[\d.\s]*)\s*(?:€|EUR)/i.test(value);
}

function normalizePriceNumber(value) {
  const match = String(value || '').match(/\d[\d.\s]*(?:,\d{2})?/);
  return match ? match[0].replace(/[.\s]/g, '').replace(/,\d{2}$/, '') : '';
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

  const titleText = [meta.title, meta.description, visibleText.slice(0, 8000)].filter(Boolean).join('\n');
  data.Art ||= detectArt(pickValue(lines, ['Objektart', 'Immobilienart', 'Haustyp', 'Typ', 'Kategorie']) || titleText);

  for (const [field, labels] of Object.entries(FIELD_LABELS)) {
    data[field] ||= pickValue(lines, labels, FIELD_PATTERNS[field], field);
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

function pickValue(lines, labels, pattern, field = '') {
  const normalizedLabels = labels.map(label => normalizeForCompare(label));

  for (let labelIndex = 0; labelIndex < normalizedLabels.length; labelIndex++) {
    const label = normalizedLabels[labelIndex];
    const rawLabel = labels[labelIndex];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const comparable = normalizeForCompare(line);
      if (!isLabelMatch(comparable, label, field)) continue;

      const candidates = [];
      const sameLine = line
        .replace(new RegExp(escapeRegExp(rawLabel), 'i'), '')
        .replace(/^[:\-\s]+|[:\-\s]+$/g, '');
      if (sameLine) candidates.push(sameLine);
      if (i + 1 < lines.length) candidates.push(lines[i + 1]);
      if (i + 2 < lines.length) candidates.push(lines[i + 2]);
      if (i > 0 && canUsePreviousCandidate(field)) candidates.push(lines[i - 1]);

      for (const candidate of candidates) {
        const value = cleanCandidate(candidate, pattern, field);
        if (value) return value;
      }
    }
  }

  return '';
}

function isLabelMatch(comparable, label, field) {
  if (comparable === label) return true;
  if (field === 'KP' && /\bkaufpreis\s*(?:pro|m2|qm)\b/i.test(comparable)) return false;
  if (field === 'WohnFL' && /\b(?:grundstucks|grundstuecks|nutz|gewerbe|laden|buro|buero)flache\b/.test(comparable)) return false;
  return comparable.startsWith(`${label} `) || comparable.endsWith(` ${label}`);
}

function canUsePreviousCandidate(field) {
  return [
    'WohnFL',
    'GewerbeFL',
    'sonst.FL',
    'KP',
    'IST Mieteinnahmen',
    'Kaufpreisfaktor IST',
    'Kaufpreis pro m²',
    'BJ',
  ].includes(field);
}

function cleanCandidate(candidate, pattern, field = '') {
  const value = normalizeCell(candidate);
  if (!value || value.length > 160) return '';
  if (isJunkCandidate(value)) return '';
  if (isLikelyLabel(value)) return '';
  if (field === 'Straße' && !isStreetLike(value)) return '';
  if (field === 'KP' && isAreaPrice(value)) return '';
  if (field === 'Bemerkungen' && value.length < 25) return '';
  if (pattern) {
    const match = value.match(pattern);
    return match ? normalizeCell(match[1] || match[0]) : '';
  }
  return value;
}

function isJunkCandidate(value) {
  return /^(objekt|weiterlesen(?:…|\.\.\.)?|mehr anzeigen|kontakt aufnehmen|kontaktieren|anbieter kontaktieren)$/i.test(value) ||
    /vollständige adresse.*erhalten/i.test(value);
}

function isAreaPrice(value) {
  return /(?:\/|pro)\s*(?:m²|m2|qm)/i.test(value);
}

function isStreetLike(value) {
  if (/käufer/i.test(value)) return false;
  return /(straße|strasse|str\.|weg|allee|platz|ring|damm|gasse|chaussee|ufer)\b/i.test(value);
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
    .replace(/²/g, '2')
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
    ['Objektart', 'Immobilienart', 'Haustyp', 'Typ', 'Kategorie']
  );
  return direct || '';
}

function extractAddress(lines, jsonLdData) {
  const data = {};
  data.Ort ||= jsonLdData.Ort || '';
  data['Straße'] ||= jsonLdData['Straße'] || '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const districtZipMatch = line.match(/^([A-ZÄÖÜ][\p{L} .'-]{2,80}),\s*\d{5}\s+([A-ZÄÖÜ][\p{L} .'-]{2,80})/u);
    if (districtZipMatch) {
      data['Ortteil'] ||= normalizeCell(districtZipMatch[1]);
      data.Ort ||= normalizeCell(districtZipMatch[2].replace(/Deutschland.*$/i, ''));
    }

    const zipMatch = line.match(/\b\d{5}\s+([A-ZÄÖÜ][\p{L} .'-]{2,80})/u);
    if (zipMatch && !data.Ort) {
      data.Ort = normalizeCell(zipMatch[1].replace(/Deutschland.*$/i, ''));
    }

    if (!data['Ortteil'] && /stadtteil|ortsteil/i.test(line)) {
      data['Ortteil'] = pickValue(lines.slice(Math.max(0, i - 1), i + 3), ['Stadtteil', 'Ortsteil'], null, 'Ortteil');
    }

    if (!data['Straße'] && isStreetLike(line) && isPropertyAddressContext(lines, i) && !isProviderAddressContext(lines, i)) {
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

function isProviderAddressContext(lines, index) {
  const start = Math.max(0, index - 10);
  const context = lines.slice(start, index + 1).map(line => normalizeForCompare(line)).join(' ');
  return /\b(anbieter|anbietende|firma|makler|gewerblich|identitat verifiziert|telefonnummer|nachricht|impressum|widerrufsbelehrung)\b/.test(context) ||
    /\bwww\b/.test(context);
}

function isPropertyAddressContext(lines, index) {
  const start = Math.max(0, index - 4);
  const context = lines.slice(start, index + 1).map(line => normalizeForCompare(line)).join(' ');
  return /\badresse\b/.test(context) || /\b\d{5}\b/.test(lines[index] || '') || /\b\d{5}\b/.test(lines[index + 1] || '');
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

function createOpenAIListingText(capture, extractionText) {
  const rawLines = String(extractionText || '')
    .split('\n')
    .map(line => normalizeCell(line))
    .filter(Boolean);

  const lines = [];
  let mutedSection = false;
  let scriptConfig = false;
  let charCount = 0;

  for (const line of rawLines) {
    if (isImportantListingSection(line)) {
      mutedSection = false;
      scriptConfig = false;
    }

    if (startsScriptConfig(line)) {
      scriptConfig = true;
      continue;
    }
    if (scriptConfig) continue;

    if (startsMutedListingSection(line)) {
      mutedSection = true;
      continue;
    }
    if (mutedSection) continue;
    if (isOpenAIJunkLine(line)) continue;
    if (lines[lines.length - 1] === line) continue;

    lines.push(line);
    charCount += line.length + 1;
    if (charCount >= OPENAI_TEXT_LIMIT_PER_OBJECT) break;
  }

  const header = [
    `ID: ${capture.id}`,
    `URL: ${capture.url || ''}`,
    `Titel: ${capture.title || capture.printTitle || ''}`,
  ].join('\n');
  return `${header}\n\n${lines.join('\n')}`.slice(0, OPENAI_TEXT_LIMIT_PER_OBJECT + header.length + 2);
}

function isImportantListingSection(line) {
  return /^(objektdetails|kosten|bausubstanz\s*&\s*energieausweis|objektbeschreibung|ausstattung|lage|sonstiges|adresse|anbieter)$/i.test(line);
}

function startsScriptConfig(line) {
  return /^(window\.IS24|var\s+COUNTERNAME|navUpdateTimeout|services:\s*\[|window\.)/i.test(line) ||
    /exposeAvailableServicesConfig|_jcr_content|contentSrc\s*:|trackingId\s*:|activeRealEstateTypes\s*:|requiresFlag\s*:/i.test(line);
}

function startsMutedListingSection(line) {
  return /^(bilder|bilder ausblenden|grundrisse|grundrisse ausblenden|karte|karte ausblenden|services für dich|ergänzende links|preis- und lageinformationen|weiteres vom anbietenden|weitere ergebnisse|baufinanzierung|über immoscout24|für profis|app herunterladen|folge uns)$/i.test(line);
}

function isOpenAIJunkLine(line) {
  const cmp = normalizeForCompare(line);
  if (!cmp) return true;
  if (/^[{}\[\],;()]+$/.test(line)) return true;
  if (/^(id|chip|title|subline|icon|link|contentSrc|trackingId|activeRealEstateTypes|requiresFlag)\s*:/i.test(line)) return true;
  if (/^['"]?(wohnung|haus|anlage|gastronomie|hallen|buero|buro|einzelhandel)[a-z0-9_-]*['"]?,?$/i.test(line)) return true;
  if (/https?:\/\/(?:rebrand\.ly|www\.immobilienscout24\.de\/expose\/content)/i.test(line)) return true;
  if (/\b(?:eff\.?\s*jahreszins|geb\.?\s*sollzins|basierend auf|eigenkapital|monatsrate|finanzieren\?|finanzierungsangebote)\b/i.test(line)) return true;
  return [
    'suchende',
    'eigentumer innen',
    'inserieren ab 0',
    'makler in finden',
    'anmelden',
    'menu',
    'plus',
    'jetzt aktivieren',
    'mitglieder wissen mehr',
    'erkunde deine chancen auf diese immobilie',
    'services fur dich',
    'telefonnummer anzeigen',
    'nachricht',
    'preis vorschlagen',
    'melden',
    'drucken',
    'nach oben',
    'folgen',
    'impressum',
    'widerrufsbelehrung',
    'datenschutz',
    'agb rechtliche hinweise',
    'kontakt hilfe',
  ].includes(cmp);
}

async function extractBatchWithOpenAI(contexts) {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const listings = contexts.map(context => ({
    id: context.capture.id,
    url: context.capture.url || '',
    title: context.capture.title || context.capture.printTitle || '',
    text: context.openAIText,
  }));
  const prompt = [
    `Du bekommst ${listings.length} bereinigte ImmoScout-Objekte.`,
    'Extrahiere fuer jedes Objekt genau eine Tabellenzeile.',
    'Wenn ein Wert nicht eindeutig vorhanden ist, verwende einen leeren String.',
    'Erfinde keine Werte und rechne keine Werte selbst aus.',
    'Die Kennung muss exakt die ID aus dem jeweiligen Objekt sein.',
    '',
    'Wichtige Zuordnungsregeln:',
    '- KP ist der gesamte Kaufpreis. Niemals Kaufpreis pro m² oder €/m² als KP verwenden.',
    '- Kaufpreis pro m² enthält nur Werte wie €/m², EUR/m² oder EUR pro qm.',
    '- WohnFL ist nur Wohnfläche, nicht Grundstücksfläche, Nutzfläche, Bürofläche oder Ladenfläche.',
    '- sonst.FL bevorzugt Nutzfläche/Sonstige Fläche; Grundstücksfläche nur verwenden, wenn keine Nutzfläche/Sonstige Fläche vorhanden ist.',
    '- Ort ist die Stadt/Gemeinde. Bei "Holzlar, 53229 Bonn" ist Ort "Bonn".',
    '- Ortteil ist der Stadtteil/Ortsteil. Bei "Holzlar, 53229 Bonn" ist Ortteil "Holzlar".',
    '- Straße nur füllen, wenn eine echte Straße/Adresse genannt wird. Stadtteil + PLZ + Ort ist keine Straße.',
    '- Anbieter nur füllen, wenn Anbietername, Firma oder Kontaktperson eindeutig genannt ist.',
    '- Zustand nur mit echtem Zustand füllen, z.B. neuwertig, gepflegt, renoviert.',
    '- Bemerkungen nur mit sinnvoller Beschreibung füllen; Wörter wie "Objekt" oder "weiterlesen" leer lassen.',
    '- Provision vollständig übernehmen, z.B. "3,57 % inkl. MwSt."; "für Käufer" allein ist kein Wert.',
    '',
    'Antworte ausschließlich als JSON-Objekt in dieser Form:',
    `{"items":[{${COLUMNS.map(column => `"${column}":""`).join(',')}}]}`,
    'Die items-Liste muss genau eine Zeile pro Eingabeobjekt enthalten.',
    '',
    'Eingabeobjekte:',
    listings.map((listing, index) => [
      `--- OBJEKT ${index + 1} START ---`,
      `Kennung: ${listing.id}`,
      `URL: ${listing.url}`,
      `Titel: ${listing.title}`,
      'Bereinigter Text:',
      listing.text,
      `--- OBJEKT ${index + 1} ENDE ---`,
    ].join('\n')).join('\n\n'),
  ].join('\n');

  const requestBody = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Du bist ein präziser deutscher Immobilien-Datenextraktor. Du erfindest keine Werte.',
      },
      { role: 'user', content: prompt },
    ],
  };
  if (/^gpt-5(?:[.-]|$)/i.test(model)) {
    requestBody.reasoning_effort = normalizeReasoningEffort(process.env.OPENAI_REASONING_EFFORT) || 'low';
  } else {
    requestBody.temperature = 0;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('leere OpenAI-Antwort');

  const parsed = parseOpenAIJson(content);
  const responseItems = getOpenAIResponseItems(parsed);
  if (!Array.isArray(responseItems)) throw new Error('OpenAI-Antwort enthaelt keine items-Liste');

  const expectedIds = new Set(contexts.map(context => context.capture.id));
  const cleanRows = new Map();
  for (const item of responseItems) {
    const id = normalizeCell(item?.Kennung || item?.kennung || item?.id || item?.ID || item?.exposeId);
    if (!expectedIds.has(id)) continue;
    const clean = {};
    for (const column of COLUMNS) {
      clean[column] = normalizeCell(item?.[column]);
    }
    clean.Kennung = id;
    cleanRows.set(id, clean);
  }
  return cleanRows;
}

function parseOpenAIJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const text = String(content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('OpenAI-Antwort ist kein gueltiges JSON');
  }
}

function getOpenAIResponseItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return parsed?.items || parsed?.rows || parsed?.objekte || parsed?.objects || parsed?.data || null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').toLowerCase().trim();
  return ['minimal', 'low', 'medium', 'high'].includes(effort) ? effort : '';
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
  <cols>${columns.map((column, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${idx === 0 ? 16 : 22}" customWidth="1"/>`).join('')}</cols>
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
  return stripInvalidXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripInvalidXmlChars(value) {
  const text = String(value ?? '');
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += text[i] + text[i + 1];
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
      if (code !== 0xfffe && code !== 0xffff) clean += text[i];
    }
  }
  return clean;
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
