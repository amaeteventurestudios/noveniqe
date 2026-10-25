// Starts Novenique Core: node core/server.mjs (settings from the environment; see lib/config.mjs).
import { loadConfig } from './lib/config.mjs';
import { makeCore } from './lib/app.mjs';

const cfg = loadConfig();
const core = makeCore(cfg);
for (let i = 1; ; i++) {   // the database may still be starting after a reboot
  try { await core.ensureSchema(); await core.accounts.realm(); break; }
  catch (e) { if (i >= 30) throw e; console.error(`waiting for the database (${e.message})`); await new Promise((r) => setTimeout(r, 2000)); }
}
await core.listen();
console.log(`Novenique Core on http://${cfg.host}:${cfg.port} (${cfg.mode}; public ${cfg.publicUrl}; Google ${cfg.google ? 'on' : 'off'}; email ${cfg.mail.on ? cfg.mail.provider : 'off'})`);
