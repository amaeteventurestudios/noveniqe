// Test harness: a throwaway PocketBase (PB_BIN, default ./pocketbase or /tmp/pocketbase) with either the fixture schema or
// Palasora's real migrations (PB_MIGRATIONS), Core on a free port, and a tiny browser with a cookie jar.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { loadConfig } from '../lib/config.mjs';
import { makeCore } from '../lib/app.mjs';
import { sha, challengeOf, token } from '../lib/util.mjs';

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const bin = () => [process.env.PB_BIN, './pocketbase', '/tmp/pocketbase'].find((p) => p && existsSync(p));

export const SECRETS = { agp: 'agp-test-secret-0123456789', palasora: 'palasora-test-secret-0123456789' };
export const CLIENTS = {
  agp: { id: 'agp', name: 'Agent Grand Prix', product: 'agp', guests: true, color: '#E10600', home: 'https://agp.test', redirect_uris: ['https://agp.test/cb'], secretHash: sha(SECRETS.agp) },
  palasora: { id: 'palasora', name: 'Palasora', product: 'palasora', guests: false, color: '#C34218', home: 'https://palasora.test', redirect_uris: ['https://palasora.test/cb'], secretHash: sha(SECRETS.palasora) },
};

export async function start(overrides = {}) {
  const pbBin = bin();
  if (!pbBin) throw new Error('Set PB_BIN to a PocketBase 0.40 binary');
  const dir = mkdtempSync(join(tmpdir(), 'nvcore-'));
  const migrations = process.env.PB_MIGRATIONS ?? new URL('./fixtures/pb_migrations', import.meta.url).pathname;
  const args = [`--dir=${dir}`, `--migrationsDir=${migrations}`];
  execFileSync(pbBin, ['migrate', 'up', ...args], { stdio: 'ignore' });
  execFileSync(pbBin, ['superuser', 'upsert', 'core@test.local', 'core-test-password', `--dir=${dir}`], { stdio: 'ignore' });
  const port = await freePort();
  const proc = spawn(pbBin, ['serve', ...args, '--automigrate=false', `--http=127.0.0.1:${port}`], { stdio: 'ignore' });
  const pbUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${pbUrl}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  const corePort = await freePort();
  const cfg = loadConfig({ CORE_ENV: 'test', CORE_PUBLIC_URL: `http://127.0.0.1:${corePort}`, PB_URL: pbUrl, PB_CORE_EMAIL: 'core@test.local', PB_CORE_PASSWORD: 'core-test-password',
    MAIL_PROVIDER: 'sink', CORE_SECRET: 'a'.repeat(64), STAFF_MFA_REQUIRED: 'true' }, { clients: CLIENTS, ...overrides });
  const core = makeCore(cfg, { fetch: overrides.fetchStub });
  await core.ensureSchema();
  await core.pb.create('tenants', { slug: 'palavva', name: 'Palasora', status: 'active' });
  const srv = await core.listen(corePort, '127.0.0.1');
  const base = `http://127.0.0.1:${corePort}`;
  return { cfg, core, pb: core.pb, base, stop: () => { srv.close(); proc.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A browser: keeps cookies, never follows redirects, returns { status, location, html }. */
export function browser(base) {
  const jar = new Map();
  async function req(method, path, form, headers = {}) {
    const r = await fetch(path.startsWith('http') ? path : base + path, { method, redirect: 'manual',
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: form ? new URLSearchParams(form) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  }
  return { get: (p) => req('GET', p), post: (p, f, h) => req('POST', p, f, h), del: (p, f, h) => req('DELETE', p, f, h), jar };
}
export const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

/** Starts a game sign-in: returns the PKCE verifier and the /authorize URL. */
export function authorizeUrl(client, extra = {}) {
  const verifier = token(48), state = token(8);
  const p = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: client.redirect_uris[0], state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', ...extra });
  return { verifier, state, url: `/authorize?${p}` };
}

/** The whole email sign-in in a browser, ending at the game's return address. Returns the final redirect. */
export async function emailSignIn(t, b, client, email, { profile = { display_name: 'Ada', handle: 'ada_' + token(4).toLowerCase().replace(/[^a-z0-9]/g, 'x') }, link } = {}) {
  const a = authorizeUrl(client, link ? { link } : {});
  let r = await b.get(a.url);
  if (r.location?.startsWith(client.redirect_uris[0])) return { ...a, final: r };
  if (r.location !== '/signin') return { ...a, final: r };
  r = await b.get('/signin');
  r = await b.post('/email/start', { csrf: csrfOf(r.html), email });
  r = await b.post('/email/verify', { csrf: csrfOf(r.html), code: t.cfg.mail.last.code });
  if (r.location === '/profile') {
    const p = await b.get('/profile');
    r = await b.post('/profile', { csrf: csrfOf(p.html), ...profile });
  }
  return { ...a, final: r };
}

export async function exchange(t, client, final, verifier, secret = SECRETS[client.id]) {
  const u = new URL(final.location);
  const r = await fetch(`${t.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${client.id}:${secret}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code') ?? '', redirect_uri: client.redirect_uris[0], code_verifier: verifier }) });
  return { status: r.status, body: await r.json(), code: u.searchParams.get('code') };
}

export async function api(t, client, method, path, body) {
  const r = await fetch(t.base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${client.id}:${SECRETS[client.id]}`).toString('base64') },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
