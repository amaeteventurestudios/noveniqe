// Sign-in codes by email. Providers: Resend or Brevo (their free tiers are enough to start; the key lives only in the server's
// env file), or "sink" for development and tests (writes to a file, nothing leaves the machine). "off" hides email sign-in.
import { appendFileSync } from 'node:fs';

export async function sendCode(mail, to, code, brand) {
  const subject = `${code} is your ${brand} sign-in code`;
  const text = `Your sign-in code for ${brand} is ${code}.\n\nIt works for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.\n\nNovenique accounts`;
  const html = `<p>Your sign-in code for ${brand} is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>`
    + '<p>It works for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.</p><p>Novenique accounts</p>';
  if (mail.provider === 'sink') {
    if (mail.sinkFile) appendFileSync(mail.sinkFile, JSON.stringify({ to, subject, code, at: new Date().toISOString() }) + '\n');
    mail.last = { to, code };
    return true;
  }
  if (mail.provider === 'resend' && mail.resendKey) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${mail.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: mail.from, to: [to], subject, text, html }), signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  if (mail.provider === 'brevo' && mail.brevoKey) {
    const m = mail.from.match(/^(.*)<(.+)>$/);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': mail.brevoKey, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { name: (m?.[1] ?? 'Novenique').trim(), email: (m?.[2] ?? mail.from).trim() }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  }
  return false;
}
