// Sign-in codes through our own mailbox: a stand-in SMTP server checks the conversation and the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { sendCode } from '../lib/mail.mjs';
import { loadConfig } from '../lib/config.mjs';

function fakeSmtp(pass) {
  const got = { lines: [], data: '' };
  const srv = createServer((s) => {
    let buf = '', inData = false;
    s.write('220 test ESMTP\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else got.data += line + '\n'; continue; }
        got.lines.push(line);
        const n = got.lines.length;
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (got.lines[n - 2] === 'AUTH LOGIN') s.write('334 UGFzc3dvcmQ6\r\n');
        else if (got.lines[n - 3] === 'AUTH LOGIN') s.write(Buffer.from(line, 'base64').toString() === pass ? '235 ok\r\n' : '535 no\r\n');
        else if (/^MAIL FROM|^RCPT TO/.test(line)) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, got, port: srv.address().port })));
}

test('a code goes out through our own mailbox, from the game\'s own address', async () => {
  const { srv, got, port } = await fakeSmtp('pw');
  const mail = { provider: 'smtp', from: 'x@y', smtp: { host: '127.0.0.1', port, user: 'no-reply@agentgrandprix.com', pass: 'pw', secure: 'none' } };
  assert.equal(await sendCode(mail, 'kai@example.com', '123456', 'Agent Grand Prix', 'Agent Grand Prix <no-reply@agentgrandprix.com>'), true);
  assert.ok(got.lines.includes('MAIL FROM:<no-reply@agentgrandprix.com>'));
  assert.ok(got.lines.includes('RCPT TO:<kai@example.com>'));
  assert.match(got.data, /^From: "Agent Grand Prix" <no-reply@agentgrandprix\.com>$/m);
  assert.match(got.data, /^Subject: 123456 is your Agent Grand Prix sign-in code$/m);
  srv.close();
});

test('a wrong password is a failed send, not a crash', async () => {
  const { srv, port } = await fakeSmtp('right');
  const mail = { provider: 'smtp', from: 'a@b', smtp: { host: '127.0.0.1', port, user: 'u', pass: 'wrong', secure: 'none' } };
  assert.equal(await sendCode(mail, 'k@example.com', '1', 'X'), false);
  srv.close();
});

test('SMTP settings switch email on, and the mailbox is the sender when nothing else is set', () => {
  const cfg = loadConfig({ SMTP_HOST: 'mail.test', SMTP_USER: 'no-reply@agentgrandprix.com', SMTP_PASS: 'p' }, { clients: {} });
  assert.equal(cfg.mail.provider, 'smtp');
  assert.equal(cfg.mail.on, true);
  assert.equal(cfg.mail.from, 'no-reply@agentgrandprix.com');
  assert.equal(cfg.mail.smtp.port, 465);
});
