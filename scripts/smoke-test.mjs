/**
 * End-to-end check of the Groups API. Boots a throwaway server on a random port
 * against a temp data dir, then walks the whole product: two friends, a group,
 * a hangout with location gating, clips, and the 20:00 lock.
 *
 *   npm test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { encryptPayload } from '../server/push.mjs';

const PORT = 8000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = await fs.mkdtemp(path.join(os.tmpdir(), 'groups-test-'));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

async function call(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body: payload, headers: res.headers };
}

/* Something that looks enough like an MP4 to be stored and streamed back. */
function fakeMp4(seed = 1) {
  const header = Buffer.from([
    0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const body = crypto.createHash('sha256').update(String(seed)).digest();
  return Buffer.concat([header, Buffer.alloc(4096, body[0]), body]);
}

const server = spawn(process.execPath, ['--no-warnings', 'server/server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, INSECURE_COOKIES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  if (!await waitForServer()) throw new Error(`server never started:\n${serverLog}`);

  console.log('\n\x1b[1mauth\x1b[0m');
  const reg = await call('POST', '/api/auth/register', { body: { name: 'Ada', emoji: '🦊' } });
  eq('register returns 200', reg.status, 200);
  check('issues a token', typeof reg.body.token === 'string' && reg.body.token.length > 20);
  check('issues a 6-word recovery phrase', reg.body.recoveryPhrase.split('-').length === 6);
  const ada = reg.body.token;

  const bobReg = await call('POST', '/api/auth/register', { body: { name: 'Bo', emoji: '🐢' } });
  const bo = bobReg.body.token;
  const zedReg = await call('POST', '/api/auth/register', { body: { name: 'Zed', emoji: '👽' } });
  const zed = zedReg.body.token;

  eq('anonymous /api/me is 401', (await call('GET', '/api/me')).status, 401);
  eq('token works', (await call('GET', '/api/me', { token: ada })).status, 200);

  const restored = await call('POST', '/api/auth/restore', {
    body: { recoveryPhrase: reg.body.recoveryPhrase.replace(/-/g, ' ').toUpperCase() },
  });
  eq('recovery phrase restores the same account', restored.body.user.id, reg.body.user.id);
  eq('wrong phrase is rejected',
    (await call('POST', '/api/auth/restore', { body: { recoveryPhrase: 'a-b-c-d-e-f' } })).status, 404);

  console.log('\n\x1b[1mgroups\x1b[0m');
  const made = await call('POST', '/api/groups', {
    token: ada, body: { name: 'Roof Gang', emoji: '🌇', tz: 'Europe/Berlin', unlockHour: 20 },
  });
  eq('create group', made.status, 200);
  const gid = made.body.group.id;
  const code = made.body.group.inviteCode;
  check('invite code is 6 shoutable chars', /^[A-Z2-9]{6}$/.test(code), code);

  eq('non-member is blocked', (await call('GET', `/api/groups/${gid}`, { token: bo })).status, 403);
  const joined = await call('POST', '/api/groups/join', { token: bo, body: { code: code.toLowerCase() } });
  eq('join by code (case-insensitive)', joined.status, 200);
  eq('member list now has 2', joined.body.group.members.length, 2);
  eq('bad code 404s',
    (await call('POST', '/api/groups/join', { token: zed, body: { code: 'ZZZZZZ' } })).status, 404);

  console.log('\n\x1b[1mhangouts\x1b[0m');
  const ping = await call('POST', `/api/groups/${gid}/hangouts`, {
    token: ada,
    body: { vibe: 'food', note: 'ramen?', lat: 52.52, lng: 13.405, accuracy: 12, hours: 3 },
  });
  eq('start a hangout', ping.status, 200);
  const hid = ping.body.hangout.id;
  eq('host sees own location', ping.body.hangout.location.lat, 52.52);
  eq('host is marked as host', ping.body.hangout.myAnswer, 'host');

  const beforeYes = await call('GET', `/api/hangouts/${hid}`, { token: bo });
  eq('before answering, location is hidden', beforeYes.body.hangout.location, null);
  eq('but you can see there is one', beforeYes.body.hangout.hasLocation, true);

  const said = await call('POST', `/api/hangouts/${hid}/respond`, {
    token: bo, body: { answer: 'yes', lat: 52.5, lng: 13.4 },
  });
  eq('saying yes works', said.status, 200);
  eq('saying yes reveals the location', said.body.hangout.location.lat, 52.52);
  eq('yes count', said.body.hangout.yes, 1);

  const hostView = await call('GET', `/api/hangouts/${hid}`, { token: ada });
  eq('host sees who is in', hostView.body.hangout.responses[0].answer, 'yes');
  eq('host sees their location back', hostView.body.hangout.responses[0].location.lat, 52.5);

  const flip = await call('POST', `/api/hangouts/${hid}/respond`, { token: bo, body: { answer: 'no' } });
  eq('changing to no hides the location again', flip.body.hangout.location, null);
  eq('outsiders cannot respond',
    (await call('POST', `/api/hangouts/${hid}/respond`, { token: zed, body: { answer: 'yes' } })).status, 403);
  eq('host cannot answer their own ping',
    (await call('POST', `/api/hangouts/${hid}/respond`, { token: ada, body: { answer: 'yes' } })).status, 400);

  console.log('\n\x1b[1mmemories\x1b[0m');
  const yesterdayShot = Date.now() - 30 * 3600_000;
  const old = await call('POST', `/api/groups/${gid}/clips`, {
    token: bo, raw: true, body: fakeMp4(1),
    headers: {
      'content-type': 'video/mp4',
      'x-shot-at': String(yesterdayShot),
      'x-duration': '42.5',
      'x-caption': Buffer.from('sunset from the roof').toString('base64'),
      'x-width': '1080', 'x-height': '1920',
    },
  });
  eq('upload a clip', old.status, 200);
  const openDay = old.body.day;

  const fresh = await call('POST', `/api/groups/${gid}/clips`, {
    token: ada, raw: true, body: fakeMp4(2),
    headers: { 'content-type': 'video/mp4', 'x-shot-at': String(Date.now()), 'x-duration': '10' },
  });
  const lockedDay = fresh.body.day;
  check('a clip shot now lands in a still-locked day', lockedDay !== openDay, `${lockedDay} vs ${openDay}`);

  const openMem = await call('GET', `/api/groups/${gid}/memories/${openDay}`, { token: ada });
  eq('yesterday is unlocked', openMem.body.unlocked, true);
  eq('and shows the clip', openMem.body.clips.length, 1);
  eq('with its caption', openMem.body.clips[0].caption, 'sunset from the roof');
  eq('and the shooter', openMem.body.clips[0].user.name, 'Bo');

  const lockedMem = await call('GET', `/api/groups/${gid}/memories/${lockedDay}`, { token: bo });
  eq('tonight is locked', lockedMem.body.unlocked, false);
  eq('locked memory hides the clips', lockedMem.body.clips.length, 0);
  eq('but reveals the count', lockedMem.body.counts.n, 1);
  check('and tells you when it opens', lockedMem.body.opensAt > Date.now());

  const clipId = openMem.body.clips[0].id;
  const video = await fetch(`${BASE}/api/clips/${clipId}/video`, {
    headers: { authorization: `Bearer ${ada}` },
  });
  eq('unlocked clip streams', video.status, 200);
  eq('with a video content-type', video.headers.get('content-type'), 'video/mp4');
  eq('and advertises range support', video.headers.get('accept-ranges'), 'bytes');

  const ranged = await fetch(`${BASE}/api/clips/${clipId}/video`, {
    headers: { authorization: `Bearer ${ada}`, range: 'bytes=0-99' },
  });
  eq('Safari-style range probe returns 206', ranged.status, 206);
  eq('with the right slice length', (await ranged.arrayBuffer()).byteLength, 100);
  check('and a content-range header',
    /^bytes 0-99\/\d+$/.test(ranged.headers.get('content-range')), ranged.headers.get('content-range'));

  const lockedClipId = (await call('GET', `/api/groups/${gid}`, { token: ada }))
    .body.vault.clips.length;
  eq('the group view hides tonight\'s clips too', lockedClipId, 0);

  const peek = await call('GET', `/api/clips/${clipId}/video`, { token: zed });
  eq('outsiders cannot stream clips', peek.status, 403);

  // <video> and EventSource cannot send an Authorization header, so the session
  // cookie has to work on its own.
  const meWithCookie = await fetch(`${BASE}/api/me`, {
    headers: { authorization: `Bearer ${ada}` },
  });
  const cookie = (meWithCookie.headers.get('set-cookie') || '').split(';')[0];
  check('a bearer client gets the session cookie re-issued', cookie.startsWith('g_sess='), cookie);
  const byCookie = await fetch(`${BASE}/api/clips/${clipId}/video`, { headers: { cookie } });
  eq('cookie alone can stream a clip', byCookie.status, 200);
  eq('and no credentials cannot', (await fetch(`${BASE}/api/clips/${clipId}/video`)).status, 401);

  console.log('\n\x1b[1mreactions + archive\x1b[0m');
  eq('react to a clip',
    (await call('POST', `/api/clips/${clipId}/react`, { token: ada, body: { emoji: '🔥' } })).status, 200);
  const withReactions = await call('GET', `/api/groups/${gid}/memories/${openDay}`, { token: ada });
  eq('reaction shows up', withReactions.body.clips[0].reactions[0].emoji, '🔥');

  const archive = await call('GET', `/api/groups/${gid}/memories`, { token: ada });
  eq('archive lists both days', archive.body.days.length, 2);
  check('archive is newest first', archive.body.days[0].day > archive.body.days[1].day);
  eq('locked day in archive is marked locked',
    archive.body.days.find((d) => d.day === lockedDay).unlocked, false);

  eq('delete someone else\'s clip is refused',
    (await call('DELETE', `/api/clips/${clipId}`, { token: ada })).status, 403);
  eq('delete your own clip works',
    (await call('DELETE', `/api/clips/${clipId}`, { token: bo })).status, 200);

  console.log('\n\x1b[1mhosting the app elsewhere\x1b[0m');
  {
    // GitHub Pages can serve the app but not the API, so the two end up on
    // different origins. Everything below is what makes that work.
    // The earlier clip was deleted, so put two fresh ones in the open day.
    for (const seed of [7, 8]) {
      await call('POST', `/api/groups/${gid}/clips`, {
        token: ada, raw: true, body: fakeMp4(seed),
        headers: { 'content-type': 'video/mp4', 'x-shot-at': String(yesterdayShot + seed), 'x-duration': '3' },
      });
    }
    const mem = await call('GET', `/api/groups/${gid}/memories/${openDay}`, { token: ada });
    const signed = mem.body.clips[0]?.url;
    check('clip URLs come back signed', /\?t=[^&]+$/.test(signed || ''), signed);

    const bare = await fetch(BASE + signed);   // no cookie, no bearer
    eq('a signed URL plays with no credentials at all', bare.status, 200);

    const stolen = `/api/clips/${mem.body.clips[1].id}/video${signed.slice(signed.indexOf('?'))}`;
    eq('a signature for one clip does not unlock another',
      (await fetch(BASE + stolen)).status, 401);
    eq('a tampered signature is refused',
      (await fetch(`${BASE + signed.slice(0, -2)}xx`)).status, 401);

    const preflight = await fetch(`${BASE}/api/me`, {
      method: 'OPTIONS',
      headers: { origin: 'https://someone.github.io', 'access-control-request-method': 'GET' },
    });
    eq('CORS preflight is answered', preflight.status, 204);
    eq('with the calling origin allowed',
      preflight.headers.get('access-control-allow-origin'), 'https://someone.github.io');
    check('and the upload headers permitted',
      (preflight.headers.get('access-control-allow-headers') || '').includes('x-shot-at'),
      preflight.headers.get('access-control-allow-headers'));
    check('cookies are never allowed across origins',
      preflight.headers.get('access-control-allow-credentials') === null,
      preflight.headers.get('access-control-allow-credentials'));

    const ticket = await call('POST', '/api/stream/ticket', { token: bo });
    check('a stream ticket is issued', typeof ticket.body.ticket === 'string');
    const streamed = await fetch(`${BASE}/api/stream?ticket=${encodeURIComponent(ticket.body.ticket)}`);
    eq('and opens the event stream without a header or cookie', streamed.status, 200);
    streamed.body.cancel();
    eq('a junk ticket does not',
      (await fetch(`${BASE}/api/stream?ticket=nope.1.zz`)).status, 401);
  }

  console.log('\n\x1b[1mrealtime\x1b[0m');
  const streamed = await new Promise(async (resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); resolve(null); }, 5000);
    let buffer = '';
    try {
      const res = await fetch(`${BASE}/api/stream`, {
        headers: { authorization: `Bearer ${bo}` }, signal: controller.signal,
      });
      setTimeout(() => {
        call('POST', `/api/groups/${gid}/hangouts`, { token: ada, body: { vibe: 'walk' } });
      }, 300);
      for await (const chunk of res.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        if (buffer.includes('event: hangout')) {
          clearTimeout(timer); controller.abort(); resolve(buffer); return;
        }
      }
    } catch { resolve(null); }
  });
  check('SSE delivers a hangout to the other member', Boolean(streamed && streamed.includes('event: hangout')));

  console.log('\n\x1b[1mweb push crypto\x1b[0m');
  {
    // RFC 8291 §5 — verify the derived CEK/NONCE decrypt our own ciphertext.
    const out = encryptPayload(
      'When I grow up, I want to be a watermelon',
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      {
        asPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      },
    );
    eq('aes128gcm header carries the RFC public key',
      out.subarray(21, 86).toString('base64url'),
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const ct = out.subarray(86);
    const d = crypto.createDecipheriv('aes-128-gcm',
      Buffer.from('oIhVW04MRdy2XN9CiKLxTg', 'base64url'),
      Buffer.from('4h_95klXJ5E_qnoN', 'base64url'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    eq('RFC 8291 CEK/NONCE decrypt our payload',
      plain.subarray(0, -1).toString('utf8'), 'When I grow up, I want to be a watermelon');
    eq('record ends with the 0x02 delimiter', plain[plain.length - 1], 2);
  }

  console.log('\n\x1b[1mstatic + PWA\x1b[0m');
  for (const [file, type] of [
    ['/', 'text/html'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
    ['/css/app.css', 'text/css'],
    ['/js/app.js', 'text/javascript'],
  ]) {
    const r = await fetch(BASE + file);
    check(`serves ${file}`, r.ok && (r.headers.get('content-type') || '').includes(type),
      `${r.status} ${r.headers.get('content-type')}`);
  }
  const spa = await fetch(`${BASE}/some/deep/link?join=ABC123`, { redirect: 'manual' });
  eq('unknown routes redirect to the app root', spa.status, 302);
  eq('keeping the query string, so invite links survive',
    spa.headers.get('location'), '/?join=ABC123');
  eq('and following it lands on the app',
    (await fetch(`${BASE}/some/deep/link`)).status, 200);

  const shell = await (await fetch(`${BASE}/`)).text();
  check('the shell uses relative asset URLs, so a CDN subpath works',
    shell.includes('href="css/theme.css') && shell.includes('src="js/app.js'),
    shell.match(/(?:href|src)="[^"]*app\.js[^"]*"/)?.[0]);
  const traversal = await fetch(`${BASE}/../package.json`);
  check('path traversal is blocked', traversal.status === 404 || traversal.status === 403, String(traversal.status));

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
}

try {
  await main();
} catch (err) {
  console.error('\n\x1b[31mtest run blew up:\x1b[0m', err);
  console.error(serverLog);
  failed++;
} finally {
  server.kill('SIGKILL');
  await fs.rm(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
