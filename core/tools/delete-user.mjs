// Delete someone's account (a test account, or a person who asked by email). Run on the server by the "Delete an
// account" workflow: node tools/delete-user.mjs [--env core.env] <email or @handle>
// Removes the name, @handle and email, ends every sign-in and role; game records keep the anonymous id. Audited.
import { loadConfig, readEnvFile } from '../lib/config.mjs';
import { makePB, q } from '../lib/pb.mjs';
import { makeAccounts } from '../lib/accounts.mjs';

const args = process.argv.slice(2), envAt = args.indexOf('--env');
const env = envAt >= 0 ? { ...process.env, ...readEnvFile(args.splice(envAt, 2)[1]) } : process.env;
const [who] = args;
if (!who) { console.error('usage: delete-user.mjs <email or @handle>'); process.exit(2); }
const cfg = loadConfig(env), pb = makePB(cfg.pb), A = makeAccounts({ pb, cfg }), realm = await A.realm();
const u = await pb.first('users', `tenant_id=${q(realm)} && account_status!='deleted' && ` + (who.startsWith('@') ? `handle=${q(who.slice(1).toLowerCase())}` : `email=${q(who.toLowerCase())}`));
if (!u) { console.error('No account with that email or handle.'); process.exit(1); }
await A.erase(u.id);
console.log(`Deleted the account ${u.id} (${u.display_name || 'no name'}).`);
