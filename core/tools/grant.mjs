// Give someone a role directly (the first Super Administrator has nobody above them to grant it). Run on the server by the
// "Grant a role" workflow: node tools/grant.mjs [--env core.env] <email or @handle> <platform|agp|palasora> <role|none>
// The person must have signed in once. Every change is written to the audit trail.
import { loadConfig, readEnvFile } from '../lib/config.mjs';
import { makePB, q } from '../lib/pb.mjs';
import { makeAccounts } from '../lib/accounts.mjs';
import { ROLES, PRODUCTS } from '../lib/roles.mjs';

const args = process.argv.slice(2), envAt = args.indexOf('--env');
const env = envAt >= 0 ? { ...process.env, ...readEnvFile(args.splice(envAt, 2)[1]) } : process.env;
const [who, product, role] = args;
if (!who || !PRODUCTS.includes(product) || !(role === 'none' || ROLES[role]?.products.includes(product))) {
  console.error(`usage: grant.mjs <email or @handle> <${PRODUCTS.join('|')}> <role|none>; roles: ${Object.entries(ROLES).map(([k, v]) => `${k} (${v.products.join('/')})`).join(', ')}`);
  process.exit(2);
}
const cfg = loadConfig(env), pb = makePB(cfg.pb), A = makeAccounts({ pb, cfg }), realm = await A.realm();
const u = await pb.first('users', `tenant_id=${q(realm)} && account_status='active' && ` + (who.startsWith('@') ? `handle=${q(who.slice(1).toLowerCase())}` : `email=${q(who.toLowerCase())}`));
if (!u) { console.error('Nobody with that email or handle has signed in yet.'); process.exit(1); }
const cur = await pb.first('nv_roles', `user_id=${q(u.id)} && product=${q(product)}`);
if (role === 'none') { if (cur) await pb.remove('nv_roles', cur.id); }
else if (cur) await pb.update('nv_roles', cur.id, { role, granted_by: 'server-tool' });
else await pb.create('nv_roles', { user_id: u.id, product, role, granted_by: 'server-tool' });
await A.audit('server-tool', role === 'none' ? 'access.role_removed' : 'access.role_granted', u.id, { product, role, before: cur?.role ?? null, via: 'grant.mjs' }, 'system');
console.log(`${u.handle ? '@' + u.handle : u.id}: ${product} ${role === 'none' ? 'role removed' : role}${ROLES[role]?.staff ? '. They set up the second sign-in step on their account page.' : ''}`);
