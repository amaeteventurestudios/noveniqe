// Signing in on the game's own screen: the game's server calls /v1/signin/* with what the player typed, and Google goes
// straight from the game to Google and back (via=google), so the player never sees a Novenique page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, browser, authorizeUrl, exchange, api, CLIENTS } from './helpers.mjs';
import { resetLimits } from '../lib/util.mjs';

const google = { claims: null };
let t;
before(async () => {
  t = await start({
    google: { id: 'gid.apps', secret: 'gsecret', authUrl: 'https://google.test/auth', tokenUrl: 'https://google.test/token' },
    fetchStub: async (url, init) => {
      if (url !== 'https://google.test/token') return fetch(url, init);
      const p = new URLSearchParams(String(init.body));
      if (p.get('redirect_uri') !== 'https://agp.test/auth/google/callback') return new Response('{}', { status: 400 });
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(google.claims)}.sig` }), { status: 200 });
    },
  });
});
after(() => t?.stop());

const uniq = () => Math.random().toString(36).slice(2, 8);
const agp = (path, body) => api(t, CLIENTS.agp, 'POST', path, body);

test('email on the game screen: a new player gets a code, signs in, then picks a name', async () => {
  resetLimits();
  const email = `ivy.${uniq()}@example.com`;
  const s = await agp('/v1/signin/email/start', { email, ip: '10.1.0.1' });
  assert.equal(s.status, 200);
  assert.match(s.body.masked, /@example\.com$/);
  assert.equal((await agp('/v1/signin/email/start', { email: 'nope' })).status, 400);
  const wrong = await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.body.error.code, 'WRONG_CODE');
  const v = await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.kind, 'member');
  assert.equal(v.body.needs_profile, true);
  assert.equal((await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code })).body.error.code, 'EXPIRED', 'a code works once');
  const bad = await agp('/v1/signin/profile', { ticket: v.body.ticket, display_name: 'Ivy', handle: 'x' });
  assert.equal(bad.body.error.code, 'BAD_PROFILE');
  const p = await agp('/v1/signin/profile', { ticket: v.body.ticket, display_name: 'Ivy', handle: 'ivy_' + uniq() });
  assert.equal(p.status, 200);
  assert.equal(p.body.needs_profile, false);
  assert.equal(p.body.user.id, v.body.user.id);
  assert.equal((await api(t, CLIENTS.palasora, 'POST', '/v1/signin/profile', { ticket: v.body.ticket, display_name: 'Ivy', handle: 'ivy_' + uniq() })).status, 400, 'a ticket only works for its own game');
});

test('email on the game screen: a guest keeps their id, or merges into an account after a yes', async () => {
  resetLimits();
  const g = await agp('/v1/guests', {});
  const email = `jo.${uniq()}@example.com`;
  await agp('/v1/signin/email/start', { email });
  const v = await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code, guest_token: g.body.guest_token });
  assert.equal(v.body.user.id, g.body.user.id, 'the guest became the member');
  assert.equal(v.body.user.kind, 'member');

  const g2 = await agp('/v1/guests', {});
  await agp('/v1/signin/email/start', { email });
  const m = await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code, guest_token: g2.body.guest_token });
  assert.equal(m.body.merge_needed, true);
  assert.ok(m.body.who);
  assert.equal((await agp('/v1/signin/profile', { ticket: m.body.ticket, display_name: 'A', handle: 'abcdef' })).status, 400, 'a merge ticket is not a sign-in');
  const yes = await agp('/v1/signin/merge', { ticket: m.body.ticket, choice: 'merge' });
  assert.equal(yes.body.user.id, g.body.user.id);
  assert.deepEqual(yes.body.merged_from, [g2.body.user.id]);
  assert.equal((await t.pb.get('users', g2.body.user.id)).account_status, 'deleted');
});

test('Google from the game: straight to Google, back through the game, then the game finishes it', async () => {
  resetLimits();
  const b = browser(t.base), a = authorizeUrl(CLIENTS.agp, { via: 'google' });
  const go = await b.get(a.url);
  const g = new URL(go.location);
  assert.equal(g.origin + g.pathname, 'https://google.test/auth', 'no Novenique page');
  assert.equal(g.searchParams.get('redirect_uri'), 'https://agp.test/auth/google/callback');
  google.claims = { iss: 'https://accounts.google.com', aud: 'gid.apps', exp: Math.floor(Date.now() / 1000) + 600, nonce: g.searchParams.get('nonce'),
    sub: 'g-' + uniq(), email: `kai.${uniq()}@gmail.com`, email_verified: true, name: 'Kai' };
  const r = await b.get(`/google/callback?code=abc&state=${g.searchParams.get('state')}`);
  assert.ok(r.location.startsWith('https://agp.test/cb?code='), 'no profile page either');
  const x = await exchange(t, CLIENTS.agp, r, a.verifier);
  assert.equal(x.body.needs_profile, true);
  const p = await agp('/v1/signin/profile', { ticket: x.body.ticket, display_name: 'Kai', handle: 'kai_' + uniq() });
  assert.equal(p.body.user.id, x.body.user.id);

  // cancelled at Google: back to the game with an error
  const b2 = browser(t.base), a2 = authorizeUrl(CLIENTS.agp, { via: 'google' });
  const g2 = new URL((await b2.get(a2.url)).location);
  const no = await b2.get(`/google/callback?error=access_denied&state=${g2.searchParams.get('state')}`);
  assert.match(no.location, /^https:\/\/agp\.test\/cb\?error=access_denied/);
});

test('Google from the game, as a guest whose email has an account: the game asks before merging', async () => {
  resetLimits();
  const email = `lee.${uniq()}@example.com`;
  await agp('/v1/signin/email/start', { email });
  const member = (await agp('/v1/signin/email/verify', { email, code: t.cfg.mail.last.code })).body.user;
  const g = await agp('/v1/guests', {});
  const li = await agp('/v1/link-intents', { guest_token: g.body.guest_token });
  const b = browser(t.base), a = authorizeUrl(CLIENTS.agp, { via: 'google', link: li.body.link });
  const gu = new URL((await b.get(a.url)).location);
  google.claims = { iss: 'https://accounts.google.com', aud: 'gid.apps', exp: Math.floor(Date.now() / 1000) + 600, nonce: gu.searchParams.get('nonce'),
    sub: 'g-' + uniq(), email, email_verified: true };
  const r = new URL((await b.get(`/google/callback?code=abc&state=${gu.searchParams.get('state')}`)).location);
  assert.equal(r.origin + r.pathname, 'https://agp.test/cb');
  assert.ok(r.searchParams.get('merge'));
  assert.ok(r.searchParams.get('who'));
  const yes = await agp('/v1/signin/merge', { ticket: r.searchParams.get('merge'), choice: 'merge' });
  assert.equal(yes.body.user.id, member.id);
  assert.deepEqual(yes.body.merged_from, [g.body.user.id]);
});
