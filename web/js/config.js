/**
 * Where the API lives.
 *
 * The app can be served from three quite different places:
 *
 *   1. the Groups server itself   — the API is right here, at ./api
 *   2. GitHub Pages (or any CDN)  — static only; the API is somewhere else
 *   3. a subpath                  — Pages puts the app at /<repo>/, not /
 *
 * So nothing is hardcoded to the origin. The base is resolved once at boot,
 * remembered, and can arrive in an invite link as ?s=<server url>.
 */

const KEY = 'groups.server';

/** The directory the app is served from: '' at the root, '/groups' on Pages. */
const localBase = new URL('.', location.href).pathname.replace(/\/+$/, '');

export const config = {
  apiBase: localBase,   // no trailing slash
  connected: false,     // has a server actually answered?
  local: true,          // is that server the one serving this page?
};

export function normalizeServer(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    // Tolerate someone pasting a full invite link rather than a bare host.
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const remembered = () => {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
};

export function rememberServer(base) {
  try {
    if (base) localStorage.setItem(KEY, base);
    else localStorage.removeItem(KEY);
  } catch { /* private mode */ }
};

/** Absolute URL for an API path such as "/api/me". */
export const apiUrl = (path) => `${config.apiBase}${path}`;

/**
 * Media links come back from the server as root-relative paths with a signature
 * attached. They have to be re-based onto whichever server issued them.
 */
export const mediaUrl = (path) => (path ? `${config.apiBase}${path}` : path);

async function reachable(base, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Point the app at a server, checking it answers before committing. */
export async function useServer(input) {
  const base = normalizeServer(input);
  if (!base) return { ok: false, error: 'That does not look like an address' };
  if (!(await reachable(base))) {
    return { ok: false, error: 'No Groups server answered there' };
  }
  config.apiBase = base;
  config.connected = true;
  config.local = false;
  rememberServer(base);
  return { ok: true, base };
}

/**
 * Work out which server to talk to. Order: an invite link, then whatever we
 * used last, then a server.json shipped alongside the app, then this origin.
 */
export async function resolveServer() {
  const params = new URLSearchParams(location.search);

  const fromLink = normalizeServer(params.get('s'));
  if (fromLink && await reachable(fromLink)) {
    config.apiBase = fromLink;
    config.connected = true;
    config.local = false;
    rememberServer(fromLink);
    return config;
  }

  const saved = normalizeServer(remembered());
  if (saved && await reachable(saved)) {
    config.apiBase = saved;
    config.connected = true;
    config.local = false;
    return config;
  }

  // A deployment can ship a default server next to the static files.
  try {
    const res = await fetch(new URL('server.json', new URL('.', location.href)), {
      cache: 'no-store',
    });
    if (res.ok) {
      const bundled = normalizeServer((await res.json()).apiBase);
      if (bundled && await reachable(bundled)) {
        config.apiBase = bundled;
        config.connected = true;
        config.local = false;
        rememberServer(bundled);
        return config;
      }
    }
  } catch { /* no bundled server, which is fine */ }

  // Finally: are we being served by the Groups server itself?
  if (await reachable(localBase)) {
    config.apiBase = localBase;
    config.connected = true;
    config.local = true;
    return config;
  }

  config.connected = false;
  return config;
}

export function forgetServer() {
  rememberServer('');
  config.apiBase = localBase;
  config.connected = false;
  config.local = true;
}
