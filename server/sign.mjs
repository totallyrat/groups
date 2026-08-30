/**
 * Short-lived signed URLs.
 *
 * `<video src>`, a download link and `EventSource` cannot carry an
 * Authorization header, and once the app is served from another origin —
 * GitHub Pages, say — the session cookie cannot travel with them either.
 * So the server hands out URLs that carry their own proof instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A per-install secret, persisted so signatures survive a restart. */
export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key.length >= 32) return key;
  } catch { /* first boot */ }
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function createSigner(secret) {
  const mac = (data) =>
    crypto.createHmac('sha256', secret).update(data).digest('base64url').slice(0, 27);

  return {
    /**
     * @param {string} userId  who the link is for
     * @param {string} scope   what it unlocks, e.g. "clip:c_abc" or "stream"
     */
    sign(userId, scope, ttlSeconds = 6 * 3600) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return `${userId}.${exp}.${mac(`${userId}.${scope}.${exp}`)}`;
    },

    /** @returns {string|null} the user id the token belongs to */
    verify(token, scope) {
      if (typeof token !== 'string') return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [userId, expRaw, given] = parts;
      const exp = Number(expRaw);
      if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
      const expected = mac(`${userId}.${scope}.${exp}`);
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      return userId;
    },
  };
}
