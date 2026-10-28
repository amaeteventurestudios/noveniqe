// The pass in Core: Stripe's signed webhooks grant, renew and end it; each game only sees its own; a game's older passes
// can be imported once; checkout and the billing page go to Stripe with the game's own product and home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { start, CLIENTS, api } from './helpers.mjs';
import { stripeVerify } from '../lib/billing.mjs';

const HOOK = 'whsec_test_0123456789';
const PASS = { name: 'Anti-Bot Pass', plans: { year: { cents: 599, interval: 'year', count: 1, name: 'Yearly', on: true, price: 'price_year' },
  month: { cents: 99, interval: 'month', count: 1, name: 'Monthly', on: false } } };
const calls = [];
let t;
before(async () => {
  t = await start({ clients: { ...CLIENTS, agp: { ...CLIENTS.agp, pass: PASS } }, stripe: { key: 'sk_test_x', hook: HOOK, prices: {} },
    fetchStub: async (url, opts) => { calls.push({ url: String(url), body: String(opts.body) }); return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/s1' }), { status: 200 }); } });
});
after(() => t.stop());

const signed = (raw, at = Math.floor(Date.now() / 1000)) => `t=${at},v1=${createHmac('sha256', HOOK).update(`${at}.${raw}`).digest('hex')}`;
async function hook(ev, sig) {
  const raw = JSON.stringify(ev);
  const r = await fetch(t.base + '/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig ?? signed(raw) }, body: raw });
  return r.status;
}
const guest = async () => (await api(t, CLIENTS.agp, 'POST', '/v1/guests', {})).body.user.id;

test('signatures: fresh passes, stale, changed or missing is refused', () => {
  const raw = '{"a":1}', now = Date.now(), at = Math.floor(now / 1000);
  assert.ok(stripeVerify(raw, signed(raw, at), HOOK, now));
  assert.ok(!stripeVerify(raw, signed(raw, at - 600), HOOK, now));
  assert.ok(!stripeVerify(raw + ' ', signed(raw, at), HOOK, now));
  assert.ok(!stripeVerify(raw, '', HOOK, now));
});

test('a subscription starts, renews, stops renewing and ends', async () => {
  const uid = await guest();
  let p = await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`);
  assert.equal(p.body.active, false);
  assert.equal(p.body.sell, true);
  assert.deepEqual(p.body.plans.map((x) => x.id), ['year'], 'only plans that are on are offered');
  assert.equal(p.body.price.yearly, '5.99');
  assert.equal(await hook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } }, 't=1,v1=00'), 400, 'unsigned is refused');
  assert.equal(await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid', metadata: { uid, plan: 'year', game: 'agp' }, subscription: 'sub_1', customer: 'cus_1' } } }), 200);
  p = await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`);
  assert.ok(p.body.active && p.body.renews && p.body.manage);
  assert.ok(p.body.until > Date.now() + 360 * 864e5);
  assert.equal((await api(t, CLIENTS.palasora, 'GET', `/v1/pass?user_id=${uid}`)).body.active, false, 'a pass is for one game');
  // the same event again changes nothing
  assert.equal(await hook({ id: 'evt_1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled' } } }), 200);
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`)).body.active, true);
  const end2 = Math.floor(Date.now() / 1000) + 2 * 365 * 86400;
  await hook({ id: 'evt_2', type: 'invoice.paid', data: { object: { subscription: 'sub_1', amount_paid: 599, lines: { data: [{ period: { end: end2 } }] } } } });
  p = await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`);
  assert.ok(p.body.until >= end2 * 1000, 'a renewal extends the pass to the end of the paid period');
  await hook({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: true } } });
  p = await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`);
  assert.ok(p.body.active && !p.body.renews, 'cancelling keeps the pass to the end of the period');
  await hook({ id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', status: 'canceled' } } });
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`)).body.active, true, 'an unknown subscription ending touches nothing');
  await hook({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled' } } });
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${uid}`)).body.active, false);
  const list = await api(t, CLIENTS.agp, 'GET', '/v1/passes');
  assert.ok(list.body.passes.some((x) => x.id === uid));
  assert.ok(!(await api(t, CLIENTS.palasora, 'GET', '/v1/passes')).body.passes.some((x) => x.id === uid), 'each game lists only its own');
});

test('checkout and the billing page go to Stripe with the game, the person and the game\'s home', async () => {
  const uid = await guest();
  const r = await api(t, CLIENTS.agp, 'POST', '/v1/pass/checkout', { user_id: uid, email: 'ada@example.com', plan: 'year' });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://checkout.stripe.test/s1');
  const sent = new URLSearchParams(calls.at(-1).body);
  assert.match(calls.at(-1).url, /checkout\/sessions$/);
  assert.equal(sent.get('mode'), 'subscription');
  assert.equal(sent.get('metadata[uid]'), uid);
  assert.equal(sent.get('subscription_data[metadata][game]'), 'agp');
  assert.equal(sent.get('line_items[0][price]'), 'price_year');
  assert.equal(sent.get('success_url'), 'https://agp.test/?pass=ok');
  assert.equal((await api(t, CLIENTS.agp, 'POST', '/v1/pass/checkout', { user_id: uid, plan: 'month' })).status, 400, 'a plan that is off is not sold');
  assert.equal((await api(t, CLIENTS.palasora, 'POST', '/v1/pass/checkout', { user_id: uid })).status, 503, 'a game with no priced plan sells nothing');
  assert.equal((await api(t, CLIENTS.agp, 'POST', '/v1/pass/manage', { user_id: uid })).status, 404, 'no subscription, no billing page');
});

test('a game\'s older passes import once and never shorten a pass', async () => {
  const a = await guest(), b = await guest(), until = Date.now() + 100 * 864e5;
  let r = await api(t, CLIENTS.agp, 'POST', '/v1/pass/import', { passes: [{ id: a, plan: 'year', sub: 'sub_imp', customer: 'cus_imp', until, renews: true, since: Date.now() }, { id: 'nope', until }],
    events: ['evt_old_1'] });
  assert.deepEqual(r.body, { imported: 1, events: 1 });
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${a}`)).body.active, true);
  r = await api(t, CLIENTS.agp, 'POST', '/v1/pass/import', { passes: [{ id: a, until: until - 864e5 }], events: ['evt_old_1'] });
  assert.deepEqual(r.body, { imported: 0, events: 0 }, 'running it again changes nothing');
  // an imported subscription keeps renewing through Core
  await hook({ id: 'evt_imp', type: 'invoice.paid', data: { object: { subscription: 'sub_imp', lines: { data: [{ period: { end: Math.floor(until / 1000) + 365 * 86400 } }] } } } });
  assert.ok((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${a}`)).body.until > until + 300 * 864e5);
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/pass?user_id=${b}`)).body.active, false);
  const h = await (await fetch(t.base + '/health')).json();
  assert.deepEqual(h.pay, { stripe: true, selling: ['agp'] });
});
