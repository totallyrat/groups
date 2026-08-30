/* App state, live updates, and the offline upload queue. */

import { api, auth, ApiError } from './api.js';

/* ------------------------------------------------------------------ state -- */

const listeners = new Set();

export const state = {
  me: null,
  groups: [],
  groupId: null,
  home: null,        // payload of GET /api/groups/:id
  push: { enabled: false, publicKey: null },
  capabilities: {},
  online: navigator.onLine,
  uploads: [],       // in-flight or queued clips
  lastSeq: 0,
  // Bumped only when the group payload is replaced, so upload-progress ticks
  // (which fire many times a second) do not rebuild the whole home screen.
  homeVersion: 0,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[groups] render error', err); }
  }
}

export function patch(changes) {
  Object.assign(state, changes);
  emit();
}

const GROUP_KEY = 'groups.lastGroup';
export const rememberGroup = (gid) => {
  try { localStorage.setItem(GROUP_KEY, gid); } catch { /* ignore */ }
};
export const lastGroup = () => {
  try { return localStorage.getItem(GROUP_KEY); } catch { return null; }
};

/* ------------------------------------------------------------------ loads -- */

export async function loadMe() {
  const data = await api.me();
  patch({
    me: data.user,
    groups: data.groups,
    push: data.push,
    capabilities: data.capabilities || {},
  });
  return data;
}

export async function loadGroup(gid = state.groupId, { quiet = false } = {}) {
  if (!gid) return null;
  try {
    const data = await api.group(gid);
    if (state.groupId !== gid) rememberGroup(gid);
    patch({ groupId: gid, home: data, homeVersion: state.homeVersion + 1 });
    return data;
  } catch (err) {
    if (!quiet) throw err;
    return null;
  }
}

/* --------------------------------------------------------------- realtime -- */

let source = null;
let reconnectTimer = null;
const eventHandlers = new Set();

export function onServerEvent(fn) {
  eventHandlers.add(fn);
  return () => eventHandlers.delete(fn);
}

export function connectLive() {
  if (!auth.token || source) return;
  // EventSource cannot send an Authorization header — the session cookie set at
  // sign-in carries it instead.
  try {
    source = new EventSource(`/api/stream?since=${state.lastSeq}`);
  } catch {
    return;
  }

  source.onmessage = handleEvent;
  for (const type of [
    'hangout', 'hangout-response', 'hangout-closed', 'clip', 'clip-removed',
    'member-joined', 'member-left', 'member', 'group', 'vault-opened', 'reel',
    'watched', 'reaction',
  ]) {
    source.addEventListener(type, handleEvent);
  }

  source.onerror = () => {
    source?.close();
    source = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectLive, 4000);
  };
}

export function disconnectLive() {
  source?.close();
  source = null;
  clearTimeout(reconnectTimer);
}

function handleEvent(message) {
  let event;
  try { event = JSON.parse(message.data); } catch { return; }
  if (event.seq) state.lastSeq = Math.max(state.lastSeq, event.seq);
  for (const fn of eventHandlers) {
    try { fn(event); } catch (err) { console.error('[groups] event handler', err); }
  }
}

/* --------------------------------------------------------- upload queue -- */

const DB_NAME = 'groups';
const STORE = 'uploads';
let dbPromise = null;

function openQueue() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openQueue();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const result = fn(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Queue a clip. It uploads immediately when possible, and survives the app being
 * closed mid-upload on a bad connection — you filmed it, it will land.
 */
export async function queueClip({ groupId, blob, poster, meta }) {
  const item = {
    id: `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    groupId, blob, poster, meta, tries: 0, queuedAt: Date.now(),
  };
  try { await tx('readwrite', (store) => store.put(item)); } catch { /* memory-only fallback */ }
  state.uploads = [...state.uploads, { id: item.id, progress: 0, meta }];
  emit();
  flushQueue();
  return item.id;
}

let flushing = false;

export async function flushQueue() {
  if (flushing || !navigator.onLine || !auth.token) return;
  flushing = true;
  try {
    let items = [];
    try { items = await tx('readonly', (store) => store.getAll()); } catch { items = []; }
    for (const item of items) {
      await sendOne(item);
    }
  } finally {
    flushing = false;
  }
}

async function sendOne(item) {
  const track = (progress) => {
    state.uploads = state.uploads.map((u) => (u.id === item.id ? { ...u, progress } : u));
    emit();
  };
  try {
    const res = await api.uploadClip(item.groupId, item.blob, item.meta, { onProgress: track });
    if (item.poster && res?.clip?.id) {
      await api.uploadPoster(res.clip.id, item.poster).catch(() => {});
    }
    await tx('readwrite', (store) => store.delete(item.id)).catch(() => {});
    state.uploads = state.uploads.filter((u) => u.id !== item.id);
    emit();
    for (const fn of eventHandlers) {
      fn({ type: 'local-upload-done', groupId: item.groupId, payload: res });
    }
  } catch (err) {
    const fatal = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
    if (fatal || item.tries >= 6) {
      await tx('readwrite', (store) => store.delete(item.id)).catch(() => {});
      state.uploads = state.uploads.filter((u) => u.id !== item.id);
      emit();
      for (const fn of eventHandlers) {
        fn({ type: 'local-upload-failed', payload: { message: err.message } });
      }
    } else {
      item.tries += 1;
      await tx('readwrite', (store) => store.put(item)).catch(() => {});
    }
  }
}

export async function pendingUploads() {
  try { return await tx('readonly', (store) => store.getAll()); } catch { return []; }
}

window.addEventListener('online', () => { patch({ online: true }); flushQueue(); connectLive(); });
window.addEventListener('offline', () => patch({ online: false }));
