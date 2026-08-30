/**
 * Simulates the GitHub Pages setup: the app served as plain static files from
 * one origin and a subpath (like /<repo>/), with the API on a different origin
 * entirely. Drives the whole flow in Chromium to prove the split works.
 *
 *   node scripts/pages-check.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const REPO_PATH = '/groups';                 // what Pages would use
const API_PORT = 8500 + Math.floor(Math.random() * 100);
const CDN_PORT = 8600 + Math.floor(Math.random() * 100);
const API = `http://127.0.0.1:${API_PORT}`;
const CDN = `http://127.0.0.1:${CDN_PORT}`;
const OUT = process.argv[2] || path.join(os.tmpdir(), 'groups-pages-shots');
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'groups-pages-'));
await fsp.mkdir(OUT, { recursive: true });

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

/* ------------------------------------------------- a dumb static host ---- */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Deliberately dumb: no templating, no API, exactly what a CDN gives you.
const cdn = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(`${REPO_PATH}/`) && url.pathname !== REPO_PATH) {
    res.writeHead(404).end('not found');
    return;
  }
  let rel = url.pathname.slice(REPO_PATH.length) || '/';
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => cdn.listen(CDN_PORT, '127.0.0.1', r));

const server = spawn(process.execPath, ['--no-warnings', 'server/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(API_PORT), DATA_DIR: DATA, INSECURE_COOKIES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${API}/api/health`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

const errors = [];
async function phone(geo) {
  const context = await browser.newContext({
    ...devices['iPhone 14 Pro'],
    permissions: ['geolocation'],
    geolocation: geo,
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

try {
  /* -------------------------------------------- landing with no server -- */

  const ada = await phone({ latitude: 52.52, longitude: 13.405 });
  await ada.goto(`${CDN}${REPO_PATH}/`, { waitUntil: 'domcontentloaded' });
  await ada.waitForSelector('#screen-connect.active', { timeout: 15000 });
  await ada.waitForTimeout(500);
  check('a static copy with no server shows the connect screen', true);
  await shot(ada, 'p1-connect');

  const manifest = await ada.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').href;
    const res = await fetch(href);
    return { href, ...(await res.json()) };
  });
  check('the manifest loads from the subpath', manifest.href.includes(`${REPO_PATH}/manifest`), manifest.href);
  check('and is scoped to it, so Add to Home Screen works',
    manifest.scope === './' && manifest.start_url === './',
    `${manifest.scope} / ${manifest.start_url}`);

  const sw = await ada.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.scope : null;
  });
  check('the service worker registers under the subpath',
    Boolean(sw && sw.endsWith(`${REPO_PATH}/`)), sw);

  /* ------------------------------------------------- connect and sign up -- */

  await ada.fill('#server-field', API);
  await ada.click('#connect-body .btn-primary');
  await ada.waitForSelector('#screen-welcome.active', { timeout: 15000 });
  check('entering the server address connects', true);
  await shot(ada, 'p2-welcome');

  await ada.fill('#welcome-name', 'Ada');
  await ada.click('#welcome-go');
  await ada.waitForSelector('.phrase-box', { timeout: 10000 });
  await ada.click('.sheet .btn-primary');
  await ada.waitForSelector('#screen-setup.active', { timeout: 8000 });
  await ada.fill('#group-name', 'Roof Gang');
  await ada.click('#group-create');
  await ada.waitForSelector('.code-box', { timeout: 10000 });
  const code = (await ada.textContent('.code-box')).trim();
  check('a group can be created across origins', /^[A-Z2-9]{6}$/.test(code), code);
  await ada.click('#scrim', { position: { x: 30, y: 40 } });
  await ada.waitForTimeout(500);

  /* -------------------------------------- a friend arrives by invite link -- */

  const bo = await phone({ latitude: 52.5163, longitude: 13.3777 });
  const invite = `${CDN}${REPO_PATH}/?s=${encodeURIComponent(API)}&join=${code}`;
  await bo.goto(invite, { waitUntil: 'domcontentloaded' });
  await bo.waitForSelector('#screen-welcome.active', { timeout: 15000 });
  check('an invite link carries the server, skipping the connect screen', true);

  await bo.fill('#welcome-name', 'Bo');
  await bo.click('#welcome-go');
  await bo.waitForSelector('.phrase-box', { timeout: 10000 });
  await bo.click('.sheet .btn-primary');
  await bo.waitForTimeout(1500);
  const joined = await bo.evaluate(() =>
    import('/groups/js/store.js').then((m) => m.state.home?.group?.name || null));
  check('and joins the group straight away', joined === 'Roof Gang', String(joined));
  await shot(bo, 'p3-joined');

  /* -------------------------------------------------- hangout end to end -- */

  await ada.click('#btn-hangout');
  await ada.waitForSelector('.vibe-grid', { timeout: 8000 });
  await ada.click('.vibe-grid .vibe:nth-child(2)');
  await ada.fill('.sheet input.field', 'ramen at 8?');
  await ada.click('.sheet .btn-primary');
  await ada.waitForSelector('.ping', { timeout: 12000 });

  // No reload: this has to arrive over the cross-origin event stream.
  await bo.waitForSelector('.ping', { timeout: 15000 });
  check('a hangout arrives live over the cross-origin event stream', true);
  await bo.click('.ping .answers .btn-primary');
  await bo.waitForSelector('.map-card', { timeout: 12000 });
  check('saying yes reveals the location', true);
  await shot(bo, 'p4-location');

  /* ------------------------------------------------------ clips and reel -- */

  const upload = (page, { hoursAgo, caption, seconds }) => page.evaluate(async (args) => {
    const canvas = document.createElement('canvas');
    canvas.width = 360; canvas.height = 640;
    const ctx = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start();
    const started = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const t = (performance.now() - started) / 1000;
        const g = ctx.createLinearGradient(0, 0, 0, 640);
        g.addColorStop(0, `hsl(${260 + t * 30} 55% 22%)`);
        g.addColorStop(1, `hsl(${20 + t * 20} 85% 55%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 360, 640);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 34px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(args.caption, 180, 320);
        if (t < args.seconds) requestAnimationFrame(draw);
        else { recorder.stop(); resolve(); }
      };
      draw();
    });
    await new Promise((r) => { recorder.onstop = r; setTimeout(r, 400); });
    const { api } = await import('/groups/js/api.js');
    const { state } = await import('/groups/js/store.js');
    return api.uploadClip(state.groupId, new Blob(chunks, { type: 'video/webm' }), {
      shotAt: Date.now() - args.hoursAgo * 3600000,
      duration: args.seconds, caption: args.caption, width: 360, height: 640,
    });
  }, { hoursAgo, caption, seconds });

  const clip = await upload(ada, { hoursAgo: 30, caption: 'the roof', seconds: 2.5 });
  await upload(bo, { hoursAgo: 28, caption: 'sunset', seconds: 2.5 });
  check('clips upload to the other origin', Boolean(clip?.clip?.id), JSON.stringify(clip));

  await ada.reload({ waitUntil: 'domcontentloaded' });
  await ada.waitForTimeout(1500);
  await shot(ada, 'p5-home');

  await ada.evaluate(async (day) => {
    const { openReel } = await import('/groups/js/views/reel.js');
    const { state } = await import('/groups/js/store.js');
    await openReel(state.groupId, day);
  }, clip.day);
  await ada.waitForSelector('#screen-reel.active', { timeout: 12000 });
  await ada.waitForTimeout(2000);

  const playing = await ada.evaluate(() => {
    const v = document.querySelector('#reel-video');
    return { src: v.currentSrc, time: v.currentTime, error: v.error?.code || null };
  });
  check('the reel actually plays video from the other origin',
    playing.time > 0 && !playing.error, JSON.stringify(playing));
  check('using a signed URL', playing.src.includes('?t='), playing.src);
  await shot(ada, 'p6-reel');

  /* ------------------------------------------------------------ offline -- */

  await ada.evaluate(() => import('/groups/js/views/reel.js').then((m) => m.closeReel()));
  await ada.waitForTimeout(500);
  const cached = await ada.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('groups-shell-'));
    if (!shell) return null;
    const cache = await caches.open(shell);
    const hit = await cache.match(new URL('js/app.js', location.href).toString());
    return { shell, hasApp: Boolean(hit), entries: (await cache.keys()).length };
  });
  check('the shell is cached for offline launch',
    Boolean(cached?.hasApp), JSON.stringify(cached));

  // Probing this origin for an API it does not have is how the app discovers it
  // is running on a static host — that 404 is the mechanism, not a fault.
  const realErrors = errors.filter((e) =>
    !/vibrate/i.test(e) && !/404/.test(e));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(failed
    ? `\n  \x1b[31m${failed} failed\x1b[0m\n`
    : `\n  the GitHub Pages split works — screenshots in ${OUT}\n`);
} catch (err) {
  failed++;
  console.error('\n\x1b[31mpages check blew up:\x1b[0m', err.message);
  console.error(log.slice(-1500));
} finally {
  await browser.close();
  cdn.close();
  server.kill('SIGKILL');
  await fsp.rm(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
