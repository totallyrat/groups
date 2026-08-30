/**
 * Drives the real app in Chromium at iPhone size and captures each screen.
 * Not part of `npm test` — it needs Playwright and a browser.
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node scripts/visual-check.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const PORT = 8300 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[2] || path.join(os.tmpdir(), 'groups-shots');
const DATA = await fs.mkdtemp(path.join(os.tmpdir(), 'groups-visual-'));
await fs.mkdir(OUT, { recursive: true });

const server = spawn(process.execPath, ['--no-warnings', 'server/server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, INSECURE_COOKIES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
// Each friend needs their own context: separate cookies, storage and session.
const newPhone = (geo) => browser.newContext({
  ...devices['iPhone 14 Pro'],
  permissions: ['geolocation'],
  geolocation: geo,
  locale: 'en-GB',
  timezoneId: 'Europe/Berlin',
});

const adaPhone = await newPhone({ latitude: 52.5200, longitude: 13.4050 });
const boPhone = await newPhone({ latitude: 52.5163, longitude: 13.3777 });

const errors = [];
const shots = [];

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  console.log(`  📸 ${name}`);
}

async function makePage(context) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return page;
}

/* ------------------------------------------------- friend 1 signs up ---- */

const ada = await makePage(adaPhone);
await ada.goto(BASE, { waitUntil: 'domcontentloaded' });
await ada.waitForTimeout(600);
await shot(ada, '01-welcome');

await ada.fill('#welcome-name', 'Ada');
await ada.click('.emoji-picker button:nth-child(3)');
await ada.click('#welcome-go');
await ada.waitForSelector('.phrase-box', { timeout: 8000 });
await ada.waitForTimeout(400);
await shot(ada, '02-recovery-phrase');

const phrase = (await ada.textContent('.phrase-box')).trim();
await ada.click('.sheet .btn-primary');
await ada.waitForSelector('#screen-setup.active', { timeout: 5000 });
await ada.waitForTimeout(400);
await shot(ada, '03-setup');

await ada.fill('#group-name', 'Roof Gang');
await ada.click('#group-create');
await ada.waitForSelector('.code-box', { timeout: 8000 });
await ada.waitForTimeout(500);
await shot(ada, '04-invite');
const code = (await ada.textContent('.code-box')).trim();
console.log(`  group code: ${code}`);

await ada.click('#scrim', { position: { x: 30, y: 40 } });
await ada.waitForTimeout(600);
await shot(ada, '05-home-empty');

/* ------------------------------------------------- friend 2 joins ------- */

// An invite link drops you straight into the group after signing up.
const bo = await makePage(boPhone);
await bo.goto(`${BASE}/?join=${code}`, { waitUntil: 'domcontentloaded' });
await bo.fill('#welcome-name', 'Bo');
await bo.click('#welcome-go');
await bo.waitForSelector('.phrase-box', { timeout: 8000 });
await bo.click('.sheet .btn-primary');
await bo.waitForSelector('#screen-home.active', { timeout: 10000 });
await bo.waitForTimeout(900);
await shot(bo, '06-home-joined');

/* ------------------------------------------------- a hangout ------------ */

await ada.click('#btn-hangout');
await ada.waitForSelector('.vibe-grid', { timeout: 5000 });
await ada.waitForTimeout(400);
await shot(ada, '07-hangout-sheet');

await ada.click('.vibe-grid .vibe:nth-child(2)');       // Food
await ada.fill('.sheet input.field', 'ramen at 8?');
await ada.click('.sheet .btn-primary');
await ada.waitForSelector('.ping', { timeout: 10000 });
await ada.waitForTimeout(900);
await shot(ada, '08-hangout-live-host');

await bo.reload({ waitUntil: 'domcontentloaded' });
await bo.waitForSelector('.ping', { timeout: 10000 });
await bo.waitForTimeout(600);
await shot(bo, '09-hangout-received');

await bo.click('.ping .answers .btn-primary');           // I'm in
await bo.waitForSelector('.map-card', { timeout: 10000 });
await bo.waitForTimeout(700);
await shot(bo, '10-location-revealed');

await ada.waitForTimeout(1500);
await ada.reload({ waitUntil: 'domcontentloaded' });
await ada.waitForTimeout(900);
await shot(ada, '11-host-sees-yes');

/* ------------------------------------------------- clips + reel --------- */

// Two clips: one from yesterday's window (already open) and one for tonight.
const upload = async (page, { hoursAgo, caption, seconds }) => page.evaluate(async (args) => {
  const canvas = document.createElement('canvas');
  canvas.width = 360; canvas.height = 640;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(24);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
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
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(args.caption, 180, 320);
      if (t < args.seconds) requestAnimationFrame(draw);
      else { recorder.stop(); resolve(); }
    };
    draw();
  });
  await new Promise((r) => { recorder.onstop = r; setTimeout(r, 400); });
  const blob = new Blob(chunks, { type: 'video/webm' });

  const { api } = await import('/js/api.js');
  const { state } = await import('/js/store.js');
  return api.uploadClip(state.groupId, blob, {
    shotAt: Date.now() - args.hoursAgo * 3600000,
    duration: args.seconds,
    caption: args.caption,
    width: 360, height: 640,
  });
}, { hoursAgo, caption, seconds });

const openDayClip = await upload(ada, { hoursAgo: 30, caption: 'the roof', seconds: 2.5 });
await upload(bo, { hoursAgo: 28, caption: 'sunset', seconds: 2.5 });
await upload(ada, { hoursAgo: 0, caption: 'tonight', seconds: 2 });
console.log(`  clips uploaded (open day ${openDayClip.day})`);

await ada.reload({ waitUntil: 'domcontentloaded' });
await ada.waitForTimeout(1200);
await shot(ada, '12-home-with-vault');

// Watch the memory that has already opened.
const openDay = openDayClip.day;
await ada.evaluate(async (day) => {
  const { openReel } = await import('/js/views/reel.js');
  const { state } = await import('/js/store.js');
  await openReel(state.groupId, day);
}, openDay);
await ada.waitForSelector('#screen-reel.active', { timeout: 8000 });
await ada.waitForTimeout(1400);
await shot(ada, '13-reel-playing');

await ada.waitForTimeout(4500);
await shot(ada, '14-reel-end');

await ada.evaluate(() => import('/js/views/reel.js').then((m) => m.closeReel()));
await ada.waitForTimeout(600);

/* ------------------------------------------------- archive + settings --- */

await ada.click('#go-archive');
await ada.waitForSelector('.mem-tile', { timeout: 8000 });
await ada.waitForTimeout(700);
await shot(ada, '15-memory-lane');

await ada.evaluate(() => import('/js/router.js').then((m) => m.back('home')));
await ada.waitForTimeout(400);
await ada.click('#go-settings');
await ada.waitForTimeout(700);
await shot(ada, '16-settings');

/* ------------------------------------------------- report --------------- */

console.log(`\n  ${shots.length} screenshots -> ${OUT}`);
if (errors.length) {
  console.log(`\n  \x1b[31m${errors.length} console errors:\x1b[0m`);
  for (const e of [...new Set(errors)].slice(0, 20)) console.log(`   - ${e}`);
} else {
  console.log('  no console errors 🎉');
}

await browser.close();
server.kill('SIGKILL');
await fs.rm(DATA, { recursive: true, force: true });
process.exit(errors.length ? 1 : 0);
