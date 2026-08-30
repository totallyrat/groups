/**
 * Checks the server-side stitcher end to end with real encoded video:
 * two clips in, one downloadable MP4 out, in shot order.
 *
 * Needs ffmpeg on PATH (the Docker image ships it).
 *
 *   node scripts/reel-test.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const MODE = process.env.REEL_MODE || 'full';
const PORT = 8900 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = await fs.mkdtemp(path.join(os.tmpdir(), 'groups-reel-'));
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), 'groups-src-'));

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  await run('ffmpeg', ['-version']);
} catch {
  console.log('  ffmpeg not on PATH — skipping (the app falls back to per-clip saving)');
  process.exit(0);
}

async function makeClip(file, seconds, colour) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=540x960:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file,
  ]);
  return fs.readFile(file);
}

const duration = async (file) => {
  // `ffmpeg -i` exits non-zero with no output file, but prints the duration.
  const stderr = await run('ffmpeg', ['-hide_banner', '-i', file])
    .then((r) => r.stderr, (err) => err.stderr || '');
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

const server = spawn(process.execPath, ['--no-warnings', 'server/server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, INSECURE_COOKIES: '1' },
  stdio: 'ignore',
});

for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* waiting */ }
  await new Promise((r) => setTimeout(r, 150));
}

try {
  const call = async (method, url, { token, body, raw, headers = {} } = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: raw ? body : (body ? JSON.stringify(body) : undefined),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const reg = await call('POST', '/api/auth/register', { body: { name: 'Ada' } });
  const token = reg.body.token;
  const group = (await call('POST', '/api/groups', {
    token, body: { name: 'Reel Test', tz: 'UTC', unlockHour: 20 },
  })).body.group;

  // Two clips inside a window that has already opened, deliberately uploaded
  // out of order so the stitcher has to sort them.
  const a = await makeClip(path.join(WORK, 'a.mp4'), 2, 'red');
  const b = await makeClip(path.join(WORK, 'b.mp4'), 3, 'blue');
  const base = Date.now() - 30 * 3600_000;

  const second = await call('POST', `/api/groups/${group.id}/clips`, {
    token, raw: true, body: b,
    headers: { 'content-type': 'video/mp4', 'x-shot-at': String(base + 600_000), 'x-duration': '3' },
  });
  const first = await call('POST', `/api/groups/${group.id}/clips`, {
    token, raw: true, body: a,
    headers: { 'content-type': 'video/mp4', 'x-shot-at': String(base), 'x-duration': '2' },
  });
  check('both clips uploaded', second.status === 200 && first.status === 200);
  const day = first.body.day;
  check('they land in the same memory', second.body.day === day, `${second.body.day} vs ${day}`);

  const memory = await call('GET', `/api/groups/${group.id}/memories/${day}`, { token });
  check('the memory is open', memory.body.unlocked === true);
  check('clips come back in shot order, not upload order',
    memory.body.clips[0].duration === 2 && memory.body.clips[1].duration === 3,
    memory.body.clips.map((c) => c.duration).join(','));
  if (MODE === 'off') {
    check('REEL_MODE=off advertises no server-side stitching',
      memory.body.reel.available === false);
    const refused = await call('POST', `/api/groups/${group.id}/memories/${day}/reel`, { token });
    check('and refuses to build one', refused.body.status === 'unavailable', refused.body.status);
    console.log('\n  reel stitching is off, as configured\n');
    process.exit(failed ? 1 : 0);
  }

  check('the server offers a stitched reel', memory.body.reel.available === true);

  let build = await call('POST', `/api/groups/${group.id}/memories/${day}/reel`, { token });
  check('build starts', build.body.status === 'building' || build.body.status === 'ready');

  let ready = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const m = await call('GET', `/api/groups/${group.id}/memories/${day}`, { token });
    if (m.body.reel.status === 'ready') { ready = m.body.reel; break; }
    if (m.body.reel.status === 'unavailable') break;
  }
  check('the reel finishes building', Boolean(ready));

  if (ready) {
    const res = await fetch(BASE + ready.url, { headers: { authorization: `Bearer ${token}` } });
    check('the reel downloads', res.ok, String(res.status));
    check('as an attachment named after the day',
      (res.headers.get('content-disposition') || '').includes(day),
      res.headers.get('content-disposition'));

    const out = path.join(WORK, 'reel.mp4');
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
    const total = await duration(out);
    check('and is both clips long', Math.abs(total - 5) < 1.2, `${total.toFixed(2)}s, expected ~5s`);
  }

  /* --- and the harder case: clips that disagree on codec and shape --------- */

  const oddball = path.join(WORK, 'odd.webm');
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=2:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2',
    '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libvorbis', '-shortest', oddball,
  ]);

  const mixed = await call('POST', `/api/groups/${group.id}/clips`, {
    token, raw: true, body: await fs.readFile(oddball),
    headers: {
      'content-type': 'video/webm',
      'x-shot-at': String(base + 1_200_000),
      'x-duration': '2',
    },
  });
  check('a landscape WebM clip is accepted alongside portrait MP4s', mixed.status === 200);

  await call('POST', `/api/groups/${group.id}/memories/${day}/reel`, { token });
  let mixedReel = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const m = await call('GET', `/api/groups/${group.id}/memories/${day}`, { token });
    if (m.body.reel.status === 'ready') { mixedReel = m.body.reel; break; }
    if (m.body.reel.status === 'unavailable') break;
  }

  if (MODE === 'copy') {
    // A small machine is told not to re-encode; the app saves clip by clip.
    check('REEL_MODE=copy refuses to re-encode a mismatched day', mixedReel === null);
  } else {
    check('the stitcher falls back to a normalising re-encode', Boolean(mixedReel));
    if (mixedReel) {
      const res = await fetch(BASE + mixedReel.url, { headers: { authorization: `Bearer ${token}` } });
      const out = path.join(WORK, 'mixed.mp4');
      await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
      const total = await duration(out);
      check('and produces all three clips', Math.abs(total - 7) < 1.5, `${total.toFixed(2)}s, expected ~7s`);
    }
  }

  console.log(failed
    ? `\n  \x1b[31m${failed} failed\x1b[0m\n`
    : `\n  reel stitching works (REEL_MODE=${MODE})\n`);
} catch (err) {
  failed++;
  console.error('\n\x1b[31mreel test blew up:\x1b[0m', err);
} finally {
  server.kill('SIGKILL');
  await fs.rm(DATA, { recursive: true, force: true });
  await fs.rm(WORK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
