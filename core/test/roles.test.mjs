// Every role against every admin route (sideways into another product, upwards into money, secrets and roles), and the
// escalation guard. Pure: no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, ROLES, permsOf, checkRoleChange, isSensitive, ALL_PERMS } from '../lib/roles.mjs';
import { handleProblem } from '../lib/accounts.mjs';

// Expected: which route prefixes each role row may open. Written out by hand, not derived from the matrix.
const MAY = {
  'platform:super_admin': () => true,
  'platform:platform_admin': (r) => !['platform:/admin/money', 'platform:/admin/secrets', 'platform:/admin/xp', '/admin/api/audit/export'].includes(r.path),
  'agp:agp_admin': (r) => r.path.startsWith('agp:'),
  'palasora:palasora_admin': (r) => r.path.startsWith('palasora:'),
  'agp:moderator': (r) => ['agp:/admin', 'agp:/admin/moderation'].includes(r.path),
  'palasora:moderator': (r) => ['palasora:/admin', 'palasora:/admin/moderation'].includes(r.path),
  'platform:moderator': (r) => ['agp:/admin', 'agp:/admin/moderation', 'palasora:/admin', 'palasora:/admin/moderation'].includes(r.path),
  'agp:player': () => false, 'palasora:player': () => false, 'platform:player': () => false, 'none:guest': () => false,
};

test('every role against every route', () => {
  for (const [key, may] of Object.entries(MAY)) {
    const [product, role] = key.split(':');
    const perms = permsOf(role === 'guest' ? [] : [{ product, role }]);
    for (const r of ROUTES) assert.equal(perms.has(r.perm), may(r), `${key} → ${r.method} ${r.path}`);
  }
});

test('a role on the wrong product grants nothing', () => {
  assert.equal(permsOf([{ product: 'palasora', role: 'agp_admin' }]).size, 0);
  assert.equal(permsOf([{ product: 'agp', role: 'super_admin' }]).size, 0);
  assert.equal(permsOf([{ product: 'agp', role: 'made_up' }]).size, 0);
});

test('nobody but Super Administrator holds a sensitive permission', () => {
  const sensitive = ALL_PERMS.filter(isSensitive);
  assert.ok(sensitive.length >= 4);
  for (const [role, def] of Object.entries(ROLES)) for (const product of def.products) {
    if (role === 'super_admin') continue;
    const held = sensitive.filter((p) => permsOf([{ product, role }]).has(p));
    assert.deepEqual(held, [], `${product}:${role}`);
  }
});

test('the escalation guard', () => {
  const sup = [{ product: 'platform', role: 'super_admin' }], pa = [{ product: 'platform', role: 'platform_admin' }], agpA = [{ product: 'agp', role: 'agp_admin' }];
  const base = { actorId: 'a', targetId: 'b', targetRows: [] };
  assert.equal(checkRoleChange({ ...base, actorRows: agpA, product: 'agp', role: 'moderator' }).ok, false, 'a game admin cannot grant roles at all');
  assert.equal(checkRoleChange({ ...base, actorRows: pa, product: 'agp', role: 'agp_admin' }).ok, true);
  assert.equal(checkRoleChange({ ...base, actorRows: pa, product: 'platform', role: 'super_admin' }).ok, false, 'only super grants super');
  assert.equal(checkRoleChange({ ...base, actorRows: pa, product: 'platform', role: 'platform_admin' }).ok, true);
  assert.equal(checkRoleChange({ ...base, actorRows: pa, targetRows: sup, product: 'platform', role: null }).ok, false, 'cannot remove a super');
  assert.equal(checkRoleChange({ ...base, actorRows: pa, targetId: 'a', product: 'agp', role: 'moderator' }).ok, false, 'never your own roles');
  assert.equal(checkRoleChange({ ...base, actorRows: pa, product: 'agp', role: 'platform_admin' }).ok, false, 'a role on the wrong product');
  assert.equal(checkRoleChange({ ...base, actorRows: sup, product: 'platform', role: 'super_admin' }).ok, true);
  assert.equal(checkRoleChange({ ...base, actorRows: sup, targetRows: sup, product: 'platform', role: null }).ok, true);
});

test('handles: reserved words and look-alikes', () => {
  for (const h of ['ada_lovelace', 'steamy', 'helper', 'jevon', 'rootsy']) assert.equal(handleProblem(h), null, h);
  for (const h of ['novenique', 'n0venique', 'pala_sora', 'palasora_fan', 'the_admin', 'adm1n', 'agentgrandprix', 'support99']) assert.ok(handleProblem(h), h);
  for (const h of ['ab', 'Ada', 'ada lovelace', 'a'.repeat(31)]) assert.ok(handleProblem(h), h);
});
