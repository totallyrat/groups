/* Thin API client. Holds the session token and knows how to survive being offline. */

import { apiUrl } from './config.js';

const TOKEN_KEY = 'groups.token';

export const auth = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode */ }
  },
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, { body, headers = {}, raw, signal, onProgress } = {}) {
  // XHR is the only way to get upload progress, and clips are big.
  if (onProgress && raw) return uploadWithProgress(method, path, body, headers, onProgress, signal);

  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    throw new ApiError(res.status, payload?.error || 'error', payload?.message || `HTTP ${res.status}`);
  }
  return payload;
}

function uploadWithProgress(method, path, body, headers, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, apiUrl(path));
    // Only meaningful same-origin; cross-origin auth is the bearer token.
    xhr.withCredentials = true;
    if (auth.token) xhr.setRequestHeader('authorization', `Bearer ${auth.token}`);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new ApiError(xhr.status, payload?.error || 'error', payload?.message || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'Network unavailable'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

export const api = {
  get: (p, opts) => request('GET', p, opts),
  post: (p, body, opts) => request('POST', p, { ...opts, body }),
  patch: (p, body, opts) => request('PATCH', p, { ...opts, body }),
  del: (p, opts) => request('DELETE', p, opts),

  /* auth */
  register: (name, emoji, hue) =>
    request('POST', '/api/auth/register', { body: { name, emoji, hue, device: deviceLabel() } }),
  restore: (recoveryPhrase) =>
    request('POST', '/api/auth/restore', { body: { recoveryPhrase, device: deviceLabel() } }),
  me: () => request('GET', '/api/me'),
  updateMe: (patch) => request('PATCH', '/api/me', { body: patch }),

  /* groups */
  createGroup: (name, emoji) =>
    request('POST', '/api/groups', {
      body: { name, emoji, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, unlockHour: 20 },
    }),
  joinGroup: (code) => request('POST', '/api/groups/join', { body: { code } }),
  group: (gid) => request('GET', `/api/groups/${gid}`),
  updateGroup: (gid, patch) => request('PATCH', `/api/groups/${gid}`, { body: patch }),
  leaveGroup: (gid) => request('POST', `/api/groups/${gid}/leave`),

  /* hangouts */
  startHangout: (gid, payload) => request('POST', `/api/groups/${gid}/hangouts`, { body: payload }),
  hangout: (hid) => request('GET', `/api/hangouts/${hid}`),
  respond: (hid, payload) => request('POST', `/api/hangouts/${hid}/respond`, { body: payload }),
  closeHangout: (hid) => request('POST', `/api/hangouts/${hid}/close`),

  /* memories */
  uploadClip: (gid, blob, meta, { onProgress, signal } = {}) =>
    request('POST', `/api/groups/${gid}/clips`, {
      raw: true,
      body: blob,
      onProgress,
      signal,
      headers: {
        'content-type': blob.type || 'video/mp4',
        'x-shot-at': String(meta.shotAt),
        'x-duration': String(meta.duration || 0),
        'x-caption': b64(meta.caption || ''),
        ...(meta.width ? { 'x-width': String(meta.width) } : {}),
        ...(meta.height ? { 'x-height': String(meta.height) } : {}),
      },
    }),
  uploadPoster: (clipId, blob) =>
    request('POST', `/api/clips/${clipId}/poster`, {
      raw: true, body: blob, headers: { 'content-type': 'image/jpeg' },
    }),
  memories: (gid) => request('GET', `/api/groups/${gid}/memories`),
  memory: (gid, day) => request('GET', `/api/groups/${gid}/memories/${day}`),
  markWatched: (gid, day) => request('POST', `/api/groups/${gid}/memories/${day}/mark-watched`),
  buildReel: (gid, day) => request('POST', `/api/groups/${gid}/memories/${day}/reel`),
  react: (clipId, emoji, remove = false) =>
    request('POST', `/api/clips/${clipId}/react`, { body: { emoji, remove } }),
  deleteClip: (clipId) => request('DELETE', `/api/clips/${clipId}`),

  /* realtime */
  streamTicket: () => request('POST', '/api/stream/ticket'),

  /* push */
  subscribePush: (subscription) => request('POST', '/api/push/subscribe', { body: { subscription } }),
  unsubscribePush: (endpoint) => request('POST', '/api/push/unsubscribe', { body: { endpoint } }),
  testPush: () => request('POST', '/api/push/test'),
};

function b64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Web';
}
