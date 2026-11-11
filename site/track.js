/* Noveniqe website: product analytics, error reports and the email sign-up, all through PostHog.
   Cookieless: no cookies, nothing stored in the browser, no person profiles, no session recording.
   Events go to /ingest on this site (the server passes them on to PostHog without the visitor's IP).
   Events: $pageview (visited), world_viewed (a game section came into view), play_clicked (left for a game),
   jisste_clicked, signup_submitted (email sign-up; the list lives in these events), contact_clicked, $exception. */
(() => {
  const KEY = 'phc_swHNzgwgqgrJRcL63H2uMvddEabvUZjpnHnshx9k8eYj'; // public project key, safe to publish
  const queue = [];
  let ph = null;
  const send = (ev, props) => (ph ? ph.capture(ev, props) : queue.push(['capture', ev, props]));
  const oops = err => (ph ? ph.captureException(err) : queue.push(['err', err]));
  window.nvTrack = send;

  // errors before and after PostHog loads
  addEventListener('error', e => { if (e.error || e.message) oops(e.error || new Error(e.message)); });
  addEventListener('unhandledrejection', e => oops(e.reason instanceof Error ? e.reason : new Error(String(e.reason))));

  let booted = false;
  function boot() {
    if (booted) return; booted = true;
    if (location.protocol !== 'https:' || /^(localhost|127\.)/.test(location.hostname)) return; // no data from previews
    const s = document.createElement('script');
    s.src = '/vendor/posthog.js';
    s.onload = () => {
      const P = window.posthog; if (!P || !P.init) return;
      P.init(KEY, {
        api_host: '/ingest', ui_host: 'https://us.posthog.com',
        cookieless_mode: 'always', persistence: 'memory', person_profiles: 'identified_only',
        autocapture: false, capture_pageview: true, capture_pageleave: true,
        disable_session_recording: true, disable_surveys: true, advanced_disable_flags: true,
        capture_exceptions: false, // reported by hand above, so nothing extra is fetched
        loaded: p => {
          ph = p;
          p.register({ site: 'noveniqe.com', $geoip_disable: true });
          queue.splice(0).forEach(([k, a, b]) => (k === 'err' ? p.captureException(a) : p.capture(a, b)));
        },
      });
    };
    document.head.appendChild(s);
  }
  const later = () => (window.requestIdleCallback ? requestIdleCallback(boot, { timeout: 4000 }) : setTimeout(boot, 1500));
  document.readyState === 'complete' ? later() : addEventListener('load', later);

  // which world sections people actually reach
  const worlds = { games: 'Agent Grand Prix', palasora: 'Palasora', warfront: 'Agent Warfront', anansora: 'Anansora', jisste: 'Jisste', partners: 'Partners' };
  const seen = new Set();
  const io = new IntersectionObserver(es => es.forEach(e => {
    const id = e.target.id;
    if (e.isIntersecting && !seen.has(id)) { seen.add(id); send('world_viewed', { world: worlds[id] }); io.unobserve(e.target); }
  }), { threshold: 0.35 });
  Object.keys(worlds).forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });

  // clicks that leave for a game, Jisste or email
  const games = { 'agentgrandprix.com': 'Agent Grand Prix', 'warfront.noveniqe.com': 'Agent Warfront', 'palasora.com': 'Palasora', 'anansora.noveniqe.com': 'Anansora' };
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    const href = a.getAttribute('href');
    if (href.startsWith('mailto:')) return send('contact_clicked', { to: href.slice(7).split('@')[0] });
    let u; try { u = new URL(href, location.href); } catch { return; }
    const where = (a.closest('section,footer,header') || {}).id || (a.closest('footer') ? 'footer' : '');
    if (games[u.hostname]) send('play_clicked', { world: games[u.hostname], from: where });
    else if (u.hostname.includes('jisste')) send('jisste_clicked', { teams: u.hostname.startsWith('teams.'), from: where });
  }, true);

  // email sign-up
  const form = document.getElementById('join');
  if (form) {
    const input = form.querySelector('input'), msg = document.getElementById('jmsg');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const email = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
        input.setAttribute('aria-invalid', 'true'); input.focus();
        msg.textContent = 'That email does not look right. Try again?';
        return;
      }
      input.removeAttribute('aria-invalid');
      const btn = form.querySelector('button'); btn.disabled = true;
      // straight to PostHog's capture endpoint, so a sign-up never waits on (or gets lost with) the analytics script
      fetch('/ingest/i/v0/e/', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: KEY, event: 'signup_submitted', distinct_id: 'signup-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()),
          properties: { email, source: 'next-world', site: 'noveniqe.com', $geoip_disable: true, $current_url: location.href, $process_person_profile: false } }),
      }).then(r => {
        if (!r.ok) throw new Error('sign-up ' + r.status);
        form.classList.add('done');
        msg.textContent = "You're on the list. We'll write when the next world opens.";
      }).catch(err => {
        btn.disabled = false; oops(err);
        msg.innerHTML = 'That did not go through. Try again in a moment, or write to <a href="mailto:hello@noveniqe.com">hello@noveniqe.com</a>.';
      });
    });
  }
})();
