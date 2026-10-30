/* Midterms 2026 dashboard. Vanilla JS, no build step.
   Reads data/live.json (pipeline output), data/polls.json, data/timeseries.json and data/seed/history.json. */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  const ET = 'America/New_York';
  const STATE = { tz: (localStorage.getItem('tz') === 'local' && LOCAL_TZ !== ET) ? LOCAL_TZ : ET, senateFilter: 'comp', houseFilter: 'comp', govFilter: 'comp' };
  let D = null, P = null, H = null, T = null;
  const ELECTION = new Date('2026-11-03T23:00:00Z'); // first polls close 6pm ET

  const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'D.C.' };

  // ------------------------------------------------------------ formatting
  const pct = (p, d = 0) => (p == null || isNaN(p)) ? '–' : (p * 100).toFixed(d) + '%';
  const pctProb = (p) => {
    if (p == null) return '–';
    const v = p * 100;
    if (v >= 99) return '>99%';
    if (v <= 1) return '<1%';
    return Math.round(v) + '%';
  };
  const marginTxt = (m, d = 1, parties) => {
    if (m == null || isNaN(m)) return '–';
    const [a, b] = parties || ['D', 'R'];
    if (Math.abs(m) < 0.05) return 'Tied';
    return (m > 0 ? a : b) + '+' + Math.abs(m).toFixed(d);
  };
  const marginClass = (m, parties) => (m == null ? '' : m > 0 ? ((parties && parties[0] === 'I') ? 'i' : 'd') : 'r');
  const fmtNum = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  const fmtTime = (iso, opts) => {
    if (!iso) return '–';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-US', Object.assign({ timeZone: STATE.tz, hour: 'numeric', minute: '2-digit' }, opts || {}));
  };
  const fmtDateTime = (iso) => fmtTime(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tzAbbrev = (tz) => {
    if (tz === ET) return 'ET';
    try { const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName'); return part ? part.value : tz; } catch (e) { return tz; }
  };
  const tzShort = () => tzAbbrev(STATE.tz);
  const otherTz = () => (STATE.tz === ET ? LOCAL_TZ : ET);
  const ago = (iso) => {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return (s / 3600).toFixed(1) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };
  const partyName = (p) => ({ D: 'Democrat', R: 'Republican', I: 'Independent', O: 'Other' }[p] || p);
  const ratingLabel = (r) => {
    if (!r) return '';
    return String(r).replace(/[-_]/g, ' ').replace(/\b(dem|d)\b/i, 'D').replace(/\b(rep|r)\b/i, 'R')
      .replace(/\b\w/g, (c) => c.toUpperCase()).replace('Toss Up', 'Toss-up').replace('Tossup', 'Toss-up');
  };
  const ratingClass = (r) => {
    if (!r) return 't';
    const s = String(r).toLowerCase();
    if (s.includes('toss')) return 't';
    if (/dem|-d$|\bd\b/.test(s)) return 'd';
    if (/rep|-r$|\br\b/.test(s)) return 'r';
    return 't';
  };
  const stateName = (p) => STATES[p] || p;

  // ------------------------------------------------------------- data load
  async function fetchJson(path, optional) {
    try {
      const r = await fetch(path + '?t=' + Math.floor(Date.now() / 30000), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status + ' ' + path);
      return await r.json();
    } catch (e) {
      if (optional) return null;
      throw e;
    }
  }
  async function load(first) {
    const [live, polls, hist, ts] = await Promise.all([
      fetchJson('data/live.json'), fetchJson('data/polls_combined.json', true).then((x) => x || fetchJson('data/polls.json', true)),
      first ? fetchJson('data/seed/history.json', true) : Promise.resolve(H), fetchJson('data/timeseries.json', true)]);
    D = live; P = polls; H = hist; T = ts;
    render();
  }

  // --------------------------------------------------------------- charts
  function lineChart(opts) {
    // opts: series [{name, cls, points:[{x:Date|number,y}]}], yFmt, xFmt, height, zero, yDomain, band
    const W = 640, Hh = opts.height || 220, m = { t: 14, r: 16, b: 26, l: 40 };
    const all = opts.series.flatMap((s) => s.points).filter((p) => p.y != null && !isNaN(p.y));
    if (!all.length) return h('div', { class: 'muted' }, 'No data yet.');
    const xs = all.map((p) => +p.x), ys = all.map((p) => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    let y0 = opts.yDomain ? opts.yDomain[0] : Math.min(...ys), y1 = opts.yDomain ? opts.yDomain[1] : Math.max(...ys);
    if (!opts.yDomain) { const pad = (y1 - y0) * 0.15 || 1; y0 -= pad; y1 += pad; if (opts.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); } }
    const X = (x) => m.l + ((+x - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * (Hh - m.t - m.b);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    svg.setAttribute('role', 'img');
    const g = (cls) => { const e = document.createElementNS(ns, 'g'); if (cls) e.setAttribute('class', cls); svg.appendChild(e); return e; };
    const el = (tag, attrs, parent) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); (parent || svg).appendChild(e); return e; };
    const grid = g('grid'), axis = g('axis');
    const ticks = niceTicks(y0, y1, 5);
    for (const t of ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }, grid);
      const tx = el('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }, axis); tx.textContent = (opts.yFmt || ((v) => v))(t);
    }
    if (opts.zero && y0 < 0 && y1 > 0) el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) });
    const xt = opts.xTicks || timeTicks(x0, x1, 6);
    for (const t of xt) { const tx = el('text', { x: X(t), y: Hh - 8, 'text-anchor': 'middle' }, axis); tx.textContent = (opts.xFmt || ((v) => v))(t); }
    if (opts.band) { // [lo, hi] y band
      el('rect', { x: m.l, y: Y(opts.band[1]), width: W - m.l - m.r, height: Math.max(0, Y(opts.band[0]) - Y(opts.band[1])), fill: 'currentColor', opacity: 0.05 });
    }
    for (const s of opts.series) {
      const pts = s.points.filter((p) => p.y != null && !isNaN(p.y)).sort((a, b) => +a.x - +b.x);
      if (!pts.length) continue;
      if (s.area) {
        const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ') + ` L${X(pts[pts.length - 1].x).toFixed(1)} ${Y(opts.zero ? 0 : y0)} L${X(pts[0].x).toFixed(1)} ${Y(opts.zero ? 0 : y0)} Z`;
        el('path', { d, class: 'fill-' + s.cls, opacity: 0.1 });
      }
      if (s.dots) {
        for (const p of pts) el('circle', { cx: X(p.x), cy: Y(p.y), r: s.r || 3, class: 'fill-' + s.cls, opacity: s.opacity || 0.45 });
      } else {
        const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
        el('path', { d, class: 'line ' + s.cls });
        const last = pts[pts.length - 1];
        el('circle', { cx: X(last.x), cy: Y(last.y), r: 4, class: 'dot fill-' + s.cls });
        if (opts.endLabels !== false) {
          const t = el('text', { x: X(last.x) + 7, y: Y(last.y) + 4, class: 'lbl strong' });
          t.textContent = (opts.yFmt || ((v) => v))(last.y);
        }
      }
    }
    const wrap = h('div', { class: 'chart' }, svg);
    // hover crosshair + tooltip
    const lineSeries = opts.series.filter((s) => !s.dots);
    if (lineSeries.length) {
      const ch = el('line', { class: 'crosshair', y1: m.t, y2: Hh - m.b, x1: -10, x2: -10, opacity: 0 });
      const tip = $('#tip');
      const over = (ev) => {
        const r = svg.getBoundingClientRect();
        const px = ((ev.clientX - r.left) / r.width) * W;
        if (px < m.l || px > W - m.r) { ch.setAttribute('opacity', 0); tip.style.display = 'none'; return; }
        const xv = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
        const rows = [];
        let nearestX = null;
        for (const s of lineSeries) {
          const pts = s.points.filter((p) => p.y != null).sort((a, b) => +a.x - +b.x);
          if (!pts.length) continue;
          let best = pts[0];
          for (const p of pts) if (Math.abs(+p.x - xv) < Math.abs(+best.x - xv)) best = p;
          nearestX = nearestX == null ? +best.x : nearestX;
          rows.push(`${esc(s.name)}: <b>${esc((opts.yFmt || ((v) => v))(best.y))}</b>`);
        }
        if (nearestX == null) return;
        ch.setAttribute('x1', X(nearestX)); ch.setAttribute('x2', X(nearestX)); ch.setAttribute('opacity', 1);
        tip.innerHTML = `<div>${esc((opts.xFmt || ((v) => v))(nearestX, true))}</div>` + rows.join('<br>');
        tip.style.display = 'block';
        tip.style.left = (ev.pageX) + 'px'; tip.style.top = (ev.pageY) + 'px';
      };
      svg.addEventListener('mousemove', over);
      svg.addEventListener('touchmove', (e) => { if (e.touches[0]) over(e.touches[0]); }, { passive: true });
      svg.addEventListener('mouseleave', () => { ch.setAttribute('opacity', 0); tip.style.display = 'none'; });
    }
    if (opts.series.length >= 2 && opts.legend !== false) {
      wrap.append(h('div', { class: 'legend' }, opts.series.map((s) => h('span', null, h('i', { class: 'sw', style: `background:var(--${s.cls === 'neutral' ? 'neutral' : s.cls})` }), s.name))));
    }
    return wrap;
  }
  function niceTicks(a, b, n) {
    const span = b - a || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((s) => span / s <= n + 1) || mag * 10;
    const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  function timeTicks(x0, x1, n) {
    const out = [], step = (x1 - x0) / (n - 1);
    for (let i = 0; i < n; i++) out.push(x0 + step * i);
    return out;
  }
  const dateFmt = (v, long) => new Date(v).toLocaleDateString('en-US', long ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });

  function histogram(dist, toWin, cur, label) {
    // dist: {seats: prob}
    const entries = Object.entries(dist || {}).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]);
    if (!entries.length) return h('div', { class: 'muted' }, 'No distribution yet.');
    const W = 640, Hh = 150, m = { t: 10, r: 10, b: 28, l: 10 };
    let lo = entries[0][0], hi = entries[entries.length - 1][0];
    if (toWin != null) { lo = Math.min(lo, toWin - 2); hi = Math.max(hi, toWin + 2); }
    const n = hi - lo + 1, bw = (W - m.l - m.r) / n, maxp = Math.max(...entries.map((e) => e[1]));
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.appendChild(e); return e; };
    const map = Object.fromEntries(entries);
    const tip = $('#tip');
    for (let s = lo; s <= hi; s++) {
      const p = map[s] || 0, bh = (p / maxp) * (Hh - m.t - m.b);
      const x = m.l + (s - lo) * bw;
      const r = el('rect', { x: x + 1, y: Hh - m.b - bh, width: Math.max(1, bw - 2), height: bh, rx: 2, class: 'fill-' + (toWin != null ? (s >= toWin ? 'dem' : 'rep') : 'neutral'), opacity: 0.85 });
      r.addEventListener('mousemove', (ev) => { tip.innerHTML = `<b>${s}</b> Democratic seats<br>${(p * 100).toFixed(1)}% of simulations`; tip.style.display = 'block'; tip.style.left = ev.pageX + 'px'; tip.style.top = ev.pageY + 'px'; });
      r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    if (toWin != null) {
      const x = m.l + (toWin - lo) * bw;
      el('line', { x1: x, x2: x, y1: m.t, y2: Hh - m.b, class: 'zero', 'stroke-dasharray': '0' });
      const t = el('text', { x: x + 4, y: m.t + 10, class: 'lbl strong' }); t.textContent = `${toWin} for control`;
    }
    const step = n > 40 ? 10 : n > 20 ? 5 : n > 10 ? 2 : 1;
    for (let s = Math.ceil(lo / step) * step; s <= hi; s += step) {
      const t = el('text', { x: m.l + (s - lo + 0.5) * bw, y: Hh - 10, class: 'lbl', 'text-anchor': 'middle' }); t.textContent = s;
    }
    const wrap = h('div', { class: 'chart' }, svg);
    wrap.append(h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, label || 'Distribution of Democratic seats across 20,000 simulations.'));
    return wrap;
  }

  function barsChart(rows, opts) {
    // rows: [{label, value, cls, note}] horizontal bars around zero or from zero
    const vals = rows.map((r) => r.value).filter((v) => v != null);
    if (!vals.length) return h('div', { class: 'muted' }, 'No data.');
    const maxAbs = Math.max(...vals.map(Math.abs)) || 1;
    const zero = opts && opts.zero;
    const list = h('div', { class: 'cmp', style: 'grid-template-columns:auto 1fr auto' });
    for (const r of rows) {
      const v = r.value;
      const bar = h('div', { class: 'bar', style: 'height:10px' });
      if (v != null) {
        if (zero) {
          const w = (Math.abs(v) / maxAbs) * 50;
          bar.append(h('span', { class: v < 0 ? 'r' : '', style: `left:${v < 0 ? 50 - w : 50}%;width:${w}%;background:var(--${r.cls || (v < 0 ? 'rep' : 'dem')})` }));
          bar.append(h('span', { style: 'left:50%;width:1px;background:var(--ink-3)' }));
        } else {
          bar.append(h('span', { style: `width:${(v / maxAbs) * 100}%;background:var(--${r.cls || 'dem'})` }));
        }
      }
      list.append(h('div', { class: 'k' }, r.label), bar, h('div', { class: 'v num' }, (opts && opts.fmt ? opts.fmt(v) : v == null ? '–' : v)));
    }
    return list;
  }

  // ------------------------------------------------------- header / phase
  function renderHeader() {
    const phase = D.phase;
    const pill = $('#phasepill'), dot = $('#livedot');
    pill.className = 'pill'; dot.className = 'dot';
    const now = Date.now();
    if (phase === 'pre') {
      const days = Math.max(0, (ELECTION - now) / 86400000);
      pill.textContent = days >= 1 ? `${Math.ceil(days)} day${Math.ceil(days) === 1 ? '' : 's'} to polls closing` : `${Math.max(1, Math.round(days * 24))} hours to first polls closing`;
    } else if (phase === 'live') {
      pill.textContent = 'LIVE RESULTS'; pill.classList.add('live'); dot.classList.add('live');
    } else { pill.textContent = 'Final results'; }
    $('#updated').textContent = `Updated ${ago(D.generated_at)} · ${fmtDateTime(D.generated_at)} ${tzShort()}`;
    $('#tab-night').textContent = phase === 'pre' ? 'Election night guide' : 'Election night';
    $$('#tzseg button').forEach((b) => { b.classList.toggle('on', (b.dataset.tz === 'local') === (STATE.tz !== ET)); if (b.dataset.tz === 'local') { b.textContent = LOCAL_TZ === ET ? 'Local (ET)' : 'Local ' + tzAbbrev(LOCAL_TZ); } });
  }

  // --------------------------------------------------------- hero / summary
  function chamberCard(name, sum, extra) {
    if (!sum) return h('div', { class: 'card chamber' }, h('h3', null, name), h('div', { class: 'muted' }, 'No data'));
    const p = sum.p_dem_control;
    const favored = p >= 0.5 ? 'D' : 'R';
    const favP = p >= 0.5 ? p : 1 - p;
    const total = sum.total, toWinD = sum.to_win.D, toWinR = sum.to_win.R;
    const secD = sum.secured.D, secR = sum.secured.R, leadD = sum.leading.D, leadR = sum.leading.R;
    const expD = sum.expected.D, expR = sum.expected.R;
    const uncalledNoLead = total - secD - secR - leadD - leadR;
    const w = (n) => (100 * n / total).toFixed(2) + '%';
    const live = D.phase !== 'pre';
    const card = h('div', { class: 'card chamber' },
      h('div', { class: 'title' }, h('h3', null, name), extra && extra.badge),
      h('div', { class: 'hero-num' },
        h('span', { class: 'big', style: `color:var(--${favored === 'D' ? 'dem' : 'rep'})` }, pctProb(favP)),
        h('span', { class: 'lbl' }, `chance ${favored === 'D' ? 'Democrats' : 'Republicans'} ${extra && extra.verb || 'control'} ${extra && extra.object || 'the chamber'}`)),
      h('div', { class: 'hero-sub' }, live
        ? `${secD} D and ${secR} R secured · ${sum.uncalled} races uncalled · expected ${expD.toFixed(0)} D / ${expR.toFixed(0)} R`
        : `Expected ${expD.toFixed(0)} D / ${expR.toFixed(0)} R · 80% range ${sum.dem_80[0]} to ${sum.dem_80[1]} D seats`),
      (() => {
        // Before results: dark = seats not on the ballot, light = expected gains from the races being decided.
        const expGainD = live ? leadD : Math.max(0, Math.round(expD) - secD);
        const expGainR = live ? leadR : Math.max(0, Math.round(expR) - secR);
        const gap = Math.max(0, total - secD - secR - expGainD - expGainR);
        const bar = h('div', { class: 'seatbar' },
          h('div', { class: 'd', style: `width:${w(secD)}`, title: `${secD} Democratic seats ${live ? 'secured' : 'not on the ballot'}` }),
          h('div', { class: 'dl', style: `width:${w(expGainD)}`, title: live ? `${leadD} Democrats leading` : `${expGainD} expected Democratic wins` }),
          h('div', { class: 'u', style: `width:${w(gap)}` }),
          h('div', { class: 'rl', style: `width:${w(expGainR)}`, title: live ? `${leadR} Republicans leading` : `${expGainR} expected Republican wins` }),
          h('div', { class: 'r', style: `width:${w(secR)}`, title: `${secR} Republican seats ${live ? 'secured' : 'not on the ballot'}` }));
        if (toWinD) bar.append(h('div', { class: 'mark', style: `left:${w(toWinD)}`, 'data-l': toWinD }));
        if (toWinR && toWinR !== toWinD) bar.append(h('div', { class: 'mark', style: `left:${(100 - 100 * toWinR / total).toFixed(2)}%`, 'data-l': toWinR }));
        return bar;
      })(),
      h('div', { class: 'seatlabels' },
        h('span', null, h('b', { style: 'color:var(--dem)' }, live ? secD : Math.round(expD)), live ? (leadD ? ` +${leadD} leading` : '') : ' expected'),
        h('span', { class: 'mid' }, live ? `${sum.uncalled} to call` : `${total} seats`),
        h('span', null, live ? (leadR ? `${leadR} leading + ` : '') : 'expected ', h('b', { style: 'color:var(--rep)' }, live ? secR : Math.round(expR)))),
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'sw', style: 'background:var(--dem)' }), live ? 'D secured' : 'D not on ballot'), h('span', null, h('i', { class: 'sw', style: 'background:color-mix(in srgb, var(--dem) 45%, var(--surface))' }), live ? 'D leading' : 'D expected wins'), h('span', null, h('i', { class: 'sw', style: 'background:color-mix(in srgb, var(--rep) 45%, var(--surface))' }), live ? 'R leading' : 'R expected wins'), h('span', null, h('i', { class: 'sw', style: 'background:var(--rep)' }), live ? 'R secured' : 'R not on ballot')),
    );
    if (extra && extra.compare) card.append(extra.compare);
    return card;
  }

  function compareRows(rows) {
    // rows: [{k, v (0..1 dem prob), note}]
    const list = h('div', { class: 'cmp' });
    for (const r of rows) {
      if (r.v == null) continue;
      list.append(h('div', { class: 'k' }, r.k), h('div', { class: 'bar' }, h('span', { style: `width:${(r.v * 100).toFixed(1)}%` })), h('div', { class: 'v num' }, pctProb(r.v)));
    }
    return list;
  }

  function senateCompare() {
    const s = D.senate, f = s.forecasts || {}, mk = s.markets || {};
    const rows = [{ k: 'Our model', v: s.summary.p_dem_control }];
    const names = { ddhq: 'Decision Desk HQ', silver_bulletin: 'Silver Bulletin', racetothewh: 'Race to the WH', split_ticket: 'Split Ticket', economist: 'The Economist', poliwave: 'Poliwave', davemanuel: 'Dave Manuel', pollcheck: 'PollCheck', votescope: 'Vote-Scope', vote_scope: 'Vote-Scope', electindex: 'ElectIndex', kalshi: 'Kalshi', polymarket: 'Polymarket' };
    for (const [k, v] of Object.entries(f)) {
      const val = typeof v === 'object' && v ? v.dem_control : v;
      if (typeof val === 'number' && !['kalshi', 'polymarket'].includes(k)) rows.push({ k: names[k] || k, v: val });
    }
    if (mk.polymarket_dem != null) rows.push({ k: 'Polymarket (live)', v: mk.polymarket_dem }); else if (f.polymarket) rows.push({ k: 'Polymarket', v: typeof f.polymarket === 'object' ? f.polymarket.dem_control : f.polymarket });
    if (mk.kalshi_dem != null) rows.push({ k: 'Kalshi (live)', v: mk.kalshi_dem }); else if (f.kalshi) rows.push({ k: 'Kalshi', v: typeof f.kalshi === 'object' ? f.kalshi.dem_control : f.kalshi });
    return h('div', null, h('div', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, 'Chance of Democratic control, by source'), compareRows(rows));
  }
  function houseCompare() {
    const hs = D.house, mk = hs.markets || {};
    const rows = [{ k: 'Our model', v: hs.summary.p_dem_control }];
    for (const f of hs.forecasts || []) {
      if (f.dem_control != null && !/kalshi|polymarket/i.test(f.source)) rows.push({ k: f.source, v: f.dem_control });
    }
    const pf = (hs.forecasts || []).find((f) => /polymarket/i.test(f.source)), kf = (hs.forecasts || []).find((f) => /kalshi/i.test(f.source));
    if (mk.polymarket_dem != null) rows.push({ k: 'Polymarket (live)', v: mk.polymarket_dem }); else if (pf) rows.push({ k: 'Polymarket', v: pf.dem_control });
    if (mk.kalshi_dem != null) rows.push({ k: 'Kalshi (live)', v: mk.kalshi_dem }); else if (kf) rows.push({ k: 'Kalshi', v: kf.dem_control });
    return h('div', null, h('div', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, 'Chance of Democratic control, by source'), compareRows(rows));
  }

  function renderHero() {
    const hero = $('#hero'); hero.innerHTML = '';
    const sen = D.senate.summary, hou = D.house.summary, gov = D.governors.summary;
    hero.append(
      chamberCard('Senate', sen, { compare: senateCompare(), badge: h('span', { class: 'pill' }, `${sen.to_win.D} D or ${sen.to_win.R} R to control`) }),
      chamberCard('House', hou, { compare: houseCompare(), badge: h('span', { class: 'pill' }, '218 to control') }),
      chamberCard('Governors', gov, { verb: 'hold a majority of', object: 'governorships', badge: h('span', { class: 'pill' }, '36 races') }));
    const gb = D.house.generic_ballot_median;
    const sw = D.phase === 'pre' ? null : (D.senate.swing || {});
    const kp = $('#kpis'); kp.innerHTML = '';
    const tile = (k, v, s) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'ks s' }, s));
    const ourGb = P && P.generic_ballot && P.generic_ballot.avg ? P.generic_ballot.avg : null;
    kp.append(
      tile('Generic ballot', ourGb && ourGb.margin != null ? marginTxt(ourGb.margin) : gb != null ? marginTxt(gb) : '–', ourGb ? `our average of ${ourGb.n_polls} polls · aggregators: ${gb != null ? marginTxt(gb) : '–'}` : 'median of public averages'),
      tile('Senate seats expected', `${sen.expected.D.toFixed(0)} D · ${sen.expected.R.toFixed(0)} R`, `80% range ${sen.dem_80[0]}–${sen.dem_80[1]} D`),
      tile('House seats expected', `${hou.expected.D.toFixed(0)} D · ${hou.expected.R.toFixed(0)} R`, `80% range ${hou.dem_80[0]}–${hou.dem_80[1]} D`),
      D.phase === 'pre'
        ? tile('Likely flips', `${sen.likely_flips.length} Sen · ${hou.likely_flips.filter((f) => Math.abs(f.p - 0.5) > 0.1).length} House`, `${gov.likely_flips.length} governorships`)
        : tile('Results vs expectations', sw && sw.n ? (sw.swing > 0 ? 'D' : 'R') + ' +' + Math.abs(sw.swing).toFixed(1) : 'Waiting', sw && sw.n ? `median across ${sw.n} races mostly counted` : 'needs races with most votes in'));
    const b = $('#banner'); b.innerHTML = '';
    if (D.phase === 'live') {
      const nextClose = (D.poll_closing || []).map((c) => ({ ...c, t: new Date(c.close_utc) })).filter((c) => c.t > Date.now()).sort((a, b) => a.t - b.t);
      b.append(h('div', { class: 'banner', style: 'margin-bottom:12px' },
        h('b', null, 'Results are live. '),
        `Polls have closed in ${(D.poll_closing || []).length - nextClose.length} states. `,
        nextClose.length ? `Next closing: ${nextClose.slice(0, 4).map((c) => c.state).join(', ')} at ${fmtTime(nextClose[0].close_utc)} ${tzShort()}. ` : 'All polls have closed. ',
        'Our projection blends the count so far with pre-election expectations and updates every few minutes.'));
    }
  }

  // ---------------------------------------------------------- race cards
  function raceCard(r, kind) {
    const live = r.live || {}, proj = r.proj || {}, prior = r.prior || {};
    const indMain = r.main_challenger === 'I' || (!r.dem && r.other && r.other.length);
    const parties = indMain ? ['I', 'R'] : ['D', 'R'];
    const p = proj.p_live != null ? proj.p_live : prior.p_dem;
    const favD = p >= 0.5;
    const probCls = favD ? (indMain ? 'i' : 'd') : 'r';
    const favName = favD ? (r.dem || (r.other && r.other[0] && r.other[0].name) || 'Dem') : (r.rep || 'Rep');
    const base = (r.state || stateName(r.postal)).replace(/\s*\(special\)\s*/i, '');
    const stLabel = `${base}${r.special ? ' (special)' : ''}`;
    const inc = r.incumbent ? `${r.incumbent} (${r.incumbent_party || '?'})${r.incumbent_running === false || r.open ? ', open seat' : ''}` : (r.open ? 'Open seat' : '');
    const tags = [];
    const rt = r.ratings || {};
    for (const [k, lab] of [['cook', 'Cook'], ['sabato', 'Sabato'], ['inside', 'Inside'], ['nyt', 'NYT']]) if (rt[k]) tags.push(h('span', { class: 'tag ' + ratingClass(rt[k]) }, `${lab}: ${ratingLabel(rt[k])}`));
    if (r.poll_avg && r.poll_avg.margin != null) tags.push(h('span', { class: 'tag' }, `Polls ${marginTxt(r.poll_avg.margin, 1, parties)}${r.poll_avg.n_polls ? ` (${r.poll_avg.n_polls})` : ''}`));
    if (r.market) {
      const mv = [r.market.polymarket_dem, r.market.kalshi_dem].filter((x) => x != null);
      if (mv.length) tags.push(h('span', { class: 'tag' }, `Markets ${pctProb(mv.reduce((a, b) => a + b, 0) / mv.length)} ${indMain ? 'I' : 'D'}`));
    }
    if (isFlip(r)) tags.unshift(h('span', { class: 'tag flip' }, `FLIP ${r.incumbent_party} → ${favD ? (indMain ? 'I' : 'D') : 'R'}`));
    let callTag = null;
    if (live.call === 'called' && live.winner) callTag = h('span', { class: 'tag called' }, `✓ ${live.winner} (${live.winner_party})`);
    else if (live.call === 'runoff') callTag = h('span', { class: 'tag called' }, 'Runoff');
    else if (live.eevp > 0) callTag = h('span', { class: 'tag ' + marginClass(live.margin) }, `${live.eevp}% in · ${marginTxt(live.margin, 1)}`);
    const card = h('div', { class: 'race', id: `race-${kind}-${r.postal}${r.special ? '-S' : ''}`, onclick: (e) => { if (e.target.closest('a')) return; card.classList.toggle('open'); } },
      h('div', { class: 'who' }, h('span', { class: 'st' }, stLabel), callTag,
        h('div', { class: 'cands', style: 'flex-basis:100%' },
          r.dem ? h('b', { style: 'color:var(--dem)' }, r.dem) : null, r.dem ? ' (D) vs ' : '',
          r.rep ? h('b', { style: 'color:var(--rep)' }, r.rep) : null, r.rep ? ' (R)' : '',
          (r.other || []).filter((o) => o && o.name).slice(0, 2).map((o) => h('span', null, ' · ', h('b', { style: 'color:var(--ind)' }, o.name), ` (${o.party || 'I'})`))),
        h('div', { class: 'tags', style: 'flex-basis:100%' }, tags)),
      h('div', { class: 'prob' },
        h('div', { class: 'p ' + probCls }, pctProb(favD ? p : 1 - p)),
        h('div', { class: 'm' }, `${favName.split(' ').slice(-1)[0]} · ${marginTxt(proj.margin_live != null ? proj.margin_live : prior.margin, 1, parties)}`)),
      h('div', { class: 'probbar' }, h('span', { class: indMain ? 'i' : 'd', style: `width:${(p * 100).toFixed(1)}%` }), h('span', { class: 'r', style: `width:${((1 - p) * 100).toFixed(1)}%` }), h('span', { class: 'mid' })),
      raceDetail(r, kind, parties));
    return card;
  }

  function raceDetail(r, kind, parties) {
    const live = r.live || {}, proj = r.proj || {}, prior = r.prior || {};
    const box = h('div', { class: 'full' });
    if (live.cands && live.cands.length && live.votes) {
      const lead = live.cands[0];
      box.append(h('div', { class: 'livebox' }, live.cands.slice(0, 4).map((c) => h('div', { class: 'c' + (c === lead ? ' lead' : '') },
        h('span', null, h('b', { style: `color:var(--${c.party === 'D' ? 'dem' : c.party === 'R' ? 'rep' : 'ind'})` }, c.name), ` (${c.party})${c.inc ? ' inc.' : ''}`),
        h('span', { class: 'num' }, `${c.pct != null ? c.pct.toFixed(1) + '%' : ''} · ${fmtNum(c.votes)}`)))));
      box.append(h('div', { class: 'muted', style: 'font-size:12px' }, `${live.eevp}% of expected vote in · ${fmtNum(live.votes)} of ~${fmtNum(live.expected)} votes · ${live.precincts ? live.precincts[0] + '/' + live.precincts[1] + ' precincts' : ''} · updated ${fmtTime(live.updated)} ${tzShort()}`));
    } else if (D.phase !== 'pre') {
      box.append(h('div', { class: 'muted' }, 'No votes reported yet.'));
    }
    const kv = h('div', { class: 'kv' });
    const row = (k, v) => { if (v != null && v !== '') kv.append(h('div', { class: 'k' }, k), h('div', null, v)); };
    row('Incumbent', r.incumbent ? `${r.incumbent} (${r.incumbent_party})${r.incumbent_running === false ? ', not running' : ''}` : r.open ? 'Open seat' : null);
    row('Our pre-election margin', `${marginTxt(prior.margin, 1, parties)} · σ ${prior.sigma} · based on ${prior.basis || '–'}`);
    if (proj.margin_live != null && proj.state !== 'pre') row('Live-adjusted margin', `${marginTxt(proj.margin_live, 1, parties)} (${proj.state})`);
    if (r.poll_avg) row('Polling average', `${marginTxt(r.poll_avg.margin, 1, parties)}${r.poll_avg.dem != null ? ` (${r.poll_avg.dem}–${r.poll_avg.rep})` : ''}${r.poll_avg.source ? ' · ' + r.poll_avg.source : ''}${r.poll_avg.as_of ? ' · ' + r.poll_avg.as_of : ''}`);
    const fc = r.forecast || {};
    const fcParts = Object.entries(fc).filter(([k, v]) => typeof v === 'number').map(([k, v]) => `${k.replace(/_dem_win|_win/g, '').replace(/_/g, ' ')} ${pctProb(v)}`);
    if (fcParts.length) row('Model probabilities (D)', fcParts.join(' · '));
    if (r.market) row('Markets (D)', [r.market.polymarket_dem != null ? `Polymarket ${pctProb(r.market.polymarket_dem)}` : null, r.market.kalshi_dem != null ? `Kalshi ${pctProb(r.market.kalshi_dem)}` : null].filter(Boolean).join(' · '));
    const rt = r.ratings || {};
    const extra = Object.entries(rt).filter(([k]) => !['cook', 'sabato', 'inside', 'nyt', 'ratings_as_of'].includes(k) && typeof rt[k] === 'string').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${ratingLabel(v)}`);
    if (extra.length) row('Other ratings', extra.join(' · '));
    if (r.prev) row('Last result', `${r.prev.year || ''} ${marginTxt(r.prev.margin_dem, 1)}${r.prev.note ? ' · ' + r.prev.note : ''}`);
    if (live.hist && live.hist.pres_2024_margin_dem != null) row('2024 presidential', marginTxt(live.hist.pres_2024_margin_dem, 1));
    if (r.pvi) row('Cook PVI', r.pvi);
    box.append(kv);
    if (r.notes) box.append(h('p', { class: 'muted', style: 'font-size:13px' }, r.notes));
    // Individual polls from our collector
    const pollsFor = P && (kind === 'senate' ? P.senate : kind === 'gov' ? P.governors : null);
    const pp = pollsFor && pollsFor[r.postal];
    if (pp && pp.polls && pp.polls.length) {
      const cands = pp.candidates || [];
      const det = h('details', null, h('summary', null, `${pp.polls.length} individual polls (our average ${pp.avg && pp.avg.margin != null ? marginTxt(pp.avg.margin, 1, parties) : '–'})`));
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Pollster'), h('th', null, 'Dates'), h('th', { class: 'r' }, 'n'), ...cands.slice(0, 4).map((c) => h('th', { class: 'r' }, `${(c.name || '').split(' ').slice(-1)[0]} (${c.party})`)), h('th', { class: 'r' }, 'Margin'))));
      const tb = h('tbody');
      for (const q of pp.polls.slice(0, 40)) {
        const vals = cands.slice(0, 4).map((c) => (q.results && q.results[c.name] != null) ? q.results[c.name] : (c.party === 'D' ? q.dem : c.party === 'R' ? q.rep : q.ind));
        const mg = q.margin != null ? q.margin : (q.dem != null && q.rep != null ? q.dem - q.rep : null);
        tb.append(h('tr', null, h('td', null, q.url ? h('a', { href: q.url, target: '_blank', rel: 'noopener' }, q.pollster) : q.pollster, q.sponsor ? h('span', { class: 'muted' }, ` / ${q.sponsor}`) : ''), h('td', null, `${q.start || ''}${q.end ? ' – ' + q.end : ''}`), h('td', { class: 'r' }, q.n ? `${fmtNum(q.n)} ${q.pop || ''}` : '–'), ...vals.map((v) => h('td', { class: 'r' }, v == null ? '–' : v)), h('td', { class: 'r' }, h('span', { class: marginClass(mg, parties) === 'r' ? 'rp' : marginClass(mg, parties) === 'i' ? 'ip' : 'd' }, marginTxt(mg, 1, parties)))));
      }
      tbl.append(tb);
      det.append(h('div', { class: 'tablewrap', style: 'margin-top:6px' }, tbl));
      if (pp.trend && pp.trend.length > 2) det.append(h('div', { style: 'margin-top:8px' }, lineChart({ height: 160, zero: true, yFmt: (v) => marginTxt(v, 0, parties), xFmt: dateFmt, series: [{ name: 'Weekly poll average', cls: 'dem', points: pp.trend.map((t) => ({ x: new Date(t.week), y: t.margin })) }, { name: 'Individual polls', cls: 'neutral', dots: true, points: pp.polls.filter((q) => q.end).map((q) => ({ x: new Date(q.end), y: q.margin != null ? q.margin : (q.dem != null && q.rep != null ? q.dem - q.rep : null) })) }] })));
      box.append(det);
    }
    if (live.url) box.append(h('div', { style: 'margin-top:6px;font-size:12px' }, h('a', { href: live.url, target: '_blank', rel: 'noopener' }, 'NYT results page ↗')));
    return box;
  }

  function isCompetitive(r) {
    const p = (r.proj && r.proj.p_live != null) ? r.proj.p_live : (r.prior ? r.prior.p_dem : 0.5);
    const rt = r.ratings || {};
    const ratedComp = Object.values(rt).some((v) => typeof v === 'string' && /toss|lean|tilt/i.test(v));
    return (p > 0.08 && p < 0.92) || ratedComp || (r.live && r.live.call !== 'called' && r.live.eevp > 0 && Math.abs(r.live.margin || 0) < 6);
  }
  function isFlip(r) {
    const p = (r.proj && r.proj.p_live != null) ? r.proj.p_live : (r.prior ? r.prior.p_dem : 0.5);
    return (r.incumbent_party === 'D' && p < 0.5) || (r.incumbent_party === 'R' && p >= 0.5);
  }

  function renderSenate() {
    const s = D.senate, sum = s.summary;
    $('#senate-sub').textContent = `${sum.to_win.D} seats for Democratic control, ${sum.to_win.R} for Republican (the vice-president breaks ties). ${sum.not_up.D} D and ${sum.not_up.R} R seats are not on the ballot.`;
    const top = $('#senate-top'); top.innerHTML = '';
    top.append(
      h('div', { class: 'card' }, h('h3', null, 'Seat distribution'), h('div', { class: 'muted', style: 'font-size:13px;margin-bottom:6px' }, `Our model: ${pctProb(sum.p_dem_control)} Democratic control · expected ${sum.expected.D.toFixed(1)} D seats`), histogram(sum.dist, sum.to_win.D)),
      h('div', { class: 'card' }, h('h3', null, 'Who is likely to flip a seat'), flipsList(s.races, 'senate')));
    const list = $('#senate-races'); list.innerHTML = '';
    const q = ($('#senate-q').value || '').toLowerCase();
    let races = s.races.slice();
    if (STATE.senateFilter === 'comp') races = races.filter(isCompetitive);
    if (STATE.senateFilter === 'flip') races = races.filter(isFlip);
    if (q) races = races.filter((r) => `${r.state} ${r.postal} ${r.dem} ${r.rep} ${(r.other || []).map((o) => o.name).join(' ')}`.toLowerCase().includes(q));
    if (!races.length) list.append(h('div', { class: 'muted' }, 'Nothing matches.'));
    for (const r of races) list.append(raceCard(r, 'senate'));
  }

  function flipsList(races, kind) {
    const flips = races.filter(isFlip).sort((a, b) => Math.abs(((b.proj || {}).p_live ?? b.prior.p_dem) - 0.5) - Math.abs(((a.proj || {}).p_live ?? a.prior.p_dem) - 0.5));
    if (!flips.length) return h('div', { class: 'muted' }, 'No seat is currently expected to change hands.');
    const list = h('div', { class: 'cmp' });
    for (const r of flips.slice(0, 14)) {
      const p = (r.proj || {}).p_live ?? r.prior.p_dem;
      const toD = p >= 0.5;
      const conf = toD ? p : 1 - p;
      list.append(h('div', { class: 'k' }, `${r.postal || r.id}${r.special ? '*' : ''} ${r.incumbent_party} → ${toD ? 'D' : 'R'}`), h('div', { class: 'bar' }, h('span', { class: toD ? '' : 'r', style: `width:${conf * 100}%` })), h('div', { class: 'v num' }, pctProb(conf)));
    }
    return list;
  }

  function renderGovernors() {
    const g = D.governors, sum = g.summary;
    $('#gov-sub').textContent = `36 governorships on the ballot. Republicans hold ${g.current && g.current.R || 27} governorships and Democrats ${g.current && g.current.D || 23} nationally.`;
    const top = $('#gov-top'); top.innerHTML = '';
    top.append(
      h('div', { class: 'card' }, h('h3', null, 'Expected governorships after the election'), h('div', { class: 'hero-num' }, h('span', { class: 'big', style: 'color:var(--dem)' }, sum.expected.D.toFixed(0)), h('span', { class: 'lbl' }, 'Democratic governors expected (of 50)'), h('span', { class: 'big', style: 'color:var(--rep);margin-left:auto' }, sum.expected.R.toFixed(0))), h('div', { class: 'muted', style: 'font-size:13px' }, `80% range ${sum.dem_80[0]} to ${sum.dem_80[1]} Democratic governors. ${pctProb(sum.p_dem_control)} chance Democrats hold 26 or more.`)),
      h('div', { class: 'card' }, h('h3', null, 'Likely flips'), flipsList(g.races, 'gov')));
    const list = $('#gov-races'); list.innerHTML = '';
    let races = g.races.slice();
    if (STATE.govFilter === 'comp') races = races.filter(isCompetitive);
    for (const r of races) list.append(raceCard(r, 'gov'));
  }

  // ---------------------------------------------------------------- house
  function renderHouse() {
    const hs = D.house, sum = hs.summary;
    const cur = hs.current || {};
    $('#house-sub').textContent = `218 seats for a majority. Current House: ${cur.R || '?'} R, ${cur.D || '?'} D${cur.vacant ? `, ${cur.vacant} vacant` : ''}.`;
    const top = $('#house-top'); top.innerHTML = '';
    const gbSeries = [];
    const ourGb = P && P.generic_ballot;
    if (ourGb && ourGb.trend && ourGb.trend.length) gbSeries.push({ name: 'Our poll average', cls: 'dem', points: ourGb.trend.map((t) => ({ x: new Date(t.week), y: t.margin })) });
    if (ourGb && ourGb.polls) gbSeries.push({ name: 'Individual polls', cls: 'neutral', dots: true, opacity: 0.35, points: ourGb.polls.filter((q) => q.end && q.dem != null && q.rep != null).map((q) => ({ x: new Date(q.end), y: q.dem - q.rep })) });
    if (!gbSeries.length && hs.generic_ballot_history && hs.generic_ballot_history.length) gbSeries.push({ name: 'Published averages', cls: 'dem', points: hs.generic_ballot_history.map((t) => ({ x: new Date(t.date), y: t.margin })) });
    top.append(
      h('div', { class: 'card' }, h('h3', null, 'Generic ballot'), h('div', { class: 'muted', style: 'font-size:13px;margin-bottom:6px' }, 'Which party voters say they will back for Congress, Democratic lead in points'),
        gbSeries.length ? lineChart({ height: 200, zero: true, yFmt: (v) => marginTxt(v, 0), xFmt: dateFmt, series: gbSeries }) : h('div', { class: 'muted' }, 'No trend data yet.'),
        h('div', { class: 'tablewrap', style: 'margin-top:10px' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Average'), h('th', { class: 'r' }, 'D'), h('th', { class: 'r' }, 'R'), h('th', { class: 'r' }, 'Margin'), h('th', null, 'As of'))),
          h('tbody', null,
            ourGb && ourGb.avg && ourGb.avg.margin != null ? h('tr', null, h('td', null, h('b', null, 'Our average'), h('span', { class: 'muted' }, ` (${ourGb.avg.n_polls} polls)`)), h('td', { class: 'r' }, ourGb.avg.dem), h('td', { class: 'r' }, ourGb.avg.rep), h('td', { class: 'r' }, h('span', { class: ourGb.avg.margin >= 0 ? 'd' : 'rp' }, marginTxt(ourGb.avg.margin))), h('td', null, (P.generated_at || '').slice(0, 10))) : null,
            (hs.generic_ballot || []).map((g) => h('tr', null, h('td', null, g.url ? h('a', { href: g.url, target: '_blank', rel: 'noopener' }, g.source) : g.source, g.live ? h('span', { class: 'tag', style: 'margin-left:6px' }, 'live') : ''), h('td', { class: 'r' }, g.dem ?? '–'), h('td', { class: 'r' }, g.rep ?? '–'), h('td', { class: 'r' }, h('span', { class: g.margin >= 0 ? 'd' : 'rp' }, marginTxt(g.margin))), h('td', null, g.as_of || ''))))))),
      h('div', { class: 'card' }, h('h3', null, 'Seat distribution'), h('div', { class: 'muted', style: 'font-size:13px;margin-bottom:6px' }, `Our model: ${pctProb(sum.p_dem_control)} Democratic majority · expected ${sum.expected.D.toFixed(0)} D seats · 80% range ${sum.dem_80[0]} to ${sum.dem_80[1]}`), histogram(sum.dist, 218),
        hs.ratings_summary ? ratingsTable(hs.ratings_summary) : null));
    const mid = $('#house-mid'); mid.innerHTML = '';
    if (hs.redistricting_notes) mid.append(h('div', { class: 'card' }, h('h3', null, 'Redistricting'), h('p', { class: 'muted', style: 'font-size:13px;margin-top:6px' }, hs.redistricting_notes)));
    mid.append(h('div', { class: 'card' }, h('h3', null, 'Likely flips'), flipsList(hs.districts.filter((d) => d.incumbent_party), 'house')));
    // table
    const wrap = $('#house-table'); wrap.innerHTML = '';
    const q = ($('#house-q').value || '').toLowerCase();
    let rows = hs.districts.slice();
    if (STATE.houseFilter === 'comp') rows = rows.filter((d) => d.competitive || (d.prior.p_dem > 0.1 && d.prior.p_dem < 0.9));
    if (STATE.houseFilter === 'flip') rows = rows.filter(isFlip);
    if (STATE.houseFilter === 'called') rows = rows.filter((d) => d.live && d.live.call === 'called');
    if (q) rows = rows.filter((d) => `${d.id} ${stateName(d.state)} ${d.dem} ${d.rep} ${d.incumbent}`.toLowerCase().includes(q));
    const live = D.phase !== 'pre';
    const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'District'), h('th', null, 'Candidates'), h('th', null, 'Ratings'), h('th', { class: 'r' }, 'PVI'), h('th', { class: 'r' }, '2024'), h('th', { class: 'r' }, 'Our D win'), live ? h('th', { class: 'r' }, 'In') : null, live ? h('th', { class: 'r' }, 'Margin') : null, live ? h('th', null, 'Status') : null)));
    const tb = h('tbody');
    for (const d of rows.slice(0, 450)) {
      const p = (d.proj && d.proj.p_live != null) ? d.proj.p_live : d.prior.p_dem;
      const rt = d.ratings || {};
      const l = d.live || {};
      tb.append(h('tr', null,
        h('td', null, h('b', null, d.id), isFlip(d) ? h('span', { class: 'tag flip', style: 'margin-left:6px' }, 'FLIP') : null, d.incumbent ? h('div', { class: 'muted', style: 'font-size:11px' }, `${d.incumbent} (${d.incumbent_party})`) : (d.incumbent_party ? h('div', { class: 'muted', style: 'font-size:11px' }, `${d.incumbent_party}-held`) : null)),
        h('td', null, d.dem ? h('span', { class: 'd' }, d.dem) : '', d.dem && d.rep ? ' v ' : '', d.rep ? h('span', { class: 'rp' }, d.rep) : ''),
        h('td', null, ['cook', 'sabato', 'inside', 'nyt'].filter((k) => rt[k]).map((k) => h('span', { class: 'tag ' + ratingClass(rt[k]), style: 'margin-right:3px' }, `${k === 'nyt' ? 'NYT' : k[0].toUpperCase() + k.slice(1)} ${ratingLabel(rt[k])}`))),
        h('td', { class: 'r' }, d.pvi || '–'),
        h('td', { class: 'r' }, d.prev_margin_2024 != null ? marginTxt(d.prev_margin_2024, 1) : (l.hist && l.hist.pres_2024_margin_dem != null ? h('span', { class: 'muted', title: '2024 presidential margin' }, marginTxt(l.hist.pres_2024_margin_dem, 1)) : '–')),
        h('td', { class: 'r' }, h('span', { class: p >= 0.5 ? 'd' : 'rp' }, pctProb(p))),
        live ? h('td', { class: 'r' }, l.eevp ? l.eevp + '%' : '–') : null,
        live ? h('td', { class: 'r' }, l.margin != null && l.eevp ? h('span', { class: l.margin >= 0 ? 'd' : 'rp' }, marginTxt(l.margin, 1)) : '–') : null,
        live ? h('td', null, l.call === 'called' ? h('span', { class: 'tag called' }, `✓ ${l.winner || l.winner_party}`) : l.call === 'runoff' ? 'Runoff' : l.eevp ? 'Counting' : 'Waiting') : null));
    }
    tbl.append(tb);
    wrap.append(tbl);
    if (!rows.length) wrap.append(h('div', { class: 'muted', style: 'padding:12px' }, 'Nothing matches.'));
  }

  function ratingsTable(rs) {
    const order = ['solid_d', 'likely_d', 'lean_d', 'tossup', 'lean_r', 'likely_r', 'solid_r'];
    const lab = { solid_d: 'Solid D', likely_d: 'Likely D', lean_d: 'Lean D', tossup: 'Toss-up', lean_r: 'Lean R', likely_r: 'Likely R', solid_r: 'Solid R' };
    const tbl = h('table', { style: 'margin-top:10px' }, h('thead', null, h('tr', null, h('th', null, 'Ratings'), ...order.map((k) => h('th', { class: 'r' }, lab[k])))));
    const tb = h('tbody');
    for (const [src, v] of Object.entries(rs)) {
      if (!v || typeof v !== 'object') continue;
      tb.append(h('tr', null, h('td', null, src[0].toUpperCase() + src.slice(1)), ...order.map((k) => h('td', { class: 'r' }, v[k] ?? '–'))));
    }
    tbl.append(tb);
    return h('div', { class: 'tablewrap' }, tbl);
  }

  // ---------------------------------------------------------------- polls
  function renderPolls() {
    const body = $('#polls-body'); body.innerHTML = '';
    if (!P) { body.append(h('div', { class: 'note' }, 'The poll collector has not produced data yet.')); return; }
    $('#polls-sub').textContent = `Every individual general-election poll we can find, aggregated by us. ${Object.keys(P.senate || {}).length} Senate and ${Object.keys(P.governors || {}).length} governor races. Updated ${ago(P.generated_at)}.`;
    const gb = P.generic_ballot || {};
    const grid = h('div', { class: 'grid two' });
    if (gb.polls && gb.polls.length) {
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Pollster'), h('th', null, 'Dates'), h('th', { class: 'r' }, 'n'), h('th', { class: 'r' }, 'D'), h('th', { class: 'r' }, 'R'), h('th', { class: 'r' }, 'Margin'))));
      const tb = h('tbody');
      for (const q of gb.polls.slice(0, 60)) tb.append(h('tr', null, h('td', null, q.pollster, q.sponsor ? h('span', { class: 'muted' }, ` / ${q.sponsor}`) : ''), h('td', null, `${q.start || ''}${q.end ? ' – ' + q.end : ''}`), h('td', { class: 'r' }, q.n ? `${fmtNum(q.n)} ${q.pop || ''}` : '–'), h('td', { class: 'r' }, q.dem ?? '–'), h('td', { class: 'r' }, q.rep ?? '–'), h('td', { class: 'r' }, h('span', { class: (q.dem - q.rep) >= 0 ? 'd' : 'rp' }, marginTxt(q.dem != null && q.rep != null ? q.dem - q.rep : null)))));
      tbl.append(tb);
      grid.append(h('div', { class: 'card' }, h('h3', null, `Generic ballot, latest ${Math.min(60, gb.polls.length)} of ${gb.polls.length} polls`), h('div', { class: 'tablewrap', style: 'margin-top:8px;max-height:520px;overflow:auto' }, tbl)));
    }
    // Competitive race poll averages table
    const rows = [];
    for (const [kind, obj] of [['Senate', P.senate || {}], ['Governor', P.governors || {}]]) {
      for (const [st, r] of Object.entries(obj)) {
        if (!r.avg || r.avg.margin == null) continue;
        rows.push({ kind, st, r });
      }
    }
    rows.sort((a, b) => Math.abs(a.r.avg.margin) - Math.abs(b.r.avg.margin));
    const tbl2 = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Race'), h('th', { class: 'r' }, 'Polls'), h('th', { class: 'r' }, 'Window'), h('th', { class: 'r' }, 'Lead'), h('th', { class: 'r' }, 'Our avg'), h('th', { class: 'r' }, 'Trend 4 wks'))));
    const tb2 = h('tbody');
    for (const x of rows) {
      const a = x.r.avg, parties = a.main_challenger === 'I' ? ['I', 'R'] : ['D', 'R'];
      const tr = x.r.trend || [];
      const prev = tr.length >= 5 ? tr[tr.length - 5].margin : null;
      const delta = prev != null && tr.length ? tr[tr.length - 1].margin - prev : null;
      tb2.append(h('tr', null, h('td', null, h('b', null, `${x.st}`), ` ${x.kind}${x.r.special ? ' (special)' : ''}`), h('td', { class: 'r' }, a.n_polls), h('td', { class: 'r' }, a.window_days ? a.window_days + 'd' : '–'),
        h('td', { class: 'r' }, a.margin >= 0 ? (parties[0] === 'I' ? h('span', { class: 'ip' }, 'I') : h('span', { class: 'd' }, 'D')) : h('span', { class: 'rp' }, 'R')),
        h('td', { class: 'r' }, h('span', { class: marginClass(a.margin, parties) === 'r' ? 'rp' : marginClass(a.margin, parties) === 'i' ? 'ip' : 'd' }, marginTxt(a.margin, 1, parties))),
        h('td', { class: 'r' }, delta == null ? '–' : (delta > 0 ? '▲ ' : delta < 0 ? '▼ ' : '') + marginTxt(delta, 1, parties))));
    }
    tbl2.append(tb2);
    grid.append(h('div', { class: 'card' }, h('h3', null, 'State race averages, closest first'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Recency and sample weighted average of polls from the last three weeks. Open a race in the Senate or Governors section to see every poll.'), h('div', { class: 'tablewrap', style: 'max-height:520px;overflow:auto' }, tbl2)));
    body.append(grid);
  }

  // ---------------------------------------------------------- models/mkts
  function renderModels() {
    const body = $('#models-body'); body.innerHTML = '';
    const grid = h('div', { class: 'grid two' });
    // Senate table of toplines
    const s = D.senate, hs = D.house;
    const names = { ddhq: 'Decision Desk HQ', silver_bulletin: 'Silver Bulletin', racetothewh: 'Race to the WH', split_ticket: 'Split Ticket', economist: 'The Economist', poliwave: 'Poliwave', davemanuel: 'Dave Manuel', pollcheck: 'PollCheck', votescope: 'Vote-Scope', vote_scope: 'Vote-Scope', electindex: 'ElectIndex', kalshi: 'Kalshi', polymarket: 'Polymarket' };
    const senRows = [{ source: 'Our model', dem_control: s.summary.p_dem_control, dem_seats_median: s.summary.expected.D, as_of: D.generated_at.slice(0, 10), url: '#method' }];
    for (const [k, v] of Object.entries(s.forecasts || {})) {
      if (v == null) continue;
      const o = typeof v === 'object' ? v : { dem_control: v };
      senRows.push({ source: names[k] || k, ...o });
    }
    if (s.markets && s.markets.polymarket_dem != null) senRows.push({ source: 'Polymarket (live)', dem_control: s.markets.polymarket_dem, as_of: D.generated_at.slice(0, 10), url: 'https://polymarket.com/event/which-party-will-win-the-senate-in-2026' });
    if (s.markets && s.markets.kalshi_dem != null) senRows.push({ source: 'Kalshi (live)', dem_control: s.markets.kalshi_dem, as_of: D.generated_at.slice(0, 10) });
    const houRows = [{ source: 'Our model', dem_control: hs.summary.p_dem_control, dem_seats_median: hs.summary.expected.D, as_of: D.generated_at.slice(0, 10) }, ...(hs.forecasts || [])];
    if (hs.markets && hs.markets.polymarket_dem != null) houRows.push({ source: 'Polymarket (live)', dem_control: hs.markets.polymarket_dem, as_of: D.generated_at.slice(0, 10), url: 'https://polymarket.com/event/which-party-will-win-the-house-in-2026' });
    if (hs.markets && hs.markets.kalshi_dem != null) houRows.push({ source: 'Kalshi (live)', dem_control: hs.markets.kalshi_dem, as_of: D.generated_at.slice(0, 10) });
    const mkTable = (rows, seatLabel) => {
      // Drop the seed snapshot of a market when a live reading exists.
      for (const m of ['Polymarket', 'Kalshi']) if (rows.some((r) => r.source === m + ' (live)')) rows = rows.filter((r) => r.source !== m);
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Source'), h('th', { class: 'r' }, 'D control'), h('th', { class: 'r' }, seatLabel), h('th', null, 'As of'))));
      const tb = h('tbody');
      for (const r of rows.filter((r) => r.dem_control != null).sort((a, b) => b.dem_control - a.dem_control)) tb.append(h('tr', null, h('td', null, r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.source) : r.source), h('td', { class: 'r' }, h('span', { class: r.dem_control >= 0.5 ? 'd' : 'rp' }, pctProb(r.dem_control))), h('td', { class: 'r' }, r.dem_seats_median != null ? Number(r.dem_seats_median).toFixed(0) : '–'), h('td', null, r.as_of || '')));
      tbl.append(tb);
      return h('div', { class: 'tablewrap' }, tbl);
    };
    grid.append(h('div', { class: 'card' }, h('h3', null, 'Senate control'), mkTable(senRows, 'D seats')), h('div', { class: 'card' }, h('h3', null, 'House control'), mkTable(houRows, 'D seats')));
    // Market and model time series
    if (T && T.points && T.points.length > 1) {
      const pts = T.points;
      const ser = (key, name, cls) => ({ name, cls, points: pts.filter((p) => p[key] != null).map((p) => ({ x: new Date(p.t), y: p[key] })) });
      grid.append(h('div', { class: 'card' }, h('h3', null, 'Senate: our model vs markets over time'), lineChart({ height: 200, yDomain: [0, 1], yFmt: (v) => Math.round(v * 100) + '%', xFmt: (v, l) => l ? fmtDateTime(v) : dateFmt(v), series: [ser('sen_model', 'Our model', 'dem'), ser('sen_poly', 'Polymarket', 'ind'), ser('sen_kalshi', 'Kalshi', 'neutral')].filter((s) => s.points.length) })));
      grid.append(h('div', { class: 'card' }, h('h3', null, 'House: our model vs markets over time'), lineChart({ height: 200, yDomain: [0, 1], yFmt: (v) => Math.round(v * 100) + '%', xFmt: (v, l) => l ? fmtDateTime(v) : dateFmt(v), series: [ser('hou_model', 'Our model', 'dem'), ser('hou_poly', 'Polymarket', 'ind'), ser('hou_kalshi', 'Kalshi', 'neutral')].filter((s) => s.points.length) })));
    }
    // Per-race market table (Senate + governors) from the summarised per-race prices
    const raceRows = [];
    for (const r of D.senate.races) if (r.market && (r.market.polymarket_dem != null || r.market.kalshi_dem != null)) raceRows.push({ k: `${r.postal}${r.special ? '*' : ''} Senate`, who: r.main_challenger === 'I' ? (r.other[0] && r.other[0].name) : r.dem, m: r.market, p: r.prior.p_dem });
    for (const r of D.governors.races) if (r.market && (r.market.polymarket_dem != null || r.market.kalshi_dem != null)) raceRows.push({ k: `${r.postal} Governor`, who: r.dem, m: r.market, p: r.prior.p_dem });
    raceRows.sort((a, b) => Math.abs(((a.m.polymarket_dem ?? a.m.kalshi_dem) || 0) - 0.5) - Math.abs(((b.m.polymarket_dem ?? b.m.kalshi_dem) || 0) - 0.5));
    if (raceRows.length) {
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Race'), h('th', null, 'Non-Republican'), h('th', { class: 'r' }, 'Polymarket'), h('th', { class: 'r' }, 'Kalshi'), h('th', { class: 'r' }, 'Our model'))));
      const tb = h('tbody');
      for (const r of raceRows) tb.append(h('tr', null, h('td', null, h('b', null, r.k)), h('td', null, r.who || '–'), h('td', { class: 'r' }, pctProb(r.m.polymarket_dem)), h('td', { class: 'r' }, pctProb(r.m.kalshi_dem)), h('td', { class: 'r' }, h('span', { class: r.p >= 0.5 ? 'd' : 'rp' }, pctProb(r.p)))));
      tbl.append(tb);
      grid.append(h('div', { class: 'card', style: 'grid-column:1 / -1' }, h('h3', null, 'Race by race: markets versus our model'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Chance the Democrat (or the main independent) wins. Closest markets first.'), h('div', { class: 'tablewrap', style: 'max-height:480px;overflow:auto' }, tbl)));
    }
    // Raw market detail, collapsed
    const raw = D.markets_raw || {};
    const pm = raw.polymarket || {};
    const detail = h('details', { class: 'card', style: 'grid-column:1 / -1' }, h('summary', null, 'Prediction market detail (every contract we read)'));
    for (const [k, ev] of Object.entries(pm)) {
      if (!ev || !ev.markets) continue;
      const rows = ev.markets.filter((m) => m.outcomes && m.outcomes.Yes != null).sort((a, b) => (b.outcomes.Yes || 0) - (a.outcomes.Yes || 0)).slice(0, 8);
      if (!rows.length) continue;
      detail.append(h('h4', { style: 'margin-top:12px;font-size:13px' }, h('a', { href: ev.url, target: '_blank', rel: 'noopener' }, ev.title || k), h('span', { class: 'muted' }, ` · Polymarket · $${fmtNum(Math.round(ev.volume || 0))} volume`)),
        barsChart(rows.map((m) => ({ label: (m.item || m.q || '').replace(/^Will (the )?/, '').replace(/ after the 2026 Midterm elections\?| in 2026\?/g, '').slice(0, 48), value: m.outcomes.Yes, cls: /democrat|D Senate, D House|Democrats|\(D\)/i.test(m.q || m.item || '') ? 'dem' : /republican|\(R\)/i.test(m.q || m.item || '') ? 'rep' : 'neutral' })), { fmt: (v) => pctProb(v) }));
    }
    const ks = raw.kalshi || {};
    for (const [k, sv] of Object.entries(ks)) {
      if (!sv || !sv.markets) continue;
      const rows = sv.markets.filter((m) => m.yes != null).slice(0, 8);
      if (!rows.length) continue;
      detail.append(h('h4', { style: 'margin-top:12px;font-size:13px' }, `Kalshi · ${k.replace(/_/g, ' ')}`), barsChart(rows.map((m) => ({ label: (m.sub || m.title || m.ticker || '').slice(0, 48), value: m.yes, cls: /dem|-D$/i.test((m.sub || '') + (m.ticker || '')) ? 'dem' : /rep|-R$/i.test((m.sub || '') + (m.ticker || '')) ? 'rep' : 'neutral' })), { fmt: (v) => pctProb(v) }));
    }
    grid.append(detail);
    body.append(grid);
  }

  // -------------------------------------------------------------- history
  function renderHistory() {
    const body = $('#history-body'); body.innerHTML = '';
    if (!H) { body.append(h('div', { class: 'note' }, 'Historical dataset not loaded.')); return; }
    const grid = h('div', { class: 'grid two' });
    const mids = (H.midterms || []).filter((m) => m.year >= 1946);
    if (mids.length) {
      const rows = mids.map((m) => ({ label: `${m.year} ${m.president || ''} (${m.pres_party})`, value: m.house_change_pres_party, cls: m.pres_party === 'D' ? 'dem' : 'rep' }));
      grid.append(h('div', { class: 'card' }, h('h3', null, "House seats gained or lost by the president's party"), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Every midterm since 1946. The president\'s party has lost House seats in all but three.'), barsChart(rows, { zero: true, fmt: (v) => (v == null ? '–' : (v > 0 ? '+' : '') + v) })));
      const rows2 = mids.map((m) => ({ label: `${m.year} (${m.pres_party})`, value: m.senate_change_pres_party, cls: m.pres_party === 'D' ? 'dem' : 'rep' }));
      grid.append(h('div', { class: 'card' }, h('h3', null, "Senate seats gained or lost by the president's party"), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'The Senate map matters more than the national mood. In 2026, Republicans defend 22 seats and Democrats 13.'), barsChart(rows2, { zero: true, fmt: (v) => (v == null ? '–' : (v > 0 ? '+' : '') + v) })));
      // approval vs house loss scatter-ish table
      const withApp = mids.filter((m) => m.approval != null && m.house_change_pres_party != null);
      if (withApp.length) grid.append(h('div', { class: 'card' }, h('h3', null, 'Presidential approval and House losses'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Lower approval, bigger losses. Each dot is a midterm since 1946.'), lineChart({ height: 220, zero: true, yFmt: (v) => (v > 0 ? '+' : '') + Math.round(v), xFmt: (v) => Math.round(v) + '%', xTicks: [30, 40, 50, 60, 70], series: [{ name: 'Midterms', cls: 'neutral', dots: true, r: 5, opacity: 0.7, points: withApp.map((m) => ({ x: m.approval, y: m.house_change_pres_party })) }], legend: false })));
    }
    // Generic ballot vs result table
    const gbm = mids.filter((m) => m.generic_ballot_final != null && m.house_popular_vote_margin != null);
    if (gbm.length) {
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Year'), h('th', { class: 'r' }, 'Final generic ballot'), h('th', { class: 'r' }, 'Actual House vote'), h('th', { class: 'r' }, 'Miss'))));
      const tb = h('tbody');
      for (const m of gbm) { const miss = m.house_popular_vote_margin - m.generic_ballot_final; tb.append(h('tr', null, h('td', null, m.year), h('td', { class: 'r' }, marginTxt(m.generic_ballot_final)), h('td', { class: 'r' }, marginTxt(m.house_popular_vote_margin)), h('td', { class: 'r' }, h('span', { class: miss >= 0 ? 'd' : 'rp' }, (miss >= 0 ? 'D' : 'R') + ' did ' + Math.abs(miss).toFixed(1) + ' better')))); }
      tbl.append(tb);
      grid.append(h('div', { class: 'card' }, h('h3', null, 'How far off the final generic ballot was'), h('div', { class: 'tablewrap', style: 'margin-top:8px' }, tbl)));
    }
    // Polling error by cycle
    if (H.polling_error_by_cycle && H.polling_error_by_cycle.length) {
      const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Cycle'), h('th', { class: 'r' }, 'Poll bias (pts)'), h('th', null, 'Direction'), h('th', { class: 'r' }, 'Generic ballot miss'))));
      const tb = h('tbody');
      for (const c of H.polling_error_by_cycle) { const bias = c.senate_avg_bias ?? c.senate_avg_miss ?? c.overall_bias; tb.append(h('tr', null, h('td', null, c.year), h('td', { class: 'r' }, bias != null ? bias + ' pts' : '–'), h('td', null, c.direction || ''), h('td', { class: 'r' }, c.house_generic_miss != null ? c.house_generic_miss + ' pts' : '–'))); }
      tbl.append(tb);
      grid.append(h('div', { class: 'card' }, h('h3', null, 'Polling error by cycle'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Polls underestimated Republicans in 2014, 2016, 2020 and 2024, and were close to neutral in 2018 and 2022. Our model assumes a typical miss of about 5 points per race, with 2 to 3 points shared nationally.'), h('div', { class: 'tablewrap' }, tbl)));
    }
    // 2022 Senate polls vs result
    const s22 = (H.senate_2022 || []).filter((r) => r.margin != null && r.final_poll_avg_margin != null);
    if (s22.length) {
      const rows = s22.sort((a, b) => Math.abs(a.final_poll_avg_margin) - Math.abs(b.final_poll_avg_margin)).slice(0, 16).map((r) => ({ label: `${r.state} ${r.winner || ''}`, value: r.margin - r.final_poll_avg_margin, cls: (r.margin - r.final_poll_avg_margin) >= 0 ? 'dem' : 'rep' }));
      grid.append(h('div', { class: 'card' }, h('h3', null, '2022 Senate: result minus final poll average'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Positive means Democrats beat their polls. The most competitive 2022 races.'), barsChart(rows, { zero: true, fmt: (v) => marginTxt(v, 1) })));
    }
    const s18 = (H.senate_2018 || []).filter((r) => r.margin != null && r.final_poll_avg_margin != null);
    if (s18.length) {
      const rows = s18.sort((a, b) => Math.abs(a.final_poll_avg_margin) - Math.abs(b.final_poll_avg_margin)).slice(0, 16).map((r) => ({ label: `${r.state} ${r.winner || ''}`, value: r.margin - r.final_poll_avg_margin, cls: (r.margin - r.final_poll_avg_margin) >= 0 ? 'dem' : 'rep' }));
      grid.append(h('div', { class: 'card' }, h('h3', null, '2018 Senate: result minus final poll average'), barsChart(rows, { zero: true, fmt: (v) => marginTxt(v, 1) })));
    }
    if (H.turnout && H.turnout.length) {
      grid.append(h('div', { class: 'card' }, h('h3', null, 'Midterm turnout'), barsChart(H.turnout.map((t) => ({ label: String(t.year), value: t.vap_turnout, cls: 'neutral' })), { fmt: (v) => v + '%' })));
    }
    body.append(grid);
    if (H.sources && H.sources.length) body.append(h('details', { style: 'margin-top:10px' }, h('summary', null, 'Sources for the historical data'), h('ul', { class: 'prose' }, H.sources.slice(0, 40).map((u) => h('li', null, h('a', { href: u, target: '_blank', rel: 'noopener' }, u))))));
  }

  // ------------------------------------------------------- election night
  function renderNight() {
    const body = $('#night-body'); body.innerHTML = '';
    const live = D.phase !== 'pre';
    $('#night-sub').textContent = live ? 'What the count is telling us, and what is still to come' : `Poll closing times and what to watch, shown in ${tzShort()}`;
    const grid = h('div', { class: 'grid two' });
    // Swing gauge
    if (live) {
      const sw = D.senate.swing || {}, hsw = D.house.swing || {}, gsw = D.governors.swing || {};
      const all = [sw, gsw, hsw].filter((x) => x.n);
      const card = h('div', { class: 'card' }, h('h3', null, 'Results versus expectations'));
      if (!all.length) card.append(h('p', { class: 'muted', style: 'margin-top:6px' }, 'Once a few races have most of their vote counted, this shows whether the night is running better for Democrats or Republicans than the polls and models expected, and how we are adjusting the uncalled races.'));
      else {
        const v = sw.n ? sw.swing : (gsw.n ? gsw.swing : hsw.swing);
        const pos = Math.max(5, Math.min(95, 50 + v * 5));
        card.append(h('p', { style: 'margin-top:6px' }, h('b', null, v > 0 ? `Democrats are running ${Math.abs(v).toFixed(1)} points ahead of expectations` : v < 0 ? `Republicans are running ${Math.abs(v).toFixed(1)} points ahead of expectations` : 'Results are tracking expectations'), ` across ${sw.n || 0} Senate, ${gsw.n || 0} governor and ${hsw.n || 0} House races with most of the vote counted.`),
          h('div', { class: 'swing' }, h('span', { class: 'muted', style: 'font-size:12px' }, 'R +10'), h('div', { class: 'gauge' }, h('div', { class: 'needle', style: `left:${pos}%` })), h('span', { class: 'muted', style: 'font-size:12px' }, 'D +10')),
          h('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, `Uncalled races have their expected margins shifted by 70% of this swing. Spread across races: ${sw.spread != null ? sw.spread : '–'} pts.`));
      }
      grid.append(card);
      // Races to watch next: uncalled, most vote in, closest
      const watch = [...D.senate.races.map((r) => ({ ...r, kind: 'Senate' })), ...D.governors.races.map((r) => ({ ...r, kind: 'Gov' }))]
        .filter((r) => r.live && r.live.call !== 'called' && isCompetitive(r)).sort((a, b) => (b.live.eevp || 0) - (a.live.eevp || 0)).slice(0, 10);
      const wc = h('div', { class: 'card' }, h('h3', null, 'Competitive races still counting'));
      if (!watch.length) wc.append(h('p', { class: 'muted', style: 'margin-top:6px' }, 'Nothing counting yet.'));
      else {
        const tbl = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Race'), h('th', { class: 'r' }, 'In'), h('th', { class: 'r' }, 'Now'), h('th', { class: 'r' }, 'Expected'), h('th', { class: 'r' }, 'Our D win'))));
        const tb = h('tbody');
        for (const r of watch) tb.append(h('tr', null, h('td', null, `${r.postal} ${r.kind}${r.special ? '*' : ''}`), h('td', { class: 'r' }, (r.live.eevp || 0) + '%'), h('td', { class: 'r' }, h('span', { class: (r.live.margin || 0) >= 0 ? 'd' : 'rp' }, marginTxt(r.live.margin, 1))), h('td', { class: 'r' }, marginTxt(r.prior.margin, 1)), h('td', { class: 'r' }, pctProb(r.proj.p_live))));
        tbl.append(tb); wc.append(h('div', { class: 'tablewrap', style: 'margin-top:8px' }, tbl));
      }
      grid.append(wc);
    }
    // Poll closing schedule
    const closings = (D.poll_closing || []).slice().sort((a, b) => new Date(a.close_utc) - new Date(b.close_utc));
    if (closings.length) {
      const groups = new Map();
      for (const c of closings) { const k = c.close_utc; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c.state); }
      const now = Date.now();
      let nextMarked = false;
      const senStates = new Set(D.senate.races.map((r) => r.postal)), govStates = new Set(D.governors.races.map((r) => r.postal));
      const comp = new Set([...D.senate.races.filter(isCompetitive).map((r) => r.postal + 'S'), ...D.governors.races.filter(isCompetitive).map((r) => r.postal + 'G')]);
      const list = h('div', { class: 'closings' });
      for (const [t, sts] of groups) {
        const past = new Date(t).getTime() < now;
        const isNext = !past && !nextMarked; if (isNext) nextMarked = true;
        const hot = sts.filter((s) => comp.has(s + 'S') || comp.has(s + 'G'));
        list.append(h('div', { class: 'c' + (past && live ? ' past' : '') + (isNext && live ? ' next' : '') },
          h('div', { class: 't' }, `${fmtTime(t)} ${tzShort()}`, h('span', { class: 'muted', style: 'font-weight:400;font-size:11px' }, otherTz() === STATE.tz ? '' : ` · ${new Date(t).toLocaleTimeString('en-US', { timeZone: otherTz(), hour: 'numeric', minute: '2-digit' })} ${tzAbbrev(otherTz())}`)),
          h('div', { class: 'sts' }, sts.map((s) => h('span', { class: 'tag ' + ((comp.has(s + 'S') || comp.has(s + 'G')) ? 't' : ''), style: 'margin:2px 2px 0 0' + ((senStates.has(s) || govStates.has(s)) ? ';font-weight:600' : '') }, s))),
          hot.length ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, `Watch: ${hot.join(', ')}`) : null));
      }
      grid.append(h('div', { class: 'card', style: 'grid-column:1 / -1' }, h('h3', null, 'Last poll closing times'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Bold states have a Senate or governor race. Highlighted tags are competitive. Networks and the AP do not call a race before its last polls close.'), list));
    }
    // Counting speed notes
    if (H && H.counting_speed_notes) {
      const notes = Object.entries(H.counting_speed_notes).filter(([st]) => STATES[st]);
      const general = H.counting_speed_notes.general;
      grid.append(h('div', { class: 'card', style: 'grid-column:1 / -1' }, h('h3', null, 'How fast each state counts'), h('div', { class: 'muted', style: 'font-size:12px;margin:4px 0 8px' }, 'Early returns can mislead. Which votes are counted first differs by state.'), general ? h('p', { class: 'note', style: 'margin-bottom:10px' }, general) : null, h('div', { class: 'closings' }, notes.map(([st, n]) => h('div', { class: 'c' }, h('div', { class: 't' }, stateName(st)), h('div', { class: 'sts' }, n))))));
    }
    if (H && H.election_night_2022_timeline && H.election_night_2022_timeline.length) {
      grid.append(h('div', { class: 'card', style: 'grid-column:1 / -1' }, h('h3', null, 'How 2022 unfolded, for comparison'), h('div', { class: 'tablewrap', style: 'margin-top:8px' }, h('table', null, h('tbody', null, H.election_night_2022_timeline.filter((e) => e && e.time_et && e.event).map((e) => h('tr', null, h('td', { class: 'mono', style: 'width:90px' }, e.time_et + ' ET'), h('td', { style: 'white-space:normal' }, e.event))))))));
    }
    body.append(grid);
  }

  // ----------------------------------------------------------------- news
  function renderNews() {
    const body = $('#news-body'); body.innerHTML = '';
    const n = D.news || {};
    $('#news-sub').textContent = n.items && n.items.length ? `${n.items.length} headlines · via ${n.via === 'tavily' ? 'Tavily (fallback)' : 'Google News RSS'} · ${ago(n.fetched)}` : '';
    for (const it of (n.items || []).slice(0, 30)) {
      body.append(h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title, h('div', { class: 'src' }, [it.source, it.at ? fmtDateTime(it.at) + ' ' + tzShort() : null].filter(Boolean).join(' · '))));
    }
    if (!(n.items || []).length) body.append(h('div', { class: 'muted' }, 'No headlines fetched yet.'));
  }

  // --------------------------------------------------------------- method
  function renderMethod() {
    const m = D.method || {};
    $('#method-body').innerHTML = `
      <p><b>What this is.</b> A single page that tracks the 2026 US midterms before, during and after election night. Before the election it is a forecast built from polls, published models, race ratings and prediction markets. On election night it becomes a live results tracker that keeps re-estimating the likely outcome as votes come in.</p>
      <p><b>Our model, before the election.</b> Each race gets an expected margin from a weighted blend: our own polling average (weight 2, built from every individual poll in the race from the last three weeks, recency and sample weighted), the average of published model probabilities converted to a margin (weight 2.5), race ratings from Cook, Sabato's Crystal Ball, Inside Elections and the New York Times converted to margins (weight 1.5), and prediction market prices (weight 1). Races with polls or models get an uncertainty of ${m.sigma_poll || 4.8} points, rating-only races ${m.sigma_rating_only || 7} points. Chamber control comes from 20,000 simulations with a shared national error of ${m.sigma_national || 2.6} points, so races move together the way they do in real elections.</p>
      <p><b>Our model, on election night.</b> As votes arrive, each race's estimate blends the live margin with its pre-election expectation, trusting the count more as the share of expected vote reported rises (a concave curve, so early returns are discounted). Races called by the AP are fixed. Across races with most of the vote in, we compute the median gap between the result and the expectation and shift uncalled races by 70% of that swing. That is how a strong night for one party in Georgia and North Carolina changes the odds in Michigan before Michigan reports.</p>
      <p><b>Results data.</b> New York Times election results feeds (AP vote counts and race calls, with NYT expected-vote estimates), refreshed every few minutes on the night. Links on each race go to the NYT page.</p>
      <p><b>Other sources.</b> Polls: Wikipedia's polling tables for every Senate, governor and generic-ballot poll, plus RealClearPolling, PollCheck, Silver Bulletin, Strength In Numbers, VoteHub and DDHQ averages where public. Models: Decision Desk HQ, Silver Bulletin, Race to the WH, Split Ticket, The Economist, Poliwave, Dave Manuel. Ratings: Cook, Sabato, Inside Elections, NYT. Markets: Polymarket and Kalshi public APIs. News: Google News RSS, with Tavily as a capped fallback only.</p>
      <p><b>Caveats.</b> This is an indicative model written for a dashboard, not a peer-reviewed forecast. Ratings-to-probability mappings are conventional approximations. Some published model figures are a few days old where sites are paywalled. Ranked-choice races in Maine and Alaska will not have a final result on the night.</p>
      <p>Built by Jack McLintock. Data refreshes automatically via GitHub Actions. Times are shown in ${tzShort()} (toggle at the top).</p>`;
    const st = $('#status'); st.innerHTML = '';
    for (const [k, v] of Object.entries(D.status || {})) st.append(h('span', { class: 's' + (v.ok ? '' : ' bad'), title: v.note || '' }, h('i'), k.replace(/_/g, ' '), v.items ? h('span', { class: 'muted' }, ` ${v.items}`) : ''));
    $('#foot').innerHTML = `Midterms 2026 · data generated ${esc(fmtDateTime(D.generated_at))} ${tzShort()} · seed data as of ${esc(D.seed_as_of && D.seed_as_of.senate || '')} · <a href="https://github.com/jackmclintock/midterms-2026" target="_blank" rel="noopener">Source on GitHub</a>`;
  }

  // ------------------------------------------------------------------ map
  function renderMap() {
    if (!window.MidtermsMap) return;
    window.MidtermsMap.render(D, $('#map-body'), (office, r) => {
      if (office === 'house') {
        STATE.houseFilter = 'all'; $$('#house-filter button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'all'));
        $('#house-q').value = r.id; renderHouse();
        document.getElementById('house').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const kind = office === 'senate' ? 'senate' : 'gov';
      if (kind === 'senate') { STATE.senateFilter = 'all'; $$('#senate-filter button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'all')); $('#senate-q').value = ''; renderSenate(); }
      else { STATE.govFilter = 'all'; $$('#gov-filter button').forEach((x) => x.classList.toggle('on', x.dataset.f === 'all')); renderGovernors(); }
      const card = document.getElementById(`race-${kind}-${r.postal}${r.special ? '-S' : ''}`);
      if (card) { card.classList.add('open'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }).catch((e) => console.error('map', e));
  }

  // --------------------------------------------------------------- render
  function render() {
    try { renderHeader(); renderHero(); renderMap(); renderNight(); renderSenate(); renderHouse(); renderGovernors(); renderPolls(); renderModels(); renderHistory(); renderNews(); renderMethod(); }
    catch (e) { console.error(e); $('#loading').textContent = 'Render error: ' + e.message; $('#loading').classList.remove('hide'); }
    $('#loading').classList.add('hide'); $('#app').classList.remove('hide');
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $$('#tzseg button').forEach((b) => b.addEventListener('click', () => { STATE.tz = b.dataset.tz === 'local' ? LOCAL_TZ : ET; try { localStorage.setItem('tz', b.dataset.tz); } catch (e) {} render(); }));
    $('#themebtn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      const next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next); try { localStorage.setItem('theme', next); } catch (e) {}
    });
    try { const t = localStorage.getItem('theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
    const seg = (id, key, fn) => $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => { STATE[key] = b.dataset.f; $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); fn(); }));
    seg('senate-filter', 'senateFilter', renderSenate); seg('house-filter', 'houseFilter', renderHouse); seg('gov-filter', 'govFilter', renderGovernors);
    $('#senate-q').addEventListener('input', renderSenate); $('#house-q').addEventListener('input', renderHouse);
    // tab highlighting on scroll
    const links = $$('#tabs a');
    const obs = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id)); }, { rootMargin: '-120px 0px -70% 0px' });
    $$('section.block').forEach((s) => obs.observe(s));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false).catch(console.error); });
  }

  wire();
  load(true).then(() => {
    // Refresh cadence: every 60s when live, every 5 min otherwise. Also tick the header.
    const tick = () => { if (D) renderHeader(); };
    setInterval(tick, 30000);
    setInterval(() => load(false).catch(console.error), 60000);
  }).catch((e) => { $('#loading').textContent = 'Could not load data: ' + e.message; });
})();
