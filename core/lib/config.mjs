// Core's settings, all from the environment (on the server: /etc/novenique/core.env, made by deploy/install.sh).
// Games ("clients") are listed in clients.json (no secrets); each client's secret is only on the server, in
// <CORE_CLIENT_SECRETS_DIR>/<id>.env as NOVENIQUE_CLIENT_SECRET=..., and Core keeps only its hash in memory.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha } from './util.mjs';

/** KEY=value lines (systemd EnvironmentFile style: the value is the rest of the line, quotes optional). */
export function readEnvFile(file) {
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^'(.*)'$|^"(.*)"$/, '$1$2')]));
}

const on = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

export function loadConfig(env = process.env, overrides = {}) {
  const secret = env.CORE_SECRET ?? '';
  const mode = env.CORE_ENV ?? 'development';
  if (!/^[0-9a-f]{64}$/i.test(secret) && mode === 'production') throw new Error('CORE_SECRET (64 hex characters) must be set in production');
  const key = Buffer.from(/^[0-9a-f]{64}$/i.test(secret) ? secret : sha('novenique-core-development-only'), 'hex');
  const publicUrl = (env.CORE_PUBLIC_URL ?? 'http://127.0.0.1:8200').replace(/\/$/, '');
  const clients = overrides.clients ?? readClients(env);
  const mailProvider = env.MAIL_PROVIDER || (env.SMTP_HOST ? 'smtp' : env.RESEND_API_KEY ? 'resend' : env.BREVO_API_KEY ? 'brevo' : mode === 'production' ? 'off' : 'sink');
  const cfg = {
    mode, key, publicUrl, secure: publicUrl.startsWith('https://'),
    port: Number(env.CORE_PORT ?? 8200), host: env.CORE_HOST ?? '127.0.0.1',
    pb: { url: env.PB_URL ?? 'http://127.0.0.1:8190', email: env.PB_CORE_EMAIL ?? '', password: env.PB_CORE_PASSWORD ?? '' },
    realmSlug: env.CORE_REALM_SLUG ?? 'palavva',
    sessionDays: Number(env.CORE_SESSION_DAYS ?? 30),
    clients,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
      authUrl: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token' } : null,
    mail: { provider: mailProvider, from: env.MAIL_FROM || (env.SMTP_USER ? env.SMTP_USER : 'Novenique <accounts@novenique.com>'), resendKey: env.RESEND_API_KEY ?? '', brevoKey: env.BREVO_API_KEY ?? '',
      sinkFile: env.MAIL_SINK_FILE ?? '',
      smtp: { host: env.SMTP_HOST ?? '', port: Number(env.SMTP_PORT || 465), user: env.SMTP_USER ?? '', pass: env.SMTP_PASS ?? '' } },
    // payments: one Stripe account for every game (lib/billing.mjs); STRIPE_PRICE_<PRODUCT>_<PLAN> overrides a plan's Price ID
    stripe: { key: env.STRIPE_SECRET_KEY ?? '', hook: env.STRIPE_WEBHOOK_SECRET ?? '',
      prices: Object.fromEntries(Object.entries(env).filter(([k, v]) => /^STRIPE_PRICE_[A-Z0-9]+_[A-Z]+$/.test(k) && v).map(([k, v]) => [k.slice(13).toLowerCase().replace('_', '.'), v])) },
    staffMfa: mode === 'production' || !['0', 'false', 'no', 'off'].includes(String(env.STAFF_MFA_REQUIRED ?? 'true').toLowerCase()),
    trustProxy: on(env.CORE_TRUST_PROXY ?? (mode === 'production' ? 'true' : 'false')),
    ...overrides,
  };
  cfg.mail.on = (cfg.mail.provider === 'smtp' && !!cfg.mail.smtp.host) || (cfg.mail.provider === 'resend' && !!cfg.mail.resendKey) || (cfg.mail.provider === 'brevo' && !!cfg.mail.brevoKey) || cfg.mail.provider === 'sink';
  return cfg;
}

function readClients(env) {
  const file = env.CORE_CLIENTS_FILE ?? new URL('../deploy/clients.json', import.meta.url).pathname;
  const dir = env.CORE_CLIENT_SECRETS_DIR ?? '/etc/novenique/clients';
  const list = JSON.parse(readFileSync(file, 'utf8')).clients;
  return Object.fromEntries(list.map((c) => {
    const f = join(dir, `${c.id}.env`);
    const line = existsSync(f) ? readFileSync(f, 'utf8').match(/^NOVENIQUE_CLIENT_SECRET=(.+)$/m) : null;
    return [c.id, { ...c, secretHash: line ? sha(line[1].trim()) : null }];
  }));
}
