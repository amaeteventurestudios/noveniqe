// Makes (or updates) Core's own superuser in the shared PocketBase, signing in with Palasora's service account. Run by
// deploy/install.sh as root: node pb-user.mjs <palasora env file> <core env file>. Prints nothing secret.
import { readEnvFile } from '../lib/config.mjs';

const pal = readEnvFile(process.argv[2]), core = readEnvFile(process.argv[3]);
const url = core.PB_URL ?? 'http://127.0.0.1:8190';
const call = async (method, path, body, token) => {
  const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path.split('?')[0]}: ${r.status}`);
  return r.json();
};
const { token } = await call('POST', '/api/collections/_superusers/auth-with-password', { identity: pal.PB_SERVICE_EMAIL, password: pal.PB_SERVICE_PASSWORD });
const filter = encodeURIComponent(`email='${core.PB_CORE_EMAIL}'`);
const have = (await call('GET', `/api/collections/_superusers/records?filter=${filter}`, null, token)).items[0];
const data = { email: core.PB_CORE_EMAIL, password: core.PB_CORE_PASSWORD, passwordConfirm: core.PB_CORE_PASSWORD };
if (have) await call('PATCH', `/api/collections/_superusers/records/${have.id}`, data, token);
else await call('POST', '/api/collections/_superusers/records', data, token);
console.log(`Core's database account is ready (${have ? 'updated' : 'created'}).`);
