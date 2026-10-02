// 中一 · 自學系統 — zero-dependency Node.js server (Node 18+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const LESSON_DIR = path.join(DATA_DIR, 'lessons');
const DB_FILE = path.join(DATA_DIR, 'lessons.json');
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const MAX_UNZIPPED = 3 * MAX_UPLOAD;
const MAX_FILES = 3000;
const SUBJECTS = ['數學', '中文', '英文', '科學', '其他'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn(`[中一] ADMIN_PASSWORD 未設定，今次臨時密碼：${ADMIN_PASSWORD}`);
}
const SECRET = crypto.createHash('sha256').update('zhongone:' + ADMIN_PASSWORD).digest();
const bad = (msg, code = 400) => Object.assign(new Error(msg), { status: code, expose: true });

/* ---------- storage: each lesson = data/lessons/<id>/ + entry html ---------- */
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; } }
function saveDB(list) { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, DB_FILE); }
function init() {
  fs.mkdirSync(LESSON_DIR, { recursive: true });
  let list = loadDB();
  if (!list) {
    list = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'seed.json'), 'utf8'));
    list.forEach(l => fs.cpSync(path.join(__dirname, 'seed', 'lessons', l.id), path.join(LESSON_DIR, l.id), { recursive: true }));
    saveDB(list);
    console.log(`[中一] 已載入 ${list.length} 個初始課件`);
    return;
  }
  // migrate v1 layout (data/lessons/<id>.html) → data/lessons/<id>/index.html
  let changed = false;
  list.forEach(l => {
    const old = path.join(LESSON_DIR, l.id + '.html'), dir = path.join(LESSON_DIR, l.id);
    if (!fs.existsSync(dir) && fs.existsSync(old)) { fs.mkdirSync(dir); fs.renameSync(old, path.join(dir, 'index.html')); changed = true; }
    if (!l.entry) { l.entry = 'index.html'; changed = true; }
  });
  if (changed) saveDB(list);
}

/* ---------- zip extraction (stored + deflate, no zip64) ---------- */
function unzip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw bad('唔係有效嘅 zip 檔案');
  const count = buf.readUInt16LE(e + 10), cdOff = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw bad('唔支援 zip64，請將檔案分細啲');
  if (count > MAX_FILES) throw bad(`檔案太多（上限 ${MAX_FILES} 個）`);
  const out = []; let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('zip 格式錯誤');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw bad('唔支援加密 zip');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad('zip 格式錯誤');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, MAX_UNZIPPED - total) }); }
      catch { throw bad('解壓失敗或者解壓後太大'); }
    } else throw bad('唔支援呢種壓縮方式，請用普通 zip');
    total += data.length;
    if (total > MAX_UNZIPPED) throw bad('解壓後太大');
    out.push({ name, data });
  }
  return out;
}
// clean, safe relative paths; drop macOS junk; strip a single shared top-level folder
function normalizeEntries(entries) {
  let files = [];
  for (const { name, data } of entries) {
    const parts = name.replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
    if (!parts.length || parts.includes('..') || /^[a-zA-Z]:$/.test(parts[0])) continue;
    if (parts[0] === '__MACOSX' || parts.some(s => s === '.DS_Store' || s.startsWith('._') || s === 'Thumbs.db')) continue;
    files.push({ parts, data });
  }
  while (files.length && files.every(f => f.parts.length > 1 && f.parts[0] === files[0].parts[0])) files.forEach(f => f.parts.shift());
  return files.map(f => ({ rel: f.parts.join('/'), data: f.data }));
}
function pickEntry(files) {
  const htmls = files.map(f => f.rel).filter(r => /\.html?$/i.test(r));
  if (!htmls.length) throw bad('入面搵唔到 .html 檔案');
  const depth = r => r.split('/').length;
  return htmls.find(r => /^index\.html?$/i.test(r))
    || htmls.sort((a, b) => depth(a) - depth(b) || (/index\.html?$/i.test(b) - /index\.html?$/i.test(a)) || a.localeCompare(b))[0];
}

/* ---------- auth (HMAC-signed cookie) ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() { const exp = Date.now() + 7 * 864e5; return `${exp}.${sign(String(exp))}`; }
function isAdmin(req) {
  const m = /(?:^|;\s*)zo_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || +exp < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map(); // ip -> {n, until}
function safeEq(a, b) { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); }

/* ---------- helpers ---------- */
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(bad(`檔案太大（上限 ${limit / 1048576 | 0}MB）`, 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendFile(res, file, type, extra = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '搵唔到');
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  });
}
const clientIP = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const hdr = (req, k) => { try { return decodeURIComponent(req.headers[k] || '').trim(); } catch { return ''; } };
// Lesson files run sandboxed (opaque origin): they can never touch admin cookies or the API.
// Because the origin is opaque, sub-resources need CORS (module scripts, fetch, fonts).
const LESSON_HEADERS = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-presentation',
  'Access-Control-Allow-Origin': '*',
};

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  try {
    if (method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (method === 'GET' && p === '/admin') return sendFile(res, path.join(__dirname, 'public', 'admin.html'), 'text/html; charset=utf-8');
    if (method === 'GET' && p === '/healthz') return send(res, 200, 'ok');

    if (method === 'GET' && p === '/api/lessons') return send(res, 200, { subjects: SUBJECTS, lessons: loadDB() || [] });
    if (method === 'GET' && p === '/api/me') return send(res, 200, { admin: isAdmin(req) });

    const lm = /^\/lesson\/([a-z0-9-]+)(\/.*)?$/.exec(p);
    if (method === 'GET' && lm) {
      const lesson = (loadDB() || []).find(l => l.id === lm[1]);
      if (!lesson) return send(res, 404, '搵唔到呢個課件');
      const entry = lesson.entry || 'index.html';
      const rest = lm[2] || '';
      if (!rest) return send(res, 301, '', { Location: `/lesson/${lesson.id}/` + url.search });
      if (rest === '/') {
        if (entry.includes('/')) return send(res, 302, '', { Location: `/lesson/${lesson.id}/${entry.split('/').map(encodeURIComponent).join('/')}` });
        return sendFile(res, path.join(LESSON_DIR, lesson.id, entry), MIME['.html'], LESSON_HEADERS);
      }
      const root = path.join(LESSON_DIR, lesson.id);
      let rel; try { rel = decodeURIComponent(rest); } catch { return send(res, 400, 'bad path'); }
      let file = path.resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'forbidden');
      try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { return send(res, 404, '搵唔到'); }
      return sendFile(res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', LESSON_HEADERS);
    }

    if (method === 'POST' && p === '/api/login') {
      const ip = clientIP(req), f = fails.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, { error: '試太多次，請稍後再試' });
      let password = '';
      try { password = String(JSON.parse((await readBody(req, 4096)).toString() || '{}').password || ''); } catch { }
      if (!safeEq(password, ADMIN_PASSWORD)) {
        const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60e3 : 0 });
        return send(res, 401, { error: '密碼唔啱' });
      }
      fails.delete(ip);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `zo_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
    }
    if (method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'zo_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });

    if (p.startsWith('/api/lessons') && !isAdmin(req)) return send(res, 401, { error: '請先登入' });

    // Upload: body is either a single HTML file, or a zip (uploaded directly or packed by the admin page).
    if (method === 'POST' && p === '/api/lessons') {
      const buf = await readBody(req, MAX_UPLOAD);
      const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5);
      let files;
      if (isZip) files = normalizeEntries(unzip(buf));
      else {
        if (!/<html|<!doctype|<body|<script|<div/i.test(buf.toString('utf8', 0, 65536))) throw bad('唔似係 HTML 或 zip 檔案');
        files = [{ rel: 'index.html', data: buf }];
      }
      if (!files.length) throw bad('冇可用嘅檔案');
      const entry = pickEntry(files);
      const entryHtml = files.find(f => f.rel === entry).data.toString('utf8');
      let title = hdr(req, 'x-title');
      if (!title) { const m = /<title[^>]*>([^<]*)<\/title>/i.exec(entryHtml); title = (m && m[1].trim()) || '未命名課件'; }
      const subject = SUBJECTS.includes(hdr(req, 'x-subject')) ? hdr(req, 'x-subject') : '其他';
      const id = 's1-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const tmp = path.join(LESSON_DIR, '.tmp-' + id), dest = path.join(LESSON_DIR, id);
      try {
        for (const f of files) {
          const target = path.resolve(tmp, f.rel);
          if (!target.startsWith(tmp + path.sep)) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, f.data);
        }
        fs.renameSync(tmp, dest);
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
      const list = loadDB() || [];
      const lesson = { id, title: title.slice(0, 120), desc: hdr(req, 'x-desc').slice(0, 200), subject, entry, files: files.length, createdAt: new Date().toISOString() };
      list.push(lesson); saveDB(list);
      return send(res, 201, lesson);
    }
    const dm = /^\/api\/lessons\/([a-z0-9-]+)$/.exec(p);
    if (method === 'DELETE' && dm) {
      const list = loadDB() || [], i = list.findIndex(l => l.id === dm[1]);
      if (i < 0) return send(res, 404, { error: '搵唔到' });
      list.splice(i, 1); saveDB(list);
      fs.rmSync(path.join(LESSON_DIR, dm[1]), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    send(res, 404, '搵唔到');
  } catch (e) {
    if (e.expose) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: '伺服器錯誤' });
  }
});

init();
server.listen(PORT, HOST, () => console.log(`[中一] http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
