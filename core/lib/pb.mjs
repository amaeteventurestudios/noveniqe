// PocketBase client for Core. Core keeps its people in the shared store (Palasora's PocketBase, the plan's option C) and
// signs in as its own superuser; the token never leaves the server. Mirrors Palasora's apps/web/lib/pb.ts.
export class PBError extends Error {
  constructor(status, message, data) { super(`PocketBase ${status}: ${message}`); this.status = status; this.data = data; }
}

export function makePB({ url, email, password }) {
  let token = null, tokenAt = 0;
  async function auth(force = false) {
    if (!force && token && Date.now() - tokenAt < 50 * 60_000) return token;
    const r = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: email, password }),
    });
    if (!r.ok) throw new PBError(r.status, 'Core could not sign in to the database');
    token = (await r.json()).token; tokenAt = Date.now();
    return token;
  }
  async function req(method, path, body, retry = true) {
    const t = await auth();
    const r = await fetch(`${url}${path}`, {
      method, headers: { Authorization: t, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && retry) { await auth(true); return req(method, path, body, false); }
    if (!r.ok) {
      let msg = r.statusText, data;
      try { const j = await r.json(); msg = j.message ?? msg; data = j.data; } catch { /* not JSON */ }
      throw new PBError(r.status, msg, data);
    }
    return r.status === 204 ? undefined : r.json();
  }
  const pb = {
    async list(coll, { filter, sort, perPage = 50, page = 1, fields } = {}) {
      const p = new URLSearchParams({ perPage: String(perPage), page: String(page), skipTotal: '1' });
      if (filter) p.set('filter', filter);
      if (sort) p.set('sort', sort);
      if (fields) p.set('fields', fields);
      return (await req('GET', `/api/collections/${coll}/records?${p}`)).items;
    },
    async first(coll, filter, sort) { return (await pb.list(coll, { filter, sort, perPage: 1 }))[0] ?? null; },
    async get(coll, id) {
      try { return await req('GET', `/api/collections/${coll}/records/${encodeURIComponent(id)}`); }
      catch (e) { if (e instanceof PBError && e.status === 404) return null; throw e; }
    },
    create: (coll, data) => req('POST', `/api/collections/${coll}/records`, data),
    update: (coll, id, data) => req('PATCH', `/api/collections/${coll}/records/${encodeURIComponent(id)}`, data),
    remove: (coll, id) => req('DELETE', `/api/collections/${coll}/records/${encodeURIComponent(id)}`),
    collection: async (name) => { try { return await req('GET', `/api/collections/${encodeURIComponent(name)}`); } catch (e) { if (e.status === 404) return null; throw e; } },
    createCollection: (def) => req('POST', '/api/collections', def),
    updateCollection: (name, def) => req('PATCH', `/api/collections/${encodeURIComponent(name)}`, def),
    async health() { try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } },
  };
  return pb;
}

/** Quote a value for a PocketBase filter expression. */
export function q(v) {
  if (typeof v !== 'string') return String(v);
  return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
export const pbDate = (d = new Date()) => d.toISOString().replace('T', ' ');
export const fromPb = (s) => (s ? new Date(String(s).replace(' ', 'T')) : null);
