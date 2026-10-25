// Small helpers shared by Core's handlers: hashing, cookies, signed values, request bodies, rate limits, HTML escaping.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sixDigits = () => String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
export function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
/** S256 code challenge for a PKCE verifier. */
export const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

// ---- signed values (the sign-in flow cookie): base64url(JSON) + "." + HMAC-SHA256 ----
export function sign(obj, secret) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function unsign(value, secret) {
  if (!value || value.length > 4000) return null;
  const [body, mac] = value.split('.');
  if (!body || !mac || !same(mac, createHmac('sha256', secret).update(body).digest('base64url'))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

// ---- sealing (MFA secrets): AES-256-GCM, "v1:<iv>:<tag>:<ciphertext>" ----
export function seal(plain, key) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}
export function unseal(sealed, key) {
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---- cookies ----
export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
export function setCookie(res, name, value, { maxAge, secure, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

// ---- request bodies: forms and JSON, capped at 32 KB ----
export async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 32_768) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString();
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); } }
  return Object.fromEntries(new URLSearchParams(raw));
}

// ---- rate limits: fixed windows in memory (one Core process) ----
const hits = new Map();
export function limited(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key);
  if (!h || now - h.at > windowMs) { hits.set(key, { at: now, n: 1 }); return false; }
  h.n += 1;
  if (hits.size > 50_000) for (const [k, v] of hits) if (now - v.at > 3_600_000) hits.delete(k);
  return h.n > max;
}
export const resetLimits = () => hits.clear();

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return d ? `${u.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(u.length - 1, 6)))}@${d}` : '';
}
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
