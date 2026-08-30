/* Tiny DOM + interaction helpers. No framework: the whole app is ~5 screens. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', {class:'x', onclick}, [child, 'text']) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [children].flat(3)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const c of [children].flat(3)) if (c) f.append(c.nodeType ? c : document.createTextNode(String(c)));
  return f;
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------------------------------------------------------- avatars -- */

export function avatar(user, size = '') {
  return el('span', {
    class: `avatar ${size}`.trim(),
    style: { '--hue': String(user?.hue ?? 20) },
    'aria-hidden': 'true',
  }, [user?.emoji || '🙂']);
}

/* ----------------------------------------------------------------- toasts -- */

const toastHost = () => $('#toasts');

export function toast(message, kind = '', ms = 3200) {
  const node = el('div', { class: `toast ${kind}`.trim() }, [message]);
  toastHost().append(node);
  const kill = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  };
  node.addEventListener('click', kill);
  setTimeout(kill, ms);
  return kill;
}

export function toastBusy(message) {
  const node = el('div', { class: 'toast' }, [el('span', { class: 'spinner' }), message]);
  toastHost().append(node);
  return {
    done(text, kind = 'good') {
      node.replaceChildren(document.createTextNode(text));
      node.className = `toast ${kind}`;
      setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 260); }, 2000);
    },
    remove: () => node.remove(),
  };
}

/* ----------------------------------------------------------------- sheets -- */

let sheetCloser = null;

export function openSheet(content, { onClose } = {}) {
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  clear(body).append(content);
  $('#scrim').classList.add('on');
  sheet.classList.add('on');
  $('#dock').classList.add('away');
  sheetCloser = onClose || null;
  return closeSheet;
}

export function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('on')) return;
  sheet.classList.remove('on');
  $('#scrim').classList.remove('on');
  const onHome = document.documentElement.dataset.screen === 'home';
  if (onHome && document.body.dataset.dock !== 'hidden') $('#dock').classList.remove('away');
  const cb = sheetCloser;
  sheetCloser = null;
  if (cb) cb();
}

export function confirmSheet({ title, body, confirm = 'Do it', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value) => { answered = true; closeSheet(); resolve(value); };
    openSheet(frag([
      el('h3', { class: 't-title' }, [title]),
      body ? el('p', { class: 't-meta', style: { marginTop: 'var(--s2)' } }, [body]) : null,
      el('div', { class: 'stack gap-2', style: { marginTop: 'var(--s5)' } }, [
        el('button', {
          class: `btn btn-block ${danger ? 'btn-flare' : 'btn-primary'}`,
          onclick: () => done(true),
        }, [confirm]),
        el('button', { class: 'btn btn-quiet btn-block', onclick: () => done(false) }, ['Cancel']),
      ]),
    ]), { onClose: () => { if (!answered) resolve(false); } });
  });
}

/* ------------------------------------------------------------------ time -- */

const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "4h 12m" / "12:04" style countdown, chosen by magnitude. */
export function fmtCountdown(ms) {
  if (ms <= 0) return { text: 'now', parts: null };
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return { text: `${h}:${pad(m)}:${pad(s)}`, parts: { h, m, s } };
  return { text: `${m}:${pad(s)}`, parts: { h: 0, m, s } };
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Friendly label for a memory day key (YYYY-MM-DD). */
export function fmtDay(dayKey, { long = false } = {}) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  if (!long) {
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
  }
  return date.toLocaleDateString([], {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* --------------------------------------------------------------- feedback -- */

/** iOS ignores vibrate, but Android phones in the group get the tick. */
export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

export const icon = (path, size = 20, width = 1.75) =>
  el('span', {
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="${width}" stroke-linecap="round"
      stroke-linejoin="round">${path}</svg>`,
    style: { display: 'flex' },
  });

export const ICONS = {
  location: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1116 0z"/><circle cx="12" cy="10" r="3"/>',
  share: '<path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><path d="M16 6l-4-4-4 4M12 2v14"/>',
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 018 0v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 012-2h10"/>',
};
