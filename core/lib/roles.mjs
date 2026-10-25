// Who may do what across Novenique. Pure module (no I/O): Core's admin API, the games (through /v1/authz) and the tests all
// use these same rules. Built on Palasora's permission matrix (apps/web/lib/access/permissions.ts) with a product added.
//
//   permission = `${product}.${area}.${action}`   e.g. "agp.races.administer", "platform.money.view"
//   role row   = { product, role }: at most one per person per product (nv_roles)
//
// Deny by default. Super Administrator alone holds every permission and cannot be narrowed. Money, secrets and exporting the
// audit trail are sensitive: no role but Super Administrator holds them. Every staff role needs the second sign-in step.
export const PRODUCTS = ['platform', 'agp', 'palasora'];
export const GAMES = ['agp', 'palasora'];

const AREAS = {
  platform: { users: ['view', 'edit', 'roles'], audit: ['view', 'export'], money: ['view', 'edit'], secrets: ['edit'], xp: ['view', 'adjust'] },
  agp: { admin: ['view'], races: ['view', 'edit', 'administer'], players: ['view', 'edit'], moderation: ['act'] },
  palasora: { admin: ['view'], town: ['view', 'edit', 'administer'], players: ['view', 'edit'], moderation: ['act'] },
};
export const ALL_PERMS = Object.entries(AREAS).flatMap(([p, areas]) => Object.entries(areas).flatMap(([a, acts]) => acts.map((x) => `${p}.${a}.${x}`)));
const ofProduct = (p) => ALL_PERMS.filter((x) => x.startsWith(p + '.'));

export function isSensitive(perm) {
  return /^platform\.(money|secrets)\./.test(perm) || perm === 'platform.audit.export' || perm === 'platform.xp.adjust';
}

// products: where a role row may sit. perms(product) gives what that row grants.
export const ROLES = {
  super_admin: { name: 'Super Administrator', staff: true, products: ['platform'], locked: true, perms: () => [...ALL_PERMS] },
  platform_admin: { name: 'Platform Administrator', staff: true, products: ['platform'],
    perms: () => [...ALL_PERMS.filter((p) => !isSensitive(p))] },
  agp_admin: { name: 'Agent Grand Prix Administrator', staff: true, products: ['agp'], perms: () => ofProduct('agp') },
  palasora_admin: { name: 'Palasora Administrator', staff: true, products: ['palasora'], perms: () => ofProduct('palasora') },
  moderator: { name: 'Moderator', staff: true, products: ['agp', 'palasora', 'platform'],
    perms: (p) => (p === 'platform' ? GAMES : [p]).flatMap((g) => [`${g}.admin.view`, `${g}.players.view`, `${g}.moderation.act`]) },
  player: { name: 'Player', staff: false, products: ['agp', 'palasora', 'platform'], perms: () => [] },
};
export const ROLE_KEYS = Object.keys(ROLES);

/** rows: [{ product, role }] → Set of permissions. Unknown roles and roles on the wrong product grant nothing. */
export function permsOf(rows) {
  const out = new Set();
  for (const r of rows ?? []) {
    const def = ROLES[r.role];
    if (!def || !def.products.includes(r.product)) continue;
    for (const p of def.perms(r.product)) out.add(p);
  }
  return out;
}
export const isStaff = (rows) => (rows ?? []).some((r) => ROLES[r.role]?.staff && ROLES[r.role].products.includes(r.product));
export const can = (perms, perm) => perms.has(perm);

/** Every admin route Core serves, and the game admin areas the games ask about through /v1/authz. */
export const ROUTES = [
  { method: 'GET', path: '/admin/api/users', perm: 'platform.users.view' },
  { method: 'GET', path: '/admin/api/users/:id', perm: 'platform.users.view' },
  { method: 'POST', path: '/admin/api/roles', perm: 'platform.users.roles' },
  { method: 'DELETE', path: '/admin/api/roles', perm: 'platform.users.roles' },
  { method: 'GET', path: '/admin/api/audit', perm: 'platform.audit.view' },
  { method: 'GET', path: '/admin/api/audit/export', perm: 'platform.audit.export' },
  { method: 'GET', path: 'agp:/admin', perm: 'agp.admin.view' },
  { method: 'POST', path: 'agp:/admin/races', perm: 'agp.races.administer' },
  { method: 'POST', path: 'agp:/admin/players', perm: 'agp.players.edit' },
  { method: 'POST', path: 'agp:/admin/moderation', perm: 'agp.moderation.act' },
  { method: 'GET', path: 'palasora:/admin', perm: 'palasora.admin.view' },
  { method: 'POST', path: 'palasora:/admin/town', perm: 'palasora.town.administer' },
  { method: 'POST', path: 'palasora:/admin/players', perm: 'palasora.players.edit' },
  { method: 'POST', path: 'palasora:/admin/moderation', perm: 'palasora.moderation.act' },
  { method: 'GET', path: 'platform:/admin/money', perm: 'platform.money.view' },
  { method: 'POST', path: 'platform:/admin/secrets', perm: 'platform.secrets.edit' },
  { method: 'POST', path: 'platform:/admin/xp', perm: 'platform.xp.adjust' },
];

/** Privilege-escalation guard for granting or removing a role (Palasora's checkRoleChange, per product). All must hold:
 *  1. the actor holds platform.users.roles;  2. nobody changes their own roles;
 *  3. only a Super Administrator grants or removes Super Administrator;
 *  4. the new role row grants only permissions the actor holds;
 *  5. the actor holds every permission the target has now (so nobody edits someone above them). */
export function checkRoleChange({ actorRows, actorId, targetId, targetRows, product, role }) {
  const actor = permsOf(actorRows);
  if (!actor.has('platform.users.roles')) return { ok: false, reason: 'Your role cannot change other people\'s roles.' };
  if (actorId === targetId) return { ok: false, reason: 'You cannot change your own roles. Ask another administrator.' };
  if (!PRODUCTS.includes(product)) return { ok: false, reason: 'Unknown product.' };
  if (role !== null && (!ROLES[role] || !ROLES[role].products.includes(product))) return { ok: false, reason: 'That role does not exist for that product.' };
  const actorIsSuper = (actorRows ?? []).some((r) => r.role === 'super_admin' && r.product === 'platform');
  const current = (targetRows ?? []).find((r) => r.product === product);
  if ((role === 'super_admin' || current?.role === 'super_admin') && !actorIsSuper)
    return { ok: false, reason: 'Only a Super Administrator can grant or remove Super Administrator.' };
  const grants = role ? permsOf([{ product, role }]) : new Set();
  const missing = [...grants].filter((p) => !actor.has(p));
  if (missing.length) return { ok: false, reason: `That role includes permissions you do not hold (${missing.slice(0, 3).join(', ')}).` };
  const above = [...permsOf(targetRows)].filter((p) => !actor.has(p));
  if (above.length) return { ok: false, reason: 'This person has permissions you do not hold, so you cannot change their roles.' };
  return { ok: true };
}
