/* global Chart */
'use strict';

const api = window.vpsmon;

// ---------- palette (dark surface) ----------
const INK = { ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835' };
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OVERFLOW = '#898781'; // 9th+ module: muted, dashed, hidden by default (never a generated hue)
const KEEP_MS = 3600e3;
const DEFAULT_VISIBLE = 6;

// ---------- state ----------
const S = {
  servers: [],
  status: new Map(),   // id -> {state, message}
  buf: new Map(),      // id -> [{rt, d}]
  logs: new Map(),     // id -> [string]
  modColor: new Map(), // id -> Map(module -> color|null)
  modVis: new Map(),   // `${id}:${chart}` -> Map(module -> visible)
  page: 'overview',
  sel: null,
  windowMs: loadPref('windowMs', 900000),
  mock: false,
};

function loadPref(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
function setClass(node, cls) { if (node && node.className !== cls) node.className = cls; }

// ---------- formatting ----------
function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '–';
  if (b <= 0) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}
const fmtPct = (v) => (v == null || !isFinite(v) ? '–' : `${Number(v).toFixed(1)}%`);
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms, sec) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ':' + pad(d.getSeconds()) : ''}`; }
function fmtAgo(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; }
function level(v, warn, crit) { return v == null ? '' : v >= crit ? 'lvl-crit' : v >= warn ? 'lvl-warn' : ''; }

// ---------- status ----------
function effectiveStatus(id) {
  const st = S.status.get(id) || { state: 'stopped', message: '' };
  if (st.state === 'streaming') {
    const last = lastSample(id);
    const iv = (last?.d.interval || serverById(id)?.interval || 2) * 1000;
    if (!last || Date.now() - last.rt > 3 * iv + 1000) return { ...st, state: 'stale' };
  }
  return st;
}
const STATUS_LABEL = {
  streaming: ['good', 'Live'], stale: ['warn', 'Stale'], connecting: ['idle', 'Connecting…'],
  reconnecting: ['warn', 'Reconnecting'], error: ['crit', 'Error'], 'needs-passphrase': ['crit', 'Passphrase needed'],
  stopped: ['idle', 'Stopped'],
};
function statusBadge(node, st) {
  const [cls, label] = STATUS_LABEL[st.state] || ['idle', st.state];
  setClass(node, `st ${cls}`);
  setText(node, label);
}

// ---------- buffers ----------
const serverById = (id) => S.servers.find((s) => s.id === id);
function lastSample(id) { const b = S.buf.get(id); return b && b.length ? b[b.length - 1] : null; }
function windowed(id) {
  const b = S.buf.get(id) || [];
  const from = Date.now() - S.windowMs;
  let lo = 0; let hi = b.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (b[m].rt < from) lo = m + 1; else hi = m; }
  return b.slice(lo);
}
function pushSample(id, d) {
  let b = S.buf.get(id);
  if (!b) { b = []; S.buf.set(id, b); }
  const rt = Date.now();
  b.push({ rt, d });
  const cut = rt - KEEP_MS;
  let n = 0; while (n < b.length && b[n].rt < cut) n++;
  if (n) b.splice(0, n);
}

// ---------- charts ----------
Chart.defaults.color = INK.muted;
Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.animation = false;
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

function makeChart(canvas, { yFmt, yMax, stacked, legend = true, sharedTooltip = true, onLegendClick }) {
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      parsing: false,
      normalized: true,
      spanGaps: false,
      interaction: sharedTooltip ? { mode: 'index', intersect: false } : { mode: 'nearest', axis: 'x', intersect: false },
      elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 6 }, line: { borderWidth: 2, tension: 0 } },
      scales: {
        x: {
          type: 'linear',
          grid: { color: INK.grid, drawTicks: false },
          border: { color: INK.axis },
          ticks: { maxTicksLimit: 7, callback: (v) => fmtClock(v), padding: 6 },
        },
        y: {
          stacked: !!stacked,
          beginAtZero: true,
          max: yMax,
          grid: { color: INK.grid, drawTicks: false },
          border: { display: false },
          ticks: { maxTicksLimit: 5, callback: (v) => yFmt(v), padding: 6 },
        },
      },
      plugins: {
        legend: {
          display: legend,
          position: 'top',
          align: 'end',
          labels: { boxWidth: 10, boxHeight: 10, color: INK.ink2, padding: 10, usePointStyle: true, pointStyle: 'rectRounded' },
          onClick: onLegendClick || Chart.defaults.plugins.legend.onClick,
        },
        tooltip: {
          backgroundColor: '#2c2c2a',
          borderColor: 'rgba(255,255,255,0.12)',
          borderWidth: 1,
          titleColor: INK.ink,
          bodyColor: INK.ink2,
          padding: 8,
          boxWidth: 8,
          boxHeight: 8,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          filter: (item) => !(item.parsed.y === 0 && item.chart.data.datasets.length > 6),
          callbacks: {
            title: (items) => (items.length ? fmtClock(items[0].parsed.x, true) : ''),
            label: (item) => ` ${item.dataset.label}: ${yFmt(item.parsed.y)}`,
          },
        },
      },
    },
  });
}

// Replace dataset data in place, keyed, so visibility and order survive updates.
function setSeries(chart, series) {
  const byKey = new Map(chart.data.datasets.map((ds) => [ds.key, ds]));
  const next = series.map((s) => {
    const ds = byKey.get(s.key) || { key: s.key };
    Object.assign(ds, {
      label: s.label,
      data: s.data,
      borderColor: s.color,
      backgroundColor: s.fill ? s.color + '55' : s.color,
      fill: s.fill || false,
      borderDash: s.dash || [],
      borderWidth: s.width || 2,
    });
    if (s.hidden !== undefined) ds.hidden = s.hidden;
    return ds;
  });
  chart.data.datasets = next;
}

function setRange(chart) {
  const now = Date.now();
  chart.options.scales.x.min = now - S.windowMs;
  chart.options.scales.x.max = now;
}

// ---------- sparkline (svg) ----------
function sparkline(svg, values, color, max = 100) {
  const W = 100; const H = 30;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (values.length < 2) { svg.innerHTML = ''; return; }
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 1 - (Math.min(v, max) / max) * (H - 2)).toFixed(1)}`).join(' ');
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
}
function recentBusy(id, ms) {
  const b = S.buf.get(id) || [];
  const from = Date.now() - ms;
  const out = [];
  for (let i = b.length - 1; i >= 0 && b[i].rt >= from; i--) out.push(b[i].d.cpu.busy);
  return out.reverse();
}

// ================================================================== sidebar
const sideNodes = new Map();
function renderSidebar() {
  const ul = $('#serverList');
  const ids = new Set(S.servers.map((s) => s.id));
  for (const [id, n] of sideNodes) if (!ids.has(id)) { n.li.remove(); sideNodes.delete(id); }
  S.servers.forEach((s) => {
    let n = sideNodes.get(s.id);
    if (!n) {
      const li = el('li', 'server-item');
      li.draggable = true;
      li.dataset.id = s.id;
      const sw = el('span', 'swatch');
      const name = el('span', 'name');
      const val = el('span', 'val');
      const sub = el('div', 'sub');
      const st = el('span', 'st idle');
      const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      spark.classList.add('spark');
      sub.append(st, spark);
      li.append(sw, name, val, sub);
      li.addEventListener('click', () => openDetail(s.id));
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', async (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        const from = e.dataTransfer.getData('text/plain');
        if (!from || from === s.id) return;
        const order = S.servers.map((x) => x.id).filter((x) => x !== from);
        order.splice(order.indexOf(s.id), 0, from);
        applyServers(await api.reorderServers(order));
      });
      n = { li, sw, name, val, st, spark };
      sideNodes.set(s.id, n);
    }
    ul.append(n.li); // keeps DOM order in sync with config order
    n.sw.style.background = s.color;
    setText(n.name, s.name);
    n.li.classList.toggle('active', S.page === 'detail' && S.sel === s.id);
    updateSidebarItem(s.id);
  });
}
function updateSidebarItem(id) {
  const n = sideNodes.get(id);
  const s = serverById(id);
  if (!n || !s) return;
  const st = effectiveStatus(id);
  statusBadge(n.st, st);
  const last = lastSample(id);
  setText(n.val, last && st.state !== 'stopped' ? fmtPct(last.d.cpu.busy) : '');
  sparkline(n.spark, recentBusy(id, 5 * 60e3), s.color);
}

// ================================================================== overview
const cardNodes = new Map();
let cmpCpu = null;
let cmpRam = null;

function buildOverview() {
  const wrap = $('#cards');
  const ids = new Set(S.servers.map((s) => s.id));
  for (const [id, n] of cardNodes) if (!ids.has(id)) { n.card.remove(); cardNodes.delete(id); }
  S.servers.forEach((s) => {
    let n = cardNodes.get(s.id);
    if (!n) {
      const card = el('div', 'card');
      card.tabIndex = 0;
      card.addEventListener('click', () => openDetail(s.id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(s.id); });
      const head = el('div', 'card-head');
      const sw = el('span', 'swatch');
      const name = el('span', 'name');
      const st = el('span', 'st idle');
      const edit = el('button', 'card-edit', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openEditor(s.id); });
      edit.addEventListener('keydown', (e) => e.stopPropagation());
      const term = el('button', 'card-term', 'Terminal');
      term.type = 'button';
      term.title = 'Open an SSH terminal window';
      term.addEventListener('click', (e) => { e.stopPropagation(); api.openTerminal(s.id); });
      term.addEventListener('keydown', (e) => e.stopPropagation());
      head.append(sw, name, st, term, edit);
      const host = el('div', 'host');
      const metrics = el('div', 'metrics');
      const m = {};
      for (const [k, label] of [['busy', 'CPU busy'], ['steal', 'Steal'], ['load', 'Load 1m'], ['ram', 'RAM'], ['disk', 'Disk'], ['queue', 'Queue']]) {
        const box = el('div', 'metric');
        box.append(el('div', 'k', label));
        m[k] = el('div', 'v', '–');
        box.append(m[k]);
        metrics.append(box);
      }
      const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      spark.classList.add('spark');
      const msg = el('div', 'msg');
      card.append(head, host, metrics, spark, msg);
      n = { card, sw, name, st, host, m, spark, msg };
      cardNodes.set(s.id, n);
    }
    wrap.append(n.card);
    n.sw.style.background = s.color;
    setText(n.name, s.name);
    setText(n.host, `${s.username}@${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`);
    updateCard(s.id);
  });
  $('#emptyState').hidden = S.servers.length > 0;
  $('#cmpGrid').hidden = S.servers.length === 0;

  if (!cmpCpu) {
    cmpCpu = makeChart($('#cmpCpu'), { yFmt: (v) => `${v}%`, yMax: 100, sharedTooltip: false });
    cmpRam = makeChart($('#cmpRam'), { yFmt: (v) => `${v}%`, yMax: 100, sharedTooltip: false });
  }
  updateCompare();
}

function updateCard(id) {
  const n = cardNodes.get(id);
  if (!n) return;
  const st = effectiveStatus(id);
  statusBadge(n.st, st);
  const last = lastSample(id);
  const d = last?.d;
  const live = d && st.state !== 'stopped';
  const set = (k, text, cls = '') => { setText(n.m[k], live ? text : '–'); setClass(n.m[k], `v ${live ? cls : ''}`); };
  if (d) {
    const ramPct = d.mem.total ? (d.mem.used / d.mem.total) * 100 : null;
    set('busy', fmtPct(d.cpu.busy), level(d.cpu.busy, 80, 95));
    set('steal', fmtPct(d.cpu.steal), level(d.cpu.steal, 20, 50));
    set('load', `${d.load[0]}`, level(d.load[0] / d.ncpu, 1, 2));
    set('ram', fmtPct(ramPct), level(ramPct, 85, 95));
    set('disk', `${d.disk.pct}%`, level(d.disk.pct, 80, 90));
    set('queue', d.queue ? String(d.queue.pending) : 'n/a', d.queue ? level(d.queue.pending, 101, 1001) : '');
  } else {
    for (const k of Object.keys(n.m)) set(k, '–');
  }
  sparkline(n.spark, recentBusy(id, 5 * 60e3), serverById(id)?.color || SERIES[0]);
  const msg = st.state === 'streaming' ? `${d?.host || ''} · ${d?.ncpu || '?'} cores · updated ${last ? fmtAgo(Date.now() - last.rt) : '–'}`
    : st.state === 'stale' ? `no data for ${last ? fmtAgo(Date.now() - last.rt).replace(' ago', '') : '?'}`
      : st.message || '';
  setText(n.msg, msg);
}

function updateCompare() {
  if (!cmpCpu) return;
  const cpu = []; const ram = [];
  S.servers.forEach((s) => {
    const w = windowed(s.id);
    cpu.push({ key: s.id, label: s.name, color: s.color, data: w.map((x) => ({ x: x.rt, y: x.d.cpu.busy })) });
    ram.push({ key: s.id, label: s.name, color: s.color, data: w.map((x) => ({ x: x.rt, y: x.d.mem.total ? Math.round((x.d.mem.used / x.d.mem.total) * 1000) / 10 : 0 })) });
  });
  setSeries(cmpCpu, cpu); setSeries(cmpRam, ram);
  setRange(cmpCpu); setRange(cmpRam);
  cmpCpu.options.plugins.legend.display = S.servers.length > 1;
  cmpRam.options.plugins.legend.display = S.servers.length > 1;
  cmpCpu.update('none'); cmpRam.update('none');
}

// ================================================================== detail
const D = { charts: null, tiles: null };

function destroyDetailCharts() {
  if (!D.charts) return;
  Object.values(D.charts).forEach((c) => c.destroy());
  D.charts = null;
}

function moduleLegendClick(chartKey) {
  return (e, item, legend) => {
    const chart = legend.chart;
    const ds = chart.data.datasets[item.datasetIndex];
    ds.hidden = !ds.hidden;
    visMap(S.sel, chartKey).set(ds.key, !ds.hidden);
    chart.update('none');
  };
}
function visMap(id, chartKey) {
  const k = `${id}:${chartKey}`;
  if (!S.modVis.has(k)) S.modVis.set(k, new Map());
  return S.modVis.get(k);
}

function buildDetail() {
  destroyDetailCharts();
  const bytes = (v) => fmtBytes(v);
  D.charts = {
    hostCpu: makeChart($('#chHostCpu'), { yFmt: (v) => `${v}%`, yMax: 100, stacked: true }),
    mem: makeChart($('#chMem'), { yFmt: bytes }),
    modCpu: makeChart($('#chModCpu'), { yFmt: (v) => `${v}%`, onLegendClick: moduleLegendClick('cpu') }),
    modRam: makeChart($('#chModRam'), { yFmt: bytes, onLegendClick: moduleLegendClick('ram') }),
    queue: makeChart($('#chQueue'), { yFmt: (v) => `${v}` }),
  };
  buildTiles();
  $('#logBox').textContent = (S.logs.get(S.sel) || []).join('\n');
  updateDetail();
}

const TILE_DEFS = [
  ['busy', 'CPU busy'], ['steal', 'CPU steal'], ['iowait', 'IO wait'], ['load', 'Load 1 / 5 / 15'],
  ['ram', 'RAM used'], ['swap', 'Swap used'], ['disk', 'Disk /'], ['queue', 'Queue pending'],
];
function buildTiles() {
  const wrap = $('#tiles');
  wrap.textContent = '';
  D.tiles = {};
  for (const [k, label] of TILE_DEFS) {
    const t = el('div', 'tile');
    const v = el('div', 'v', '–');
    const s = el('div', 's', '');
    t.append(el('div', 'k', label), v, s);
    wrap.append(t);
    D.tiles[k] = { v, s };
  }
}
function tile(k, value, sub = '', cls = '') {
  const t = D.tiles[k];
  setText(t.v, value);
  setClass(t.v, `v ${cls}`);
  setText(t.s, sub);
}

// stable color per module per server: assigned on first sight in CPU order
function moduleColor(id, name) {
  if (!S.modColor.has(id)) S.modColor.set(id, new Map());
  const m = S.modColor.get(id);
  if (!m.has(name)) {
    const used = [...m.values()].filter(Boolean).length;
    m.set(name, used < SERIES.length ? SERIES[used] : null);
  }
  return m.get(name);
}

function moduleSeries(id, w, field, chartKey) {
  const names = new Map(); // name -> avg
  const off = serverById(id)?.disabledModules || [];
  for (const x of w) for (const m of x.d.modules) if (!off.includes(m.name)) names.set(m.name, (names.get(m.name) || 0) + m[field]);
  const last = w.length ? w[w.length - 1].d.modules : [];
  // color order follows the first-seen CPU ranking, independent of which chart asks
  [...last].sort((a, b) => b.cpu - a.cpu).forEach((m) => moduleColor(id, m.name));
  const vis = visMap(id, chartKey);
  const ranked = [...names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  ranked.forEach((n, i) => { if (!vis.has(n)) vis.set(n, i < DEFAULT_VISIBLE && moduleColor(id, n) !== null); });
  return ranked.map((name) => {
    const color = moduleColor(id, name);
    return {
      key: name,
      label: name,
      color: color || OVERFLOW,
      dash: color ? [] : [4, 3],
      hidden: !vis.get(name),
      data: w.map((x) => {
        const m = x.d.modules.find((mm) => mm.name === name);
        return { x: x.rt, y: m ? m[field] : 0 };
      }),
    };
  });
}

function updateDetail() {
  const id = S.sel;
  const s = serverById(id);
  if (!s || !D.charts) return;
  const st = effectiveStatus(id);
  const last = lastSample(id);
  const d = last?.d;

  // header
  setText($('#pageTitle'), s.name);
  setText($('#pageMeta'), [
    `${s.username}@${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`,
    d ? `${d.host} · ${d.ncpu} cores · every ${d.interval}s` : null,
    last ? `last sample ${fmtAgo(Date.now() - last.rt)}` : null,
  ].filter(Boolean).join('  ·  '));
  const pill = $('#detailStatus');
  const [cls, label] = STATUS_LABEL[st.state] || ['idle', st.state];
  setClass(pill, `pill st ${cls}`);
  setText(pill, label);
  const running = ['connecting', 'streaming', 'stale', 'reconnecting'].includes(st.state);
  $('#btnConnect').hidden = running;
  $('#btnDisconnect').hidden = !running;

  // banner for problems
  const banner = $('#banner');
  if (st.state === 'error' || st.state === 'needs-passphrase' || st.state === 'reconnecting') {
    banner.hidden = false;
    banner.className = `banner ${st.state === 'reconnecting' ? 'warn' : ''}`;
    setText($('#bannerText'), st.message || label);
    const act = $('#bannerAction');
    act.hidden = st.state === 'reconnecting';
    setText(act, st.state === 'needs-passphrase' ? 'Enter passphrase' : 'Edit server');
    act.onclick = () => (st.state === 'needs-passphrase' ? askPassphrase(id) : openEditor(id));
  } else {
    banner.hidden = true;
  }

  // tiles
  if (d) {
    const ramPct = d.mem.total ? (d.mem.used / d.mem.total) * 100 : null;
    tile('busy', fmtPct(d.cpu.busy), `idle ${fmtPct(d.cpu.idle)} · other ${fmtPct(d.other)}`, level(d.cpu.busy, 80, 95));
    tile('steal', fmtPct(d.cpu.steal), 'held by the hypervisor', level(d.cpu.steal, 20, 50));
    tile('iowait', fmtPct(d.cpu.iowait), '', level(d.cpu.iowait, 10, 30));
    tile('load', d.load.join(' / '), `${d.ncpu} cores`, level(d.load[0] / d.ncpu, 1, 2));
    tile('ram', fmtBytes(d.mem.used), `of ${fmtBytes(d.mem.total)} · ${fmtBytes(d.mem.avail)} available`, level(ramPct, 85, 95));
    tile('swap', fmtBytes(d.swap.used), `of ${fmtBytes(d.swap.total)}`);
    tile('disk', `${d.disk.pct}%`, `${fmtBytes(d.disk.used)} of ${fmtBytes(d.disk.size)}`, level(d.disk.pct, 80, 90));
    if (d.queue) tile('queue', String(d.queue.pending), `${d.queue.running} running`, level(d.queue.pending, 101, 1001));
    else tile('queue', 'n/a', s.db ? 'cannot read (needs sudo?)' : 'no queue database set');
  }

  // charts
  const w = windowed(id);
  const C = D.charts;
  setSeries(C.hostCpu, [
    { key: 'busy', label: 'busy', color: SERIES[0], fill: true, data: w.map((x) => ({ x: x.rt, y: x.d.cpu.busy })) },
    { key: 'iowait', label: 'iowait', color: SERIES[1], fill: true, data: w.map((x) => ({ x: x.rt, y: x.d.cpu.iowait })) },
    { key: 'steal', label: 'steal', color: SERIES[2], fill: true, data: w.map((x) => ({ x: x.rt, y: x.d.cpu.steal })) },
  ]);
  setSeries(C.mem, [
    { key: 'ram', label: 'RAM used', color: SERIES[0], data: w.map((x) => ({ x: x.rt, y: x.d.mem.used })) },
    { key: 'swap', label: 'Swap used', color: SERIES[1], data: w.map((x) => ({ x: x.rt, y: x.d.swap.used })) },
  ]);
  C.mem.options.scales.y.max = d ? d.mem.total : undefined;
  setSeries(C.modCpu, moduleSeries(id, w, 'cpu', 'cpu'));
  setSeries(C.modRam, moduleSeries(id, w, 'mem', 'ram'));
  setSeries(C.queue, [
    { key: 'pending', label: 'pending', color: SERIES[0], data: w.map((x) => ({ x: x.rt, y: x.d.queue ? x.d.queue.pending : null })) },
    { key: 'running', label: 'running', color: SERIES[1], data: w.map((x) => ({ x: x.rt, y: x.d.queue ? x.d.queue.running : null })) },
  ]);
  setText($('#queueTop'), d?.queue?.top ? `Most queued: ${d.queue.top}` : '');
  for (const c of Object.values(C)) { setRange(c); c.update('none'); }

  renderModToggles(s);
  renderModTable(id, d);
}

// Checkbox per known module; only rebuilt when the set or its state changes so clicks aren't lost.
let modToggleSig = '';
function renderModToggles(s) {
  const box = $('#modToggles');
  const off = s.disabledModules || [];
  const names = [...new Set([...(s.knownModules || []), ...off])].sort();
  const sig = `${s.id}|${names.join(',')}|${off.join(',')}`;
  if (sig === modToggleSig) return;
  modToggleSig = sig;
  const frag = document.createDocumentFragment();
  for (const n of names) {
    const label = el('label', off.includes(n) ? 'off' : '');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !off.includes(n);
    cb.addEventListener('change', async () => {
      const next = new Set(serverById(s.id)?.disabledModules || []);
      if (cb.checked) next.delete(n); else next.add(n);
      applyServers(await api.setModules(s.id, [...next]));
    });
    label.append(cb, document.createTextNode(n));
    frag.append(label);
  }
  box.replaceChildren(frag);
}

function renderModTable(id, d) {
  const tbody = $('#modTable tbody');
  if (!d) { tbody.textContent = ''; return; }
  const off = serverById(id)?.disabledModules || [];
  const rows = d.modules.filter((m) => !off.includes(m.name)).sort((a, b) => b.cpu - a.cpu);
  const frag = document.createDocumentFragment();
  for (const m of rows) {
    const tr = el('tr');
    const name = el('td');
    const sw = el('span', 'swatch');
    sw.style.background = moduleColor(id, m.name) || OVERFLOW;
    name.append(sw, document.createTextNode(m.name));
    const stTd = el('td');
    const ok = m.state === 'active' || m.state === '-';
    stTd.append(el('span', `st ${ok ? (m.state === '-' ? 'idle' : 'good') : 'crit'}`, m.state));
    tr.append(name, stTd, el('td', 'num', fmtPct(m.cpu)), el('td', 'num', fmtBytes(m.mem)), el('td', 'num', m.swap ? fmtBytes(m.swap) : '–'), el('td', 'num', String(m.tasks)));
    frag.append(tr);
  }
  const other = el('tr', 'other');
  other.append(el('td', null, 'other'), el('td', null, '(kernel+)'), el('td', 'num', fmtPct(d.other)), el('td'), el('td'), el('td'));
  frag.append(other);
  tbody.replaceChildren(frag);
}

// ================================================================== navigation
function openOverview() {
  S.page = 'overview';
  S.sel = null;
  destroyDetailCharts();
  $('#overview').hidden = false;
  $('#detail').hidden = true;
  $('#detailActions').hidden = true;
  $('#navOverview').classList.add('active');
  setText($('#pageTitle'), 'Overview');
  updateOverviewMeta();
  renderSidebar();
  buildOverview();
}
function updateOverviewMeta() {
  const total = S.servers.length;
  const live = S.servers.filter((s) => effectiveStatus(s.id).state === 'streaming').length;
  setText($('#pageMeta'), total ? `${live} of ${total} server${total > 1 ? 's' : ''} live` : '');
}
function openDetail(id) {
  S.page = 'detail';
  S.sel = id;
  if (cmpCpu) { cmpCpu.destroy(); cmpRam.destroy(); cmpCpu = cmpRam = null; }
  $('#overview').hidden = true;
  $('#detail').hidden = false;
  $('#detailActions').hidden = false;
  $('#navOverview').classList.remove('active');
  renderSidebar();
  buildDetail();
  $('main').scrollTop = 0;
}

// ---------- render scheduling: batch samples into one frame ----------
const dirty = new Set();
let frame = 0;
function markDirty(id) {
  dirty.add(id);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  const ids = [...dirty];
  dirty.clear();
  ids.forEach(updateSidebarItem);
  if (S.page === 'overview') {
    ids.forEach(updateCard);
    updateCompare();
    updateOverviewMeta();
  } else if (ids.includes(S.sel)) {
    updateDetail();
  }
}

// ================================================================== dialogs
let editingId = null;
function openEditor(id) {
  editingId = id || null;
  const f = $('#editorForm');
  const s = id ? serverById(id) : null;
  f.reset();
  $('#editorTitle').textContent = s ? `Edit ${s.name}` : 'Add server';
  const defaults = { port: 22, username: 'root', interval: 2, color: SERIES[S.servers.length % SERIES.length] };
  const src = s || defaults;
  for (const k of ['name', 'host', 'port', 'username', 'privateKeyPath', 'interval', 'db', 'modulesConf', 'color']) {
    if (src[k] != null) f.elements[k].value = src[k];
  }
  f.elements.useSudo.checked = !!src.useSudo;
  f.elements.autoConnect.checked = s ? !!s.autoConnect : true;
  $('#hostKeyRow').hidden = !s?.hostKey;
  $('#hostKeyText').textContent = s?.hostKey || '';
  f.dataset.hostKey = s?.hostKey || '';
  $('#deleteServer').hidden = !s;
  $('#testResult').hidden = true;
  $('#editor').showModal();
}
function readForm() {
  const f = $('#editorForm');
  const v = (k) => f.elements[k].value.trim();
  return {
    id: editingId || undefined,
    name: v('name'), host: v('host'), port: Number(v('port')) || 22, username: v('username'),
    privateKeyPath: v('privateKeyPath'), interval: Number(v('interval')) || 2, db: v('db'),
    modulesConf: f.elements.modulesConf.value, color: f.elements.color.value,
    useSudo: f.elements.useSudo.checked, autoConnect: f.elements.autoConnect.checked,
    hostKey: f.dataset.hostKey || '',
  };
}

$('#pickKey').addEventListener('click', async () => {
  const p = await api.pickKey();
  if (p) $('#editorForm').elements.privateKeyPath.value = p;
});
$('#forgetHostKey').addEventListener('click', () => {
  $('#editorForm').dataset.hostKey = '';
  $('#hostKeyText').textContent = '(will be learned on next connect)';
});
$('#cancelEdit').addEventListener('click', () => $('#editor').close());
$('#deleteServer').addEventListener('click', async () => {
  const s = serverById(editingId);
  if (!s || !confirm(`Delete server "${s.name}"? Its collected history in this window is discarded.`)) return;
  $('#editor').close();
  S.buf.delete(s.id);
  applyServers(await api.deleteServer(s.id));
  openOverview();
});
$('#testServer').addEventListener('click', async () => {
  const f = $('#editorForm');
  if (!f.reportValidity()) return;
  const out = $('#testResult');
  out.hidden = false;
  out.className = 'test-result';
  out.textContent = 'Connecting, uploading the script and reading one sample…';
  $('#testServer').disabled = true;
  try {
    const r = await api.testServer(readForm(), f.elements.passphrase.value || undefined);
    if (r.ok) {
      const d = r.sample;
      out.className = 'test-result ok';
      out.textContent = `✓ Connected to ${d.host} (${d.ncpu} cores)\n` +
        `CPU busy ${fmtPct(d.cpu.busy)} · RAM ${fmtBytes(d.mem.used)} / ${fmtBytes(d.mem.total)} · disk ${d.disk.pct}%\n` +
        `Modules found: ${d.modules.map((m) => m.name).join(', ') || 'none'}\n` +
        `Queue: ${d.queue ? `${d.queue.pending} pending` : 'not readable / disabled'}` +
        (r.hostKey && !f.dataset.hostKey ? `\nHost key: ${r.hostKey}` : '');
      if (r.hostKey && !f.dataset.hostKey) f.dataset.hostKey = r.hostKey;
    } else {
      out.className = 'test-result fail';
      out.textContent = `✕ ${r.error}`;
    }
  } finally {
    $('#testServer').disabled = false;
  }
});
$('#editorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('#editorForm');
  if (!f.reportValidity()) return;
  const profile = readForm();
  const pass = f.elements.passphrase.value || undefined;
  const list = await api.saveServer(profile);
  $('#editor').close();
  applyServers(list);
  const saved = profile.id ? serverById(profile.id) : list[list.length - 1];
  if (saved) {
    const st = effectiveStatus(saved.id).state;
    if (!['connecting', 'streaming', 'stale', 'reconnecting'].includes(st) || pass) api.connect(saved.id, pass);
    openDetail(saved.id);
  }
});

let passId = null;
function askPassphrase(id) {
  passId = id;
  const s = serverById(id);
  $('#passText').textContent = `Private key for ${s?.name} (${s?.privateKeyPath}) is encrypted. The passphrase stays in memory until the app closes.`;
  $('#passForm').reset();
  $('#passDialog').showModal();
}
$('#passCancel').addEventListener('click', () => $('#passDialog').close());
$('#passForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pass = $('#passForm').elements.passphrase.value;
  $('#passDialog').close();
  if (passId && pass) api.connect(passId, pass);
});

// ================================================================== wiring
function applyServers(list) {
  S.servers = list;
  for (const s of list) if (s.status && !S.status.has(s.id)) S.status.set(s.id, s.status);
  renderSidebar();
  if (S.page === 'overview') buildOverview();
  else if (!serverById(S.sel)) openOverview();
  else updateDetail();
}

$('#navOverview').addEventListener('click', openOverview);
$('#addServer').addEventListener('click', () => openEditor(null));
$('#emptyAdd').addEventListener('click', () => openEditor(null));
$('#connectAll').addEventListener('click', () => api.connectAll());
$('#disconnectAll').addEventListener('click', () => api.disconnectAll());
$('#btnConnect').addEventListener('click', () => {
  if (effectiveStatus(S.sel).state === 'needs-passphrase') askPassphrase(S.sel);
  else api.connect(S.sel);
});
$('#btnDisconnect').addEventListener('click', () => api.disconnect(S.sel));
$('#btnEdit').addEventListener('click', () => openEditor(S.sel));
$('#btnTerminal').addEventListener('click', () => api.openTerminal(S.sel));

function syncWindowButtons() {
  document.querySelectorAll('#windowSel button').forEach((b) => b.classList.toggle('on', Number(b.dataset.ms) === S.windowMs));
}
document.querySelectorAll('#windowSel button').forEach((b) => b.addEventListener('click', () => {
  S.windowMs = Number(b.dataset.ms);
  savePref('windowMs', S.windowMs);
  syncWindowButtons();
  if (S.page === 'overview') updateCompare(); else updateDetail();
}));

api.onSample(({ serverId, data }) => { pushSample(serverId, data); markDirty(serverId); });
api.onStatus(({ serverId, state, message }) => {
  S.status.set(serverId, { state, message });
  if (state === 'needs-passphrase' && !$('#passDialog').open && !$('#editor').open) askPassphrase(serverId);
  markDirty(serverId);
});
api.onLog(({ serverId, line, t }) => {
  if (!S.logs.has(serverId)) S.logs.set(serverId, []);
  const logs = S.logs.get(serverId);
  const entry = `${fmtClock(t, true)}  ${line}`;
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  if (S.page === 'detail' && S.sel === serverId) {
    const box = $('#logBox');
    box.textContent = logs.join('\n');
    box.scrollTop = box.scrollHeight;
  }
});
api.onServers(applyServers);

// tick: ages, stale detection, sliding time axis while idle
setInterval(() => {
  S.servers.forEach((s) => markDirty(s.id));
}, 2000);

(async () => {
  const info = await api.info();
  S.mock = info.mock;
  $('#mockBadge').hidden = !info.mock;
  syncWindowButtons();
  applyServers(await api.listServers());
  openOverview();
})();
