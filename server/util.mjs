import crypto from 'node:crypto';

/* ---------------------------------------------------------------- ids ---- */

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no look-alikes

export function id(prefix = '') {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return prefix ? `${prefix}_${out}` : out;
}

/** Short, human-shoutable invite code: 6 chars, unambiguous. */
export function inviteCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const b of bytes) out += abc[b % abc.length];
  return out;
}

export const token = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const WORDS = `amber anchor apple arrow aspen basil beacon birch bloom brave breeze bridge
cabin candle canyon cedar cinder cloud clover comet coral cove crane crest dawn delta
diver dune ember fable falcon fern ferry flint forest fox garnet glade glow grove harbor
hazel heron ivory jade jasper juniper kite lagoon lantern larch ledge lily linen lunar
maple marble meadow mesa mint moss nectar nimbus north oak ocean olive onyx opal orbit
otter pearl pebble pine pilot plum pollen quartz quill raven reef ridge river rowan sage
sail sand shore silver slate solar sparrow spruce stone storm summit swift tide timber
topaz trail tulip umber valley velvet vine violet walnut wander willow wren zenith zephyr`
  .split(/\s+/)
  .filter(Boolean);

/** 6-word recovery phrase — plenty of entropy, easy to write on paper. */
export function recoveryPhrase() {
  const out = [];
  for (let i = 0; i < 6; i++) out.push(WORDS[crypto.randomInt(WORDS.length)]);
  return out.join('-');
}

export const normalizePhrase = (p) =>
  String(p || '').toLowerCase().trim().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

/* --------------------------------------------------------------- time ---- */

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  try { fmt(tz).format(0); return true; } catch { return false; }
}

/** Wall-clock parts of an epoch-ms instant inside a time zone. */
export function localParts(ts, tz) {
  const p = Object.fromEntries(
    fmt(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  return {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    hh: p.hour === '24' ? 0 : +p.hour,
    mm: +p.minute,
    ss: +p.second,
  };
}

/** Epoch ms for a wall-clock time in a zone (handles DST by offset inversion). */
export function zonedTime(y, m, d, hh = 0, mm = 0, tz = 'UTC') {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const p = localParts(naive, tz);
  const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return naive + (naive - seen);
}

const pad = (n) => String(n).padStart(2, '0');
export const dayKeyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function addDays(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return dayKeyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Which memory a clip belongs to.
 *
 * A "memory day" runs from unlockHour to unlockHour. Anything shot after tonight's
 * 20:00 drop belongs to tomorrow's memory, so every memory is a full 24h of the
 * group's life and nothing ever appears in a reel you already watched.
 */
export function memoryDay(ts, tz, unlockHour = 20) {
  const p = localParts(ts, tz);
  const key = dayKeyOf(p.y, p.m, p.d);
  return p.hh >= unlockHour ? addDays(key, 1) : key;
}

/** Epoch ms at which a given memory day opens. */
export function unlockAt(dayKey, tz, unlockHour = 20) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedTime(y, m, d, unlockHour, 0, tz);
}

/** Start of the collection window for a memory day (the previous drop). */
export function windowStart(dayKey, tz, unlockHour = 20) {
  return unlockAt(addDays(dayKey, -1), tz, unlockHour);
}

/* --------------------------------------------------------------- http ---- */

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const bad = (m) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Sign in first') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Not allowed') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');

export async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Payload too large', 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 1 << 20) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw bad('Invalid JSON');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');
export const clean = (s, max = 200) =>
  String(s ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
