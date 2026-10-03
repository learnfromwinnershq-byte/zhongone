#!/usr/bin/env node
// Export a lesson as MP4: full landscape (1920×1080) + vertical per-chapter clips (1080×1920, for Douyin).
//
//   node tools/render_video.mjs [lessonDir] [--only=landscape|vertical] [--chapters=1,3] [--workers=4]
//                               [--fps=30] [--out=dist/<id>] [--tag=<release tag>] [--release]
//
// Needs Google Chrome (or CHROME_PATH) and ffmpeg. No API key: narration comes from the lesson's
// pre-recorded audio/ (tools/build_voice.mjs). Frames are captured deterministically: the page's
// render mode pauses every CSS animation and positions it on the lesson clock, so each frame is exact
// no matter how slowly it is captured. Finished chapter videos are reused, so an interrupted run resumes.
// --release uploads the MP4s + covers to a GitHub Release (gh CLI) and injects window.LESSON_VIDEO
// into the lesson so its player shows a "下載 MP4" menu.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const lessonDir = path.resolve(args.find(a => !a.startsWith('--')) || path.join(ROOT, 'seed/lessons/s1-math-directed-numbers'));
const lessonId = path.basename(lessonDir);
const FPS = +opt('fps', 30);
const WORKERS = +opt('workers', Math.max(1, Math.min(4, os.cpus().length - 2)));
const OUT = path.resolve(opt('out', path.join(ROOT, 'dist', lessonId)));
const WORK = path.join(OUT, '.work');
const LAYOUTS = opt('only') ? [opt('only')] : ['landscape', 'vertical'];
const ONLY_CH = opt('chapters') ? opt('chapters').split(',').map(Number) : null;
const TAG = opt('tag', `${lessonId}-video`);
const SERIES = opt('series', '中一 · S.1 數學');
const TITLE = opt('title', '有向數嘅乘法同除法');
const SIZE = { landscape: [1920, 1080], vertical: [1080, 1920] };
const SR = 48000;

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('搵唔到 Chrome，請設定 CHROME_PATH'); process.exit(1); }

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...o });

/* ---------------- minimal Chrome DevTools Protocol client ---------------- */
class Page {
  static async open(w, h) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zo-chrome-'));
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--mute-audio', `--window-size=${w},${h}`, '--force-device-scale-factor=1', '--allow-file-access-from-files',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>'] : []), 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await sleep(50);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws, proc, dir);
    await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    return p;
  }
  constructor(ws, proc, dir) {
    Object.assign(this, { ws, proc, dir, id: 0, pending: new Map() });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async load(url, layout) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 400; i++) { if (await this.eval(`document.readyState === 'complete' && !!window.__render`).catch(() => false)) break; await sleep(50); }
    return this.eval(`window.__render.setup(${JSON.stringify({ layout, series: SERIES, title: TITLE })})`);
  }
  async close() { try { this.ws.close(); } catch { } this.proc.kill('SIGKILL'); await sleep(200); fs.rmSync(this.dir, { recursive: true, force: true }); }
}

/* ---------------- frame capture → ffmpeg ---------------- */
const frameRange = ch => [Math.ceil(ch.start * FPS - 1e-6), Math.ceil(ch.end * FPS - 1e-6)];
async function renderChapter(page, layout, ch, file, onFrame) {
  const [n0, n1] = frameRange(ch);
  const tmp = file + '.part.mp4';
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-g', String(FPS * 2),
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-an', tmp], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg exit ' + c))));
  await page.eval(`window.__render.jump(${n0 / FPS})`);
  for (let n = n0; n < n1; n++) {
    await page.eval(`window.__render.frame(${n / FPS})`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true });
    if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    onFrame();
  }
  ff.stdin.end(); await done;
  fs.renameSync(tmp, file);
}

/* ---------------- audio: narration clips + synthesized SFX on the timeline ---------------- */
function decodeClip(file) {
  const raw = run('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-']);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}
function addTone(buf, at, f1, f2, d, g, type = 'sine') {
  const s0 = Math.round(at * SR), len = Math.round((d + 0.05) * SR); let ph = 0;
  for (let i = 0; i < len && s0 + i < buf.length; i++) {
    const tt = i / SR, f = f2 ? f1 * Math.pow(f2 / f1, Math.min(1, tt / d)) : f1;
    ph += 2 * Math.PI * f / SR;
    const env = tt < 0.012 ? 0.0001 * Math.pow(g / 0.0001, tt / 0.012) : tt < d ? g * Math.pow(0.0001 / g, (tt - 0.012) / (d - 0.012)) : 0;
    const x = ph / (2 * Math.PI) % 1;
    const w = type === 'square' ? (x < 0.5 ? 1 : -1) : type === 'triangle' ? 1 - 4 * Math.abs(x - 0.5) : Math.sin(ph);
    buf[s0 + i] += w * env;
  }
}
function addWhoosh(buf, at) {
  const s0 = Math.round(at * SR), len = Math.round(0.45 * SR); let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0, b2, a1, a2;
  for (let i = 0; i < len && s0 + i < buf.length; i++) {
    if (i % 64 === 0) { // band-pass sweeping 400 → 2400 Hz
      const f = 400 * Math.pow(6, i / len), w0 = 2 * Math.PI * f / SR, al = Math.sin(w0) / (2 * 1.2), a0 = 1 + al;
      b0 = al / a0; b2 = -al / a0; a1 = -2 * Math.cos(w0) / a0; a2 = (1 - al) / a0;
    }
    const x = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / len);
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[s0 + i] += y * 0.05;
  }
}
const SFX = {
  pop: (b, t) => addTone(b, t, 520, 860, 0.12, 0.045),
  ding: (b, t) => { addTone(b, t, 880, 0, 0.55, 0.04); addTone(b, t + 0.09, 1318, 0, 0.7, 0.028); },
  tick: (b, t) => addTone(b, t, 1400, 0, 0.035, 0.018, 'square'),
  wrong: (b, t) => addTone(b, t, 320, 210, 0.28, 0.04, 'triangle'),
  whoosh: addWhoosh,
};
function buildAudio(tl, file) {
  const buf = new Float32Array(Math.ceil((tl.total + 1) * SR));
  const audioDir = path.join(lessonDir, tl.audioBase || 'audio/');
  for (const c of tl.cues) {
    if (c.rec) { const pcm = decodeClip(path.join(audioDir, c.rec)); buf.set(pcm.subarray(0, Math.max(0, buf.length - Math.round(c.start * SR))), Math.round(c.start * SR)); }
    if (c.sfx && SFX[c.sfx]) SFX[c.sfx](buf, c.start);
    if (c.think) { SFX.tick(buf, c.start); for (let k = 3; k >= 1; k--) if (c.end - k > c.start + 0.5) SFX.tick(buf, c.end - k); }
  }
  for (const s of tl.steps) if (SFX[s.sfx]) SFX[s.sfx](buf, s.t);
  const pcm = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

/* ---------------- main ---------------- */
fs.mkdirSync(WORK, { recursive: true });
const url = pathToFileURL(path.join(lessonDir, 'index.html')).href;
const probe = await Page.open(...SIZE.landscape);
const tl = await probe.load(url, 'landscape');
await probe.close();
const chapters = tl.chapters.filter(c => !ONLY_CH || ONLY_CH.includes(c.no));
const pad = n => String(n).padStart(2, '0');
const vid = (layout, ch) => path.join(WORK, `${layout}-ch${pad(ch.no)}.mp4`);
log(`課件：${tl.title}（${(tl.total / 60).toFixed(1)} 分鐘，${tl.chapters.length} 章）  輸出：${path.relative(ROOT, OUT)}`);

// 1. frames (resumable, parallel)
const jobs = LAYOUTS.flatMap(layout => chapters.map(ch => ({ layout, ch }))).filter(j => !fs.existsSync(vid(j.layout, j.ch)));
const totalFrames = jobs.reduce((s, j) => { const [a, b] = frameRange(j.ch); return s + b - a; }, 0);
if (jobs.length) {
  log(`渲染 ${jobs.length} 段，共 ${totalFrames} 格（${WORKERS} 個 Chrome 並行）…`);
  let doneFrames = 0; const t0 = Date.now();
  const tick = setInterval(() => {
    const el = (Date.now() - t0) / 1000, rate = doneFrames / el;
    process.stdout.write(`\r  ${doneFrames}/${totalFrames} 格  ${rate.toFixed(1)} fps  剩餘約 ${rate ? Math.round((totalFrames - doneFrames) / rate / 60) : '?'} 分鐘   `);
  }, 2000);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, async () => {
    let page = null, layout = null;
    while (next < jobs.length) {
      const job = jobs[next++];
      if (layout !== job.layout) { if (page) await page.close(); page = await Page.open(...SIZE[job.layout]); await page.load(url, job.layout); layout = job.layout; }
      await renderChapter(page, job.layout, job.ch, vid(job.layout, job.ch), () => doneFrames++);
    }
    if (page) await page.close();
  }));
  clearInterval(tick); process.stdout.write('\n');
}

// 2. audio
const wav = path.join(WORK, 'narration.wav');
log('合成音軌（旁白 + 音效）…');
buildAudio(tl, wav);

// 3. outputs
const items = [];
const probeDur = f => +run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
const aac = ['-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2', '-movflags', '+faststart'];
if (LAYOUTS.includes('landscape') && !ONLY_CH) {
  const list = path.join(WORK, 'landscape.txt'), file = `${lessonId}-full-1080p.mp4`;
  fs.writeFileSync(list, tl.chapters.map(c => `file '${vid('landscape', c).replace(/'/g, "'\\''")}'`).join('\n'));
  log('輸出完整橫版…');
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...aac, '-shortest', path.join(OUT, file)]);
  items.push({ kind: 'landscape', label: `完整版（${tl.chapters.length} 章）`, file });
}
if (LAYOUTS.includes('vertical')) {
  fs.mkdirSync(path.join(OUT, 'covers'), { recursive: true });
  for (const ch of chapters) {
    const [n0, n1] = frameRange(ch), file = `${lessonId}-ep${pad(ch.no)}.mp4`;
    log(`輸出直版 第 ${ch.no} 集：${ch.name}`);
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', vid('vertical', ch), '-ss', (n0 / FPS).toFixed(4), '-t', ((n1 - n0) / FPS).toFixed(4), '-i', wav,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...aac, '-shortest', path.join(OUT, file)]);
    // cover: the moment just before the chapter's last line, when its board is fully built
    const lastCue = tl.cues.filter(c => c.start >= ch.start && c.start < ch.end).pop();
    const at = Math.max(0.5, Math.min(lastCue.start - ch.start + 0.9, (n1 - n0) / FPS - 0.2));
    run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', path.join(OUT, file), '-frames:v', '1', '-q:v', '2', path.join(OUT, 'covers', `${lessonId}-ep${pad(ch.no)}.jpg`)]);
    items.push({ kind: 'vertical', label: `第 ${ch.no} 集 · ${ch.name}`, file, no: ch.no });
  }
}
for (const it of items) { const f = path.join(OUT, it.file); it.dur = +probeDur(f).toFixed(1); it.size = fs.statSync(f).size; }
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ lesson: lessonId, tag: TAG, items }, null, 2));
log(`完成：${items.length} 個 MP4 → ${path.relative(ROOT, OUT)}/`);
items.forEach(it => log(`  ${it.file}  ${Math.floor(it.dur / 60)}:${String(Math.round(it.dur % 60)).padStart(2, '0')}  ${(it.size / 1048576).toFixed(1)} MB`));

// 4. optional: publish to GitHub Release + inject download menu into the lesson
if (args.includes('--release')) {
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: ROOT }).toString().trim();
  const assets = [...items.map(i => path.join(OUT, i.file)), ...fs.readdirSync(path.join(OUT, 'covers')).map(f => path.join(OUT, 'covers', f))];
  let exists = true; try { run('gh', ['release', 'view', TAG], { cwd: ROOT }); } catch { exists = false; }
  if (!exists) run('gh', ['release', 'create', TAG, '--title', `${TITLE} · MP4`, '--notes', `${tl.title} 教學影片：完整橫版 1080p + 抖音直版分集（1080×1920）＋封面。由 tools/render_video.mjs 生成。`], { cwd: ROOT });
  log(`上載 ${assets.length} 個檔案到 GitHub Release ${TAG}…`);
  run('gh', ['release', 'upload', TAG, ...assets, '--clobber'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  const manifest = { local: 'video/', release: `https://github.com/${repo}/releases/download/${TAG}/`, items: items.map(({ kind, label, file, dur, size }) => ({ kind, label, file, dur, size })) };
  const indexFile = path.join(lessonDir, 'index.html');
  let html = fs.readFileSync(indexFile, 'utf8');
  const tag = `<script id="lesson-video">window.LESSON_VIDEO = ${JSON.stringify(manifest)};</script>`;
  if (/<script id="lesson-video">[\s\S]*?<\/script>/.test(html)) html = html.replace(/<script id="lesson-video">[\s\S]*?<\/script>/, () => tag);
  else html = html.replace(/<script>\s*\/\* =+\s*\n\s*1\. CONTENT HELPERS/, m => tag + '\n' + m);
  fs.writeFileSync(indexFile, html);
  log(`已喺課件注入下載選單（${items.length} 個 MP4）`);
}
