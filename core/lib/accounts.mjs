// People: guests, members, sign-in methods, upgrades and merges. One person is one row in the shared `users` table (the
// same row Palasora reads), so a user id never changes when a guest signs up. Core's own facts sit beside it in nv_*.
import { randomUUID } from 'node:crypto';
import { q, pbDate, fromPb } from './pb.mjs';
import { sha, token } from './util.mjs';

export const GUEST_DOMAIN = 'guest.novenique.invalid';   // a guest has no email; the users table needs one, so it gets a dead address
const isPlaceholder = (e) => String(e ?? '').endsWith('@' + GUEST_DOMAIN);

// Brand names are refused anywhere in a handle (n0venique, pala_sora_fan); short words only as a whole part (the_admin, adm1n,
// support99), so ordinary handles that happen to contain them (steamy, helper) stay free.
const BRANDS = ['novenique', 'noveniqe', 'palasora', 'palavva', 'agentgrandprix', 'grandprix', 'administrator', 'moderator', 'official'];
const WORDS = ['admin', 'mod', 'support', 'staff', 'security', 'system', 'root', 'help', 'team', 'owner', 'everyone', 'null', 'undefined', 'anonymous', 'guest', 'jev'];
const LOOKALIKE = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
const squash = (h) => h.toLowerCase().replace(/[0134578]/g, (c) => LOOKALIKE[c]).replace(/[^a-z_]/g, '').replace(/l/g, 'i');

/** null when the handle may be used, else the reason. */
export function handleProblem(handle, extraBlocked = []) {
  if (!/^[a-z0-9_]{3,30}$/.test(handle)) return 'Handles use 3 to 30 lowercase letters, numbers or underscores.';
  const s = squash(handle), whole = s.replace(/_/g, ''), parts = s.split('_').filter(Boolean);
  const reserved = [...BRANDS, ...extraBlocked].some((w) => whole.includes(squash(w)))
    || WORDS.some((w) => parts.includes(squash(w)) || whole === squash(w));
  return reserved ? 'That handle is reserved. Please choose another.' : null;
}

export function makeAccounts({ pb, cfg }) {
  let realm = null;
  const A = {
    async realm() {
      if (realm) return realm;
      const t = await pb.first('tenants', `slug=${q(cfg.realmSlug)}`);
      if (!t) throw new Error(`The shared store has no tenant "${cfg.realmSlug}" yet (Palasora's seed makes it)`);
      return (realm = t.id);
    },
    async audit(actorId, action, objectId, meta = {}, actorType = 'user') {
      await pb.create('audit_events', { tenant_id: await A.realm(), actor_type: actorType, actor_id: actorId || 'anonymous', action, object_type: 'users',
        object_id: objectId ?? '', revision: 0, metadata_safe: { source: 'novenique-core', ...meta }, request_id: randomUUID() }).catch(() => {});
    },
    user: (id) => pb.get('users', id),
    account: (userId) => pb.first('nv_accounts', `user_id=${q(userId)}`),
    /** Follow merges: a merged guest's id answers with the account it went into. */
    async resolve(userId) {
      for (let i = 0; i < 5 && userId; i++) {
        const a = await A.account(userId);
        if (!a?.merged_into) return userId;
        userId = a.merged_into;
      }
      return userId;
    },
    async active(userId) {
      const u = userId ? await A.user(userId) : null;
      return u && u.tenant_id === (await A.realm()) && u.account_status === 'active' ? u : null;
    },
    async createGuest(client, name) {
      const raw = 'nvg_' + token(32), pw = token(24);
      const u = await pb.create('users', { email: `g${token(9).toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now().toString(36)}@${GUEST_DOMAIN}`, emailVisibility: false, verified: false,
        password: pw, passwordConfirm: pw, tenant_id: await A.realm(), display_name: name || `Guest ${Math.floor(1000 + Math.random() * 9000)}`,
        account_status: 'active', profile_kind: 'human', locale: 'en' });
      await pb.create('nv_accounts', { user_id: u.id, kind: 'guest', guest_token_hash: sha(raw), created_by_client: client.id });
      await A.audit(u.id, 'account.guest_created', u.id, { client: client.id }, 'system');
      return { user: u, guestToken: raw };
    },
    async guestByToken(raw) {
      if (!/^nvg_[A-Za-z0-9_-]{40,50}$/.test(String(raw ?? ''))) return null;
      return pb.first('nv_accounts', `guest_token_hash=${q(sha(raw))}`);
    },
    async createMember({ email, name, clientId }) {
      const pw = token(24);
      const u = await pb.create('users', { email, emailVisibility: false, verified: true, password: pw, passwordConfirm: pw, tenant_id: await A.realm(),
        display_name: name ?? '', account_status: 'active', profile_kind: 'human', locale: 'en' });
      await pb.create('nv_accounts', { user_id: u.id, kind: 'member', created_by_client: clientId ?? '' });
      await A.audit(u.id, 'account.created', u.id, { client: clientId });
      return u;
    },
    async identity(provider, subject) { return pb.first('nv_identities', `provider=${q(provider)} && subject=${q(subject)}`); },
    async attach(userId, provider, subject, email) {
      const have = await A.identity(provider, subject);
      if (have) { await pb.update('nv_identities', have.id, { last_used_at: pbDate() }); return have; }
      const row = await pb.create('nv_identities', { user_id: userId, provider, subject, email: email ?? '', last_used_at: pbDate() });
      await A.audit(userId, 'account.method_added', userId, { provider });
      return row;
    },
    methods: (userId) => pb.list('nv_identities', { filter: `user_id=${q(userId)}`, perPage: 20 }),
    /** An existing person with this (verified) email, including accounts made on Palasora's own sign-up form. */
    async byEmail(email) {
      if (!email || isPlaceholder(email)) return null;
      return pb.first('users', `tenant_id=${q(await A.realm())} && email=${q(email.toLowerCase())} && account_status='active'`);
    },
    /** A guest gets a sign-in method: same user id, so everything the guest did stays theirs. */
    async upgrade(guestId, { email }) {
      const u = await A.user(guestId), patch = {};
      if (email && isPlaceholder(u.email)) Object.assign(patch, { email, verified: true });
      if (Object.keys(patch).length) await pb.update('users', guestId, patch);
      const a = await A.account(guestId);
      if (a) await pb.update('nv_accounts', a.id, { kind: 'member', guest_token_hash: '' });
      await A.audit(guestId, 'account.upgraded', guestId);
    },
    /** The guest's progress goes into an existing account, in one logged step. The guest row is closed, never reused. */
    async merge(guestId, intoId, clientId) {
      if (guestId === intoId) return;
      const a = await A.account(guestId);
      if (!a || a.kind !== 'guest' || a.merged_into) throw Object.assign(new Error('Only an open guest can be merged'), { status: 409 });
      await pb.create('nv_merges', { from_user: guestId, into_user: intoId, client_id: clientId ?? '' });
      await pb.update('nv_accounts', a.id, { merged_into: intoId, merged_at: pbDate(), guest_token_hash: '' });
      await pb.update('users', guestId, { account_status: 'deleted' });
      await A.audit(intoId, 'account.guest_merged', intoId, { from: guestId, client: clientId });
    },
    roles: (userId) => pb.list('nv_roles', { filter: `user_id=${q(userId)}`, perPage: 10 }),
    needsProfile: (u) => !u.handle || !u.display_name,
    /** Name and @handle, with the reserved list, uniqueness, the 30-day hold on old handles and one change per 30 days. */
    async setProfile(u, { display_name, handle }) {
      const name = String(display_name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const h = String(handle ?? '').trim().toLowerCase();
      if (!name) return 'Tell us your name.';
      const problem = handleProblem(h, cfg.blockedHandleWords ?? []);
      if (problem) return problem;
      const realmId = await A.realm();
      if (h !== u.handle) {
        const acct = await A.account(u.id);
        const last = fromPb(acct?.handle_changed_at);
        if (u.handle && last && Date.now() - last.getTime() < 30 * 86400_000) return 'You can change your @handle once every 30 days.';
        if (await pb.first('users', `tenant_id=${q(realmId)} && handle=${q(h)} && id!=${q(u.id)}`)) return 'That handle is taken.';
        if (await pb.first('nv_handle_holds', `handle=${q(h)} && user_id!=${q(u.id)} && until>${q(pbDate())}`)) return 'That handle is taken.';
        if (u.handle) await pb.create('nv_handle_holds', { handle: u.handle, user_id: u.id, until: pbDate(new Date(Date.now() + 30 * 86400_000)) });
        if (acct) await pb.update('nv_accounts', acct.id, { handle_changed_at: pbDate() });
      }
      try { await pb.update('users', u.id, { display_name: name, handle: h }); }
      catch (e) { if (e.status === 400) return 'That handle is taken.'; throw e; }
      await A.audit(u.id, 'account.profile_changed', u.id);
      return null;
    },
    /** Deletes an account, as the account page promises: the name, @handle and email go, sign-ins and roles end, and the
     *  person can sign up again with the same email. Game records keep the anonymous id. Run by staff (tools/delete-user.mjs). */
    async erase(userId, by = 'server-tool') {
      const u = await A.user(userId);
      await pb.update('users', u.id, { account_status: 'deleted', display_name: 'Deleted player', handle: '', verified: false,
        email: `d${u.id.toLowerCase()}@${GUEST_DOMAIN}` });
      for (const c of ['nv_sessions', 'nv_identities', 'nv_roles', 'nv_handle_holds']) {
        for (const x of await pb.list(c, { filter: `user_id=${q(u.id)}`, perPage: 200 }).catch(() => [])) await pb.remove(c, x.id).catch(() => {});
      }
      const a = await A.account(u.id);
      if (a) await pb.update('nv_accounts', a.id, { guest_token_hash: '', deletion_requested_at: a.deletion_requested_at || pbDate() });
      await A.audit(by, 'account.deleted', u.id, { via: 'erase' }, 'system');
    },
    publicView(u, acct) {
      return { id: u.id, display_name: u.display_name ?? '', handle: u.handle ?? '', kind: acct?.kind ?? 'member', email_verified: !!u.verified && !isPlaceholder(u.email) };
    },
  };
  return A;
}
