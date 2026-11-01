/* Real-time layer for election night.
   GitHub Pages only rebuilds every few minutes, so on the night the browser polls the public results feeds
   directly (CNN's AP-fed JSON, which allows cross-origin reads) every 30 seconds, overlays the counts on
   the latest server-built data, and re-runs the projection model locally. Before the election it polls
   Polymarket for live chamber-control prices. Everything here degrades to the server data if a feed fails. */
(function () {
  'use strict';
  const CNN = 'https://politics.api.cnn.io/results/';
  const PM = 'https://gamma-api.polymarket.com/events?slug=';
  const LIVE_FROM = Date.parse('2026-11-03T10:00:00Z');
  const LIVE_UNTIL = Date.parse('2026-11-24T00:00:00Z');
  const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
  const SIGMA_POLL = 4.8, SIGMA_NATIONAL = 2.6;

  const S = { feedBase: null, force: false, timer: null, feed: { SG: null, GG: null, HG: null }, feedAt: null, feedErr: {}, lastHouse: 0,
    lastTick: 0, markets: null, marketsAt: null, app: null, etags: {}, pointAt: 0, running: false };

  const qs = new URLSearchParams(location.search);
  if (qs.get('feed')) { S.feedBase = qs.get('feed'); S.force = true; }

  // ------------------------------------------------------------- maths
  function erf(x) { // Abramowitz and Stegun 7.1.26
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const probFromMargin = (m, sigma) => Math.min(0.995, Math.max(0.005, normCdf(m / sigma)));
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // ------------------------------------------------- model (mirrors refresh.py)
  function liveUpdate(prior, live, swing) {
    if (!live) return Object.assign({}, prior, { p_live: prior.p_dem, state: 'pre' });
    const wp = live.winner_party;
    if (live.call === 'called' && wp) return Object.assign({}, prior, { p_live: wp !== 'R' ? 1 : 0, state: 'called' });
    if (live.call === 'runoff') return Object.assign({}, prior, { p_live: prior.p_dem, state: 'runoff' });
    const eevp = (live.eevp || 0) / 100, cur = live.margin;
    if (cur == null || eevp <= 0.02) {
      const m = prior.margin + 0.7 * swing;
      return Object.assign({}, prior, { margin_live: +m.toFixed(2), p_live: +probFromMargin(m, prior.sigma).toFixed(3), state: eevp === 0 ? 'waiting' : 'early' });
    }
    const trust = Math.pow(eevp, 1.6);
    const m = trust * cur + (1 - trust) * (prior.margin + 0.7 * swing);
    const sigma = Math.sqrt(Math.pow((1 - eevp) * prior.sigma, 2) + Math.pow(1.5 * (1 - eevp), 2) + 0.36);
    return Object.assign({}, prior, { margin_live: +m.toFixed(2), sigma_live: +sigma.toFixed(2), p_live: +probFromMargin(m, sigma).toFixed(3), state: 'counting' });
  }
  function observedSwing(races) {
    const vals = [];
    for (const r of races) {
      const l = r.live || {}, p = r.prior || {};
      if ((l.call === 'called' || (l.eevp || 0) >= 60) && l.margin != null && p.basis && p.basis !== 'none' && (l.eevp || 0) >= 40) vals.push(l.margin - p.margin);
    }
    if (!vals.length) return { swing: 0, n: 0 };
    vals.sort((a, b) => a - b);
    const med = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    return { swing: +med.toFixed(2), n: vals.length, mean: +mean.toFixed(2), spread: vals.length > 1 ? +sd.toFixed(2) : null };
  }
  function simulate(races, baseDem, toWin, sims) {
    const entries = [];
    for (const r of races) {
      const pj = r.proj || {}; if (pj.p_live == null) continue;
      if (pj.state === 'called') { entries.push([1, pj.p_live >= 0.5 ? 1 : 0, 0, 0]); continue; }
      const m = pj.margin_live != null ? pj.margin_live : (pj.margin || 0), s = pj.sigma_live || pj.sigma || SIGMA_POLL;
      const eevp = ((r.live || {}).eevp || 0) / 100, nat = SIGMA_NATIONAL * (1 - eevp);
      entries.push([0, m, nat, Math.sqrt(Math.max(s * s - nat * nat, 0.25))]);
    }
    const counts = new Array(entries.length + 1).fill(0);
    let ctrl = 0, seatSum = 0;
    for (let i = 0; i < sims; i++) {
      const ne = gauss(); let d = 0;
      for (const e of entries) { if (e[0]) d += e[1]; else if (e[1] + e[2] * ne + gauss() * e[3] > 0) d++; }
      counts[d]++; seatSum += d; if (baseDem + d >= toWin) ctrl++;
    }
    const dist = {}; let cum = 0, lo = null, hi = null;
    counts.forEach((c, i) => { if (c) dist[String(baseDem + i)] = +(c / sims).toFixed(4); cum += c / sims; if (lo == null && cum >= 0.1) lo = baseDem + i; if (hi == null && cum >= 0.9) hi = baseDem + i; });
    return { p_dem_control: +(ctrl / sims).toFixed(3), exp_dem_seats: +(baseDem + seatSum / sims).toFixed(1), dem_80: [lo, hi], dist, sims };
  }
  function summarize(races, prev, sims) {
    const st = (r) => (r.proj || {}).state;
    const calledD = races.filter((r) => st(r) === 'called' && r.proj.p_live >= 0.5).length;
    const calledR = races.filter((r) => st(r) === 'called' && r.proj.p_live < 0.5).length;
    const leadD = races.filter((r) => st(r) === 'counting' && ((r.live || {}).margin || 0) > 0).length;
    const leadR = races.filter((r) => st(r) === 'counting' && ((r.live || {}).margin || 0) < 0).length;
    const sim = simulate(races, prev.not_up.D, prev.to_win.D, sims);
    const flips = [];
    for (const r of races) { const inc = r.incumbent_party, pj = r.proj || {}; if ((inc === 'D' || inc === 'R') && pj.p_live != null && ((inc === 'D' && pj.p_live < 0.5) || (inc === 'R' && pj.p_live >= 0.5))) flips.push({ id: r.postal || r.id, from: inc, to: inc === 'D' ? 'R' : 'D', p: pj.p_live, state: pj.state }); }
    return Object.assign({}, prev, {
      called: { D: calledD, R: calledR }, leading: { D: leadD, R: leadR },
      secured: { D: prev.not_up.D + calledD, R: prev.not_up.R + calledR },
      expected: { D: sim.exp_dem_seats, R: +(prev.total - sim.exp_dem_seats).toFixed(1) },
      dem_80: sim.dem_80, p_dem_control: sim.p_dem_control, dist: sim.dist,
      uncalled: races.filter((r) => st(r) !== 'called').length,
      likely_flips: flips.sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5)).slice(0, 60),
    });
  }

  // ------------------------------------------------------- CNN parsing
  function cnnRace(r) {
    const total = +r.totalVote || 0;
    const cands = (r.candidates || []).map((c) => {
      const v = +c.voteNum || 0;
      return { id: c.lastNameSlug || c.candidateId, name: c.fullName || c.lastName, party: c.candidatePartyCode === 'D' ? 'D' : c.candidatePartyCode === 'R' ? 'R' : 'I',
        inc: !!c.isIncumbent, votes: v, pct: total ? +(100 * v / total).toFixed(1) : (c.votePercentNum != null ? +c.votePercentNum : null), winner: !!c.winner, leader: false };
    }).sort((a, b) => b.votes - a.votes);
    if (cands.length && total) cands[0].leader = true;
    const win = cands.find((c) => c.winner);
    const d = cands.find((c) => c.party === 'D'), rp = cands.find((c) => c.party === 'R');
    let margin = null;
    if (total && cands.length >= 2) {
      if (d && rp) margin = +(d.pct - rp.pct).toFixed(1);
      else if (rp) margin = +((cands[0].party !== 'R' ? cands[0].pct - rp.pct : rp.pct - cands[1].pct) * (cands[0].party !== 'R' ? 1 : -1)).toFixed(1);
    }
    const called = r.editorialStatus === 'called' || !!win;
    return { call: called ? 'called' : (r.editorialStatus === 'runoff' ? 'runoff' : 'too_early'), winner: win ? win.name : null, winner_party: win ? win.party : null,
      called_by: win ? ['ap'] : [], eevp: Math.min(99, +r.percentReporting || 0), votes: total, expected: null, precincts: [0, 0], margin, cands: cands.slice(0, 5),
      updated: r.voteTimestamp || null, special: /special/i.test(r.raceTitle || '') || /special/i.test(r.electionTitle || ''), src: 'cnn' };
  }
  function indexCnn(list, code) {
    const out = {};
    for (const r of Array.isArray(list) ? list : (list && list.races) || []) {
      if (r.electionTitle && !/general/i.test(r.electionTitle)) continue;
      const key = r.ecKey || '';
      if (code === 'HG') {
        const m = /-HG-([A-Z]{2})-(\d+)/.exec(key); if (!m) continue;
        const st = m[1], id = AT_LARGE.has(st) ? `${st}-AL` : `${st}-${m[2].padStart(2, '0')}`;
        out[id] = cnnRace(r);
      } else {
        const st = r.stateAbbreviation; if (!st) continue;
        const rec = cnnRace(r);
        (out[st] = out[st] || []).push(rec);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- fetch
  async function getJson(url, key) {
    const headers = {};
    if (S.etags[key]) headers['If-None-Match'] = S.etags[key];
    const r = await fetch(url, { headers, cache: 'no-cache' });
    if (r.status === 304) return undefined;
    if (!r.ok) throw new Error(r.status + ' ' + url);
    const et = r.headers.get('etag'); if (et) S.etags[key] = et;
    return r.json();
  }
  const feedUrl = (path) => (S.feedBase ? S.feedBase.replace(/\/?$/, '/') + path : CNN + path);

  function mergeLive(prev, c) {
    // keep NYT-only fields (expected vote, precincts, history) from the server record if present
    const out = Object.assign({}, prev || {}, c);
    if (prev && prev.expected && !c.expected) out.expected = prev.expected;
    if (prev && prev.hist) out.hist = prev.hist;
    if (prev && prev.url) out.url = prev.url;
    if (prev && prev.nyt_rating) out.nyt_rating = prev.nyt_rating;
    // never let the overlay go backwards: if the server already has more vote in, keep the server numbers
    if (prev && prev.src !== 'cnn' && (prev.eevp || 0) > (c.eevp || 0) + 5 && prev.call === 'called') return prev;
    return out;
  }

  function applyFeed(D) {
    const f = S.feed;
    if (!f.SG && !f.GG && !f.HG) return false;
    let touched = 0;
    if (f.SG) for (const r of D.senate.races) { const list = f.SG[r.postal]; if (!list) continue; const c = list.length > 1 ? (list.find((x) => !!x.special === !!r.special) || list[0]) : list[0]; r.live = mergeLive(r.live, c); touched++; }
    if (f.GG) for (const r of D.governors.races) { const list = f.GG[r.postal]; if (!list) continue; r.live = mergeLive(r.live, list[0]); touched++; }
    if (f.HG) for (const d of D.house.districts) { const c = f.HG[d.id]; if (!c) continue; d.live = mergeLive(d.live, c); touched++; }
    if (!touched) return false;
    for (const key of ['senate', 'governors']) {
      const races = D[key].races, sw = observedSwing(races);
      for (const r of races) r.proj = liveUpdate(r.prior, r.live, sw.swing);
      D[key].swing = sw;
      D[key].summary = summarize(races, D[key].summary, 8000);
    }
    const pre = (D.senate.swing.n || D.governors.swing.n) ? (D.senate.swing.n ? D.senate.swing.swing : D.governors.swing.swing) : 0;
    const dists = D.house.districts;
    for (const d of dists) d.proj = liveUpdate(d.prior, d.live, pre);
    let hs = observedSwing(dists);
    const blended = hs.n >= 10 ? ((D.senate.swing.n || D.governors.swing.n) ? (pre + hs.swing) / 2 : hs.swing) : pre;
    for (const d of dists) d.proj = liveUpdate(d.prior, d.live, blended);
    hs = observedSwing(dists);
    D.house.swing = hs;
    D.house.summary = summarize(dists, D.house.summary, 4000);
    D.phase = 'live';
    D.client_live = { at: new Date().toISOString(), source: S.feedBase ? 'rehearsal feed' : 'CNN/AP feed', touched };
    return true;
  }

  function appendPoint(D, T) {
    if (!T || !T.points) return;
    const now = Date.now();
    if (now - S.pointAt < 60000) return;
    S.pointAt = now;
    T.points.push({ t: new Date(now).toISOString().slice(0, 16), sen_model: D.senate.summary.p_dem_control, hou_model: D.house.summary.p_dem_control,
      gov_model: D.governors.summary.p_dem_control, sen_poly: (D.senate.markets || {}).polymarket_dem, hou_poly: (D.house.markets || {}).polymarket_dem, client: true });
    if (T.points.length > 6000) T.points.splice(0, T.points.length - 6000);
  }

  async function pollMarkets(D) {
    try {
      const [sen, hou] = await Promise.all([fetch(PM + 'which-party-will-win-the-senate-in-2026').then((r) => r.json()), fetch(PM + 'which-party-will-win-the-house-in-2026').then((r) => r.json())]);
      const dem = (ev) => { const e = Array.isArray(ev) ? ev[0] : ev; for (const m of (e && e.markets) || []) { if (/democrat/i.test(m.question || '')) { const p = JSON.parse(m.outcomePrices || '[]'); if (p.length) return +(+p[0]).toFixed(3); } } return null; };
      const ds = dem(sen), dh = dem(hou);
      if (ds != null) { D.senate.markets = Object.assign({}, D.senate.markets, { polymarket_dem: ds }); }
      if (dh != null) { D.house.markets = Object.assign({}, D.house.markets, { polymarket_dem: dh }); }
      S.marketsAt = new Date().toISOString();
      return ds != null || dh != null;
    } catch (e) { return false; }
  }

  async function tick() {
    if (S.running) return; S.running = true;
    const app = S.app; const D = app.getD(), T = app.getT();
    if (!D) { S.running = false; return; }
    const now = Date.now();
    const live = S.force || D.phase === 'live' || (now >= LIVE_FROM && now < LIVE_UNTIL);
    let changed = false;
    try {
      if (live) {
        const jobs = [['SG', 'national-races/2026-SG.json'], ['GG', 'national-races/2026-GG.json']];
        if (now - S.lastHouse > 120000) { jobs.push(['HG', 'national-races/2026-HG.json']); S.lastHouse = now; }
        const res = await Promise.allSettled(jobs.map(([k, p]) => getJson(feedUrl(p), k)));
        res.forEach((r, i) => {
          const k = jobs[i][0];
          if (r.status === 'fulfilled') { if (r.value !== undefined) { S.feed[k] = indexCnn(r.value, k); S.feedAt = new Date().toISOString(); changed = true; } delete S.feedErr[k]; }
          else S.feedErr[k] = String(r.reason && r.reason.message || r.reason).slice(0, 80);
        });
        if (changed || (S.feed.SG || S.feed.GG || S.feed.HG)) { if (applyFeed(D)) { changed = true; appendPoint(D, T); } }
      }
      if (now - (S.marketsAt ? Date.parse(S.marketsAt) : 0) > 60000) { if (await pollMarkets(D)) changed = true; }
    } catch (e) { console.warn('live tick', e); }
    S.lastTick = Date.now();
    if (changed) app.render();
    else app.renderHeader();
    S.running = false;
  }

  function status() {
    const errs = Object.keys(S.feedErr);
    return { active: !!S.timer, feedAt: S.feedAt, marketsAt: S.marketsAt, errors: errs.length ? S.feedErr : null, source: S.feedBase ? 'rehearsal feed' : 'CNN/AP feed', force: S.force };
  }

  function start(app) {
    S.app = app;
    if (S.timer) clearInterval(S.timer);
    const D = app.getD();
    const now = Date.now();
    const live = S.force || (D && D.phase === 'live') || (now >= LIVE_FROM && now < LIVE_UNTIL);
    tick();
    S.timer = setInterval(tick, live ? 30000 : 60000);
    // when the day arrives while the page is open, switch to the faster cadence
    if (!live) { const ms = LIVE_FROM - now; if (ms > 0 && ms < 2147000000) setTimeout(() => start(app), ms + 1000); }
  }

  // After the server data is re-fetched, put the latest feed back on top of it.
  function reapply(D, T) { if (S.feed.SG || S.feed.GG || S.feed.HG) { if (applyFeed(D)) appendPoint(D, T); } }

  window.LiveClient = { start, reapply, status, tick, _state: S };
})();
