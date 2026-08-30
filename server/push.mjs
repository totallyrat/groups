/**
 * Web Push, implemented from scratch on node:crypto.
 *
 *   - VAPID (RFC 8292)  — ES256 JWT identifying this server to the push service
 *   - aes128gcm (RFC 8188 + RFC 8291) — payload encryption to the subscriber
 *
 * This is what makes real lock-screen notifications work on an iPhone once the
 * PWA has been added to the Home Screen (iOS 16.4+).
 */
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(String(str), 'base64url');

/* ------------------------------------------------------------ VAPID keys -- */

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pjwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([
      Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y),
    ])),
    privateKey: pjwk.d,
  };
}

function privateKeyFrom(publicKeyB64, privateKeyB64) {
  const pub = unb64u(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
      d: privateKeyB64,
    },
    format: 'jwk',
  });
}

/* ------------------------------------------------------------- VAPID JWT -- */

function vapidHeader({ endpoint, subject, publicKey, privateKey }) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: privateKeyFrom(publicKey, privateKey), dsaEncoding: 'ieee-p1363' },
  );
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

/* ------------------------------------------------------------ encryption -- */

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** HKDF-Expand for output lengths <= 32 bytes (all we need here). */
const expand = (prk, info, len) =>
  hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, len);

/**
 * Encrypt `plaintext` for a subscription's keys, returning an aes128gcm body.
 * Layout: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext+tag
 */
export function encryptPayload(plaintext, p256dhB64, authB64, fixed = null) {
  const uaPublic = unb64u(p256dhB64);
  const authSecret = unb64u(authB64);

  // `fixed` exists only so the RFC 8291 test vector can be replayed deterministically.
  const local = crypto.createECDH('prime256v1');
  if (fixed?.asPrivate) local.setPrivateKey(fixed.asPrivate);
  else local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic,
  ]);
  const ikm = expand(hmac(authSecret, shared), keyInfo, 32);

  const salt = fixed?.salt || crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = expand(prk, 'Content-Encoding: nonce\0', 12);

  // A single record: plaintext followed by the 0x02 "last record" delimiter.
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, body]);
}

/* --------------------------------------------------------------- sending -- */

export class Pusher {
  constructor({ publicKey, privateKey, subject }) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.subject = subject || 'mailto:push@groups.app';
    this.enabled = Boolean(publicKey && privateKey);
  }

  /**
   * @returns {Promise<{ok: boolean, status: number, gone: boolean, error?: string}>}
   * `gone` means the subscription is dead and should be deleted.
   */
  async send(sub, payloadObject, { ttl = 3600, urgency = 'high' } = {}) {
    if (!this.enabled) return { ok: false, status: 0, gone: false, error: 'push_disabled' };

    let body;
    try {
      body = encryptPayload(JSON.stringify(payloadObject), sub.p256dh, sub.auth);
    } catch (err) {
      return { ok: false, status: 0, gone: true, error: `encrypt: ${err.message}` };
    }

    const headers = {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ttl: String(ttl),
      urgency,
      authorization: vapidHeader({
        endpoint: sub.endpoint,
        subject: this.subject,
        publicKey: this.publicKey,
        privateKey: this.privateKey,
      }),
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(sub.endpoint, {
        method: 'POST', headers, body, signal: controller.signal,
      });
      clearTimeout(timer);
      const gone = res.status === 404 || res.status === 410;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, gone, error: text.slice(0, 300) };
      }
      return { ok: true, status: res.status, gone: false };
    } catch (err) {
      return { ok: false, status: 0, gone: false, error: err.message };
    }
  }
}
