#!/usr/bin/env node
// Generate Cantonese narration for a lesson with Google Cloud Text-to-Speech.
//
//   GOOGLE_TTS_API_KEY=... node tools/build_voice.mjs [lessonDir] [--voice=NAME] [--rate=1.0] [--list]
//
// lessonDir defaults to seed/lessons/s1-math-directed-numbers. The script reads every
// narration line (cue.say) from the lesson's index.html, synthesizes each one as MP3,
// writes <lessonDir>/audio/*.mp3 and injects window.LESSON_AUDIO into index.html so the
// player uses the recorded voice (timeline durations come from the real clip lengths).
// The API key is read from the environment only. Clips are cached in .cache/tts so
// re-running (or changing one line) only bills new/changed lines.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = k => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const lessonDir = path.resolve(args.find(a => !a.startsWith('--')) || path.join(ROOT, 'seed/lessons/s1-math-directed-numbers'));
const RATE = +(opt('rate') || 1.0);
const KEY = process.env.GOOGLE_TTS_API_KEY || '';
const CACHE = process.env.TTS_CACHE_DIR || path.join(ROOT, '.cache/tts');
const API = process.env.GOOGLE_TTS_API_BASE || 'https://texttospeech.googleapis.com/v1'; // override only for local testing

if (!KEY) { console.error('請先設定環境變數 GOOGLE_TTS_API_KEY'); process.exit(1); }

// HTTPS request that honours HTTPS_PROXY / HTTP_PROXY (Node's fetch ignores them).
function request(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const proxy = u.protocol === 'https:' && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  return new Promise((resolve, reject) => {
    const go = createConnection => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, headers, createConnection, timeout: 60000 }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('request timeout')));
      req.on('error', reject);
      req.end(body);
    };
    if (!proxy) return go(undefined);
    const p = new URL(proxy);
    const auth = p.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64') } : {};
    const tunnel = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, headers: auth, timeout: 30000 });
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
      go(() => tls.connect({ socket, servername: u.hostname }));
    });
    tunnel.on('timeout', () => tunnel.destroy(new Error('proxy timeout')));
    tunnel.on('error', reject);
    tunnel.end();
  });
}

async function api(pathname, body) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await request(API + pathname, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < 5) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
      throw new Error(`連唔到 Google TTS（${e.message}）；如需代理請設定 HTTPS_PROXY`);
    }
    if (res.status >= 200 && res.status < 300) return JSON.parse(res.text);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
    throw new Error(`Google TTS ${res.status}: ${res.text.slice(0, 400)}`);
  }
}

// Prefer the most natural Cantonese voices Google offers.
const RANK = [/Chirp3-HD/, /Chirp-HD/, /Neural2/, /Wavenet/, /Standard/];
async function pickVoice() {
  const { voices = [] } = await api('/voices?languageCode=yue-HK');
  const yue = voices.filter(v => v.languageCodes.some(l => /^yue/i.test(l)))
    .sort((a, b) => RANK.findIndex(r => r.test(a.name)) - RANK.findIndex(r => r.test(b.name)) || a.name.localeCompare(b.name));
  if (args.includes('--list')) {
    yue.forEach(v => console.log(`${v.name}\t${v.ssmlGender}\t${v.languageCodes.join(',')}`));
    process.exit(0);
  }
  if (!yue.length) throw new Error('呢個 API key 搵唔到任何 yue-HK 聲音');
  const want = opt('voice');
  const v = want ? yue.find(x => x.name === want) : yue.find(x => x.ssmlGender === 'FEMALE') || yue[0];
  if (!v) throw new Error(`搵唔到聲音 ${want}；可用：${yue.map(x => x.name).join(', ')}`);
  return v;
}

// Run the lesson's content + timeline code (sections 1–4) in a sandbox to get the narration lines.
function readNarration(html) {
  const start = html.indexOf('/* =====================================================================\n   1. CONTENT HELPERS');
  const end = html.indexOf('/* =====================================================================\n   5. STAGE ENGINE');
  if (start < 0 || end < 0) throw new Error('index.html 入面搵唔到課件腳本標記');
  const ctx = vm.createContext({
    window: {}, console,
    document: { createElement: () => ({ set innerHTML(v) { this._t = String(v).replace(/<[^>]+>/g, ''); }, get textContent() { return this._t; } }) },
  });
  vm.runInContext(html.slice(start, end) + '\n;globalThis.__out = { says: CUES.filter(c => c.say).map(c => c.say), key: voiceKey };', ctx);
  return ctx.__out;
}

// Duration of an MP3 by walking its frames (works for CBR and VBR).
function mp3Duration(buf) {
  let i = 0;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  let dur = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3, bri = buf[i + 2] >> 4, sri = (buf[i + 2] >> 2) & 3, pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const br = (ver === 3 ? BR1 : BR2)[bri] * 1000, sr = SR[ver][sri];
    dur += (ver === 3 ? 1152 : 576) / sr;
    i += Math.floor((ver === 3 ? 144 : 72) * br / sr) + pad;
  }
  return dur;
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

const indexFile = path.join(lessonDir, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
const { says, key } = readNarration(html);
const unique = [...new Set(says)];
const voice = await pickVoice();
console.log(`課件：${path.relative(ROOT, lessonDir)}\n聲音：${voice.name}（${voice.ssmlGender}）  語速：${RATE}\n句數：${unique.length}`);

fs.mkdirSync(CACHE, { recursive: true });
const audioDir = path.join(lessonDir, 'audio');
fs.mkdirSync(audioDir, { recursive: true });
const items = {};
let fresh = 0, done = 0;
await pool(unique, 4, async say => {
  const cacheFile = path.join(CACHE, crypto.createHash('sha256').update(`${voice.name}|${RATE}|${say}`).digest('hex').slice(0, 20) + '.mp3');
  if (!fs.existsSync(cacheFile)) {
    const { audioContent } = await api('/text:synthesize', {
      input: { text: say },
      voice: { languageCode: voice.languageCodes[0], name: voice.name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: RATE, sampleRateHertz: 24000 },
    });
    fs.writeFileSync(cacheFile, Buffer.from(audioContent, 'base64'));
    fresh++;
  }
  const buf = fs.readFileSync(cacheFile);
  const k = key(say), f = k + '.mp3';
  fs.writeFileSync(path.join(audioDir, f), buf);
  items[k] = { f, d: +mp3Duration(buf).toFixed(3) };
  process.stdout.write(`\r合成中 ${++done}/${unique.length}`);
});
process.stdout.write('\n');

// drop clips that no longer belong to any line
const keep = new Set(Object.values(items).map(x => x.f));
for (const f of fs.readdirSync(audioDir)) if (f.endsWith('.mp3') && !keep.has(f)) fs.rmSync(path.join(audioDir, f));

const manifest = { voice: voice.name, rate: RATE, base: 'audio/', items };
const tag = `<script id="lesson-audio">window.LESSON_AUDIO = ${JSON.stringify(manifest)};</script>`;
if (/<script id="lesson-audio">[\s\S]*?<\/script>/.test(html)) html = html.replace(/<script id="lesson-audio">[\s\S]*?<\/script>/, () => tag);
else html = html.replace(/<script>\s*\/\* =+\s*\n\s*1\. CONTENT HELPERS/, m => tag + '\n' + m);
if (!html.includes('id="lesson-audio"')) throw new Error('注入 LESSON_AUDIO 失敗');
fs.writeFileSync(indexFile, html);

const total = Object.values(items).reduce((s, x) => s + x.d, 0);
const bytes = [...keep].reduce((s, f) => s + fs.statSync(path.join(audioDir, f)).size, 0);
console.log(`完成：新合成 ${fresh} 句、快取 ${unique.length - fresh} 句；旁白共 ${(total / 60).toFixed(1)} 分鐘、${(bytes / 1048576).toFixed(1)} MB`);
console.log(`已寫入 ${path.relative(ROOT, audioDir)}/ 同 index.html`);
