// Staff second sign-in step: time-based one-time codes (RFC 6238, HMAC-SHA1, 30-second steps, 6 digits), the format every
// authenticator app reads. Ported from Palasora's apps/web/lib/access/totp.ts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newSecret = () => base32Encode(randomBytes(20));
export function hotp(key, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest(), off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
export const stepAt = (ms = Date.now()) => Math.floor(ms / 30_000);
export const totp = (secret, ms = Date.now()) => hotp(base32Decode(secret), stepAt(ms));
/** The matched step (current or one either side), or null. A step at or below lastStep is refused: no replays. */
export function verify(secret, code, lastStep = -1, ms = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret), now = stepAt(ms);
  for (const s of [now - 1, now, now + 1]) {
    if (s <= lastStep) continue;
    const a = Buffer.from(hotp(key, s)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}
export const otpauth = (secret, account) =>
  `otpauth://totp/${encodeURIComponent('Novenique')}:${encodeURIComponent(account)}?secret=${secret}&issuer=Novenique&algorithm=SHA1&digits=6&period=30`;
export const hashRecovery = (c) => createHash('sha256').update(c.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
export const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => { const r = randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
