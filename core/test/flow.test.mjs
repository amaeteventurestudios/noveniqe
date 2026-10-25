// End to end against a real PocketBase: sign-in on two sites, guests, upgrade, merge, Google, the token endpoint's checks,
// and every staff role against Core's own admin API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, browser, csrfOf, authorizeUrl, emailSignIn, exchange, api, CLIENTS, SECRETS } from './helpers.mjs';
import { resetLimits } from '../lib/util.mjs';
import * as totp from '../lib/totp.mjs';

const google = { claims: null };
let t;
before(async () => {
  t = await start({
    google: { id: 'gid.apps', secret: 'gsecret', authUrl: 'https://google.test/auth', tokenUrl: 'https://google.test/token' },
    fetchStub: async (url, init) => {
      if (url !== 'https://google.test/token') return fetch(url, init);
      const p = new URLSearchParams(String(init.body));
      if (p.get('client_secret') !== 'gsecret') return new Response('{}', { status: 400 });
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(google.claims)}.sig` }), { status: 200 });
    },
  });
});
after(() => t?.stop());

const uniq = () => Math.random().toString(36).slice(2, 8);

test('a new player signs up with an email code, then is signed in on the second game at once', async () => {
  resetLimits();
  const b = browser(t.base), email = `ada.${uniq()}@example.com`;
  const s = await emailSignIn(t, b, CLIENTS.palasora, email);
  assert.match(s.final.location, /^https:\/\/palasora\.test\/cb\?code=.+&state=/);
  assert.equal(new URL(s.final.location).searchParams.get('state'), s.state);
  const x = await exchange(t, CLIENTS.palasora, s.final, s.verifier);
  assert.equal(x.status, 200);
  assert.equal(x.body.user.kind, 'member');
  assert.equal(x.body.user.email_verified, true);
  assert.equal(x.body.user.display_name, 'Ada');

  // the same browser on the other game: no screens, same person
  const a = authorizeUrl(CLIENTS.agp);
  const r = await b.get(a.url);
  assert.match(r.location, /^https:\/\/agp\.test\/cb\?code=/);
  const y = await exchange(t, CLIENTS.agp, r, a.verifier);
  assert.equal(y.body.user.id, x.body.user.id);

  // the user row is the one Palasora reads
  const u = await t.pb.get('users', x.body.user.id);
  assert.equal(u.email, email);
  assert.equal(u.handle, x.body.user.handle);
});

test('the token endpoint refuses a wrong verifier, a reused code, a wrong secret and another game\'s code', async () => {
  resetLimits();
  const b = browser(t.base);
  const s1 = await emailSignIn(t, b, CLIENTS.palasora, `bo.${uniq()}@example.com`);
  assert.equal((await exchange(t, CLIENTS.palasora, s1.final, 'x'.repeat(50))).status, 400, 'wrong verifier');
  assert.equal((await exchange(t, CLIENTS.palasora, s1.final, s1.verifier)).status, 400, 'a code is burnt by a failed try');

  const a = authorizeUrl(CLIENTS.palasora); const r = await b.get(a.url);
  assert.equal((await exchange(t, CLIENTS.palasora, r, a.verifier, 'wrong-secret')).status, 401);
  assert.equal((await exchange(t, CLIENTS.agp, r, a.verifier)).status, 400, 'another game cannot use it');
  assert.equal((await exchange(t, CLIENTS.palasora, r, a.verifier)).status, 200, 'another game\'s try does not burn the code for its own game');
});

test('the token endpoint: a good code works exactly once', async () => {
  resetLimits();
  const b = browser(t.base);
  await emailSignIn(t, b, CLIENTS.palasora, `cy.${uniq()}@example.com`);
  const a = authorizeUrl(CLIENTS.palasora); const r = await b.get(a.url);
  assert.equal((await exchange(t, CLIENTS.palasora, r, a.verifier)).status, 200);
  assert.equal((await exchange(t, CLIENTS.palasora, r, a.verifier)).status, 400);
});

test('authorize: a foreign return address gets a page, never a redirect; a bad request goes back with an error', async () => {
  const b = browser(t.base);
  const bad = new URLSearchParams({ client_id: 'agp', redirect_uri: 'https://evil.test/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  const r = await b.get(`/authorize?${bad}`);
  assert.equal(r.status, 400); assert.equal(r.location, null);
  const plain = new URLSearchParams({ client_id: 'agp', redirect_uri: 'https://agp.test/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'plain', state: 's1' });
  const r2 = await b.get(`/authorize?${plain}`);
  assert.equal(r2.location, 'https://agp.test/cb?error=invalid_request&state=s1');
  assert.equal((await b.get('/authorize?client_id=nope')).status, 400);
});

test('a guest saves their progress: same user id, the guest token stops working', async () => {
  resetLimits();
  const g = await api(t, CLIENTS.agp, 'POST', '/v1/guests', { ip: '10.0.0.1' });
  assert.equal(g.status, 201);
  assert.equal(g.body.user.kind, 'guest');
  assert.equal((await api(t, CLIENTS.palasora, 'POST', '/v1/guests', {})).status, 403, 'Palasora makes no guests');
  const again = await api(t, CLIENTS.agp, 'POST', '/v1/guests/resume', { guest_token: g.body.guest_token });
  assert.equal(again.body.user.id, g.body.user.id);

  const li = await api(t, CLIENTS.agp, 'POST', '/v1/link-intents', { guest_token: g.body.guest_token });
  assert.equal(li.status, 201);
  assert.equal((await emailSignIn(t, browser(t.base), CLIENTS.palasora, `zz.${uniq()}@example.com`, { link: li.body.link })).final.location.includes('error=invalid_request'), true, 'an intent only works for its own game');

  const b = browser(t.base);
  const s = await emailSignIn(t, b, CLIENTS.agp, `guest.${uniq()}@example.com`, { link: li.body.link });
  const x = await exchange(t, CLIENTS.agp, s.final, s.verifier);
  assert.equal(x.body.user.id, g.body.user.id, 'the same id');
  assert.equal(x.body.user.kind, 'member');
  assert.deepEqual(x.body.merged_from, []);
  assert.equal((await api(t, CLIENTS.agp, 'POST', '/v1/guests/resume', { guest_token: g.body.guest_token })).status, 404);
  assert.equal((await emailSignIn(t, browser(t.base), CLIENTS.agp, `again.${uniq()}@example.com`, { link: li.body.link })).final.location.includes('error=invalid_request'), true, 'an intent works once');
});

test('a guest whose email already has an account: merged after a yes, or left alone after a no', async () => {
  resetLimits();
  const email = `dee.${uniq()}@example.com`;
  const first = await emailSignIn(t, browser(t.base), CLIENTS.palasora, email);
  const member = (await exchange(t, CLIENTS.palasora, first.final, first.verifier)).body.user;

  // no: back to the game as a guest
  const g1 = await api(t, CLIENTS.agp, 'POST', '/v1/guests', {});
  const l1 = await api(t, CLIENTS.agp, 'POST', '/v1/link-intents', { guest_token: g1.body.guest_token });
  const b1 = browser(t.base);
  const s1 = await emailSignIn(t, b1, CLIENTS.agp, email, { link: l1.body.link });
  assert.equal(s1.final.location, '/merge');
  const m1 = await b1.get('/merge');
  assert.match(m1.html, /Add my guest progress/);
  const no = await b1.post('/merge', { csrf: csrfOf(m1.html), choice: 'cancel' });
  assert.match(no.location, /^https:\/\/agp\.test\/cb\?error=access_denied/);
  assert.equal((await api(t, CLIENTS.agp, 'POST', '/v1/guests/resume', { guest_token: g1.body.guest_token })).status, 200, 'still a guest');

  // yes: one account, the game is told which guest to fold in
  const g2 = await api(t, CLIENTS.agp, 'POST', '/v1/guests', {});
  const l2 = await api(t, CLIENTS.agp, 'POST', '/v1/link-intents', { guest_token: g2.body.guest_token });
  const b2 = browser(t.base);
  const s2 = await emailSignIn(t, b2, CLIENTS.agp, email, { link: l2.body.link });
  const m2 = await b2.get('/merge');
  const yes = await b2.post('/merge', { csrf: csrfOf(m2.html), choice: 'merge' });
  const x = await exchange(t, CLIENTS.agp, yes, s2.verifier);
  assert.equal(x.body.user.id, member.id);
  assert.deepEqual(x.body.merged_from, [g2.body.user.id]);
  const look = await api(t, CLIENTS.agp, 'GET', `/v1/users/${g2.body.user.id}`);
  assert.equal(look.body.merged_into, member.id);
  const merges = await api(t, CLIENTS.agp, 'GET', '/v1/merges');
  assert.ok(merges.body.merges.some((m) => m.from === g2.body.user.id && m.into === member.id));
  assert.equal((await t.pb.get('users', g2.body.user.id)).account_status, 'deleted');
});

test('a guest signed in to Novenique already is asked before merging', async () => {
  resetLimits();
  const b = browser(t.base);
  await emailSignIn(t, b, CLIENTS.palasora, `eve.${uniq()}@example.com`);
  const g = await api(t, CLIENTS.agp, 'POST', '/v1/guests', {});
  const l = await api(t, CLIENTS.agp, 'POST', '/v1/link-intents', { guest_token: g.body.guest_token });
  const a = authorizeUrl(CLIENTS.agp, { link: l.body.link });
  assert.equal((await b.get(a.url)).location, '/merge');
});

test('Google: a new account, and the same person when the verified email already has one', async () => {
  resetLimits();
  const email = `fay.${uniq()}@example.com`;
  const s = await emailSignIn(t, browser(t.base), CLIENTS.palasora, email);
  const member = (await exchange(t, CLIENTS.palasora, s.final, s.verifier)).body.user;

  const viaGoogle = async (claims) => {
    const b = browser(t.base), a = authorizeUrl(CLIENTS.palasora);
    await b.get(a.url);
    const go = await b.get('/google/start');
    const g = new URL(go.location);
    assert.equal(g.origin + g.pathname, 'https://google.test/auth');
    google.claims = { iss: 'https://accounts.google.com', aud: 'gid.apps', exp: Math.floor(Date.now() / 1000) + 600, nonce: g.searchParams.get('nonce'), ...claims };
    let r = await b.get(`/google/callback?code=abc&state=${g.searchParams.get('state')}`);
    if (r.location === '/profile') { const p = await b.get('/profile'); r = await b.post('/profile', { csrf: csrfOf(p.html), display_name: 'Gee', handle: 'gee_' + uniq() }); }
    return { r, x: r.location?.startsWith('https://') ? await exchange(t, CLIENTS.palasora, r, a.verifier) : null };
  };
  const same = await viaGoogle({ sub: 'g-' + uniq(), email, email_verified: true });
  assert.equal(same.x.body.user.id, member.id);
  const fresh = await viaGoogle({ sub: 'g-' + uniq(), email: `new.${uniq()}@gmail.com`, email_verified: true });
  assert.notEqual(fresh.x.body.user.id, member.id);
  const wrongNonce = await viaGoogle({ sub: 'g-' + uniq(), nonce: 'other' });
  assert.equal(wrongNonce.r.status, 400);
  const wrongAud = await viaGoogle({ sub: 'g-' + uniq(), aud: 'someone-else' });
  assert.equal(wrongAud.r.status, 400);
});

test('email codes: wrong codes run out, a stale page is refused', async () => {
  resetLimits();
  const b = browser(t.base), a = authorizeUrl(CLIENTS.palasora);
  await b.get(a.url);
  let r = await b.get('/signin');
  assert.equal((await b.post('/email/start', { csrf: 'nope', email: 'x@example.com' })).status, 400);
  r = await b.post('/email/start', { csrf: csrfOf(r.html), email: `gus.${uniq()}@example.com` });
  const csrf = csrfOf(r.html), good = t.cfg.mail.last.code, wrong = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) r = await b.post('/email/verify', { csrf, code: wrong });
  assert.match(r.html, /Too many wrong codes|expired/);
  r = await b.post('/email/verify', { csrf, code: good });
  assert.match(r.html, /expired/, 'the right code no longer works after five wrong ones');
});

test('names and handles: taken, reserved, then the account page', async () => {
  resetLimits();
  const b1 = browser(t.base);
  const s = await emailSignIn(t, b1, CLIENTS.palasora, `hal.${uniq()}@example.com`, { profile: { display_name: 'Hal', handle: 'hal_' + uniq() } });
  const taken = (await exchange(t, CLIENTS.palasora, s.final, s.verifier)).body.user.handle;
  const b2 = browser(t.base), a = authorizeUrl(CLIENTS.palasora);
  await b2.get(a.url);
  let r = await b2.get('/signin');
  r = await b2.post('/email/start', { csrf: csrfOf(r.html), email: `ivy.${uniq()}@example.com` });
  r = await b2.post('/email/verify', { csrf: csrfOf(r.html), code: t.cfg.mail.last.code });
  const p = await b2.get('/profile');
  assert.match((await b2.post('/profile', { csrf: csrfOf(p.html), display_name: 'Ivy', handle: taken })).html, /taken/);
  assert.match((await b2.post('/profile', { csrf: csrfOf(p.html), display_name: 'Ivy', handle: 'n0venique' })).html, /reserved/);
  const page = await b1.get('/account');
  assert.match(page.html, new RegExp('@' + taken));
  assert.match(page.html, /Email code/);
});

test('someone who signed up on Palasora\'s own form keeps their id when they sign in through Novenique', async () => {
  resetLimits();
  const realm = await t.core.accounts.realm(), email = `jo.${uniq()}@example.com`, pw = 'palasora-pass-123';
  const old = await t.pb.create('users', { email, password: pw, passwordConfirm: pw, verified: true, tenant_id: realm, handle: 'jo_' + uniq(), display_name: 'Jo',
    account_status: 'active', profile_kind: 'human' });
  const s = await emailSignIn(t, browser(t.base), CLIENTS.palasora, email);
  const x = await exchange(t, CLIENTS.palasora, s.final, s.verifier);
  assert.equal(x.body.user.id, old.id);
  assert.equal(x.body.user.handle, old.handle);
});

// ---------- staff ----------
async function staffBrowser(product, role, { mfa = true } = {}) {
  resetLimits();
  const b = browser(t.base), h = `st_${uniq()}`;
  const s = await emailSignIn(t, b, CLIENTS.palasora, `${h}@example.com`, { profile: { display_name: 'Staff', handle: h } });
  const id = (await exchange(t, CLIENTS.palasora, s.final, s.verifier)).body.user.id;
  if (role) await t.pb.create('nv_roles', { user_id: id, product, role, granted_by: 'test' });
  let page = await b.get('/account');
  if (mfa && role !== 'player' && role) {
    page = await b.post('/account/mfa/setup', { csrf: csrfOf(page.html) });
    const secret = page.html.match(/<code>([A-Z2-7]+)<\/code>/)[1];
    page = await b.post('/account/mfa/enable', { csrf: csrfOf(page.html), code: totp.totp(secret) });
    assert.match(page.html, /Second step is on/);
    page = await b.get('/account');
  }
  return { b, id, csrf: csrfOf(page.html) };
}

test('admin API: no session, a player, and staff before the second step are all refused', async () => {
  assert.equal((await browser(t.base).get('/admin/api/users')).status, 401);
  const player = await staffBrowser('agp', 'player');
  assert.equal((await player.b.get('/admin/api/users')).status, 403);
  const noMfa = await staffBrowser('platform', 'super_admin', { mfa: false });
  const r = await noMfa.b.get('/admin/api/users');
  assert.equal(r.status, 403); assert.match(r.html, /MFA_REQUIRED/);
});

test('admin API: every staff role against every Core admin route', async () => {
  const target = await staffBrowser(null, null);
  const routes = [['GET', '/admin/api/users', 'platform.users.view'], ['GET', `/admin/api/users/${target.id}`, 'platform.users.view'],
    ['POST', '/admin/api/roles', 'platform.users.roles'], ['DELETE', '/admin/api/roles', 'platform.users.roles'],
    ['GET', '/admin/api/audit', 'platform.audit.view'], ['GET', '/admin/api/audit/export', 'platform.audit.export']];
  const may = { 'platform:super_admin': () => true, 'platform:platform_admin': (p) => p !== 'platform.audit.export' };
  for (const [product, role] of [['platform', 'super_admin'], ['platform', 'platform_admin'], ['agp', 'agp_admin'], ['palasora', 'palasora_admin'],
    ['agp', 'moderator'], ['platform', 'moderator']]) {
    const s = await staffBrowser(product, role);
    for (const [method, path, perm] of routes) {
      const form = { user_id: target.id, product: 'agp', role: 'moderator' };
      const r = method === 'GET' ? await s.b.get(path) : method === 'POST' ? await s.b.post(path, form, { 'x-csrf': s.csrf }) : await s.b.del(path, form, { 'x-csrf': s.csrf });
      const allowed = (may[`${product}:${role}`] ?? (() => false))(perm);
      assert.equal(r.status === 200, allowed, `${product}:${role} ${method} ${path} → ${r.status} ${r.html.slice(0, 120)}`);
      if (!allowed) assert.equal(r.status, 403);
    }
  }
});

test('admin API: escalation is refused over HTTP, and a missing x-csrf header too', async () => {
  const pa = await staffBrowser('platform', 'platform_admin');
  const other = await staffBrowser(null, null);
  const grant = (s, form, h = { 'x-csrf': s.csrf }) => s.b.post('/admin/api/roles', form, h);
  assert.equal((await grant(pa, { user_id: other.id, product: 'agp', role: 'agp_admin' }, {})).status, 403, 'no csrf header');
  assert.match((await grant(pa, { user_id: other.id, product: 'platform', role: 'super_admin' })).html, /Only a Super Administrator/);
  assert.match((await grant(pa, { user_id: pa.id, product: 'agp', role: 'agp_admin' })).html, /your own roles/);
  const ok = await grant(pa, { user_id: other.id, product: 'agp', role: 'agp_admin' });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.html).roles, [{ product: 'agp', role: 'agp_admin' }]);
  const authz = await api(t, CLIENTS.agp, 'GET', `/v1/authz?user_id=${other.id}&perm=agp.races.administer`);
  assert.equal(authz.body.allowed, true);
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/authz?user_id=${other.id}&perm=palasora.town.administer`)).status, 403, 'a game asks only about itself');
  const audit = JSON.parse((await pa.b.get('/admin/api/audit')).html).events;
  assert.ok(audit.some((e) => e.action === 'access.role_granted' && e.object_id === other.id));
});

test('sign out everywhere ends every accounts-site session', async () => {
  const s = await staffBrowser(null, null);
  const r = await s.b.post('/signout', { csrf: s.csrf, everywhere: '1' });
  assert.equal(r.status, 200);
  assert.equal((await s.b.get('/account')).location, '/signin');
});

test('health', async () => {
  const r = await fetch(t.base + '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, google: true, email: true });
});

void SECRETS;
