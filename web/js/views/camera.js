/* The viewfinder. Records up to 3 minutes, then drops it into tonight's vault. */

import { $, el, toast, haptic, fmtDuration } from '../ui.js';
import { state, queueClip, loadGroup } from '../store.js';
import { show, back } from '../router.js';

const MAX_SECONDS = 180;
const ARC_LENGTH = 245.04; // 2πr for r=39

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

let stream = null;
let recorder = null;
let chunks = [];
let facing = 'user';
let startedAt = 0;
let ticker = null;
let recorded = null;   // { blob, url, duration, shotAt }
let pressAt = 0;

const pickMime = () => MIME_CANDIDATES.find((m) => {
  try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
}) || '';

/* ----------------------------------------------------------------- open -- */

export async function openCamera() {
  if (!state.groupId) return toast('Join a group first');
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('This browser cannot reach the camera', 'warn');
  }

  show('camera');
  document.body.dataset.dock = 'hidden';
  $('#dock').classList.add('away');
  resetUi();

  try {
    await startStream();
  } catch (err) {
    closeCamera();
    toast(
      err?.name === 'NotAllowedError'
        ? 'Camera access is off. Turn it on in Settings › Safari.'
        : 'Could not start the camera',
      'warn',
    );
  }
}

async function startStream() {
  stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: facing,
      width: { ideal: 1080 },
      height: { ideal: 1920 },
      frameRate: { ideal: 30 },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const preview = $('#preview');
  preview.srcObject = stream;
  preview.classList.toggle('mirror', facing === 'user');
  preview.muted = true;
  await preview.play().catch(() => {});
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export function closeCamera() {
  stopRecording({ discard: true });
  stopStream();
  clearInterval(ticker);
  releaseRecorded();
  const preview = $('#preview');
  preview.srcObject = null;
  document.body.dataset.dock = '';
  $('#dock').classList.remove('away');
  back('home');
}

/* ------------------------------------------------------------ recording -- */

function startRecording() {
  if (!stream || recorder) return;
  chunks = [];
  const mimeType = pickMime();
  try {
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 3_500_000,
      audioBitsPerSecond: 128_000,
    });
  } catch {
    recorder = new MediaRecorder(stream);
  }

  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(1000); // timeslice keeps memory sane on a 3-minute take

  startedAt = Date.now();
  haptic(14);
  $('#rec-button').classList.add('recording');
  $('#rec-timer').classList.add('live');
  $('#cam-hint').textContent = 'Tap again to stop';

  clearInterval(ticker);
  ticker = setInterval(paintProgress, 100);
  paintProgress();
}

function paintProgress() {
  const elapsed = (Date.now() - startedAt) / 1000;
  const fraction = Math.min(1, elapsed / MAX_SECONDS);
  $('#rec-arc').style.strokeDashoffset = String(ARC_LENGTH * (1 - fraction));
  $('#rec-timer').firstChild.nodeValue = `${fmtDuration(elapsed)} `;
  if (elapsed >= MAX_SECONDS) {
    toast('3 minutes — that is the limit');
    stopRecording();
  }
}

function stopRecording({ discard = false } = {}) {
  if (!recorder) return;
  if (discard) recorder.onstop = null;
  clearInterval(ticker);
  try { recorder.stop(); } catch { /* already stopped */ }
  if (discard) recorder = null;
}

function finishRecording() {
  const duration = (Date.now() - startedAt) / 1000;
  const type = recorder?.mimeType || chunks[0]?.type || 'video/mp4';
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  recorder = null;
  chunks = [];
  haptic([8, 30, 8]);

  $('#rec-button').classList.remove('recording');
  $('#rec-timer').classList.remove('live');
  $('#rec-arc').style.strokeDashoffset = String(ARC_LENGTH);

  if (duration < 0.7 || blob.size < 1024) {
    toast('Too short — hold on a bit longer');
    resetUi();
    return;
  }

  recorded = { blob, url: URL.createObjectURL(blob), duration, shotAt: startedAt };
  showReview();
}

function releaseRecorded() {
  if (recorded?.url) URL.revokeObjectURL(recorded.url);
  recorded = null;
}

/* --------------------------------------------------------------- review -- */

function showReview() {
  const playback = $('#playback');
  playback.src = recorded.url;
  playback.classList.remove('hidden');
  playback.muted = false;
  playback.play().catch(() => {});
  $('#preview').style.opacity = '0';

  $('#cam-cancel').style.visibility = 'visible';
  $('#cam-use').style.visibility = 'visible';
  $('#rec-button').style.visibility = 'hidden';
  $('#cam-flip').style.visibility = 'hidden';
  $('#cam-hint').textContent = '';

  if (!$('#caption-field')) {
    const field = el('input', {
      class: 'field',
      id: 'caption-field',
      placeholder: 'Say something (optional)',
      maxlength: '140',
      enterkeyhint: 'done',
      style: {
        position: 'absolute',
        left: 'var(--s4)',
        right: 'var(--s4)',
        bottom: 'calc(var(--safe-bottom) + 132px)',
        width: 'auto',
        zIndex: '3',
        background: 'rgba(0,0,0,.42)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      },
    });
    $('#screen-camera').append(field);
  }
  $('#caption-field').classList.remove('hidden');
  $('#rec-timer').firstChild.nodeValue = `${fmtDuration(recorded.duration)} `;
}

function resetUi() {
  const playback = $('#playback');
  playback.pause();
  playback.removeAttribute('src');
  playback.classList.add('hidden');
  $('#preview').style.opacity = '1';
  $('#cam-cancel').style.visibility = 'hidden';
  $('#cam-use').style.visibility = 'hidden';
  $('#rec-button').style.visibility = 'visible';
  $('#cam-flip').style.visibility = 'visible';
  $('#rec-arc').style.strokeDashoffset = String(ARC_LENGTH);
  $('#rec-timer').firstChild.nodeValue = '0:00 ';
  $('#cam-hint').textContent = 'Tap to record · up to 3 minutes';
  $('#caption-field')?.classList.add('hidden');
  const field = $('#caption-field');
  if (field) field.value = '';
  releaseRecorded();
}

/* --------------------------------------------------------- poster frame -- */

/** Grab a still so the vault and Memory Lane have something to show. */
async function makePoster(videoUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const bail = setTimeout(() => resolve(null), 4000);

    const grab = () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 540 / (video.videoWidth || 540));
        canvas.width = Math.round((video.videoWidth || 540) * scale);
        canvas.height = Math.round((video.videoHeight || 960) * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => { clearTimeout(bail); resolve(blob); }, 'image/jpeg', 0.72);
      } catch {
        clearTimeout(bail);
        resolve(null);
      }
    };

    video.onseeked = grab;
    video.onloadeddata = () => { try { video.currentTime = 0.15; } catch { grab(); } };
    video.onerror = () => { clearTimeout(bail); resolve(null); };
  });
}

/* ----------------------------------------------------------------- send -- */

async function useClip() {
  if (!recorded) return;
  const caption = $('#caption-field')?.value.trim() || '';
  const poster = await makePoster(recorded.url);
  const groupId = state.groupId;

  await queueClip({
    groupId,
    blob: recorded.blob,
    poster,
    meta: {
      shotAt: recorded.shotAt,
      duration: recorded.duration,
      caption,
      width: $('#playback').videoWidth || null,
      height: $('#playback').videoHeight || null,
    },
  });

  haptic([10, 40, 10]);
  const opens = state.home?.vault?.opensAt;
  const hours = opens ? Math.max(0, Math.round((opens - Date.now()) / 3600_000)) : null;
  toast(
    hours != null && hours > 0
      ? `In the vault — opens in ${hours}h`
      : 'In the vault',
    'good',
  );
  closeCamera();
  loadGroup().catch(() => {});
}

/* -------------------------------------------------------------- wire up -- */

export function initCamera() {
  const button = $('#rec-button');

  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (recorder) { stopRecording(); return; }
    pressAt = Date.now();
    startRecording();
  });

  // Hold to record, tap to toggle — whichever the thumb feels like doing.
  button.addEventListener('pointerup', () => {
    if (recorder && Date.now() - pressAt >= 350) stopRecording();
  });
  button.addEventListener('pointercancel', () => {
    if (recorder && Date.now() - pressAt >= 350) stopRecording();
  });

  $('#cam-close').addEventListener('click', closeCamera);
  $('#cam-cancel').addEventListener('click', () => { resetUi(); });
  $('#cam-use').addEventListener('click', useClip);
  $('#cam-flip').addEventListener('click', async () => {
    if (recorder) return;
    facing = facing === 'user' ? 'environment' : 'user';
    try { await startStream(); } catch { toast('No second camera'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && recorder) stopRecording();
  });
}
