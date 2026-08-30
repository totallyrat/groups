import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { createBus } from './bus.mjs';
import { createApi } from './api.mjs';
import { MediaStore, serveFile } from './media.mjs';
import { Pusher, generateVapidKeys } from './push.mjs';
import { createSigner, loadSecret } from './sign.mjs';
import { HttpError, json, parseCookies, unlockAt, memoryDay, addDays } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const WEB = path.join(ROOT, 'web');

const config = {
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  secureCookies: process.env.INSECURE_COOKIES !== '1',
  version: '1.0.0',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:hello@groups.app',
  // Which web origins may call this API. Empty = any, which is safe here
  // because cross-origin requests never carry the session cookie: they
  // authenticate with a bearer token or a signed URL, neither of which a
  // hostile page can read.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
};

fs.mkdirSync(config.dataDir, { recursive: true });

/* ------------------------------------------------------------ VAPID keys -- */

function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }
  // Persist a generated pair so notifications survive restarts on a plain VPS.
  const file = path.join(config.dataDir, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const keys = generateVapidKeys();
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log('[groups] generated VAPID keys ->', file);
    return keys;
  }
}

const vapid = loadVapid();

const db = openDb(path.join(config.dataDir, 'groups.db'));
const media = new MediaStore(path.join(config.dataDir, 'media'));
const bus = createBus();
const pusher = new Pusher({ ...vapid, subject: config.vapidSubject });
const signer = createSigner(loadSecret(config.dataDir));
const api = createApi({ db, media, pusher, bus, config, signer });

/* ----------------------------------------------------------- static files -- */

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Bumped whenever web/ changes so the service worker refreshes its shell.
let assetVersion = String(Date.now());

async function computeAssetVersion() {
  let newest = 0;
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const st = await fsp.stat(full).catch(() => null);
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  await walk(WEB);
  assetVersion = String(Math.round(newest));
}
await computeAssetVersion();

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) throw new HttpError(403, 'Nope', 'forbidden');

  let stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.isDirectory()) {
    if (path.extname(rel)) throw new HttpError(404, 'Not found', 'not_found');
    // Single-page app: send unknown paths back to the root rather than serving
    // the shell in place. The shell's asset URLs are relative — so it can also
    // be hosted from a subpath on a CDN — and would not resolve from here.
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { location: `/${query}`, 'cache-control': 'no-store' });
    return res.end();
  }

  // The shell always goes through the template so its asset URLs are versioned.
  if (file === path.join(WEB, 'index.html')) return serveShell(req, res);

  const ext = path.extname(file).toLowerCase();
  const isShell = ext === '.html' || file.endsWith('sw.js');
  const headers = {
    'content-type': STATIC_TYPES[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': isShell
      ? 'no-cache, must-revalidate'
      : 'public, max-age=3600',
    'last-modified': stat.mtime.toUTCString(),
    ...securityHeaders(),
  };
  if (file.endsWith('sw.js')) headers['service-worker-allowed'] = '/';

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function serveShell(req, res) {
  const file = path.join(WEB, 'index.html');
  const html = (await fsp.readFile(file, 'utf8')).replaceAll('__ASSET_VERSION__', assetVersion);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-cache, must-revalidate',
    ...securityHeaders(),
  });
  if (req.method === 'HEAD') return res.end();
  res.end(html);
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'geolocation=(self), camera=(self), microphone=(self)',
  };
}

const ALLOWED_HEADERS =
  'authorization, content-type, range, last-event-id, ' +
  'x-shot-at, x-duration, x-caption, x-width, x-height';

/**
 * Lets the app live somewhere else — GitHub Pages, say — while this server
 * keeps the data. Credentials are deliberately NOT allowed across origins: the
 * session cookie stays same-origin, and everything else proves itself with a
 * bearer token or a signed URL.
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const clean = origin.replace(/\/+$/, '');
  if (config.allowedOrigins.length && !config.allowedOrigins.includes(clean)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-expose-headers',
    'content-range, accept-ranges, content-disposition, content-length');
}

/* -------------------------------------------------------------- the server -- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
    req.cookies = parseCookies(req.headers.cookie);

    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        allow: 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
        'access-control-allow-headers': ALLOWED_HEADERS,
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    if (pathname === '/sw.js') {
      // The worker needs the current asset version baked in.
      const src = (await fsp.readFile(path.join(WEB, 'sw.js'), 'utf8'))
        .replaceAll('__ASSET_VERSION__', assetVersion);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(src),
        'cache-control': 'no-cache, must-revalidate',
        'service-worker-allowed': '/',
      });
      return res.end(src);
    }

    if (pathname.startsWith('/api/')) {
      const handled = await api.handle(req, res, pathname);
      if (!handled) json(res, 404, { error: 'not_found', message: 'No such endpoint' });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[groups] ${req.method} ${pathname}`, err);
    json(res, status, {
      error: err.code || 'server_error',
      message: status >= 500 ? 'Something broke on our end' : err.message,
    });
  } finally {
    if (process.env.LOG_REQUESTS === '1') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.headersTimeout = 120_000;
server.requestTimeout = 15 * 60_000; // long enough for a 3-minute clip on hotel wifi
server.keepAliveTimeout = 65_000;

/* ------------------------------------------------------------ the 20:00 tick -- */

/**
 * Once a minute, look for groups whose drop just happened: notify everyone and
 * pre-build the stitched reel so "Download tonight" is instant.
 */
const dropped = new Set();
function tick() {
  const at = Date.now();
  const groups = db.prepare('SELECT * FROM groups').all();
  for (const group of groups) {
    // Today's memory opens at the start of *this* memory day.
    const day = addDays(memoryDay(at, group.tz, group.unlock_hour), -1);
    const opensAt = unlockAt(day, group.tz, group.unlock_hour);
    const key = `${group.id}:${day}`;
    if (at < opensAt || at - opensAt > 5 * 60_000 || dropped.has(key)) continue;
    dropped.add(key);

    const counts = db
      .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS people FROM clips WHERE group_id = ? AND day = ?')
      .get(group.id, day);
    if (!counts.n) continue;

    api.emit(group.id, 'vault-opened', { day, counts });
    const memberIds = db.prepare('SELECT user_id FROM members WHERE group_id = ?')
      .all(group.id).map((r) => r.user_id);
    api.notify(memberIds, {
      title: `${group.emoji} Tonight is open`,
      body: `${counts.n} clip${counts.n === 1 ? '' : 's'} from ${counts.people} of you. Watch now.`,
      tag: `vault-${group.id}-${day}`,
      url: `/?g=${group.id}&watch=${day}`,
      data: { kind: 'vault', groupId: group.id, day },
    }).catch(() => {});
    api.buildReel(group, day).catch(() => {});
  }

  // Keep the guard set from growing forever.
  if (dropped.size > 500) dropped.clear();
}

setInterval(tick, 60_000).unref();
setTimeout(tick, 5_000).unref();

/* --------------------------------------------------------------- lifecycle -- */

server.listen(config.port, config.host, () => {
  console.log(`
  ▄▄  Groups is up
      http://localhost:${config.port}
      data      ${config.dataDir}
      push      ${pusher.enabled ? 'on' : 'off'}  (public key ${vapid.publicKey.slice(0, 12)}…)
      cookies   ${config.secureCookies ? 'secure' : 'insecure (dev)'}
`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[groups] ${signal} — closing up`);
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  });
}

export { server, db, api, config };
