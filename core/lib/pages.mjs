// The few screens people see on the accounts site. Plain server-rendered HTML, no scripts, phone first, light and dark.
// Each sign-in screen wears the game's name and colour; the Novenique name stays small (one account for every game).
import { esc } from './util.mjs';

const HEX = /^#[0-9a-fA-F]{6}$/;
export function layout({ title, brand, color, body, back }) {
  const c = HEX.test(color ?? '') ? color : '#3D5AFE';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{--brand:${c};--bg:#f6f6f4;--card:#fff;--ink:#16181d;--muted:#5d6370;--line:#dcdde1;--bad:#b3261e;--ok:#1b6e3a}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1c1e23;--ink:#f1f2f4;--muted:#a3a8b3;--line:#33363d;--bad:#ff8a80;--ok:#7fd69a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px 48px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:20px}.dot{width:14px;height:14px;border-radius:4px;background:var(--brand)}
h1{font-size:24px;line-height:1.25;margin:0 0 8px}p{margin:0 0 16px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-weight:600;margin:16px 0 6px}input{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
input:focus{outline:2px solid var(--brand);outline-offset:1px}.code{font-size:24px;letter-spacing:6px;text-align:center}
button,.btn{display:block;width:100%;margin-top:16px;padding:12px 16px;font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--brand);background:var(--brand);color:#fff;cursor:pointer;text-align:center;text-decoration:none}
button.quiet,.btn.quiet{background:transparent;color:var(--ink);border-color:var(--line)}.or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px;margin:20px 0 4px}
.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--line)}.err{color:var(--bad);font-weight:600}.ok{color:var(--ok);font-weight:600}
ul.list{list-style:none;padding:0;margin:0 0 16px}ul.list li{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
ul.list li form button{margin:0;width:auto;padding:6px 12px;font-size:14px}h2{font-size:18px;margin:28px 0 8px}code{word-break:break-all}
footer{margin-top:20px;text-align:center}footer a{color:var(--muted);font-size:14px}a{color:var(--brand)}
</style></head><body><main><div class="brand"><span class="dot" aria-hidden="true"></span>${esc(brand ?? 'Novenique')}</div><div class="card">${body}</div>
<footer>${back ? `<a href="${esc(back)}">Back to ${esc(brand)}</a>` : '<span class="muted">Novenique accounts</span>'}</footer></main></body></html>`;
}

const hidden = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
const err = (e) => (e ? `<p class="err" role="alert">${esc(e)}</p>` : '');

export function chooser({ client, csrf, google, mail, error, email = '' }) {
  return layout({ title: `Sign in to ${client.name}`, brand: client.name, color: client.color, back: client.home, body: `
<h1>Sign in to ${esc(client.name)}</h1><p class="muted">With your Novenique account: one account for Agent Grand Prix and Palasora.</p>${err(error)}
${google ? '<a class="btn" href="/google/start">Continue with Google</a>' : ''}
${google && mail ? '<div class="or">or</div>' : ''}
${mail ? `<form method="post" action="/email/start">${hidden(csrf)}<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" inputmode="email" required value="${esc(email)}">
<button type="submit">Email me a code</button><p class="muted" style="margin-top:12px">No password needed. We send a 6-digit code.</p></form>` : ''}
${!google && !mail ? '<p>Sign-in is not open yet. Please try again soon.</p>' : ''}` });
}

export function codeEntry({ client, csrf, masked, error }) {
  return layout({ title: 'Enter your code', brand: client.name, color: client.color, back: client.home, body: `
<h1>Check your email</h1><p>We sent a 6-digit code to <strong>${esc(masked)}</strong>. It works for 10 minutes.</p>${err(error)}
<form method="post" action="/email/verify">${hidden(csrf)}<label for="code">Code</label>
<input id="code" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
<button type="submit">Sign in</button></form>
<form method="post" action="/email/restart">${hidden(csrf)}<button class="quiet" type="submit">Use a different email</button></form>` });
}

export function mergeChoice({ client, csrf, who }) {
  return layout({ title: 'Add your guest progress', brand: client.name, color: client.color, back: client.home, body: `
<h1>You already have an account</h1><p><strong>${esc(who)}</strong> already has a Novenique account. Add what you did as a guest in ${esc(client.name)} to it?</p>
<form method="post" action="/merge">${hidden(csrf)}<input type="hidden" name="choice" value="merge"><button type="submit">Add my guest progress</button></form>
<form method="post" action="/merge">${hidden(csrf)}<input type="hidden" name="choice" value="cancel"><button class="quiet" type="submit">Go back and stay a guest</button></form>` });
}

export function profileForm({ client, csrf, error, name = '', handle = '', action = '/profile', title = 'Choose your name' }) {
  return layout({ title, brand: client?.name ?? 'Novenique', color: client?.color, back: client?.home, body: `
<h1>${esc(title)}</h1><p class="muted">Your name and @handle are what other players see, in every Novenique game.</p>${err(error)}
<form method="post" action="${esc(action)}">${hidden(csrf)}<label for="name">Name</label>
<input id="name" name="display_name" maxlength="40" required autocomplete="nickname" value="${esc(name)}">
<label for="handle">@handle</label><input id="handle" name="handle" maxlength="30" required pattern="[a-z0-9_]{3,30}" autocapitalize="none" autocomplete="username" value="${esc(handle)}">
<p class="muted" style="margin-top:8px">3 to 30 lowercase letters, numbers or underscores.</p><button type="submit">Continue</button></form>` });
}

export function message({ title, text, client, link }) {
  return layout({ title, brand: client?.name ?? 'Novenique', color: client?.color, back: client?.home, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<a class="btn" href="${esc(link.href)}">${esc(link.label)}</a>` : ''}` });
}

export function mfaStep({ csrf, error }) {
  return layout({ title: 'Second sign-in step', body: `<h1>Second sign-in step</h1><p>Staff accounts confirm with their authenticator app.</p>${err(error)}
<form method="post" action="/mfa">${hidden(csrf)}<label for="code">6-digit code or a recovery code</label><input id="code" name="code" autocomplete="one-time-code" required autofocus>
<button type="submit">Confirm</button></form>` });
}

export function account({ user, csrf, methods, sessions, roles, staff, mfa, notice, error, setup }) {
  const li = (a, b) => `<li><span>${a}</span>${b ?? ''}</li>`;
  return layout({ title: 'Your Novenique account', body: `<h1>${esc(user.display_name || 'Your account')}</h1>
<p class="muted">${user.handle ? '@' + esc(user.handle) : 'No @handle yet'}</p>${notice ? `<p class="ok" role="status">${esc(notice)}</p>` : ''}${err(error)}
<h2>Name and @handle</h2><form method="post" action="/account/profile">${hidden(csrf)}<label for="name">Name</label><input id="name" name="display_name" maxlength="40" required value="${esc(user.display_name)}">
<label for="handle">@handle</label><input id="handle" name="handle" maxlength="30" pattern="[a-z0-9_]{3,30}" required value="${esc(user.handle)}"><p class="muted" style="margin-top:8px">You can change your @handle once every 30 days. Your old one stays reserved for you for 30 days.</p><button type="submit">Save</button></form>
<h2>Ways to sign in</h2><ul class="list">${methods.map((m) => li(esc(m))).join('') || li('None yet')}</ul>
<h2>Where you're signed in</h2><ul class="list">${sessions.map((s) => li(`${esc(s.agent || 'A browser')}<br><span class="muted">${esc(s.when)}${s.current ? ' · this one' : ''}</span>`,
    s.current ? '' : `<form method="post" action="/account/sessions/revoke">${hidden(csrf)}<input type="hidden" name="id" value="${esc(s.id)}"><button class="quiet" type="submit">Sign out</button></form>`)).join('')}</ul>
<form method="post" action="/signout">${hidden(csrf)}<input type="hidden" name="everywhere" value="1"><button class="quiet" type="submit">Sign out everywhere</button></form>
${roles.length ? `<h2>Your roles</h2><ul class="list">${roles.map((r) => li(esc(r))).join('')}</ul>` : ''}
${staff ? `<h2>Second sign-in step</h2>${mfa ? '<p>On. Your authenticator app is set up.</p>' : setup ? `<p>Add this key to your authenticator app, then enter the code it shows.</p>
<p><code>${esc(setup.secret)}</code></p><p><a href="${esc(setup.uri)}">Open in an authenticator app</a></p>
<form method="post" action="/account/mfa/enable">${hidden(csrf)}<label for="mcode">Code</label><input id="mcode" name="code" inputmode="numeric" maxlength="6" required><button type="submit">Turn on</button></form>`
    : `<p>Staff roles need it.</p><form method="post" action="/account/mfa/setup">${hidden(csrf)}<button type="submit">Set up</button></form>`}` : ''}
<h2>Delete your account</h2><form method="post" action="/account/delete">${hidden(csrf)}<p class="muted">We remove your name, @handle and email. Game records keep an anonymous id.</p><button class="quiet" type="submit">Ask to delete my account</button></form>
<form method="post" action="/signout">${hidden(csrf)}<button class="quiet" type="submit">Sign out</button></form>` });
}

export function recoveryCodes({ codes }) {
  return layout({ title: 'Recovery codes', body: `<h1>Second step is on</h1><p>Keep these recovery codes somewhere safe. Each works once if you lose your phone. They won't be shown again.</p>
<ul class="list">${codes.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul><a class="btn" href="/account">Done</a>` });
}
