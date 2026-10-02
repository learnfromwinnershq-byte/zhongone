// 中一 · 自學系統 — zero-dependency Node.js server (Node 18+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const LESSON_DIR = path.join(DATA_DIR, 'lessons');
const DB_FILE = path.join(DATA_DIR, 'lessons.json');
const MAX_UPLOAD = 20 * 1024 * 1024;
const SUBJECTS = ['數學', '中文', '英文', '科學', '其他'];

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn(`[中一] ADMIN_PASSWORD 未設定，今次臨時密碼：${ADMIN_PASSWORD}`);
}
const SECRET = crypto.createHash('sha256').update('zhongone:' + ADMIN_PASSWORD).digest();

/* ---------- storage ---------- */
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; } }
function saveDB(list) { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, DB_FILE); }
function init() {
  fs.mkdirSync(LESSON_DIR, { recursive: true });
  if (loadDB()) return;
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'seed.json'), 'utf8'));
  seed.forEach(l => fs.copyFileSync(path.join(__dirname, 'seed', 'lessons', l.id + '.html'), path.join(LESSON_DIR, l.id + '.html')));
  saveDB(seed);
  console.log(`[中一] 已載入 ${seed.length} 個初始課件`);
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
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
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

    const lm = /^\/lesson\/([a-z0-9-]+)$/.exec(p);
    if (method === 'GET' && lm) {
      if (!(loadDB() || []).some(l => l.id === lm[1])) return send(res, 404, '搵唔到呢個課件');
      // Uploaded HTML runs sandboxed (opaque origin) so it can never touch admin cookies or the API.
      return sendFile(res, path.join(LESSON_DIR, lm[1] + '.html'), 'text/html; charset=utf-8',
        { 'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-presentation' });
    }

    if (method === 'POST' && p === '/api/login') {
      const ip = clientIP(req), f = fails.get(ip);
      if (f && f.until > Date.now()) return send(res, 429, { error: '試太多次，請稍後再試' });
      const { password = '' } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      if (!safeEq(String(password), ADMIN_PASSWORD)) {
        const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60e3 : 0 });
        return send(res, 401, { error: '密碼唔啱' });
      }
      fails.delete(ip);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `zo_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
    }
    if (method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'zo_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });

    if (p.startsWith('/api/lessons') && !isAdmin(req)) return send(res, 401, { error: '請先登入' });

    if (method === 'POST' && p === '/api/lessons') {
      const buf = await readBody(req, MAX_UPLOAD);
      const html = buf.toString('utf8');
      if (!/<html|<!doctype|<body|<script|<div/i.test(html)) return send(res, 400, { error: '唔似係 HTML 檔案' });
      let title = hdr(req, 'x-title');
      if (!title) { const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html); title = (m && m[1].trim()) || '未命名課件'; }
      const subject = SUBJECTS.includes(hdr(req, 'x-subject')) ? hdr(req, 'x-subject') : '其他';
      const id = 's1-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      fs.writeFileSync(path.join(LESSON_DIR, id + '.html'), buf);
      const list = loadDB() || [];
      const lesson = { id, title: title.slice(0, 120), desc: hdr(req, 'x-desc').slice(0, 200), subject, createdAt: new Date().toISOString() };
      list.push(lesson); saveDB(list);
      return send(res, 201, lesson);
    }
    const dm = /^\/api\/lessons\/([a-z0-9-]+)$/.exec(p);
    if (method === 'DELETE' && dm) {
      const list = loadDB() || [], i = list.findIndex(l => l.id === dm[1]);
      if (i < 0) return send(res, 404, { error: '搵唔到' });
      list.splice(i, 1); saveDB(list);
      fs.rmSync(path.join(LESSON_DIR, dm[1] + '.html'), { force: true });
      return send(res, 200, { ok: true });
    }
    send(res, 404, '搵唔到');
  } catch (e) {
    send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? '檔案太大（上限 20MB）' : '伺服器錯誤' });
    if (e.code !== 413) console.error(e);
  }
});

init();
server.listen(PORT, HOST, () => console.log(`[中一] http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
