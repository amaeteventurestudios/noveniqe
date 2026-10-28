// Sign-in codes by email. Providers: "smtp" (any mailbox's outgoing server, such as your own web hosting's), Resend or Brevo
// (their free tiers are enough to start; the key lives only in the server's env file), or "sink" for development and tests
// (writes to a file, nothing leaves the machine). "off" hides email sign-in. A game can send from its own address (`from` in
// deploy/clients.json) when the mailbox is allowed to send as it.
import { appendFileSync } from 'node:fs';
import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';
import { randomBytes } from 'node:crypto';

export async function sendCode(mail, to, code, brand, from = mail.from) {
  const subject = `${code} is your ${brand} sign-in code`;
  const text = `Your sign-in code for ${brand} is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.\n\n${brand}`;
  const html = `<p>Your sign-in code for ${brand} is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>`
    + '<p>It works for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.</p>' + `<p>${brand}</p>`;
  if (mail.provider === 'sink') {
    if (mail.sinkFile) appendFileSync(mail.sinkFile, JSON.stringify({ to, subject, code, at: new Date().toISOString() }) + '\n');
    mail.last = { to, code };
    return true;
  }
  if (mail.provider === 'smtp' && mail.smtp?.host) return smtpSend(mail.smtp, { from, to, subject, text, html });
  if (mail.provider === 'resend' && mail.resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${mail.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }), signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  if (mail.provider === 'brevo' && mail.brevoKey) {
    const m = from.match(/^(.*)<(.+)>$/);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': mail.brevoKey, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { name: (m?.[1] ?? 'Novenique').trim(), email: (m?.[2] ?? from).trim() }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  return false;
}

// A small SMTP client: implicit TLS on port 465, STARTTLS otherwise, AUTH LOGIN, one message. No dependencies.
export function smtpSend(o, { from, to, subject, text, html }) {
  const addr = (s) => (String(s).match(/<([^>]+)>/)?.[1] ?? String(s)).trim();
  const enc = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const name = String(from).match(/^(.*)<[^>]+>$/)?.[1]?.trim().replace(/^"|"$/g, '');
  const b = 'b' + randomBytes(12).toString('hex'), host = addr(from).split('@')[1] || 'localhost';
  const body = [
    `From: ${name ? `"${enc(name)}" ` : ''}<${addr(from)}>`, `To: <${to}>`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${host}>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', ...b64(text),
    `--${b}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', ...b64(html), `--${b}--`, '',
  ].join('\r\n');
  const port = Number(o.port || 465), implicit = port === 465 || o.secure === true, plain = o.secure === 'none';   // 'none': tests only
  return new Promise((resolve) => {
    let sock = implicit && !plain ? tls({ host: o.host, port, servername: o.host }) : tcp({ host: o.host, port });
    let buf = '', waiting = null, done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch { /* closed */ } resolve(ok); };
    const timer = setTimeout(() => finish(false), o.timeout ?? 15_000);
    const attach = (s) => {
      s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; let m; while ((m = buf.match(/^(\d{3})([ -])(.*)\r?\n/m)) && buf.indexOf(m[0]) === 0) {
        buf = buf.slice(m[0].length); if (m[2] === ' ' && waiting) { const w = waiting; waiting = null; w(Number(m[1])); } } });
      s.on('error', () => finish(false)); s.on('close', () => finish(false));
    };
    attach(sock);
    const reply = () => new Promise((r) => { waiting = r; });
    const say = (line) => { sock.write(line + '\r\n'); return reply(); };
    const want = (code, ok) => { if (!(Array.isArray(ok) ? ok : [ok]).includes(code)) throw new Error('smtp ' + code); };
    (async () => {
      want(await reply(), 220);
      want(await say(`EHLO ${host}`), 250);
      if (!implicit && !plain) {
        want(await say('STARTTLS'), 220);
        sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close');
        sock = tls({ socket: sock, servername: o.host }); attach(sock);
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        want(await say(`EHLO ${host}`), 250);
      }
      if (o.user) {
        want(await say('AUTH LOGIN'), 334);
        want(await say(Buffer.from(o.user).toString('base64')), 334);
        want(await say(Buffer.from(o.pass ?? '').toString('base64')), 235);
      }
      want(await say(`MAIL FROM:<${addr(from)}>`), 250);
      want(await say(`RCPT TO:<${to}>`), [250, 251]);
      want(await say('DATA'), 354);
      want(await say(body.replace(/^\./gm, '..') + '\r\n.'), 250);
      await say('QUIT').catch(() => {});
      finish(true);
    })().catch(() => finish(false));
  });
}
const b64 = (s) => Buffer.from(s).toString('base64').match(/.{1,76}/g) ?? [''];
