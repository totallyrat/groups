/**
 * Generates a VAPID key pair for Web Push.
 *
 *   npm run keys
 *
 * Put the output in your environment (or let the server generate and persist
 * its own pair into DATA_DIR/vapid.json, which is fine for one instance).
 * Changing these invalidates every existing push subscription.
 */
import { generateVapidKeys } from '../server/push.mjs';

const { publicKey, privateKey } = generateVapidKeys();

console.log(`
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:you@example.com
`);
