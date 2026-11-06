// Payments for every Novenique game: the pass (a Stripe subscription) that each game sells under its own brand.
// One Stripe account, one product per game. A game's plans are listed with the game in deploy/clients.json ("pass"), so a
// new game sells a pass by adding a few lines there; no new code. Stripe's signed webhooks are what grant, renew and end a
// pass, never the browser. Players manage or cancel on Stripe's own billing page.
//
// For game servers (client id and secret, like the rest of /v1), always about the calling game's own product:
//   GET  /v1/pass?user_id=        { active, until, renews, manage, plan, sell, plans, price }
//   GET  /v1/passes               every pass this game has sold (its owner's screen, its leaderboards)
//   POST /v1/pass/checkout        { user_id, email?, plan? }  -> { url } Stripe Checkout, back to the game's home after
//   POST /v1/pass/manage          { user_id }                 -> { url } Stripe's billing page
//   POST /v1/pass/import          { passes: [...], events: [...] }  passes a game sold before Core sold them (kept if longer)
// For Stripe: POST /stripe/webhook (checkout.session.completed, invoice.paid, customer.subscription.updated/deleted). A game
// may also pass its own webhook on here unchanged (body and Stripe-Signature header), so Stripe's settings need not change.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { q } from './pb.mjs';
import { isStaff } from './roles.mjs';

const DAY = 864e5, GRACE = 2 * DAY;   // a renewal that is a day or two late doesn't lock anyone out
const SAFE = /^[a-z0-9]{15}$/;        // a Core user id
const months = (pl) => (pl.interval === 'year' ? 12 : 1) * (pl.count || 1);
const usd = (c) => (c / 100).toFixed(2);

/** Stripe signs each webhook: "t=<time>,v1=<hmac of 't.body'>"; anything older than five minutes or unsigned is refused. */
export function stripeVerify(raw, header, secret, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((x) => x.split('=')).filter((x) => x.length === 2));
  const sigs = String(header).split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  const t = +parts.t; if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

export function makeBilling({ cfg, pb, A, fetchImpl = fetch }) {
  const key = cfg.stripe?.key ?? '', hook = cfg.stripe?.hook ?? '';
  const plansOf = (c) => Object.entries(c?.pass?.plans ?? {}).map(([id, pl]) => ({ id, ...pl, price: cfg.stripe?.prices?.[`${c.product}.${id}`] || pl.price || '' }));
  const onPlans = (c) => plansOf(c).filter((pl) => pl.on && pl.cents > 0);
  const sells = (c) => !!(key && hook && onPlans(c).length);
  const productOf = (game) => Object.values(cfg.clients).find((c) => c.product === game || c.id === game)?.product ?? null;

  const row = (userId, product) => pb.first('nv_passes', `user_id=${q(userId)} && product=${q(product)}`);
  const view = (p, now = Date.now()) => p && { id: p.user_id, plan: p.plan, since: p.since_ms || null, until: p.until_ms || 0, renews: !!p.renews, customer: p.customer || '',
    paid: p.paid || 0, source: p.source || '', active: (p.until_ms || 0) > now };
  async function save(userId, product, data) {
    const cur = await row(userId, product);
    return cur ? pb.update('nv_passes', cur.id, data) : pb.create('nv_passes', { user_id: userId, product, ...data });
  }
  /** The pass of a person for one game; a guest merged into an account carries over. Staff (any staff role on this game
   * or on the whole platform) hold it free, so the people who run a game never meet its checkout. */
  async function passOf(userId, product) {
    const id = SAFE.test(userId) ? await A.resolve(userId) : null;
    if (!id) return null;
    const p = view(await row(id, product));
    if (p && p.active) return p;
    const rows = A.roles ? await A.roles(id) : [];
    if (isStaff((rows ?? []).filter((r) => r.product === product || r.product === 'platform')))
      return { id, plan: 'staff', since: null, until: Date.now() + 365 * 864e5, renews: false, customer: '', paid: 0, source: 'staff', active: true };
    return null;
  }

  // ---- one Stripe event: started, renewed, changed or ended. Each event is used once. ----
  async function event(ev, now = Date.now()) {
    if (!ev || !ev.id || await pb.first('nv_stripe_events', `event_id=${q(String(ev.id))}`)) return null;
    const o = (ev.data && ev.data.object) || {};
    const metaOf = (m) => (m && typeof m === 'object' ? m : {});
    let meta = {}, out = null;
    const bySub = async (sub) => (sub ? pb.first('nv_passes', `sub=${q(String(sub))}`) : null);
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription' && o.payment_status === 'paid') {
      meta = metaOf(o.metadata);
      const product = productOf(meta.game), id = meta.uid || o.client_reference_id;
      if (product && SAFE.test(String(id))) {
        const c = Object.values(cfg.clients).find((x) => x.product === product), planId = meta.plan || 'year';
        const pl = plansOf(c).find((x) => x.id === planId) ?? { interval: 'year', count: 1 };
        const cur = view(await row(id, product)) ?? {};
        // until the first invoice lands, the pass runs one plan period from now
        out = { product, id, data: { plan: planId, sub: o.subscription || '', customer: o.customer || cur.customer || '', renews: true, since_ms: cur.since || now,
          until_ms: Math.max(cur.until || 0, now + months(pl) * 30.44 * DAY), source: 'stripe' } };
      }
    } else if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') {
      const sub = o.subscription || o.parent?.subscription_details?.subscription;
      const line = o.lines?.data?.[0] ?? {};
      meta = { ...metaOf(line.metadata), ...metaOf(o.parent?.subscription_details?.metadata), ...metaOf(o.subscription_details?.metadata) };
      const known = await bySub(sub);
      const product = known?.product ?? productOf(meta.game), id = known?.user_id ?? meta.uid;
      if (product && SAFE.test(String(id))) {
        const cur = view(await row(id, product)) ?? {}, end = line.period?.end || o.period_end;
        out = { product, id, data: { sub: sub || cur.sub || '', customer: o.customer || cur.customer || '', since_ms: cur.since || now, paid: (cur.paid || 0) + (o.amount_paid || 0),
          until_ms: Math.max(cur.until || 0, end ? end * 1000 + GRACE : now + 365 * DAY), source: 'stripe', ...(cur.plan ? {} : { plan: meta.plan || 'year' }) } };
      }
    } else if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
      const known = await bySub(o.id);
      if (known) {   // an older subscription ending doesn't touch the current one: sub is matched exactly
        const ends = ev.type === 'customer.subscription.deleted' || o.status === 'canceled' || o.status === 'unpaid';
        out = { product: known.product, id: known.user_id, data: { renews: ev.type === 'customer.subscription.updated' && !o.cancel_at_period_end && o.status !== 'canceled',
          ...(ends ? { until_ms: Math.min(known.until_ms || 0, now) } : {}) } };
      }
    }
    await pb.create('nv_stripe_events', { event_id: String(ev.id).slice(0, 120), type: String(ev.type ?? '').slice(0, 60), product: out?.product ?? '', user_id: out?.id ?? '' });
    if (!out) return null;
    const saved = await save(out.id, out.product, out.data);
    await A.audit(out.id, 'pass.' + ev.type, out.id, { product: out.product, until: saved.until_ms }, 'system');
    return { product: out.product, ...view(saved, now) };
  }

  async function stripe(route, form) {
    const r = await fetchImpl('https://api.stripe.com/v1/' + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw Object.assign(new Error((j.error && j.error.message) || route + ' failed'), { status: 502 });
    return j.url;
  }
  async function checkout(c, userId, email, planId = 'year') {
    const pl = onPlans(c).find((x) => x.id === planId);
    if (!pl) throw Object.assign(new Error('No such plan'), { status: 400 });
    const cur = view(await row(userId, c.product));
    const f = new URLSearchParams({ mode: 'subscription', client_reference_id: userId, 'metadata[uid]': userId, 'metadata[plan]': planId, 'metadata[game]': c.product,
      'subscription_data[metadata][uid]': userId, 'subscription_data[metadata][plan]': planId, 'subscription_data[metadata][game]': c.product,
      'line_items[0][quantity]': '1', allow_promotion_codes: 'true', success_url: `${c.home}/?pass=ok`, cancel_url: `${c.home}/?pass=cancel` });
    // the product made in Stripe's catalog when its Price ID is set; otherwise the same plan described inline
    if (pl.price) f.set('line_items[0][price]', pl.price);
    else for (const [k, v] of Object.entries({ currency: 'usd', unit_amount: String(pl.cents), 'recurring][interval': pl.interval, 'recurring][interval_count': String(pl.count || 1),
      'product_data][name': `${c.name} ${c.pass.name || 'Pass'} (${String(pl.name).toLowerCase()})`, 'product_data][metadata][game': c.product })) f.set(`line_items[0][price_data][${k}]`, v);
    if (cur && cur.customer) f.set('customer', cur.customer); else if (email) f.set('customer_email', String(email).slice(0, 320));
    return stripe('checkout/sessions', f);
  }

  /** The /v1/pass* routes for one game's server; null when the path isn't one of them. */
  async function api(req, res, url, form, c, json, fail) {
    const path = url.pathname;
    if (!path.startsWith('/v1/pass')) return null;
    const uid = String(req.method === 'GET' ? url.searchParams.get('user_id') ?? '' : form.user_id ?? '');
    if (req.method === 'GET' && path === '/v1/pass') {
      const p = await passOf(uid, c.product), plans = onPlans(c).map((pl) => ({ id: pl.id, name: pl.name, price: usd(pl.cents), months: months(pl), monthly: usd(Math.round(pl.cents / months(pl))) }));
      const y = plans.find((x) => x.id === 'year') || plans[0];
      return json(res, 200, { active: !!p, until: p ? p.until : null, renews: !!(p && p.renews), manage: !!(p && p.customer), plan: p ? p.plan : null,
        sell: sells(c), plans, price: y ? { monthly: y.monthly, yearly: y.price } : null });
    }
    if (req.method === 'GET' && path === '/v1/passes') {
      const all = [];
      for (let page = 1; page <= 50; page++) { const b = await pb.list('nv_passes', { filter: `product=${q(c.product)}`, sort: '-until_ms', perPage: 200, page }); all.push(...b); if (b.length < 200) break; }
      return json(res, 200, { sell: sells(c), passes: all.map((p) => view(p)) });
    }
    if (req.method === 'POST' && path === '/v1/pass/checkout') {
      if (!sells(c)) return fail(res, 503, 'NOT_ON_SALE', 'The pass opens very soon.');
      const id = SAFE.test(uid) ? await A.resolve(uid) : null, u = id ? await A.active(id) : null;
      if (!u) return fail(res, 404, 'NOT_FOUND', 'Unknown user');
      return json(res, 200, { url: await checkout(c, id, form.email || (String(u.email ?? '').includes('.invalid') ? '' : u.email), String(form.plan || 'year')) });
    }
    if (req.method === 'POST' && path === '/v1/pass/manage') {
      const id = SAFE.test(uid) ? await A.resolve(uid) : null, p = id ? view(await row(id, c.product)) : null;
      if (!p || !p.customer) return fail(res, 404, 'NOT_FOUND', 'No subscription');
      return json(res, 200, { url: await stripe('billing_portal/sessions', new URLSearchParams({ customer: p.customer, return_url: `${c.home}/` })) });
    }
    if (req.method === 'POST' && path === '/v1/pass/import') {
      let kept = 0;
      for (const x of Array.isArray(form.passes) ? form.passes.slice(0, 5000) : []) {
        if (!x || !SAFE.test(String(x.id)) || !(+x.until > 0)) continue;
        const id = await A.resolve(String(x.id)); if (!id) continue;
        const cur = view(await row(id, c.product));
        if (cur && cur.until >= +x.until) continue;   // Core already knows a pass at least as long
        await save(id, c.product, { plan: String(x.plan || 'year').slice(0, 20), sub: String(x.sub || '').slice(0, 80), customer: String(x.customer || '').slice(0, 80),
          renews: !!x.renews, since_ms: +x.since || Date.now(), until_ms: +x.until, paid: +x.paid || 0, source: 'import' });
        kept++;
      }
      let events = 0;
      for (const e of Array.isArray(form.events) ? form.events.slice(-500) : []) {
        if (typeof e !== 'string' || !e || await pb.first('nv_stripe_events', `event_id=${q(e)}`)) continue;
        await pb.create('nv_stripe_events', { event_id: e.slice(0, 120), type: 'imported', product: c.product, user_id: '' }); events++;
      }
      if (kept) await A.audit('', 'pass.import', '', { product: c.product, passes: kept }, 'system');
      return json(res, 200, { imported: kept, events });
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }

  /** POST /stripe/webhook: the raw body, checked against Stripe's signature before anything is read. */
  async function webhook(req, res, json) {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 256 * 1024) return json(res, 413, { error: 'too large' }); chunks.push(ch); }
    const raw = Buffer.concat(chunks).toString();
    if (!stripeVerify(raw, req.headers['stripe-signature'], hook)) return json(res, 400, { error: 'bad signature' });
    let ev; try { ev = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad event' }); }
    const r = await event(ev);
    if (r) console.log(`pass ${r.product} ${r.id}: until ${new Date(r.until).toISOString().slice(0, 10)}${r.renews ? ', renews' : ''}`);
    return json(res, 200, { received: true });
  }

  return { api, webhook, event, passOf, sells, health: () => ({ stripe: !!(key && hook), selling: Object.values(cfg.clients).filter(sells).map((c) => c.product) }) };
}
