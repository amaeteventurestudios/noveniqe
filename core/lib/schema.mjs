// Core's own tables in the shared store. All start with nv_ and are locked to superusers (no browser ever reads them).
// Core never changes Palasora's tables' shape: it reads and writes `users` (one person = one row, shared by both games) and
// writes `audit_events`, both as they are. Created on start-up and topped up when a field is added here; never dropped.
const T = (name, o = {}) => ({ name, type: 'text', max: 500, ...o });
const D = (name) => ({ name, type: 'date' });
const N = (name) => ({ name, type: 'number' });
const J = (name) => ({ name, type: 'json', maxSize: 20000 });
const S = (name, values) => ({ name, type: 'select', values, maxSelect: 1 });
const STAMPS = [{ name: 'created', type: 'autodate', onCreate: true }, { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true }];

export const TABLES = {
  // one row per person Core knows: guest or member, and where a merged guest went
  nv_accounts: [[T('user_id', { required: true, max: 40 }), S('kind', ['guest', 'member']), T('guest_token_hash', { max: 64 }), T('created_by_client', { max: 40 }),
    T('merged_into', { max: 40 }), D('merged_at'), D('handle_changed_at'), D('deletion_requested_at')],
    ['CREATE UNIQUE INDEX idx_nv_accounts_user ON nv_accounts (user_id)', "CREATE UNIQUE INDEX idx_nv_accounts_guest ON nv_accounts (guest_token_hash) WHERE guest_token_hash != ''"]],
  // sign-in methods: Google (subject = Google's account id) and email codes (subject = the address, lower case)
  nv_identities: [[T('user_id', { required: true, max: 40 }), S('provider', ['google', 'email']), T('subject', { required: true, max: 320 }), T('email', { max: 320 }), D('last_used_at')],
    ['CREATE UNIQUE INDEX idx_nv_identities ON nv_identities (provider, subject)', 'CREATE INDEX idx_nv_identities_user ON nv_identities (user_id)']],
  // sessions on the accounts site itself (each game keeps its own session cookie)
  nv_sessions: [[T('user_id', { required: true, max: 40 }), T('token_hash', { required: true, max: 64 }), T('csrf', { max: 64 }), D('expires_at'), D('last_seen_at'), D('mfa_at'),
    T('agent', { max: 120 })], ['CREATE UNIQUE INDEX idx_nv_sessions_token ON nv_sessions (token_hash)', 'CREATE INDEX idx_nv_sessions_user ON nv_sessions (user_id)']],
  // one-time codes handed back to a game (authorization code with PKCE); valid for one minute, used once
  nv_codes: [[T('code_hash', { required: true, max: 64 }), T('client_id', { max: 40 }), T('redirect_uri', { max: 500 }), T('challenge', { max: 128 }), T('user_id', { max: 40 }),
    D('expires_at'), D('used_at'), J('merged_from')], ['CREATE UNIQUE INDEX idx_nv_codes ON nv_codes (code_hash)']],
  // a game asking to turn one of its guests into a full account (proved with the guest's token)
  nv_link_intents: [[T('intent_hash', { required: true, max: 64 }), T('client_id', { max: 40 }), T('guest_user_id', { max: 40 }), D('expires_at'), D('used_at')],
    ['CREATE UNIQUE INDEX idx_nv_link_intents ON nv_link_intents (intent_hash)']],
  nv_email_codes: [[T('email', { required: true, max: 320 }), T('code_hash', { max: 64 }), N('attempts'), D('expires_at'), D('used_at')],
    ['CREATE INDEX idx_nv_email_codes ON nv_email_codes (email, created)']],
  // at most one role per person per product; "platform" roles cover the whole of Novenique
  nv_roles: [[T('user_id', { required: true, max: 40 }), S('product', ['platform', 'agp', 'palasora']), T('role', { required: true, max: 40 }), T('granted_by', { max: 40 })],
    ['CREATE UNIQUE INDEX idx_nv_roles ON nv_roles (user_id, product)']],
  // staff second sign-in step: authenticator app secret (sealed), recovery codes as hashes
  nv_mfa: [[T('user_id', { required: true, max: 40 }), T('secret_sealed', { max: 300 }), D('enabled_at'), N('last_step'), J('recovery_hashes')],
    ['CREATE UNIQUE INDEX idx_nv_mfa ON nv_mfa (user_id)']],
  nv_merges: [[T('from_user', { required: true, max: 40 }), T('into_user', { required: true, max: 40 }), T('client_id', { max: 40 })],
    ['CREATE UNIQUE INDEX idx_nv_merges ON nv_merges (from_user)']],
  // a handle someone gave up stays theirs for 30 days, so nobody can take it to pose as them
  nv_handle_holds: [[T('handle', { required: true, max: 40 }), T('user_id', { max: 40 }), D('until')], ['CREATE INDEX idx_nv_handle_holds ON nv_handle_holds (handle)']],
};

export async function ensureSchema(pb) {
  for (const [name, [fields, indexes]] of Object.entries(TABLES)) {
    const have = await pb.collection(name);
    if (!have) {
      await pb.createCollection({ name, type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [...fields, ...STAMPS], indexes });
      continue;
    }
    const known = new Set(have.fields.map((f) => f.name));
    const missing = fields.filter((f) => !known.has(f.name));
    const idx = indexes.filter((i) => !have.indexes.includes(i));
    if (missing.length || idx.length) await pb.updateCollection(name, { fields: [...have.fields, ...missing], indexes: [...have.indexes, ...idx] });
  }
}
