/* The nightly reel: everyone's clips, oldest first, played as one film. */

import { $, el, clear, toast, toastBusy, haptic, fmtClock, fmtDay, fmtDuration } from '../ui.js';
import { api } from '../api.js';
import { state, loadGroup } from '../store.js';
import { mediaUrl } from '../config.js';
import { show, back } from '../router.js';

const REACTIONS = ['❤️', '😂', '🔥', '😮', '🥲'];

let memory = null;
let index = 0;
let groupId = null;
let paused = false;
let holdTimer = null;
let preloader = null;

/* ----------------------------------------------------------------- open -- */

export async function openReel(gid, day, { startAt = 0 } = {}) {
  groupId = gid;
  const busy = toastBusy('Opening…');
  try {
    memory = await api.memory(gid, day);
  } catch (err) {
    busy.done(err.message || 'Could not open', 'warn');
    return;
  }
  busy.remove();

  if (!memory.unlocked) {
    toast('That one is still sealed');
    return;
  }
  if (!memory.clips.length) {
    toast('Nothing was filmed that day');
    return;
  }

  index = Math.min(startAt, memory.clips.length - 1);
  paused = false;
  show('reel');
  document.body.dataset.dock = 'hidden';
  $('#dock').classList.add('away');
  $('#reel-end').classList.remove('on');
  $('#screen-reel').classList.remove('ended');
  buildBars();
  playCurrent();
}

export function closeReel() {
  const video = $('#reel-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  preloader?.remove();
  preloader = null;
  document.body.dataset.dock = '';
  $('#dock').classList.remove('away');
  memory = null;
  back('home');
}

/* -------------------------------------------------------------- playback -- */

function buildBars() {
  const bars = clear($('#reel-bars'));
  for (let i = 0; i < memory.clips.length; i++) {
    bars.append(el('i', {}, [el('b')]));
  }
}

function paintBars() {
  const bars = [...$('#reel-bars').children];
  bars.forEach((bar, i) => {
    bar.firstChild.style.width = i < index ? '100%' : i === index ? '0%' : '0%';
  });
}

function playCurrent() {
  const clip = memory.clips[index];
  if (!clip) return finish();

  const video = $('#reel-video');
  video.src = mediaUrl(clip.url);
  video.currentTime = 0;
  video.muted = $('#reel-mute').dataset.muted === '1';
  video.play().catch(() => {
    // Safari refuses unmuted autoplay in some states — fall back to muted.
    video.muted = true;
    video.play().catch(() => {});
  });

  paintBars();
  $('#reel-avatar').textContent = clip.user.emoji;
  $('#reel-avatar').style.setProperty('--hue', String(clip.user.hue ?? 20));
  $('#reel-who').textContent = clip.user.id === state.me?.id ? 'You' : clip.user.name;
  $('#reel-when').textContent =
    `${fmtClock(clip.shotAt)} · ${fmtDuration(clip.duration)} · ${index + 1}/${memory.clips.length}`;
  $('#reel-caption').textContent = clip.caption || '';
  paintReactions(clip);
  preloadNext();
}

function preloadNext() {
  const next = memory.clips[index + 1];
  if (!next) return;
  if (!preloader) {
    preloader = el('video', {
      preload: 'auto', playsinline: true, muted: true,
      style: { position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' },
    });
    $('#screen-reel').append(preloader);
  }
  const nextUrl = mediaUrl(next.url);
  if (preloader.src !== nextUrl) preloader.src = nextUrl;
}

function step(delta) {
  const target = index + delta;
  if (target < 0) return;
  if (target >= memory.clips.length) return finish();
  index = target;
  haptic(6);
  playCurrent();
}

async function finish() {
  const video = $('#reel-video');
  video.pause();
  paintBars();
  $('#reel-bars').querySelectorAll('b').forEach((b) => { b.style.width = '100%'; });

  const people = new Set(memory.clips.map((c) => c.user.id)).size;
  $('#screen-reel').classList.add('ended');
  $('#reel-end-title').textContent = `That was ${fmtDay(memory.day).toLowerCase()}`;
  $('#reel-end-sub').textContent =
    `${memory.clips.length} clip${memory.clips.length === 1 ? '' : 's'} from ${people} ` +
    `${people === 1 ? 'person' : 'people'} · ${fmtDuration(memory.totalSeconds)}`;
  $('#reel-end').classList.add('on');

  api.markWatched(groupId, memory.day).then(() => loadGroup()).catch(() => {});
}

/* ------------------------------------------------------------- reactions -- */

function paintReactions(clip) {
  const bar = clear($('#reel-reacts'));
  const mine = new Set(
    (clip.reactions || []).filter((r) => r.userId === state.me?.id).map((r) => r.emoji),
  );
  for (const emoji of REACTIONS) {
    const count = (clip.reactions || []).filter((r) => r.emoji === emoji).length;
    bar.append(el('button', {
      class: `react ${mine.has(emoji) ? 'on' : ''}`.trim(),
      onclick: async (e) => {
        e.stopPropagation();
        const on = mine.has(emoji);
        haptic(10);
        e.currentTarget.classList.toggle('on', !on);
        try {
          await api.react(clip.id, emoji, on);
          clip.reactions = (clip.reactions || []).filter(
            (r) => !(r.userId === state.me?.id && r.emoji === emoji),
          );
          if (!on) clip.reactions.push({ emoji, userId: state.me?.id });
          paintReactions(clip);
        } catch { /* the optimistic toggle already happened */ }
      },
    }, [count > 0 ? `${emoji}${count > 1 ? count : ''}` : emoji]));
  }
}

/* ---------------------------------------------------------------- saving -- */

/**
 * On iOS the share sheet is the only route into Photos, so try that first and
 * fall back to a plain download everywhere else.
 */
async function saveVideo(url, filename, label) {
  const busy = toastBusy(`Getting ${label}…`);
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const file = new File([blob], filename, { type: blob.type || 'video/mp4' });

    if (navigator.canShare?.({ files: [file] })) {
      busy.remove();
      await navigator.share({ files: [file], title: filename });
      toast('Pick "Save Video" to keep it', 'good');
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = el('a', { href: objectUrl, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    busy.done('Saved to your downloads');
  } catch (err) {
    if (err?.name === 'AbortError') return busy.remove();
    busy.done(err.message || 'Could not save', 'warn');
  }
}

async function saveWholeDay() {
  if (!memory) return;
  const name = `${(state.home?.group?.name || 'groups').replace(/[^\w]+/g, '-')}-${memory.day}.mp4`;

  if (memory.reel?.available) {
    const busy = toastBusy('Stitching the day together…');
    try {
      let result = await api.buildReel(groupId, memory.day);
      for (let i = 0; i < 90 && result.status === 'building'; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const refreshed = await api.memory(groupId, memory.day);
        result = refreshed.reel.status === 'ready'
          ? { status: 'ready', url: refreshed.reel.url }
          : { status: refreshed.reel.status };
      }
      busy.remove();
      if (result.status === 'ready') {
        await saveVideo(mediaUrl(result.url), name, 'the whole day');
        return;
      }
    } catch {
      busy.remove();
    }
  }

  // No server-side stitching: hand over the clips one at a time instead.
  toast(`Saving ${memory.clips.length} clips one by one`, '', 4000);
  for (const [i, clip] of memory.clips.entries()) {
    await saveVideo(
      `${mediaUrl(clip.url)}&download=1`,
      `${memory.day}-${String(i + 1).padStart(2, '0')}-${clip.user.name.replace(/\W+/g, '')}.mp4`,
      `clip ${i + 1}`,
    );
  }
}

/* -------------------------------------------------------------- wire up -- */

export function initReel() {
  const video = $('#reel-video');

  video.addEventListener('timeupdate', () => {
    if (!memory || !video.duration) return;
    const bar = $('#reel-bars').children[index]?.firstChild;
    if (bar) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
  });
  video.addEventListener('ended', () => step(1));
  video.addEventListener('error', () => {
    if (memory) { toast('That clip would not play'); step(1); }
  });

  // Tap left/right to move, press and hold to pause.
  $('#reel-zones').addEventListener('pointerdown', (e) => {
    holdTimer = setTimeout(() => {
      paused = true;
      video.pause();
      $('.reel-bottom')?.style.setProperty('opacity', '0.25');
    }, 260);
    e.currentTarget.dataset.zone = e.target.dataset.reel || '';
  });

  const release = (e) => {
    clearTimeout(holdTimer);
    if (paused) {
      paused = false;
      video.play().catch(() => {});
      $('.reel-bottom')?.style.setProperty('opacity', '1');
      return;
    }
    const zone = e.target.dataset.reel;
    if (zone === 'back') {
      if (video.currentTime > 2) { video.currentTime = 0; }
      else step(-1);
    } else if (zone === 'next') step(1);
  };
  $('#reel-zones').addEventListener('pointerup', release);
  $('#reel-zones').addEventListener('pointercancel', () => {
    clearTimeout(holdTimer);
    if (paused) { paused = false; video.play().catch(() => {}); }
  });

  $('#reel-close').addEventListener('click', closeReel);
  $('#reel-done').addEventListener('click', closeReel);
  $('#reel-replay').addEventListener('click', () => {
    index = 0;
    $('#reel-end').classList.remove('on');
    $('#screen-reel').classList.remove('ended');
    buildBars();
    playCurrent();
  });
  $('#reel-download').addEventListener('click', saveWholeDay);

  $('#reel-mute').addEventListener('click', (e) => {
    const muted = e.currentTarget.dataset.muted !== '1';
    e.currentTarget.dataset.muted = muted ? '1' : '0';
    e.currentTarget.style.opacity = muted ? '0.5' : '1';
    video.muted = muted;
  });

  $('#reel-save').addEventListener('click', () => {
    const clip = memory?.clips[index];
    if (!clip) return;
    saveVideo(
      `${mediaUrl(clip.url)}&download=1`,
      `${memory.day}-${clip.user.name.replace(/\W+/g, '')}.mp4`,
      'this clip',
    );
  });
}
