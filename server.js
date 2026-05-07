// =====================================================
// DEPALOMI.COM — Server
// Pure Node.js, zero dependencies
// =====================================================

import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  createImmoscoutCaptureExcel,
  normalizeImmoscoutCapturePayload,
} from './lib/immoscout-export.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = Number(process.env.PORT) || 3000;
const IS_PROD    = process.env.NODE_ENV === 'production';

// ── Directories ─────────────────────────────────────
const PUBLIC_DIR  = path.join(__dirname, 'public');
const ADMIN_DIR   = path.join(__dirname, 'admin');
const DATA_DIR    = process.env.DATA_DIR || (IS_PROD ? '/var/www/depalomi-data' : path.join(__dirname, '.data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const IMMOSCOUT_RUNS_DIR = path.join(DATA_DIR, 'immoscout-runs');

// ── Data files ───────────────────────────────────────
const CONFIG_FILE    = path.join(DATA_DIR, 'config.json');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const PROJECTS_FILE  = path.join(DATA_DIR, 'projects.json');
const IMMOSCOUT_CAPTURES_FILE = path.join(DATA_DIR, 'immoscout-captures.json');

// ── MIME types ───────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.png':  'image/png',  '.webp': 'image/webp',
  '.gif':  'image/gif',  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',  '.txt':  'text/plain; charset=utf-8',
  '.pdf':  'application/pdf', '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ico':  'image/x-icon',
};

// ── Sessions (in-memory) ─────────────────────────────
const adminSessions   = new Map(); // token → { expires }
const previewSessions = new Map(); // `slug:token` → { expires }
const loginAttempts   = new Map(); // ip → { count, resetAt }

const SESSION_TTL       = 8  * 60 * 60 * 1000; // 8h
const PREVIEW_TTL       = 24 * 60 * 60 * 1000; // 24h
const MAX_ATTEMPTS      = 5;
const LOCKOUT_MS        = 15 * 60 * 1000;       // 15 min
const MAX_BODY_BYTES    = 12 * 1024 * 1024;      // 12 MB max request body

// ── Startup: init dirs + config ──────────────────────
await mkdir(DATA_DIR,    { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(IMMOSCOUT_RUNS_DIR, { recursive: true });

let config;
try {
  config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
} catch {
  const initialPw = process.env.ADMIN_PASSWORD || 'changeme';
  config = { passwordHash: await hashPassword(initialPw) };
  await saveConfig();
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Admin password initialized: ${initialPw.padEnd(12)} ║`);
  console.log(`║  Change it in the admin panel!           ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
}

if (!config.immoscoutImportToken) {
  config.immoscoutImportToken = generateToken();
  await saveConfig();
}

// ── Crypto helpers ───────────────────────────────────
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(pw, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    crypto.scrypt(pw, salt, 64, (err, key) => {
      if (err) return reject(err);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), key));
      } catch { resolve(false); }
    });
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ── Session helpers ──────────────────────────────────
function createAdminSession() {
  const token = generateToken();
  adminSessions.set(token, { expires: Date.now() + SESSION_TTL });
  return token;
}

function isAdminSession(token) {
  if (!token) return false;
  const s = adminSessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) { adminSessions.delete(token); return false; }
  return true;
}

function getAdminCookie(req) {
  const m = (req.headers.cookie || '').match(/dp_admin=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

function isAdmin(req) {
  return isAdminSession(getAdminCookie(req));
}

function createPreviewSession(slug) {
  const token = generateToken();
  previewSessions.set(`${slug}:${token}`, { expires: Date.now() + PREVIEW_TTL });
  return token;
}

function isPreviewSession(slug, token) {
  if (!token) return false;
  const key = `${slug}:${token}`;
  const s = previewSessions.get(key);
  if (!s) return false;
  if (Date.now() > s.expires) { previewSessions.delete(key); return false; }
  return true;
}

function getPreviewCookie(req, slug) {
  const name = `dp_prev_${slug.replace(/[^a-z0-9]/gi, '_')}`;
  const m = (req.headers.cookie || '').match(new RegExp(`${name}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

// ── Rate limiting ────────────────────────────────────
function allowLogin(ip) {
  const now = Date.now();
  const r   = loginAttempts.get(ip) || { count: 0, resetAt: now + LOCKOUT_MS };
  if (now > r.resetAt) { loginAttempts.delete(ip); return true; }
  return r.count < MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const r   = loginAttempts.get(ip) || { count: 0, resetAt: now + LOCKOUT_MS };
  r.count++;
  loginAttempts.set(ip, r);
}

// ── Data helpers ─────────────────────────────────────
async function saveConfig() {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

async function readPortfolio() {
  try { return JSON.parse(await readFile(PORTFOLIO_FILE, 'utf-8')); } catch { return []; }
}

async function savePortfolio(list) {
  await writeFile(PORTFOLIO_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

async function readProjects() {
  try { return JSON.parse(await readFile(PROJECTS_FILE, 'utf-8')); } catch { return []; }
}

async function saveProjects(list) {
  await writeFile(PROJECTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

async function readImmoscoutCaptures() {
  try {
    const list = JSON.parse(await readFile(IMMOSCOUT_CAPTURES_FILE, 'utf-8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveImmoscoutCaptures(list) {
  await writeFile(IMMOSCOUT_CAPTURES_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

async function upsertImmoscoutCapture(input) {
  const capture = normalizeImmoscoutCapturePayload(input);
  const list = await readImmoscoutCaptures();
  const idx = list.findIndex(item => item.id === capture.id);
  if (idx >= 0) {
    capture.createdAt = list[idx].createdAt || capture.createdAt;
    list[idx] = capture;
  } else {
    list.unshift(capture);
  }
  await saveImmoscoutCaptures(list.slice(0, 100));
  return capture;
}

function summarizeImmoscoutCaptures(list) {
  return list.map(item => ({
    id: item.id,
    url: item.url,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    textLength: String(item.text || '').length,
    printTextLength: String(item.printText || '').length,
  }));
}

function createImmoscoutCaptureSource(item) {
  const pageText = String(item.text || '').trim();
  const printText = String(item.printText || '').trim();
  const lines = [
    `URL: ${item.url || ''}`,
    item.title ? `Titel: ${item.title}` : '',
    item.printUrl ? `Druckversion: ${item.printUrl}` : '',
    item.createdAt ? `Erfasst: ${item.createdAt}` : '',
    item.updatedAt ? `Aktualisiert: ${item.updatedAt}` : '',
    `Seitentext-Zeichen: ${pageText.length.toLocaleString('de-DE')}`,
    `Drucktext-Zeichen: ${printText.length.toLocaleString('de-DE')}`,
    '',
    'Seitentext',
    pageText || '[Kein Seitentext gespeichert]',
  ];

  if (printText) {
    lines.push('', 'Druckversion-Text', printText);
  }

  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

async function readBody(req) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    body += chunk;
  }
  return body;
}

async function readJson(req) {
  const body = await readBody(req);
  return JSON.parse(body);
}

// ── Response helpers ─────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function html(res, status, content) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(content);
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function setCookie(res, name, value, maxAge) {
  const secure = IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge / 1000)}${secure}`
  );
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie',
    `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  );
}

function getClientIp(req) {
  // Only trust X-Forwarded-For in production behind a known proxy.
  // In dev / direct exposure trust the socket address to prevent IP spoofing.
  if (IS_PROD && req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function setImmoscoutCaptureCors(req, res) {
  const origin = req.headers.origin || '';
  if (/^https:\/\/([a-z0-9-]+\.)?(immobilienscout24|immoscout24)\.de$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function isValidImportToken(token) {
  const expected = String(config.immoscoutImportToken || '');
  const value = String(token || '');
  if (!expected || value.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Validate slug ─────────────────────────────────────
function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9-]{2,60}$/.test(s);
}

// ── HTTP Server ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: blob:; " +
    "frame-src *; " +          // preview iframes need to load external sites
    "connect-src 'self';"
  );

  try {
    const url  = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path_ = url.pathname;
    const method = req.method.toUpperCase();

    if (path_ === '/api/immoscout/capture') {
      setImmoscoutCaptureCors(req, res);
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // ── Admin login page ──────────────────────────────
    if (path_ === '/admin' || path_ === '/admin/') {
      return await serveFile(path.join(ADMIN_DIR, 'index.html'), req, res);
    }

    // ── Admin dashboard (auth required) ───────────────
    if (path_ === '/admin/dashboard' || path_ === '/admin/dashboard/') {
      if (!isAdmin(req)) return redirect(res, '/admin');
      return await serveFile(path.join(ADMIN_DIR, 'dashboard.html'), req, res);
    }

    // ── Preview pages ──────────────────────────────────
    const previewMatch = path_.match(/^\/preview\/([a-z0-9-]+)\/?$/);
    if (previewMatch) {
      return await handlePreviewPage(previewMatch[1], req, res);
    }

    // ── API routes ────────────────────────────────────
    if (path_.startsWith('/api/')) {
      return await handleApi(path_, method, url, req, res);
    }

    // ── Static files (public/) ─────────────────────────
    await serveStatic(path_, req, res);

  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      if (!res.headersSent) json(res, 413, { error: 'Anfrage zu groß (max. 12 MB)' });
      else res.end();
      return;
    }
    console.error('[server error]', err);
    if (!res.headersSent) await serve500(res);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`depalomi.com server → http://localhost:${PORT}`);
  console.log(`Admin panel         → http://localhost:${PORT}/admin`);
});

// ── API Router ────────────────────────────────────────
function isSafeUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

async function handleApi(path_, method, _url, req, res) {

  // POST /api/admin/login
  if (path_ === '/api/admin/login' && method === 'POST') {
    const ip = getClientIp(req);
    if (!allowLogin(ip)) return json(res, 429, { error: 'Zu viele Versuche. Bitte 15 Minuten warten.' });

    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const ok = await verifyPassword(String(data.password || ''), config.passwordHash);
    if (!ok) {
      recordFailedLogin(ip);
      return json(res, 401, { error: 'Falsches Passwort' });
    }

    loginAttempts.delete(ip);
    const token = createAdminSession();
    setCookie(res, 'dp_admin', token, SESSION_TTL);
    return json(res, 200, { ok: true });
  }

  // POST /api/admin/logout
  if (path_ === '/api/admin/logout' && method === 'POST') {
    const token = getAdminCookie(req);
    if (token) adminSessions.delete(token);
    clearCookie(res, 'dp_admin');
    return json(res, 200, { ok: true });
  }

  // GET /api/admin/me (check auth status)
  if (path_ === '/api/admin/me' && method === 'GET') {
    return json(res, 200, { authenticated: isAdmin(req) });
  }

  // POST /api/immoscout/capture (public token — called from bookmarklet)
  if (path_ === '/api/immoscout/capture' && method === 'POST') {
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }
    const token = _url.searchParams.get('token') || data.token || data.captureToken;
    if (!isValidImportToken(token)) return json(res, 401, { error: 'Ungültiger Import-Token' });

    try {
      const capture = await upsertImmoscoutCapture(data);
      return json(res, 200, { ok: true, id: capture.id });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Capture konnte nicht gespeichert werden' });
    }
  }

  // GET /api/immoscout/captures (admin only)
  if (path_ === '/api/immoscout/captures' && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const captures = await readImmoscoutCaptures();
    return json(res, 200, {
      token: config.immoscoutImportToken,
      captures: summarizeImmoscoutCaptures(captures),
    });
  }

  // GET /api/immoscout/captures/:id/source (admin only)
  const immoscoutCaptureSource = path_.match(/^\/api\/immoscout\/captures\/([^/]+)\/source$/);
  if (immoscoutCaptureSource && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const captures = await readImmoscoutCaptures();
    const id = decodeURIComponent(immoscoutCaptureSource[1]);
    const capture = captures.find(item => item.id === id);
    if (!capture) return json(res, 404, { error: 'Capture nicht gefunden' });
    return json(res, 200, {
      id,
      textLength: String(capture.text || '').length,
      printTextLength: String(capture.printText || '').length,
      sourceText: createImmoscoutCaptureSource(capture),
    });
  }

  // POST /api/immoscout/captures/import (admin only — manual paste fallback)
  if (path_ === '/api/immoscout/captures/import' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    try {
      const capture = await upsertImmoscoutCapture(data);
      return json(res, 200, { ok: true, capture: summarizeImmoscoutCaptures([capture])[0] });
    } catch (err) {
      return json(res, err.status || 400, { error: err.message || 'Capture konnte nicht importiert werden' });
    }
  }

  // DELETE /api/immoscout/captures (admin only)
  if (path_ === '/api/immoscout/captures' && method === 'DELETE') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    await saveImmoscoutCaptures([]);
    return json(res, 200, { ok: true });
  }

  // POST /api/immoscout/captures/export (admin only)
  if (path_ === '/api/immoscout/captures/export' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data = {};
    try { data = await readJson(req); } catch { /* body is optional */ }

    try {
      const captures = await readImmoscoutCaptures();
      const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
      const selected = ids.length ? captures.filter(item => ids.includes(item.id)) : captures;
      const result = await createImmoscoutCaptureExcel({ captures: selected, runsDir: IMMOSCOUT_RUNS_DIR });
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[immoscout capture export]', err);
      return json(res, err.status || 500, { error: err.message || 'Capture-Export fehlgeschlagen' });
    }
  }

  // GET /api/immoscout/export/:runId/download (admin only)
  const immoscoutDownload = path_.match(/^\/api\/immoscout\/export\/([a-z0-9]+)\/download$/);
  if (immoscoutDownload && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const runId = immoscoutDownload[1];
    const xlsxPath = path.resolve(IMMOSCOUT_RUNS_DIR, runId, 'immoscout-export.xlsx');
    if (!xlsxPath.startsWith(path.resolve(IMMOSCOUT_RUNS_DIR) + path.sep)) {
      return json(res, 404, { error: 'Nicht gefunden' });
    }

    let s;
    try { s = await stat(xlsxPath); } catch { return json(res, 404, { error: 'Nicht gefunden' }); }

    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': s.size,
      'Content-Disposition': `attachment; filename="immoscout-export-${runId}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    createReadStream(xlsxPath).pipe(res);
    return;
  }

  // POST /api/admin/password (change password)
  if (path_ === '/api/admin/password' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const { currentPassword, newPassword } = data;
    if (!currentPassword || !newPassword || String(newPassword).length < 8) {
      return json(res, 400, { error: 'Neues Passwort muss mindestens 8 Zeichen haben' });
    }
    const ok = await verifyPassword(String(currentPassword), config.passwordHash);
    if (!ok) return json(res, 401, { error: 'Aktuelles Passwort falsch' });

    config.passwordHash = await hashPassword(String(newPassword));
    await saveConfig();
    // Invalidate all sessions
    adminSessions.clear();
    clearCookie(res, 'dp_admin');
    return json(res, 200, { ok: true });
  }

  // ── Portfolio ─────────────────────────────────────────

  // GET /api/portfolio
  if (path_ === '/api/portfolio' && method === 'GET') {
    const list = await readPortfolio();
    const admin = isAdmin(req);
    return json(res, 200, admin ? list : list.filter(i => i.published));
  }

  // POST /api/portfolio
  if (path_ === '/api/portfolio' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const { type, title, category, description, url: itemUrl, imageData, published, aspectRatio } = data;
    if (!type || !title) return json(res, 400, { error: 'type und title sind Pflicht' });

    const id = generateId();
    const entry = {
      id,
      type: String(type).slice(0, 20),
      title: String(title).slice(0, 200),
      category: String(category || '').slice(0, 50),
      description: String(description || '').slice(0, 1000),
      url: type === 'video' ? String(itemUrl || '').slice(0, 500) : null,
      aspectRatio: type === 'video' ? normalizeAspectRatio(aspectRatio) : null,
      filename: null,
      published: Boolean(published),
      order: 0,
      createdAt: new Date().toISOString(),
    };

    // Save photo upload — validate MIME type before writing
    if (type === 'photo' && imageData) {
      const mimeMatch = String(imageData).match(/^data:(image\/(jpeg|png|webp|gif));base64,/);
      if (!mimeMatch) return json(res, 400, { error: 'Nur JPEG, PNG, WEBP oder GIF erlaubt' });
      const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
      const ext      = extMap[mimeMatch[2]];
      const filename = `${id}.${ext}`;
      const base64   = imageData.slice(mimeMatch[0].length);
      await writeFile(path.join(UPLOADS_DIR, filename), Buffer.from(base64, 'base64'));
      entry.filename = filename;
    }

    const list = await readPortfolio();
    list.push(entry);
    await savePortfolio(list);
    return json(res, 200, entry);
  }

  // PATCH /api/portfolio/:id
  const portfolioPatch = path_.match(/^\/api\/portfolio\/([a-z0-9]+)$/);
  if (portfolioPatch && method === 'PATCH') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const id = portfolioPatch[1];
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const list = await readPortfolio();
    const idx  = list.findIndex(i => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'Nicht gefunden' });

    const item = list[idx];
    if ('title'       in data) item.title       = String(data.title).slice(0, 200);
    if ('category'    in data) item.category    = String(data.category).slice(0, 50);
    if ('description' in data) item.description = String(data.description).slice(0, 1000);
    if ('url'         in data) item.url         = String(data.url).slice(0, 500);
    if ('aspectRatio' in data && item.type === 'video') {
      item.aspectRatio = normalizeAspectRatio(data.aspectRatio);
    }
    if ('published'   in data) item.published   = Boolean(data.published);
    if ('order'       in data) item.order        = Number(data.order) || 0;

    await savePortfolio(list);
    return json(res, 200, item);
  }

  // DELETE /api/portfolio/:id
  const portfolioDel = path_.match(/^\/api\/portfolio\/([a-z0-9]+)$/);
  if (portfolioDel && method === 'DELETE') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const id = portfolioDel[1];

    const list = await readPortfolio();
    const idx  = list.findIndex(i => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'Nicht gefunden' });

    const [item] = list.splice(idx, 1);
    await savePortfolio(list);

    if (item.filename) {
      try { await unlink(path.join(UPLOADS_DIR, item.filename)); } catch { /* gone */ }
    }
    return json(res, 200, { ok: true });
  }

  // PUT /api/portfolio/order  — reorder by id array
  if (path_ === '/api/portfolio/order' && method === 'PUT') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }
    const { ids } = data;
    if (!Array.isArray(ids)) return json(res, 400, { error: 'ids muss ein Array sein' });
    const list = await readPortfolio();
    const map  = new Map(list.map(i => [i.id, i]));
    const reordered = ids.filter(id => map.has(id)).map((id, idx) => ({ ...map.get(id), order: idx }));
    const rest = list.filter(i => !ids.includes(i.id));
    await savePortfolio([...reordered, ...rest]);
    return json(res, 200, { ok: true });
  }

  // ── Projects ──────────────────────────────────────────

  // GET /api/projects (admin only — includes passwords hashed)
  if (path_ === '/api/projects' && method === 'GET') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const list = await readProjects();
    return json(res, 200, list.map(p => ({ ...p, passwordHash: undefined })));
  }

  // POST /api/projects
  if (path_ === '/api/projects' && method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const { slug, title, description, password, previewUrl } = data;
    if (!slug || !title || !password || !previewUrl) {
      return json(res, 400, { error: 'slug, title, password und previewUrl sind Pflicht' });
    }
    if (!isSafeUrl(previewUrl)) {
      return json(res, 400, { error: 'previewUrl muss eine gültige http/https URL sein' });
    }
    if (!isValidSlug(String(slug))) {
      return json(res, 400, { error: 'Slug: nur Kleinbuchstaben, Zahlen und Bindestriche (2–60 Zeichen)' });
    }

    const projects = await readProjects();
    if (projects.find(p => p.slug === String(slug))) {
      return json(res, 409, { error: 'Slug bereits vergeben' });
    }

    const entry = {
      id: generateId(),
      slug: String(slug).slice(0, 60),
      title: String(title).slice(0, 200),
      description: String(description || '').slice(0, 500),
      passwordHash: await hashPassword(String(password)),
      previewUrl: String(previewUrl).slice(0, 500),
      published: true,
      createdAt: new Date().toISOString(),
    };

    projects.push(entry);
    await saveProjects(projects);
    return json(res, 200, { ...entry, passwordHash: undefined });
  }

  // PATCH /api/projects/:id
  const projectPatch = path_.match(/^\/api\/projects\/([a-z0-9]+)$/);
  if (projectPatch && method === 'PATCH') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const id = projectPatch[1];
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const list = await readProjects();
    const idx  = list.findIndex(p => p.id === id);
    if (idx === -1) return json(res, 404, { error: 'Nicht gefunden' });

    const item = list[idx];
    if ('title'       in data) item.title       = String(data.title).slice(0, 200);
    if ('description' in data) item.description = String(data.description).slice(0, 500);
    if ('previewUrl' in data) {
      if (!isSafeUrl(data.previewUrl)) return json(res, 400, { error: 'previewUrl muss eine gültige http/https URL sein' });
      item.previewUrl = String(data.previewUrl).slice(0, 500);
    }
    if ('published'   in data) item.published   = Boolean(data.published);
    if ('password'    in data && data.password) {
      item.passwordHash = await hashPassword(String(data.password));
    }

    await saveProjects(list);
    return json(res, 200, { ...item, passwordHash: undefined });
  }

  // DELETE /api/projects/:id
  const projectDel = path_.match(/^\/api\/projects\/([a-z0-9]+)$/);
  if (projectDel && method === 'DELETE') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Nicht authentifiziert' });
    const id = projectDel[1];

    const list = await readProjects();
    const idx  = list.findIndex(p => p.id === id);
    if (idx === -1) return json(res, 404, { error: 'Nicht gefunden' });

    list.splice(idx, 1);
    await saveProjects(list);
    return json(res, 200, { ok: true });
  }

  // POST /api/preview/:slug/auth (public — verify preview password)
  const previewAuth = path_.match(/^\/api\/preview\/([a-z0-9-]+)\/auth$/);
  if (previewAuth && method === 'POST') {
    const slug = previewAuth[1];
    let data;
    try { data = await readJson(req); } catch { return json(res, 400, { error: 'Ungültiges JSON' }); }

    const ip = getClientIp(req);
    const rateLimitKey = `preview:${ip}:${slug}`;
    if (!allowLogin(rateLimitKey)) {
      return json(res, 429, { error: 'Zu viele Versuche.' });
    }

    const projects = await readProjects();
    const project = projects.find(p => p.slug === slug && p.published);
    if (!project) return json(res, 404, { error: 'Nicht gefunden' });

    const ok = await verifyPassword(String(data.password || ''), project.passwordHash);
    if (!ok) {
      recordFailedLogin(rateLimitKey);
      return json(res, 401, { error: 'Falsches Passwort' });
    }

    loginAttempts.delete(rateLimitKey);
    const token = createPreviewSession(slug);
    const cookieName = `dp_prev_${slug.replace(/[^a-z0-9]/gi, '_')}`;
    setCookie(res, cookieName, token, PREVIEW_TTL);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Route not found' });
}

// ── Preview page ──────────────────────────────────────
async function handlePreviewPage(slug, req, res) {
  if (!isValidSlug(slug)) return html(res, 404, '<h1>Not found</h1>');

  const projects = await readProjects();
  const project = projects.find(p => p.slug === slug && p.published);
  if (!project) return html(res, 404, renderPreviewNotFound());

  const token = getPreviewCookie(req, slug);
  const authed = isPreviewSession(slug, token);

  if (!authed) return html(res, 200, renderPreviewLogin(slug, project.title));

  // Remove X-Frame-Options for the preview iframe's parent
  res.removeHeader('X-Frame-Options');
  return html(res, 200, renderPreviewFrame(project));
}

function renderPreviewLogin(slug, title) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(title)} — Vorschau</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#080808;color:#f0f0f0;font-family:'Helvetica Neue',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .box{border:1px solid #242424;padding:3rem;width:100%;max-width:400px}
    .label{font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:#666;margin-bottom:2rem;display:block}
    h1{font-size:1.5rem;font-weight:700;text-transform:uppercase;letter-spacing:-.02em;margin-bottom:.5rem}
    .sub{font-size:.875rem;color:#666;margin-bottom:2rem;line-height:1.6}
    input{width:100%;background:#111;border:1px solid #242424;color:#f0f0f0;padding:.875rem 1rem;font-size:1rem;outline:none;margin-bottom:1rem;font-family:inherit}
    input:focus{border-color:#555}
    button{width:100%;background:#f0f0f0;color:#080808;border:none;padding:.875rem;font-size:.75rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;font-family:inherit}
    button:hover{background:#ccc}
    .error{font-size:.8rem;color:#ff6b6b;margin-bottom:1rem;display:none}
    .error.show{display:block}
    .back{display:block;margin-top:1.5rem;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#444;text-decoration:none;text-align:center}
    .back:hover{color:#f0f0f0}
  </style>
</head>
<body>
  <div class="box">
    <span class="label">Kundenvorschau</span>
    <h1>${escHtml(title)}</h1>
    <p class="sub">Diese Seite ist passwortgeschützt. Bitte Zugangscode eingeben.</p>
    <div class="error" id="err"></div>
    <input type="password" id="pw" placeholder="Passwort" autocomplete="current-password" autofocus/>
    <button onclick="submit()">Zugang anfordern</button>
    <a href="/" class="back">← Zurück zur Website</a>
  </div>
  <script>
    async function submit() {
      const pw = document.getElementById('pw').value;
      const err = document.getElementById('err');
      err.classList.remove('show');
      if (!pw) return;
      try {
        const r = await fetch('/api/preview/${escHtml(slug)}/auth', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ password: pw })
        });
        if (r.ok) { location.reload(); return; }
        const d = await r.json();
        err.textContent = d.error || 'Fehler';
        err.classList.add('show');
      } catch { err.textContent = 'Verbindungsfehler'; err.classList.add('show'); }
    }
    document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  </script>
</body>
</html>`;
}

function renderPreviewFrame(project) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(project.title)} — Vorschau</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#080808;display:flex;flex-direction:column;height:100vh;overflow:hidden}
    .bar{height:48px;background:#111;border-bottom:1px solid #242424;display:flex;align-items:center;justify-content:space-between;padding:0 1.5rem;flex-shrink:0}
    .bar-left{display:flex;align-items:center;gap:1rem}
    .bar-badge{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:#666;border:1px solid #242424;padding:.25rem .6rem}
    .bar-title{font-size:.875rem;font-weight:600;color:#f0f0f0}
    .bar-right a{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#444;text-decoration:none;padding:.4rem .8rem;border:1px solid #242424;transition:color .2s,border-color .2s}
    .bar-right a:hover{color:#f0f0f0;border-color:#555}
    iframe{flex:1;width:100%;border:none;background:#fff}
  </style>
</head>
<body>
  <div class="bar">
    <div class="bar-left">
      <span class="bar-badge">Vorschau</span>
      <span class="bar-title">${escHtml(project.title)}</span>
    </div>
    <div class="bar-right">
      <a href="/">← Depalomi.com</a>
    </div>
  </div>
  <iframe src="${escHtml(project.previewUrl)}" title="${escHtml(project.title)}" allowfullscreen></iframe>
</body>
</html>`;
}

function renderPreviewNotFound() {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"/><title>Nicht gefunden</title>
  <style>body{background:#080808;color:#f0f0f0;font-family:'Helvetica Neue',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}</style>
  </head><body><div style="text-align:center"><p style="font-size:.7rem;letter-spacing:.15em;text-transform:uppercase;color:#666;margin-bottom:1rem">404</p><h1 style="font-size:2rem;font-weight:700">Vorschau nicht gefunden</h1><a href="/" style="display:inline-block;margin-top:2rem;font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:#666;text-decoration:none;border-bottom:1px solid #242424;padding-bottom:2px">← Zurück</a></div></body></html>`;
}

// ── Static file server ─────────────────────────────────
async function serveFile(filePath, req, res) {
  let s;
  try {
    s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      s = await stat(filePath);
    }
  } catch {
    return serve404(res);
  }
  streamFile(filePath, s.size, req, res);
}

async function serveStatic(requestPath, req, res) {
  const cleanRoute = await resolveCleanRoute(requestPath);
  if (cleanRoute.redirectTo) {
    return redirect(res, cleanRoute.redirectTo);
  }
  if (cleanRoute.filePath) {
    return serveFile(cleanRoute.filePath, req, res);
  }

  let filePath;

  if (requestPath.startsWith('/uploads/')) {
    // Serve only a flat filename — no subdirectories allowed
    const filename = path.basename(requestPath);
    filePath = path.join(UPLOADS_DIR, filename);
    // Confirm resolved path stays inside UPLOADS_DIR
    if (!path.resolve(filePath).startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
      return serve404(res);
    }
  } else {
    const rel  = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    filePath   = path.resolve(PUBLIC_DIR, rel);
    // Reject any path that escapes PUBLIC_DIR (path traversal guard)
    if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep) &&
        filePath !== path.resolve(PUBLIC_DIR)) {
      return serve404(res);
    }
  }

  let s;
  try {
    s = await stat(filePath);
    if (s.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      s = await stat(filePath);
    }
  } catch {
    return serve404(res);
  }

  streamFile(filePath, s.size, req, res);
}

async function resolveCleanRoute(requestPath) {
  if (requestPath === '/index.html') {
    return { redirectTo: '/' };
  }

  const htmlMatch = requestPath.match(/^\/([a-z0-9-]+)\.html$/i);
  if (htmlMatch) {
    const htmlFile = path.join(PUBLIC_DIR, `${htmlMatch[1]}.html`);
    try {
      const s = await stat(htmlFile);
      if (s.isFile()) return { redirectTo: `/${htmlMatch[1]}/` };
    } catch {
      return {};
    }
  }

  const cleanMatch = requestPath.match(/^\/([a-z0-9-]+)(\/)?$/i);
  if (!cleanMatch) return {};

  const slug = cleanMatch[1];
  const htmlFile = path.join(PUBLIC_DIR, `${slug}.html`);

  try {
    const s = await stat(htmlFile);
    if (!s.isFile()) return {};
    if (!cleanMatch[2]) return { redirectTo: `/${slug}/` };
    return { filePath: htmlFile };
  } catch {
    return {};
  }
}

function streamFile(filePath, fileSize, req, res) {
  const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers['range'];

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); res.end(); return; }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end   = m[2] ? parseInt(m[2], 10) : fileSize - 1;
    if (start > end || end >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }); res.end(); return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Cache-Control': contentType.startsWith('image') ? 'public, max-age=86400' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

async function serve500(res) {
  const p = path.join(PUBLIC_DIR, '500.html');
  res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
  try {
    await stat(p);
    createReadStream(p).pipe(res);
  } catch {
    res.end('<h1 style="font-family:sans-serif">500 Internal Server Error</h1>');
  }
}

async function serve404(res) {
  const p = path.join(PUBLIC_DIR, '404.html');
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  try {
    await stat(p);
    createReadStream(p).pipe(res);
  } catch {
    res.end('<h1 style="font-family:sans-serif">404 Not Found</h1>');
  }
}

// ── HTML escape ───────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAspectRatio(value) {
  return ['auto', '16:9', '9:16'].includes(value) ? value : 'auto';
}
