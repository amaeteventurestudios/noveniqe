// Novenique Core: one account for every Novenique game, at accounts.novenique.com.
//
// Signing in from a game (the "authorization code with PKCE" flow, so the two game domains never share a cookie):
//   1. the game sends the player to /authorize?client_id&redirect_uri&state&code_challenge&code_challenge_method=S256
//      (plus &link=<intent> when a guest is saving their progress);
//   2. the player signs in here with Google or a 6-digit email code (the flow lives in a signed cookie, nv_flow);
//   3. Core sends the player back with a one-time code; the game's server swaps it at POST /token, with its client secret
//      and the PKCE verifier, for the player's id, name, roles and any guest ids merged into them. Each game keeps its own
//      session cookie and brand.
// Guests: a game's server makes one with POST /v1/guests and keeps the guest token in its own cookie. Saving progress later
// (POST /v1/link-intents, then /authorize with &link) adds a sign-in method to the same user id, or, if that email or Google
// account already has an account, merges the guest into it after the player says yes.
import { createServer } from 'node:http';
import { makePB, q, pbDate, fromPb } from './pb.mjs';
import { ensureSchema } from './schema.mjs';
import { makeAccounts } from './accounts.mjs';
import { sendCode } from './mail.mjs';
import * as P from './pages.mjs';
import * as totp from './totp.mjs';
import { PRODUCTS, ROLES, permsOf, isStaff, checkRoleChange } from './roles.mjs';
import { EMAIL_RE, body, challengeOf, cookies, limited, maskEmail, same, seal, setCookie, sha, sign, sixDigits, token, unsign, unseal } from './util.mjs';

const FLOW = 'nv_flow';
const SELF = { id: '_self', name: 'Novenique', color: '#3D5AFE', home: null, product: 'platform' };
const FLOW_MINUTES = 30;

export function makeCore(cfg, deps = {}) {
  const pb = deps.pb ?? makePB(cfg.pb);
  const A = makeAccounts({ pb, cfg });
  const SESSION = cfg.secure ? '__Host-nv_session' : 'nv_session';
  const fetchImpl = deps.fetch ?? fetch;
  // A sign-in form's answer can redirect on to a game (and to Google), and form-action covers redirects, so list them.
  const formTargets = [...new Set([...Object.values(cfg.clients).flatMap((c) => c.redirect_uris.map((u) => new URL(u).origin)),
    ...(cfg.google ? [new URL(cfg.google.authUrl).origin] : [])])].join(' ');

  // ---------- small response helpers ----------
  const send = (res, status, html, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTargets}; frame-ancestors 'none'; base-uri 'none'`, ...headers });
    res.end(html);
  };
  const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const fail = (res, status, code, message) => json(res, status, { error: { code, message } });
  const go = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };
  const ipOf = (req) => (cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

  // ---------- the sign-in flow cookie ----------
  const readFlow = (req) => { const f = unsign(cookies(req)[FLOW], cfg.key); return f && f.exp > Date.now() ? f : null; };
  const writeFlow = (res, f) => setCookie(res, FLOW, sign({ ...f, exp: f.exp ?? Date.now() + FLOW_MINUTES * 60_000 }, cfg.key), { secure: cfg.secure, maxAge: FLOW_MINUTES * 60 });
  const clearFlow = (res) => setCookie(res, FLOW, '', { secure: cfg.secure, maxAge: 0 });
  const clientOf = (f) => (f?.c === SELF.id ? SELF : cfg.clients[f?.c]) ?? null;

  // ---------- sessions on the accounts site ----------
  async function session(req) {
    const raw = cookies(req)[SESSION];
    if (!raw || raw.length < 30 || raw.length > 100) return null;
    const s = await pb.first('nv_sessions', `token_hash=${q(sha(raw))}`);
    if (!s || !(fromPb(s.expires_at) > new Date())) return null;
    const user = await A.active(s.user_id);
    if (!user) return null;
    if (Date.now() - (fromPb(s.last_seen_at)?.getTime() ?? 0) > 3_600_000) pb.update('nv_sessions', s.id, { last_seen_at: pbDate() }).catch(() => {});
    return { ...s, user };
  }
  async function startSession(req, res, userId) {
    const old = await session(req);
    if (old) await pb.remove('nv_sessions', old.id).catch(() => {});   // a new sign-in always gets a new token
    const raw = token(32), days = cfg.sessionDays;
    await pb.create('nv_sessions', { user_id: userId, token_hash: sha(raw), csrf: token(16), expires_at: pbDate(new Date(Date.now() + days * 86400_000)),
      last_seen_at: pbDate(), agent: String(req.headers['user-agent'] ?? '').replace(/\s+/g, ' ').slice(0, 120) });
    setCookie(res, SESSION, raw, { secure: cfg.secure, maxAge: days * 86400 });
  }

  // ---------- client authentication (game servers) ----------
  function clientAuth(req, form = {}) {
    let id = form.client_id, secret = form.client_secret;
    const h = String(req.headers.authorization ?? '');
    if (h.startsWith('Basic ')) { const [a, b] = Buffer.from(h.slice(6), 'base64').toString().split(':'); id = decodeURIComponent(a ?? ''); secret = decodeURIComponent(b ?? ''); }
    const c = cfg.clients[id];
    if (!c || !c.secretHash || !secret || !same(sha(secret), c.secretHash)) return null;
    return c;
  }

  // ---------- finishing a sign-in ----------
  // userId: the person who just signed in (their new session cookie is only on the response, not on this request yet)
  async function finish(req, res, f, userId) {
    const user = userId ? await A.active(userId) : (await session(req))?.user;
    if (!user) return go(res, '/signin');
    const client = clientOf(f);
    if (A.needsProfile(user) && !f.via) { writeFlow(res, f); return go(res, '/profile'); }
    if (client === SELF) { clearFlow(res); return go(res, f.next && f.next.startsWith('/') && !f.next.startsWith('//') ? f.next : '/account'); }
    const code = token(32);
    await pb.create('nv_codes', { code_hash: sha(code), client_id: client.id, redirect_uri: f.r, challenge: f.ch, user_id: user.id,
      expires_at: pbDate(new Date(Date.now() + 60_000)), merged_from: f.mf ?? [] });
    clearFlow(res);
    const u = new URL(f.r);
    u.searchParams.set('code', code);
    if (f.s) u.searchParams.set('state', f.s);
    return go(res, u.toString());
  }

  /** One sign-in method proved (Google or an email code): find or make the person, handle a guest's upgrade or merge. */
  async function signedIn(req, res, f, { provider, subject, email, name }) {
    const ident = await A.identity(provider, subject);
    let userId = ident ? await A.resolve(ident.user_id) : null;
    if (userId && !(await A.active(userId))) return send(res, 403, P.message({ title: 'This account is closed', text: 'Contact support if you think this is a mistake.', client: clientOf(f) }));
    if (!userId && email) userId = (await A.byEmail(email))?.id ?? null;   // e.g. an account made on Palasora's own form
    const guestId = f.g ?? null;
    if (guestId && userId && userId !== guestId) {
      await A.attach(userId, provider, subject, email);
      if (f.via) {
        // signing in on the game's own screen: the game asks the merge question itself, then calls /v1/signin/merge
        const u0 = await A.active(userId), back = new URL(f.r);
        clearFlow(res);
        back.searchParams.set('merge', ticketFor(clientOf(f), { u: userId, pm: guestId }));
        back.searchParams.set('who', u0?.handle ? '@' + u0.handle : maskEmail(email || u0?.email || ''));
        if (f.s) back.searchParams.set('state', f.s);
        return go(res, back.toString());
      }
      await startSession(req, res, userId);
      writeFlow(res, { ...f, pm: guestId });
      return go(res, '/merge');
    }
    if (guestId && !userId) {
      await A.attach(guestId, provider, subject, email);
      await A.upgrade(guestId, { email });
      if (f.li) await pb.update('nv_link_intents', f.li, { used_at: pbDate() }).catch(() => {});
      userId = guestId;
    }
    if (!userId) userId = (await A.createMember({ email, name, clientId: f.c })).id;
    await A.attach(userId, provider, subject, email);
    await startSession(req, res, userId);
    await A.audit(userId, 'auth.sign_in', userId, { provider, client: f.c });
    return finish(req, res, { ...f, g: null, li: null }, userId);
  }

  // ---------- routes ----------
  async function authorize(req, res, url) {
    const p = url.searchParams, client = cfg.clients[p.get('client_id')];
    if (!client) return send(res, 400, P.message({ title: 'Unknown game', text: 'This sign-in link is not from a Novenique game.' }));
    const redirect = p.get('redirect_uri') ?? '';
    if (!client.redirect_uris.includes(redirect)) return send(res, 400, P.message({ title: 'Wrong return address', text: 'This sign-in link does not match the game. Go back and try again.', client }));
    const back = (error) => { const u = new URL(redirect); u.searchParams.set('error', error); if (p.get('state')) u.searchParams.set('state', p.get('state')); return go(res, u.toString()); };
    const ch = p.get('code_challenge') ?? '', state = p.get('state') ?? '';
    if (p.get('response_type') && p.get('response_type') !== 'code') return back('unsupported_response_type');
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(ch) || state.length > 300) return back('invalid_request');
    const f = { c: client.id, r: redirect, s: state, ch, x: token(16) };
    const link = p.get('link');
    if (link) {
      const li = await pb.first('nv_link_intents', `intent_hash=${q(sha(link))}`);
      if (!li || li.client_id !== client.id || li.used_at || !(fromPb(li.expires_at) > new Date())) return back('invalid_request');
      const g = await A.account(li.guest_user_id);
      if (!g || g.kind !== 'guest' || g.merged_into) return back('invalid_request');
      Object.assign(f, { g: li.guest_user_id, li: li.id });
    }
    // a game with its own sign-in screen: the player picked Google there, so go straight to Google (no Core page)
    if (p.get('via') === 'google') {
      if (!cfg.google) return back('temporarily_unavailable');
      return googleStart(req, res, { ...f, via: 'google' });
    }
    writeFlow(res, f);
    const s = await session(req);
    if (s && p.get('prompt') !== 'login') {
      if (f.g && f.g !== s.user.id) { writeFlow(res, { ...f, pm: f.g, g: null }); return go(res, '/merge'); }
      return finish(req, res, f);
    }
    return go(res, '/signin');
  }

  async function signinPage(req, res, f, error, status = 200) {
    if (!f) return send(res, 400, P.message({ title: 'Sign-in expired', text: 'Go back to the game and press sign in again.' }));
    return send(res, status, P.chooser({ client: clientOf(f), csrf: f.x, google: !!cfg.google, mail: cfg.mail.on, error, email: f.e ?? '' }));
  }

  async function emailStart(req, res, form) {
    const f = readFlow(req);
    if (!f || !same(form.csrf ?? '', f.x)) return signinPage(req, res, f, 'That page expired. Please try again.', 400);
    if (!cfg.mail.on) return signinPage(req, res, f, 'Email sign-in is not available right now.', 400);
    const email = String(form.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.endsWith('.invalid')) return signinPage(req, res, { ...f, e: email }, 'Enter a valid email address.', 400);
    if (limited(`mail:ip:${ipOf(req)}`, 10, 600_000) || limited(`mail:to:${email}`, 5, 3_600_000))
      return signinPage(req, res, { ...f, e: email }, 'Too many codes asked for. Please wait a few minutes.', 429);
    const code = sixDigits();
    await pb.create('nv_email_codes', { email, code_hash: sha(cfg.key.toString('hex') + email + code), attempts: 0, expires_at: pbDate(new Date(Date.now() + 10 * 60_000)) });
    const ok = await sendCode(cfg.mail, email, code, clientOf(f).name).catch(() => false);
    if (!ok) return signinPage(req, res, { ...f, e: email }, 'We could not send the email. Please try again.', 502);
    writeFlow(res, { ...f, e: email });
    return send(res, 200, P.codeEntry({ client: clientOf(f), csrf: f.x, masked: maskEmail(email) }));
  }

  async function emailVerify(req, res, form) {
    const f = readFlow(req);
    if (!f || !f.e || !same(form.csrf ?? '', f.x)) return signinPage(req, res, f, 'That page expired. Please try again.', 400);
    const again = (msg, status = 400) => send(res, status, P.codeEntry({ client: clientOf(f), csrf: f.x, masked: maskEmail(f.e), error: msg }));
    if (limited(`verify:ip:${ipOf(req)}`, 30, 600_000)) return again('Too many tries. Please wait a few minutes.', 429);
    const code = String(form.code ?? '').replace(/\D/g, '');
    const row = await pb.first('nv_email_codes', `email=${q(f.e)} && used_at='' && expires_at>${q(pbDate())}`, '-created');
    if (!row || row.attempts >= 5) return again('That code has expired. Ask for a new one.');
    if (!same(row.code_hash, sha(cfg.key.toString('hex') + f.e + code))) {
      await pb.update('nv_email_codes', row.id, { attempts: row.attempts + 1 });
      return again(row.attempts + 1 >= 5 ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right. Check the email and try again.');
    }
    await pb.update('nv_email_codes', row.id, { used_at: pbDate() });
    return signedIn(req, res, { ...f, e: undefined }, { provider: 'email', subject: f.e, email: f.e });
  }

  async function googleStart(req, res, given = null) {
    const f = given ?? readFlow(req);
    if (!f) return signinPage(req, res, null);
    if (!cfg.google) return signinPage(req, res, f, 'Google sign-in is not available right now.', 400);
    const gs = token(16), gn = token(16);
    // a game may have Google return to its own address (it forwards straight here), so players only ever see the game's name
    const gr = clientOf(f)?.google_redirect || `${cfg.publicUrl}/google/callback`;
    writeFlow(res, { ...f, gs, gn, gr });
    const u = new URL(cfg.google.authUrl);
    for (const [k, v] of Object.entries({ client_id: cfg.google.id, redirect_uri: gr, response_type: 'code', scope: 'openid email profile',
      state: gs, nonce: gn, prompt: 'select_account' })) u.searchParams.set(k, v);
    return go(res, u.toString());
  }

  async function googleCallback(req, res, url) {
    const f = readFlow(req);
    if (f?.via && (!f.gs || !same(url.searchParams.get('state') ?? '', f.gs) || url.searchParams.get('error') || !url.searchParams.get('code'))) {
      clearFlow(res);
      const u = new URL(f.r); u.searchParams.set('error', url.searchParams.get('error') ? 'access_denied' : 'invalid_request'); if (f.s) u.searchParams.set('state', f.s);
      return go(res, u.toString());
    }
    if (!f || !f.gs || !same(url.searchParams.get('state') ?? '', f.gs)) return signinPage(req, res, f, 'Google sign-in expired. Please try again.', 400);
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return signinPage(req, res, f, 'Google sign-in was cancelled.');
    // The ID token comes straight from Google's token endpoint over TLS, so its claims are checked rather than its signature
    // (OpenID Connect Core 3.1.3.7, item 6).
    const r = await fetchImpl(cfg.google.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: cfg.google.id, client_secret: cfg.google.secret,
        redirect_uri: f.gr || `${cfg.publicUrl}/google/callback`, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const tok = r?.ok ? await r.json().catch(() => null) : null;
    let c = null;
    try { c = JSON.parse(Buffer.from(String(tok?.id_token ?? '').split('.')[1] ?? '', 'base64url').toString()); } catch { /* bad token */ }
    const ok = c && ['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) && (c.aud === cfg.google.id || (Array.isArray(c.aud) && c.aud.includes(cfg.google.id)))
      && c.exp * 1000 > Date.now() && c.nonce === f.gn && c.sub;
    if (!ok && f.via) { clearFlow(res); const u = new URL(f.r); u.searchParams.set('error', 'invalid_request'); if (f.s) u.searchParams.set('state', f.s); return go(res, u.toString()); }
    if (!ok) return signinPage(req, res, f, 'Google sign-in did not work. Please try again.', 400);
    const email = c.email_verified === true || c.email_verified === 'true' ? String(c.email ?? '').toLowerCase() : '';
    return signedIn(req, res, { ...f, gs: undefined, gn: undefined, gr: undefined }, { provider: 'google', subject: String(c.sub), email, name: String(c.name ?? '').slice(0, 40) });
  }

  async function merge(req, res, form) {
    const f = readFlow(req), s = await session(req);
    if (!f || !f.pm || !s) return signinPage(req, res, f, 'That page expired. Please try again.', 400);
    const client = clientOf(f);
    if (req.method === 'GET') return send(res, 200, P.mergeChoice({ client, csrf: f.x, who: s.user.handle ? '@' + s.user.handle : maskEmail(s.user.email) }));
    if (!same(form.csrf ?? '', f.x)) return signinPage(req, res, f, 'That page expired. Please try again.', 400);
    if (form.choice !== 'merge') {
      clearFlow(res);
      const u = new URL(f.r); u.searchParams.set('error', 'access_denied'); if (f.s) u.searchParams.set('state', f.s);
      return go(res, u.toString());
    }
    await A.merge(f.pm, s.user.id, client.id);
    if (f.li) await pb.update('nv_link_intents', f.li, { used_at: pbDate() }).catch(() => {});
    return finish(req, res, { ...f, pm: undefined, li: null, mf: [...(f.mf ?? []), f.pm] }, s.user.id);
  }

  async function profile(req, res, form) {
    const s = await session(req), f = readFlow(req);
    if (!s) return go(res, '/account');
    const client = clientOf(f) ?? SELF, csrf = f?.x ?? s.csrf;
    if (req.method === 'GET') return send(res, 200, P.profileForm({ client, csrf, name: s.user.display_name, handle: s.user.handle }));
    if (!same(form.csrf ?? '', csrf)) return send(res, 400, P.profileForm({ client, csrf, error: 'That page expired. Please try again.' }));
    const error = await A.setProfile(s.user, form);
    if (error) return send(res, 400, P.profileForm({ client, csrf, error, name: form.display_name, handle: form.handle }));
    return f ? finish(req, res, f, s.user.id) : go(res, '/account');
  }

  async function tokenEndpoint(req, res, form) {
    const client = clientAuth(req, form);
    if (!client) return json(res, 401, { error: 'invalid_client' });
    if (form.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
    const row = await pb.first('nv_codes', `code_hash=${q(sha(String(form.code ?? '')))}`);
    const bad = () => json(res, 400, { error: 'invalid_grant' });
    if (!row || row.client_id !== client.id || row.redirect_uri !== form.redirect_uri) return bad();
    if (row.used_at) { await A.audit(row.user_id, 'auth.code_reused', row.user_id, { client: client.id }, 'system'); return bad(); }
    await pb.update('nv_codes', row.id, { used_at: pbDate() });
    if (!(fromPb(row.expires_at) > new Date())) return bad();
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(form.code_verifier ?? '')) || !same(challengeOf(form.code_verifier), row.challenge)) return bad();
    const u = await A.active(row.user_id);
    if (!u) return bad();
    return json(res, 200, { user: A.publicView(u, await A.account(u.id)), roles: await rolesFor(u.id, client), merged_from: row.merged_from ?? [],
      needs_profile: A.needsProfile(u), ticket: ticketFor(client, { u: u.id }) });
  }

  // ---------- signing in on the game's own screen ----------
  // A game can keep the whole sign-in on its own page: its server calls these with its client secret, passing what the
  // player typed. Nothing here sets a cookie; the game keeps its own session. A ticket (signed, 30 minutes, this game only)
  // carries a half-finished sign-in to the next step: the player's name and @handle, or the yes before merging a guest.
  const ticketFor = (client, t) => sign({ ...t, c: client.id, exp: Date.now() + FLOW_MINUTES * 60_000 }, cfg.key);
  const ticketOf = (client, raw) => { const t = unsign(String(raw ?? ''), cfg.key); return t && t.c === client.id && t.exp > Date.now() ? t : null; };
  async function signedInHere(client, { provider, subject, email, name }, guestId) {
    const ident = await A.identity(provider, subject);
    let userId = ident ? await A.resolve(ident.user_id) : null;
    if (userId && !(await A.active(userId))) return { status: 403, body: { error: { code: 'CLOSED', message: 'This account is closed' } } };
    if (!userId && email) userId = (await A.byEmail(email))?.id ?? null;
    if (guestId && userId && userId !== guestId) {
      // this email already has an account: the player says yes before the guest's progress moves into it
      await A.attach(userId, provider, subject, email);
      const u = await A.active(userId);
      return { status: 200, body: { merge_needed: true, who: u?.handle ? '@' + u.handle : maskEmail(email || u?.email || ''), ticket: ticketFor(client, { u: userId, pm: guestId }) } };
    }
    if (guestId && !userId) { await A.attach(guestId, provider, subject, email); await A.upgrade(guestId, { email }); userId = guestId; }
    if (!userId) userId = (await A.createMember({ email, name, clientId: client.id })).id;
    await A.attach(userId, provider, subject, email);
    await A.audit(userId, 'auth.sign_in', userId, { provider, client: client.id, here: true });
    return doneHere(client, userId, []);
  }
  async function doneHere(client, userId, mergedFrom) {
    const u = await A.active(userId);
    if (!u) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Unknown user' } } };
    return { status: 200, body: { user: A.publicView(u, await A.account(u.id)), roles: await rolesFor(u.id, client), merged_from: mergedFrom,
      needs_profile: A.needsProfile(u), ticket: ticketFor(client, { u: u.id, mf: mergedFrom }) } };
  }
  async function hereApi(req, res, client, path, form) {
    const out = (r) => json(res, r.status, r.body), ip = String(form.ip ?? '');
    if (path === '/v1/signin/email/start') {
      if (!cfg.mail.on) return fail(res, 503, 'UNAVAILABLE', 'Email sign-in is not available right now');
      const email = String(form.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.endsWith('.invalid')) return fail(res, 400, 'BAD_EMAIL', 'Enter a valid email address');
      if (limited(`mail:ip:${ip}`, 10, 600_000) || limited(`mail:to:${email}`, 5, 3_600_000)) return fail(res, 429, 'RATE_LIMITED', 'Too many codes asked for. Please wait a few minutes');
      const code = sixDigits();
      await pb.create('nv_email_codes', { email, code_hash: sha(cfg.key.toString('hex') + email + code), attempts: 0, expires_at: pbDate(new Date(Date.now() + 10 * 60_000)) });
      if (!(await sendCode(cfg.mail, email, code, client.name).catch(() => false))) return fail(res, 502, 'MAIL_FAILED', 'We could not send the email. Please try again');
      return json(res, 200, { masked: maskEmail(email) });
    }
    if (path === '/v1/signin/email/verify') {
      const email = String(form.email ?? '').trim().toLowerCase(), code = String(form.code ?? '').replace(/\D/g, '');
      if (limited(`verify:ip:${ip}`, 30, 600_000)) return fail(res, 429, 'RATE_LIMITED', 'Too many tries. Please wait a few minutes');
      const row = EMAIL_RE.test(email) ? await pb.first('nv_email_codes', `email=${q(email)} && used_at='' && expires_at>${q(pbDate())}`, '-created') : null;
      if (!row || row.attempts >= 5) return fail(res, 400, 'EXPIRED', 'That code has expired. Ask for a new one');
      if (!same(row.code_hash, sha(cfg.key.toString('hex') + email + code))) {
        await pb.update('nv_email_codes', row.id, { attempts: row.attempts + 1 });
        return fail(res, 400, 'WRONG_CODE', row.attempts + 1 >= 5 ? 'Too many wrong codes. Ask for a new one' : 'That code is not right. Check the email and try again');
      }
      await pb.update('nv_email_codes', row.id, { used_at: pbDate() });
      const g = form.guest_token ? await A.guestByToken(String(form.guest_token)) : null;
      return out(await signedInHere(client, { provider: 'email', subject: email, email }, g && g.kind === 'guest' && !g.merged_into ? g.user_id : null));
    }
    if (path === '/v1/signin/merge') {
      const t = ticketOf(client, form.ticket);
      if (!t || !t.pm) return fail(res, 400, 'EXPIRED', 'That sign-in expired. Please start again');
      if (form.choice !== 'merge') return json(res, 200, { merged: false });
      await A.merge(t.pm, t.u, client.id);
      return out(await doneHere(client, t.u, [t.pm]));
    }
    if (path === '/v1/signin/profile') {
      const t = ticketOf(client, form.ticket), u = t && !t.pm ? await A.active(t.u) : null;
      if (!u) return fail(res, 400, 'EXPIRED', 'That sign-in expired. Please start again');
      const error = await A.setProfile(u, form);
      if (error) return fail(res, 400, 'BAD_PROFILE', error);
      return out(await doneHere(client, u.id, t.mf ?? []));
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }
  const rolesFor = async (userId, client) => (await A.roles(userId)).filter((r) => r.product === 'platform' || r.product === client.product).map((r) => ({ product: r.product, role: r.role }));

  // ---------- service API for game servers ----------
  async function api(req, res, url, form) {
    const client = clientAuth(req, form);
    if (!client) return fail(res, 401, 'UNAUTHENTICATED', 'Send the game\'s client id and secret');
    const path = url.pathname;
    if (req.method === 'POST' && path.startsWith('/v1/signin/')) return hereApi(req, res, client, path, form);
    if (req.method === 'POST' && path === '/v1/guests') {
      if (!client.guests) return fail(res, 403, 'FORBIDDEN', 'This game does not make guests');
      if (limited(`guest:${client.id}:${String(form.ip ?? '')}`, 30, 3_600_000)) return fail(res, 429, 'RATE_LIMITED', 'Too many guests from one address');
      const { user, guestToken } = await A.createGuest(client, String(form.display_name ?? '').slice(0, 40));
      return json(res, 201, { user: A.publicView(user, { kind: 'guest' }), guest_token: guestToken });
    }
    if (req.method === 'POST' && path === '/v1/guests/resume') {
      const raw = String(form.guest_token ?? '');
      const a = await A.guestByToken(raw);
      if (!a) {
        // a merged or upgraded guest no longer has a token: the game should follow its sign-in instead
        return fail(res, 404, 'NOT_FOUND', 'Unknown guest');
      }
      const u = await A.active(a.user_id);
      return u ? json(res, 200, { user: A.publicView(u, a) }) : fail(res, 404, 'NOT_FOUND', 'Unknown guest');
    }
    if (req.method === 'POST' && path === '/v1/link-intents') {
      const a = await A.guestByToken(String(form.guest_token ?? ''));
      if (!a || a.kind !== 'guest') return fail(res, 404, 'NOT_FOUND', 'Unknown guest');
      const raw = token(24);
      await pb.create('nv_link_intents', { intent_hash: sha(raw), client_id: client.id, guest_user_id: a.user_id, expires_at: pbDate(new Date(Date.now() + 15 * 60_000)) });
      return json(res, 201, { link: raw, expires_in: 900 });
    }
    const um = path.match(/^\/v1\/users\/([a-z0-9]{15})$/);
    if (req.method === 'GET' && um) {
      const id = await A.resolve(um[1]), u = await A.active(id);
      return u ? json(res, 200, { user: A.publicView(u, await A.account(id)), roles: await rolesFor(id, client), merged_into: id !== um[1] ? id : null })
        : fail(res, 404, 'NOT_FOUND', 'Unknown user');
    }
    if (req.method === 'GET' && path === '/v1/authz') {
      const perm = url.searchParams.get('perm') ?? '', id = url.searchParams.get('user_id') ?? '';
      if (!perm.startsWith(client.product + '.')) return fail(res, 403, 'FORBIDDEN', 'A game can only ask about its own permissions');
      const u = await A.active(id);
      return json(res, 200, { allowed: !!u && permsOf(await A.roles(id)).has(perm), mfa_required: cfg.staffMfa });
    }
    if (req.method === 'GET' && path === '/v1/merges') {
      const since = url.searchParams.get('since') ?? '2000-01-01 00:00:00.000Z';
      const rows = await pb.list('nv_merges', { filter: `created>${q(since)}`, sort: 'created', perPage: 200 });
      return json(res, 200, { merges: rows.map((r) => ({ from: r.from_user, into: r.into_user, at: r.created })) });
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }

  // ---------- the person's own account page ----------
  async function accountPage(req, res, s, extra = {}) {
    const [methods, sessions, roles, mfa] = await Promise.all([A.methods(s.user.id), pb.list('nv_sessions', { filter: `user_id=${q(s.user.id)} && expires_at>${q(pbDate())}`, sort: '-last_seen_at', perPage: 20 }),
      A.roles(s.user.id), pb.first('nv_mfa', `user_id=${q(s.user.id)}`)]);
    return send(res, extra.status ?? 200, P.account({ user: s.user, csrf: s.csrf, notice: extra.notice, error: extra.error, setup: extra.setup,
      methods: methods.map((m) => (m.provider === 'google' ? `Google${m.email ? ' (' + maskEmail(m.email) + ')' : ''}` : `Email code (${maskEmail(m.subject)})`)),
      sessions: sessions.map((x) => ({ id: x.id, agent: deviceName(x.agent), when: `last seen ${String(x.last_seen_at).slice(0, 16)} UTC`, current: x.id === s.id })),
      roles: roles.map((r) => (['moderator', 'player'].includes(r.role) ? `${ROLES[r.role].name} · ${r.product === 'platform' ? 'every game' : cfg.clients[r.product]?.name ?? r.product}` : ROLES[r.role]?.name ?? r.role)),
      staff: isStaff(roles), mfa: !!mfa?.enabled_at }));
  }

  async function account(req, res, url, form) {
    const s = await session(req);
    if (!s) { writeFlow(res, { c: SELF.id, x: token(16), next: url.pathname === '/mfa' ? '/mfa' : '/account' }); return go(res, '/signin'); }
    if (req.method === 'GET' && url.pathname === '/account') return accountPage(req, res, s);
    if (req.method === 'GET' && url.pathname === '/mfa') return send(res, 200, P.mfaStep({ csrf: s.csrf }));
    if (!same(form.csrf ?? '', s.csrf)) return accountPage(req, res, s, { error: 'That page expired. Please try again.', status: 400 });
    switch (url.pathname) {
      case '/account/profile': {
        const error = await A.setProfile(s.user, form);
        return accountPage(req, res, error ? s : { ...s, user: await A.user(s.user.id) }, error ? { error, status: 400 } : { notice: 'Saved.' });
      }
      case '/account/sessions/revoke': {
        const x = await pb.get('nv_sessions', String(form.id ?? ''));
        if (x && x.user_id === s.user.id) await pb.remove('nv_sessions', x.id);
        return accountPage(req, res, s, { notice: 'Signed out there.' });
      }
      case '/signout': {
        const all = form.everywhere === '1' ? await pb.list('nv_sessions', { filter: `user_id=${q(s.user.id)}`, perPage: 200 }) : [s];
        for (const x of all) await pb.remove('nv_sessions', x.id).catch(() => {});
        setCookie(res, SESSION, '', { secure: cfg.secure, maxAge: 0 });
        await A.audit(s.user.id, form.everywhere === '1' ? 'auth.sign_out_everywhere' : 'auth.sign_out', s.user.id);
        return send(res, 200, P.message({ title: 'Signed out', text: form.everywhere === '1' ? 'You are signed out of the accounts site everywhere. Each game keeps its own sign-in until you sign out there.' : 'You are signed out.' }));
      }
      case '/account/delete': {
        const a = await A.account(s.user.id);
        if (a) await pb.update('nv_accounts', a.id, { deletion_requested_at: pbDate() });
        await A.audit(s.user.id, 'account.deletion_requested', s.user.id);
        return accountPage(req, res, s, { notice: 'We have your request. Your name, @handle and email will be removed within 30 days.' });
      }
      case '/account/mfa/setup': {
        const secret = totp.newSecret(), row = await pb.first('nv_mfa', `user_id=${q(s.user.id)}`);
        if (row?.enabled_at) return accountPage(req, res, s, { error: 'The second step is already on.' });
        const data = { user_id: s.user.id, secret_sealed: seal(secret, cfg.key), last_step: -1 };
        if (row) await pb.update('nv_mfa', row.id, data); else await pb.create('nv_mfa', data);
        return accountPage(req, res, s, { setup: { secret, uri: totp.otpauth(secret, s.user.handle || s.user.id) } });
      }
      case '/account/mfa/enable': {
        const row = await pb.first('nv_mfa', `user_id=${q(s.user.id)}`), secret = row && unseal(row.secret_sealed, cfg.key);
        const step = secret ? totp.verify(secret, String(form.code ?? '').trim(), row.last_step) : null;
        if (step === null) return accountPage(req, res, s, { error: 'That code did not match. Set up again and try the newest code.', status: 400 });
        const codes = totp.newRecoveryCodes();
        await pb.update('nv_mfa', row.id, { enabled_at: pbDate(), last_step: step, recovery_hashes: codes.map(totp.hashRecovery) });
        await pb.update('nv_sessions', s.id, { mfa_at: pbDate() });
        await A.audit(s.user.id, 'auth.mfa_enabled', s.user.id);
        return send(res, 200, P.recoveryCodes({ codes }));
      }
      case '/mfa': {
        if (limited(`mfa:${s.user.id}`, 10, 600_000)) return send(res, 429, P.mfaStep({ csrf: s.csrf, error: 'Too many tries. Please wait a few minutes.' }));
        const row = await pb.first('nv_mfa', `user_id=${q(s.user.id)}`), secret = row?.enabled_at && unseal(row.secret_sealed, cfg.key);
        const code = String(form.code ?? '').trim();
        if (!secret) return go(res, '/account');
        const step = totp.verify(secret, code, row.last_step);
        const rec = step === null ? (row.recovery_hashes ?? []).indexOf(totp.hashRecovery(code)) : -1;
        if (step === null && rec < 0) return send(res, 400, P.mfaStep({ csrf: s.csrf, error: 'That code did not match.' }));
        await pb.update('nv_mfa', row.id, step !== null ? { last_step: step } : { recovery_hashes: row.recovery_hashes.filter((_, i) => i !== rec) });
        await pb.update('nv_sessions', s.id, { mfa_at: pbDate() });
        await A.audit(s.user.id, step !== null ? 'auth.mfa_passed' : 'auth.mfa_recovery_used', s.user.id);
        return go(res, '/account');
      }
    }
    return send(res, 404, P.message({ title: 'Not found', text: 'There is nothing here.' }));
  }

  // ---------- staff admin API (JSON): session + staff role + second step + the route's permission ----------
  async function admin(req, res, url, form) {
    const s = await session(req);
    if (!s) return fail(res, 401, 'UNAUTHENTICATED', 'Sign in first');
    const rows = await A.roles(s.user.id), perms = permsOf(rows);
    if (!isStaff(rows)) return fail(res, 403, 'FORBIDDEN', 'Not permitted');
    if (cfg.staffMfa && !s.mfa_at) return fail(res, 403, 'MFA_REQUIRED', 'Finish the second sign-in step first');
    if (req.method !== 'GET' && !same(String(req.headers['x-csrf'] ?? ''), s.csrf)) return fail(res, 403, 'CSRF', 'Missing or wrong x-csrf header');
    const need = (perm) => (perms.has(perm) ? null : fail(res, 403, 'FORBIDDEN', `Your roles do not include ${perm}`));
    const path = url.pathname, um = path.match(/^\/admin\/api\/users\/([a-z0-9]{15})$/);
    if (req.method === 'GET' && path === '/admin/api/users') {
      if (need('platform.users.view')) return;
      const term = String(url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 60);
      const filter = `tenant_id=${q(await A.realm())}` + (term ? ` && (handle~${q(term)} || display_name~${q(term)})` : '');
      const users = await pb.list('users', { filter, sort: '-created', perPage: 50, fields: 'id,handle,display_name,account_status,created' });
      return json(res, 200, { users });
    }
    if (req.method === 'GET' && um) {
      if (need('platform.users.view')) return;
      const u = await A.user(um[1]);
      if (!u || u.tenant_id !== (await A.realm())) return fail(res, 404, 'NOT_FOUND', 'Unknown user');
      return json(res, 200, { user: { ...A.publicView(u, await A.account(u.id)), status: u.account_status, email: maskEmail(u.email) },
        roles: (await A.roles(u.id)).map((r) => ({ product: r.product, role: r.role })), methods: (await A.methods(u.id)).map((m) => m.provider) });
    }
    if (path === '/admin/api/roles' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (need('platform.users.roles')) return;
      const target = await A.active(String(form.user_id ?? ''));
      if (!target) return fail(res, 404, 'NOT_FOUND', 'Unknown user');
      const targetRows = await A.roles(target.id), product = String(form.product ?? ''), role = req.method === 'DELETE' ? null : String(form.role ?? '');
      const check = checkRoleChange({ actorRows: rows, actorId: s.user.id, targetId: target.id, targetRows, product, role });
      if (!check.ok) return fail(res, 403, 'FORBIDDEN', check.reason);
      const current = targetRows.find((r) => r.product === product);
      if (role === null) { if (current) await pb.remove('nv_roles', current.id); }
      else if (current) await pb.update('nv_roles', current.id, { role, granted_by: s.user.id });
      else await pb.create('nv_roles', { user_id: target.id, product, role, granted_by: s.user.id });
      await A.audit(s.user.id, role ? 'access.role_granted' : 'access.role_removed', target.id, { product, role, before: current?.role ?? null });
      return json(res, 200, { roles: (await A.roles(target.id)).map((r) => ({ product: r.product, role: r.role })) });
    }
    if (req.method === 'GET' && (path === '/admin/api/audit' || path === '/admin/api/audit/export')) {
      if (need(path.endsWith('/export') ? 'platform.audit.export' : 'platform.audit.view')) return;
      const rows2 = await pb.list('audit_events', { filter: `tenant_id=${q(await A.realm())} && metadata_safe.source='novenique-core'`, sort: '-created', perPage: 100,
        fields: 'actor_type,actor_id,action,object_id,metadata_safe,created' });
      return json(res, 200, { events: rows2 });
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }

  // ---------- the router ----------
  async function handle(req, res) {
    const url = new URL(req.url, cfg.publicUrl), path = url.pathname;
    const form = req.method === 'POST' || req.method === 'DELETE' ? await body(req) : {};
    if (path === '/health') return json(res, (await pb.health()) ? 200 : 503, { ok: await pb.health(), google: !!cfg.google, email: cfg.mail.on });
    if (path === '/') return go(res, '/account');
    if (req.method === 'GET' && path === '/authorize') return authorize(req, res, url);
    if (req.method === 'GET' && path === '/signin') return signinPage(req, res, readFlow(req));
    if (req.method === 'POST' && path === '/email/start') return emailStart(req, res, form);
    if (req.method === 'POST' && path === '/email/verify') return emailVerify(req, res, form);
    if (req.method === 'POST' && path === '/email/restart') { const f = readFlow(req); if (f) writeFlow(res, { ...f, e: undefined }); return go(res, '/signin'); }
    if (req.method === 'GET' && path === '/google/start') return googleStart(req, res);
    if (req.method === 'GET' && path === '/google/callback') return googleCallback(req, res, url);
    if (path === '/merge') return merge(req, res, form);
    if (path === '/profile') return profile(req, res, form);
    if (req.method === 'POST' && path === '/token') return tokenEndpoint(req, res, form);
    if (path.startsWith('/v1/')) return api(req, res, url, form);
    if (path.startsWith('/admin/api/')) return admin(req, res, url, form);
    if (path === '/account' || path.startsWith('/account/') || path === '/signout' || path === '/mfa') return account(req, res, url, form);
    return send(res, 404, P.message({ title: 'Not found', text: 'There is nothing here.' }));
  }

  const handler = (req, res) => handle(req, res).catch((e) => {
    if (!e.status || e.status >= 500) console.error(new Date().toISOString(), req.method, req.url?.split('?')[0], e.message);
    if (res.headersSent) return res.end();
    if (String(req.url).startsWith('/v1/') || String(req.url).startsWith('/admin/api/') || req.url === '/token') return fail(res, e.status ?? 500, 'ERROR', e.status ? e.message : 'Something went wrong');
    return send(res, e.status ?? 500, P.message({ title: 'Something went wrong', text: 'Please go back and try again.' }));
  });

  return { handler, pb, accounts: A, ensureSchema: () => ensureSchema(pb), listen: (port = cfg.port, host = cfg.host) => new Promise((ok) => { const srv = createServer(handler); srv.listen(port, host, () => ok(srv)); }) };
}

/** "Safari on iPhone" from a user-agent string, for the list of places someone is signed in. */
export function deviceName(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return browser && os ? `${browser} on ${os}` : browser || os || 'A browser';
}

export { PRODUCTS };
