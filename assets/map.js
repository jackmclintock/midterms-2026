/* US map for the Midterms 2026 dashboard.
   Senate and governor races colour the states; House races are drawn as a grid of district squares per state.
   Overlay: NYT-style shift arrows per seat (left and blue = towards Democrats, right and red = towards Republicans),
   against our expected result once votes are in, or against the 2024 presidential margin before then. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (s, el) => (el || document).querySelector(s);
  const STATE = { office: 'senate', arrows: 'auto', view: null, geo: null };
  const SMALL = { VT: 0, NH: 1, MA: 2, RI: 3, CT: 4, NJ: 5, DE: 6, MD: 7, DC: 8 };   // listed down the right edge
  const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'D.C.' };
  // Hand-tuned anchor nudges so labels and arrows sit inside the state shape.
  const NUDGE = { MI: [22, 30], FL: [10, 8], LA: [-10, 0], NY: [10, -2], CA: [-6, 10], ID: [-4, 20], MN: [0, 10], WI: [0, 8], VA: [8, -2], NC: [8, 0], WV: [-2, 4], KY: [4, 0], TN: [4, 0], MD: [0, 0], AK: [40, 0], HI: [10, -8], TX: [-6, -4], WA: [0, 6], OK: [10, 0], MA: [0, 0] };

  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
  const pctProb = (p) => (p == null ? '–' : p * 100 >= 99 ? '>99%' : p * 100 <= 1 ? '<1%' : Math.round(p * 100) + '%');
  const marginTxt = (m, parties) => { if (m == null || isNaN(m)) return '–'; const [a, b] = parties || ['D', 'R']; return Math.abs(m) < 0.05 ? 'Tied' : (m > 0 ? a : b) + '+' + Math.abs(m).toFixed(1); };

  async function geo() {
    if (STATE.geo) return STATE.geo;
    const r = await fetch('assets/us-states.json');
    STATE.geo = await r.json();
    return STATE.geo;
  }

  function anchor(g, st) {
    const s = g.states[st];
    if (!s) return null;
    const n = NUDGE[st] || [0, 0];
    return [s.cx + n[0], s.cy + n[1]];
  }

  function raceProb(r) { return r && r.proj && r.proj.p_live != null ? r.proj.p_live : (r && r.prior ? r.prior.p_dem : null); }
  function raceShift(r, mode) {
    if (!r || !r.prior) return null;
    const live = r.live || {};
    if (mode === 'expected') {
      if (live.margin != null && (live.eevp || 0) > 0) return live.margin - r.prior.margin;
      return null;
    }
    const h = live.hist && live.hist.pres_2024_margin_dem;
    if (h == null) return null;
    return r.prior.margin - h;
  }

  function isFlip(r) {
    const p = raceProb(r);
    const inc = r && r.incumbent_party;
    if (p == null || !(inc === 'D' || inc === 'R')) return false;
    return (inc === 'D' && p < 0.5) || (inc === 'R' && p >= 0.5);
  }

  function fillFor(r, D) {
    const p = raceProb(r);
    if (p == null) return { fill: 'var(--surface-2)', op: 1 };
    const indMain = r.main_challenger === 'I';
    const conf = Math.abs(p - 0.5) * 2;
    const called = r.proj && r.proj.state === 'called';
    const color = p >= 0.5 ? (indMain ? 'var(--ind)' : 'var(--dem)') : 'var(--rep)';
    const live = D.phase !== 'pre';
    const op = called ? 1 : (0.22 + 0.68 * conf) * (live && !(r.live && r.live.eevp) ? 0.55 : 1);
    return { fill: color, op: +op.toFixed(2) };
  }

  function arrow(parent, x, y, shift, scale, cls) {
    const len = Math.min(46, 6 + 3.2 * Math.abs(shift)) * scale;
    const dir = shift > 0 ? -1 : 1;            // towards Democrats = left
    const ang = 32 * Math.PI / 180;
    const x2 = x + dir * len * Math.cos(ang), y2 = y - len * Math.sin(ang);
    const color = shift > 0 ? 'var(--dem)' : 'var(--rep)';
    const g = el('g', { class: 'shift ' + (cls || '') }, parent);
    el('line', { x1: x, y1: y, x2, y2, stroke: 'var(--surface)', 'stroke-width': 4.2 * scale, 'stroke-linecap': 'round' }, g);
    el('line', { x1: x, y1: y, x2, y2, stroke: color, 'stroke-width': 2.2 * scale, 'stroke-linecap': 'round' }, g);
    // arrowhead
    const hl = 6 * scale, ha = 28 * Math.PI / 180;
    const th = Math.atan2(y2 - y, x2 - x);
    const p1 = [x2 - hl * Math.cos(th - ha), y2 - hl * Math.sin(th - ha)], p2 = [x2 - hl * Math.cos(th + ha), y2 - hl * Math.sin(th + ha)];
    el('path', { d: `M${x2} ${y2}L${p1[0]} ${p1[1]}L${p2[0]} ${p2[1]}Z`, fill: color, stroke: 'var(--surface)', 'stroke-width': 1 * scale, 'stroke-linejoin': 'round' }, g);
    return g;
  }

  function build(container, D, onPick) {
    const g = STATE.geo;
    const [vx, vy, vw, vh] = g.viewBox.split(/\s+/).map(Number);
    if (!STATE.view) STATE.view = [vx, vy, vw + 135, vh];      // room on the right for the small-state column
    const svg = el('svg', { viewBox: STATE.view.join(' '), class: 'usmap', role: 'img', 'aria-label': 'Map of the United States coloured by projected winner' });
    const defs = el('defs', {}, svg);
    for (const [id, size, w] of [['hatch', 7, 1.8], ['hatch-sm', 3.2, 0.9]]) {
      const pt = el('pattern', { id, width: size, height: size, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { x: 0, y: 0, width: w, height: size, fill: 'var(--surface)', opacity: 0.85 }, pt);
    }
    const layerStates = el('g', { class: 'states' }, svg), layerHouse = el('g', { class: 'house' }, svg), layerSmall = el('g', { class: 'small' }, svg), layerArrows = el('g', { class: 'arrows' }, svg), layerLabels = el('g', { class: 'labels' }, svg);
    const office = STATE.office;
    const tip = $('#tip');
    const live = D.phase !== 'pre';
    const arrowsMode = STATE.arrows === 'auto' ? (live ? 'expected' : 'pres2024') : STATE.arrows;

    const byState = {};
    if (office === 'senate') for (const r of D.senate.races) (byState[r.postal] = byState[r.postal] || []).push(r);
    if (office === 'gov') for (const r of D.governors.races) (byState[r.postal] = byState[r.postal] || []).push(r);
    const houseBy = {};
    if (office === 'house') for (const d of D.house.districts) (houseBy[d.state] = houseBy[d.state] || []).push(d);

    const show = (ev, html) => { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = ev.pageX + 'px'; tip.style.top = ev.pageY + 'px'; };
    const hide = () => { tip.style.display = 'none'; };

    const raceTip = (r, kind) => {
      const p = raceProb(r);
      const parties = r.main_challenger === 'I' ? ['I', 'R'] : ['D', 'R'];
      const who = p >= 0.5 ? (r.main_challenger === 'I' ? (r.other && r.other[0] && r.other[0].name) : r.dem) : r.rep;
      const lv = r.live || {};
      const sh = raceShift(r, arrowsMode);
      return `<b>${STATES[r.postal] || r.postal}${r.special ? ' (special)' : ''} · ${kind}</b>${isFlip(r) ? ' · <b>FLIP</b> from ' + r.incumbent_party : ''}<br>${r.dem ? r.dem + ' (D)' : ''}${r.dem && r.rep ? ' v ' : ''}${r.rep ? r.rep + ' (R)' : ''}${(r.other || []).slice(0, 1).map((o) => ' · ' + o.name + ' (' + (o.party || 'I') + ')').join('')}<br>` +
        `${lv.call === 'called' ? '✓ Called: ' + lv.winner : (p != null ? pctProb(p >= 0.5 ? p : 1 - p) + ' ' + (who || '') : '')}` +
        `${lv.eevp ? `<br>${lv.eevp}% in · ${marginTxt(lv.margin, parties)}` : ''}<br>Expected ${marginTxt(r.prior.margin, parties)}` +
        (sh != null ? `<br>Shift ${arrowsMode === 'expected' ? 'vs expected' : 'vs 2024 presidential'}: ${sh > 0 ? 'D' : 'R'}+${Math.abs(sh).toFixed(1)}` : '');
    };

    // Geographic states
    for (const [st, s] of Object.entries(g.states)) {
      const races = byState[st] || [];
      const r = races[0];
      const f = office === 'house' ? { fill: 'var(--surface-2)', op: 1 } : (r ? fillFor(r, D) : { fill: 'var(--surface-2)', op: 1 });
      const p = el('path', { d: s.d, fill: f.fill, 'fill-opacity': f.op, stroke: 'var(--bg)', 'stroke-width': 1.2, class: 'st' + (r ? ' has' : ''), 'data-st': st }, layerStates);
      if (office !== 'house' && r && isFlip(r)) el('path', { d: s.d, fill: 'url(#hatch)', 'pointer-events': 'none', class: 'flip' }, layerStates);
      if (office !== 'house') {
        if (r) {
          p.addEventListener('mousemove', (ev) => show(ev, raceTip(r, office === 'senate' ? 'Senate' : 'Governor')));
          p.addEventListener('mouseleave', hide);
          p.addEventListener('click', () => onPick(office, r));
          if (races.length > 1) { // two Senate races in one state (regular + special): split with a hatch dot
            const f2 = fillFor(races[1], D);
            const a = anchor(g, st);
            el('circle', { cx: a[0] + 12, cy: a[1] + 12, r: 7, fill: f2.fill, 'fill-opacity': f2.op, stroke: 'var(--bg)', 'stroke-width': 1.5 }, layerSmall)
              .addEventListener('mousemove', (ev) => show(ev, raceTip(races[1], 'Senate')));
          }
        } else {
          p.addEventListener('mousemove', (ev) => show(ev, `<b>${s.name}</b><br>No ${office === 'senate' ? 'Senate' : 'governor'} race in 2026`));
          p.addEventListener('mouseleave', hide);
        }
      }
    }

    // House: district grids per state
    if (office === 'house') {
      for (const [st, dists] of Object.entries(houseBy)) {
        const a = anchor(g, st);
        if (!a) continue;
        dists.sort((x, y) => (parseInt(x.district) || 0) - (parseInt(y.district) || 0));
        const n = dists.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
        const size = n > 30 ? 7 : n > 12 ? 8 : 9, gap = 1.4;
        const small = SMALL[st] != null;
        const ox = small ? vx + vw + 44 : a[0] - (cols * (size + gap)) / 2, oy = small ? vy + 40 + SMALL[st] * 62 : a[1] - (rows * (size + gap)) / 2;
        if (small) {
          el('line', { x1: a[0], y1: a[1], x2: ox - 4, y2: oy + (rows * (size + gap)) / 2, stroke: 'var(--ink-3)', 'stroke-width': 0.8, opacity: 0.7 }, layerSmall);
          const t = el('text', { x: ox - 6, y: oy - 4, class: 'map-lbl', 'text-anchor': 'start', 'font-size': 9 }, layerLabels); t.textContent = st;
        }
        dists.forEach((d, i) => {
          const f = fillFor(d, D);
          const x = ox + (i % cols) * (size + gap), y = oy + Math.floor(i / cols) * (size + gap);
          const rc = el('rect', { x, y, width: size, height: size, rx: 1.5, fill: f.fill, 'fill-opacity': f.op, stroke: 'var(--bg)', 'stroke-width': 0.6, class: 'dist' }, layerHouse);
          if (isFlip(d)) el('rect', { x, y, width: size, height: size, rx: 1.5, fill: 'url(#hatch-sm)', 'pointer-events': 'none' }, layerHouse);
          rc.addEventListener('mousemove', (ev) => {
            const p = raceProb(d), lv = d.live || {}, sh = raceShift(d, arrowsMode);
            show(ev, `<b>${d.id}</b>${isFlip(d) ? ' · <b>FLIP</b>' : ''} ${d.incumbent ? '· ' + d.incumbent + ' (' + d.incumbent_party + ')' : d.incumbent_party ? '· ' + d.incumbent_party + '-held' : ''}<br>${d.dem ? d.dem + ' (D)' : ''}${d.dem && d.rep ? ' v ' : ''}${d.rep ? d.rep + ' (R)' : ''}<br>${lv.call === 'called' ? '✓ Called: ' + (lv.winner || lv.winner_party) : pctProb(p >= 0.5 ? p : 1 - p) + ' ' + (p >= 0.5 ? 'D' : 'R')}${lv.eevp ? ` · ${lv.eevp}% in · ${marginTxt(lv.margin)}` : ''}<br>Expected ${marginTxt(d.prior.margin)}${Object.entries(d.ratings || {}).filter(([k, v]) => ['cook', 'sabato', 'inside'].includes(k) && v).map(([k, v]) => `<br>${k[0].toUpperCase() + k.slice(1)}: ${v}`).join('')}${sh != null ? `<br>Shift ${arrowsMode === 'expected' ? 'vs expected' : 'vs 2024 presidential'}: ${sh > 0 ? 'D' : 'R'}+${Math.abs(sh).toFixed(1)}` : ''}`);
          });
          rc.addEventListener('mouseleave', hide);
          rc.addEventListener('click', () => onPick('house', d));
          if (arrowsMode !== 'off' && STATE.view && STATE.view[2] < vw * 0.6) { // per-district arrows only when zoomed in
            const sh = raceShift(d, arrowsMode);
            if (sh != null && Math.abs(sh) >= 0.5) arrow(layerArrows, x + size / 2, y + size / 2, sh, 0.35);
          }
        });
        // state-level aggregate arrow when zoomed out
        if (arrowsMode !== 'off' && !(STATE.view && STATE.view[2] < vw * 0.6)) {
          const shifts = dists.map((d) => raceShift(d, arrowsMode)).filter((v) => v != null).sort((p, q) => p - q);
          if (shifts.length) {
            const med = shifts[Math.floor(shifts.length / 2)];
            if (Math.abs(med) >= 0.5) {
              const ax = small ? ox + (cols * (size + gap)) + 6 : a[0], ay = small ? oy + (rows * (size + gap)) / 2 : oy - 4;
              const ar = arrow(layerArrows, ax, ay, med, 0.75);
              ar.addEventListener('mousemove', (ev) => show(ev, `<b>${STATES[st]}</b><br>Median shift across ${shifts.length} districts: ${med > 0 ? 'D' : 'R'}+${Math.abs(med).toFixed(1)}`));
              ar.addEventListener('mouseleave', hide);
            }
          }
        }
      }
    } else {
      // Senate / governor: small-state column, labels and arrows
      for (const [st, idx] of Object.entries(SMALL)) {
        const races = byState[st] || [];
        const a = anchor(g, st);
        if (!a) continue;
        const bx = vx + vw + 40, by = vy + 60 + idx * 40;
        const r = races[0];
        const f = r ? fillFor(r, D) : { fill: 'var(--surface-2)', op: 1 };
        el('line', { x1: a[0], y1: a[1], x2: bx, y2: by + 9, stroke: 'var(--ink-3)', 'stroke-width': 0.8, opacity: 0.7 }, layerSmall);
        const rc = el('rect', { x: bx, y: by, width: 18, height: 18, rx: 3, fill: f.fill, 'fill-opacity': f.op, stroke: 'var(--bg)', 'stroke-width': 1 }, layerSmall);
        if (r && isFlip(r)) el('rect', { x: bx, y: by, width: 18, height: 18, rx: 3, fill: 'url(#hatch)', 'pointer-events': 'none' }, layerSmall);
        const t = el('text', { x: bx + 22, y: by + 13, class: 'map-lbl', 'font-size': 11 }, layerLabels); t.textContent = st;
        if (r) { rc.addEventListener('mousemove', (ev) => show(ev, raceTip(r, office === 'senate' ? 'Senate' : 'Governor'))); rc.addEventListener('mouseleave', hide); rc.addEventListener('click', () => onPick(office, r)); }
      }
      for (const [st, races] of Object.entries(byState)) {
        const a = anchor(g, st);
        if (!a) continue;
        const small = SMALL[st] != null;
        if (!small) { const t = el('text', { x: a[0], y: a[1] + 15, class: 'map-lbl', 'text-anchor': 'middle', 'font-size': 10 }, layerLabels); t.textContent = st; }
        if (arrowsMode === 'off') continue;
        races.forEach((r, i) => {
          const sh = raceShift(r, arrowsMode);
          if (sh == null || Math.abs(sh) < 0.3) return;
          const ax = small ? vx + vw + 100 : a[0] + i * 10, ay = small ? vy + 60 + SMALL[st] * 40 + 14 : a[1] - 2 + i * 6;
          const ar = arrow(layerArrows, ax, ay, sh, small ? 0.6 : 1);
          ar.addEventListener('mousemove', (ev) => show(ev, raceTip(r, office === 'senate' ? 'Senate' : 'Governor')));
          ar.addEventListener('mouseleave', hide);
        });
      }
    }

    // pan + zoom
    let drag = null;
    svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, v: STATE.view.slice() }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const k = STATE.view[2] / rect.width;
      STATE.view[0] = drag.v[0] - (e.clientX - drag.x) * k; STATE.view[1] = drag.v[1] - (e.clientY - drag.y) * k;
      svg.setAttribute('viewBox', STATE.view.join(' '));
    });
    const end = () => { drag = null; };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    container.innerHTML = '';
    container.appendChild(svg);
    return { arrowsMode };
  }

  function zoom(factor, D, container, onPick) {
    const v = STATE.view; const cx = v[0] + v[2] / 2, cy = v[1] + v[3] / 2;
    const w = v[2] / factor, h = v[3] / factor;
    STATE.view = [cx - w / 2, cy - h / 2, w, h];
    build(container, D, onPick);
  }

  async function render(D, host, onPick) {
    await geo();
    host.innerHTML = '';
    const bar = document.createElement('div'); bar.className = 'filters';
    const seg = (opts, key, cb) => {
      const s = document.createElement('div'); s.className = 'seg';
      for (const [val, lab] of opts) { const b = document.createElement('button'); b.textContent = lab; b.className = STATE[key] === val ? 'on' : ''; b.addEventListener('click', () => { STATE[key] = val; cb(); }); s.appendChild(b); }
      return s;
    };
    const mapBox = document.createElement('div'); mapBox.className = 'mapbox';
    const legend = document.createElement('div'); legend.className = 'legend';
    const live = D.phase !== 'pre';
    const redraw = () => { render(D, host, onPick); };
    bar.appendChild(seg([['senate', 'Senate'], ['house', 'House'], ['gov', 'Governors']], 'office', redraw));
    bar.appendChild(seg([['auto', live ? 'Arrows: vs expected' : 'Arrows: vs 2024'], ['expected', 'vs expected'], ['pres2024', 'vs 2024 pres.'], ['off', 'No arrows']], 'arrows', redraw));
    const zb = document.createElement('div'); zb.className = 'seg';
    for (const [lab, f] of [['−', 1 / 1.5], ['+', 1.5], ['Reset', 0]]) { const b = document.createElement('button'); b.textContent = lab; b.addEventListener('click', () => { if (!f) { STATE.view = null; render(D, host, onPick); } else zoom(f, D, mapBox, onPick); }); zb.appendChild(b); }
    bar.appendChild(zb);
    host.appendChild(bar);
    host.appendChild(mapBox);
    const { arrowsMode } = build(mapBox, D, onPick);
    const sw = (c, t, op) => { const s = document.createElement('span'); s.innerHTML = `<i class="sw" style="background:${c};opacity:${op || 1}"></i>${t}`; return s; };
    legend.append(sw('var(--dem)', 'Democrat favoured'), sw('var(--dem)', 'leaning D', 0.4), sw('var(--rep)', 'leaning R', 0.4), sw('var(--rep)', 'Republican favoured'), sw('var(--ind)', 'Independent favoured'), sw('var(--surface-2)', STATE.office === 'house' ? 'squares are districts' : 'no race'));
    const flipSw = document.createElement('span'); flipSw.innerHTML = '<i class="sw hatched"></i>hatched = projected to change party'; legend.append(flipSw);
    const note = document.createElement('div'); note.className = 'muted'; note.style.cssText = 'font-size:12px;margin-top:6px';
    note.textContent = arrowsMode === 'off' ? 'Click a state or district to jump to the race. Drag to pan.' :
      arrowsMode === 'expected' ? 'Arrows: how the count so far compares with our expected result for that seat. Left and blue means the Democrat is running ahead of expectations, right and red the Republican. Longer is bigger. Click a state or district to jump to the race. Drag to pan.' :
        'Arrows: how our expected result for the seat compares with the 2024 presidential vote there. Left and blue means a shift toward Democrats, right and red toward Republicans. Once votes are in, the arrows switch to results versus expectations. Click a state or district to jump to the race. Drag to pan.';
    if (STATE.office === 'house') note.textContent += ' Zoom in for per-district arrows.';
    host.appendChild(legend); host.appendChild(note);
  }

  window.MidtermsMap = { render, state: STATE };
})();
