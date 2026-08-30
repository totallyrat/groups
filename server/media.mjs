import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { HttpError, notFound } from './util.mjs';

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export function extForMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('webm')) return 'webm';
  return 'mp4';
}

export class MediaStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'clips'), { recursive: true });
    fs.mkdirSync(path.join(root, 'posters'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reels'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  }

  clipPath(clipId, ext = 'mp4') { return path.join(this.root, 'clips', `${clipId}.${ext}`); }
  posterPath(clipId) { return path.join(this.root, 'posters', `${clipId}.jpg`); }
  reelPath(groupId, day) { return path.join(this.root, 'reels', `${groupId}_${day}.mp4`); }

  /** Stream an upload straight to disk; returns bytes written. */
  async saveStream(dest, stream, limitBytes) {
    const tmp = path.join(this.root, 'tmp', `${path.basename(dest)}.part`);
    let size = 0;
    const out = fs.createWriteStream(tmp);
    try {
      await pipeline(
        stream,
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > limitBytes) throw new HttpError(413, 'Clip too large', 'too_large');
            yield chunk;
          }
        },
        out,
      );
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    await fsp.rename(tmp, dest);
    return size;
  }

  async remove(file) { await fsp.rm(file, { force: true }); }

  async usage() {
    let total = 0;
    for (const dir of ['clips', 'posters', 'reels']) {
      const d = path.join(this.root, dir);
      for (const name of await fsp.readdir(d).catch(() => [])) {
        const st = await fsp.stat(path.join(d, name)).catch(() => null);
        if (st) total += st.size;
      }
    }
    return total;
  }
}

/* ------------------------------------------------------- range streaming -- */

/**
 * Serve a file with HTTP Range support — required for `<video>` seeking in Safari,
 * which always issues a `Range: bytes=0-1` probe before it will play anything.
 */
export async function serveFile(req, res, file, { mime, download, maxAge = 31536000 } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw notFound('File gone');
  }

  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = mime || MIME_BY_EXT[ext] || 'application/octet-stream';
  const headers = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': `private, max-age=${maxAge}, immutable`,
    'last-modified': stat.mtime.toUTCString(),
  };
  if (download) {
    headers['content-disposition'] =
      `attachment; filename="${String(download).replace(/["\\]/g, '')}"`;
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);
      if (start === null) {
        // suffix range: last N bytes
        start = Math.max(0, stat.size - (end ?? 0));
        end = stat.size - 1;
      } else if (end === null || end >= stat.size) {
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
    }
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res).catch(() => {});
}

/* ---------------------------------------------------------------- ffmpeg -- */

/**
 * How hard the stitcher is allowed to work, for the benefit of very small
 * machines (Oracle's free E2.1.Micro is 1 GB and an eighth of a core):
 *
 *   full  re-encode mismatched clips into one file      (default)
 *   copy  only stream-copy clips that already match; a mixed day falls back
 *         to saving clip by clip, which costs the box nothing
 *   off   no server-side stitching at all
 */
const REEL_MODE = ['full', 'copy', 'off'].includes(process.env.REEL_MODE)
  ? process.env.REEL_MODE
  : 'full';

let ffmpegChecked = null;
let ffprobeChecked = null;

const probeBinary = (name) => new Promise((resolve) => {
  execFile(name, ['-version'], (err) => resolve(!err));
});

/** Is ffmpeg on PATH? Cached after the first look. */
export function hasFfmpeg() {
  if (ffmpegChecked !== null) return ffmpegChecked;
  ffmpegChecked = probeBinary('ffmpeg').then((ok) => { ffmpegChecked = ok; return ok; });
  return ffmpegChecked;
}

/** Can this server offer "save the whole day" as one file? */
export async function reelEnabled() {
  return REEL_MODE !== 'off' && await hasFfmpeg();
}

function hasFfprobe() {
  if (ffprobeChecked !== null) return ffprobeChecked;
  ffprobeChecked = probeBinary('ffprobe').then((ok) => { ffprobeChecked = ok; return ok; });
  return ffprobeChecked;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(0, 1 << 20); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * A fingerprint of everything the concat demuxer insists must match.
 * Returns null when we cannot tell — which we treat as "assume mismatched".
 */
async function signature(file) {
  if (!(await hasFfprobe())) return null;
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,sample_rate,channels,pix_fmt',
    '-of', 'json', file,
  ], 20_000);
  if (code !== 0) return null;
  try {
    const streams = JSON.parse(stdout).streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!video) return null;
    return [
      video.codec_name, video.width, video.height, video.pix_fmt,
      audio ? `${audio.codec_name}:${audio.sample_rate}:${audio.channels}` : 'silent',
    ].join('|');
  } catch {
    return null;
  }
}

async function probeDuration(file) {
  if (!(await hasFfprobe())) return null;
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], 20_000);
  const value = Number(String(stdout).trim());
  return code === 0 && Number.isFinite(value) ? value : null;
}

const concatList = async (files, listFile) => {
  await fsp.writeFile(
    listFile,
    files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  return listFile;
};

const concatCopy = (listFile, outFile, timeoutMs) => run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', '-movflags', '+faststart',
  outFile,
], timeoutMs);

/**
 * Re-encode one clip to the house format: portrait 1080x1920, 30fps, stereo AAC.
 * Clips filmed without sound get a silent track so concat still lines up.
 */
async function normalise(file, outFile, hasAudio, timeoutMs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,' +
           'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '30000',
  );
  if (!hasAudio) args.push('-shortest');
  args.push(outFile);
  return run('ffmpeg', args, timeoutMs);
}

/**
 * Stitch clips into one downloadable MP4, in the order given.
 *
 * A stream copy is instant and lossless, but the concat demuxer will happily
 * exit 0 having silently dropped clips whose codec or size does not match the
 * first one — so we only take that path when every clip has an identical
 * fingerprint (the normal case: a group of iPhones), and we still check the
 * result is as long as it should be before trusting it. Otherwise every clip is
 * re-encoded to one house format first and then copied together.
 */
export async function stitchReel(files, outFile, { timeoutMs = 10 * 60_000, expectedSeconds = 0 } = {}) {
  if (REEL_MODE === 'off') return { ok: false, error: 'reel_disabled' };
  if (!(await hasFfmpeg())) return { ok: false, error: 'ffmpeg_unavailable' };
  if (!files.length) return { ok: false, error: 'no_clips' };

  const listFile = `${outFile}.txt`;
  const scratch = [];
  const cleanup = async () => {
    await fsp.rm(listFile, { force: true });
    await Promise.all(scratch.map((f) => fsp.rm(f, { force: true })));
  };

  try {
    const signatures = await Promise.all(files.map(signature));
    const uniform = signatures[0] !== null && signatures.every((s) => s === signatures[0]);

    let copyError = '';
    if (uniform) {
      await concatList(files, listFile);
      const copy = await concatCopy(listFile, outFile, timeoutMs);
      if (copy.code === 0 && await isComplete(outFile, expectedSeconds)) {
        return { ok: true, mode: 'copy' };
      }
      copyError = copy.stderr || 'stream copy came out short';
    }

    if (REEL_MODE === 'copy') {
      // Re-encoding would pin a tiny machine for minutes. The app already
      // knows how to hand over the clips one at a time instead.
      await fsp.rm(outFile, { force: true });
      return { ok: false, error: copyError || 'clips do not match and re-encoding is off' };
    }

    for (const [i, file] of files.entries()) {
      const temp = `${outFile}.${i}.part.mp4`;
      scratch.push(temp);
      const hasAudio = signatures[i] === null || !signatures[i].endsWith('silent');
      const result = await normalise(file, temp, hasAudio, timeoutMs);
      if (result.code !== 0) {
        // A clip we truly cannot read should not sink the whole reel.
        const retry = await normalise(file, temp, !hasAudio, timeoutMs);
        if (retry.code !== 0) {
          scratch.pop();
          await fsp.rm(temp, { force: true });
        }
      }
    }

    const usable = [];
    for (const temp of scratch) {
      const stat = await fsp.stat(temp).catch(() => null);
      if (stat && stat.size > 1024) usable.push(temp);
    }
    if (!usable.length) {
      await fsp.rm(outFile, { force: true });
      return { ok: false, error: (copyError || 'no clip could be re-encoded').slice(-400) };
    }

    await concatList(usable, listFile);
    const joined = await concatCopy(listFile, outFile, timeoutMs);
    if (joined.code === 0) {
      return { ok: true, mode: 'encode', clips: usable.length };
    }
    await fsp.rm(outFile, { force: true });
    return { ok: false, error: (joined.stderr || copyError || 'ffmpeg failed').slice(-400) };
  } finally {
    await cleanup();
  }
}

/** Did the stitch actually keep everything? */
async function isComplete(file, expectedSeconds) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.size < 1024) return false;
  if (!expectedSeconds) return true;
  const actual = await probeDuration(file);
  if (actual === null) return true; // cannot check — trust the exit code
  return actual >= expectedSeconds * 0.85;
}

/** Pull a poster frame out of a clip when the client could not make one. */
export async function extractPoster(videoFile, outFile) {
  if (!(await hasFfmpeg())) return false;
  const r = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '0.3', '-i', videoFile, '-frames:v', '1',
    '-vf', 'scale=540:-2', '-q:v', '4', outFile,
  ], 60_000);
  return r.code === 0;
}
