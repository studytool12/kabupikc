'use strict';
const state = { stocks: [], prices: {}, removed: [], view: 'watchlist', sortKey: 'code', sortDir: 1, chartRange: 252, chartId: null, sectorMode: 'holdings', flash: new Map(), fingerprint: null, lastCheckedAt: null, chartHover: null, chartPts: [], chartAll: [], chartStockObj: null };

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? '-' : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const pct = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
const cls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4200);
}

// Unlock token: kept in page memory ONLY (never localStorage /
// sessionStorage / Cookie), so a page reload drops it and the lock
// screen comes back — the password must be entered again.
let appToken = null;

function showLock() {
  appToken = null;
  $('#lock-screen').classList.remove('hidden');
  const pw = $('#lock-password');
  pw.value = '';
  setTimeout(() => pw.focus(), 0);
}

function hideLock() {
  $('#lock-screen').classList.add('hidden');
  $('#lock-error').textContent = '';
}

function showLoading() { $('#loading-screen').classList.remove('hidden'); }
function hideLoading() { $('#loading-screen').classList.add('hidden'); }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (appToken) headers['X-App-Token'] = appToken;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401) { showLock(); throw new Error(`${path} -> 401`); }
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lock-error').textContent = '';
  showLoading();
  try {
    const r = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#lock-password').value }),
    });
    if (!r.ok) { hideLoading(); $('#lock-error').textContent = 'パスワードが違います'; return; }
    const j = await r.json();
    appToken = j.token;
    $('#lock-password').value = '';
    await loadAll();
    hideLock();
    hideLoading();
    updateAutoStatus();
    pollOnce();
  } catch (err) { hideLoading(); $('#lock-error').textContent = '通信に失敗しました'; }
});

// ---------- tags / sector helpers ----------
// Fallback sector map (JPX 33業種) for the current watchlist, used only when
// a stock record has no `sector` of its own. The per-stock sector field
// (editable in the edit dialog) always takes precedence.
const SECTOR_MAP = {
  '1332': '水産・農林業', '1801': '建設業', '1802': '建設業', '1803': '建設業', '186A': 'サービス業',
  '1887': '建設業', '1944': '建設業', '2269': '食料品', '2353': '不動産業', '2602': '食料品',
  '2702': '小売業', '2768': '卸売業', '285A': '電気機器', '290A': 'サービス業', '3038': '卸売業',
  '3132': '卸売業', '3289': '不動産業', '3371': '情報・通信業', '3407': '化学', '3436': '金属製品',
  '3659': '情報・通信業', '3687': '情報・通信業', '3692': '情報・通信業', '3778': '情報・通信業',
  '3905': '情報・通信業', '3921': '情報・通信業', '3923': '情報・通信業', '3993': '情報・通信業',
  '3994': '情報・通信業', '4062': '電気機器', '4063': '化学', '4186': '化学', '4194': 'サービス業',
  '4204': '化学', '4259': '情報・通信業', '4264': '情報・通信業', '4369': '化学',
  '4396': '情報・通信業', '4443': '情報・通信業', '4475': '情報・通信業', '4478': '情報・通信業',
  '4493': '情報・通信業', '4498': '情報・通信業', '4506': '医薬品', '4523': '医薬品', '4568': '医薬品',
  '4661': 'サービス業', '4674': '情報・通信業', '4755': 'サービス業', '4776': '情報・通信業',
  '4828': '情報・通信業', '5384': '化学', '5401': '鉄鋼', '5574': '情報・通信業', '5631': '機械',
  '5801': '非鉄金属', '5803': '非鉄金属', '593A': '情報・通信業', '6036': 'サービス業', '6055': '化学',
  '6146': '機械', '6254': '機械', '6266': '機械', '6315': '機械', '6323': '機械', '6324': '機械',
  '6330': '建設業', '6367': '機械', '642A': '電気・ガス業', '6501': '電気機器', '6525': '機械',
  '6526': '電気機器', '6590': '機械', '6758': '電気機器', '6857': '電気機器', '6861': '電気機器',
  '6871': '電気機器', '6890': '金属製品', '6920': '電気機器', '6981': '電気機器', '7011': '機械',
  '7012': '輸送用機器', '7013': '機械', '7203': '輸送用機器', '7261': '輸送用機器', '7721': '精密機器',
  '7729': '精密機器', '7751': '電気機器', '7832': 'その他製品', '7974': 'その他製品', '8001': '卸売業',
  '8002': '卸売業', '8031': '卸売業', '8035': '電気機器', '8058': '卸売業', '8136': '卸売業',
  '8267': '小売業', '8306': '銀行業', '8316': '銀行業', '8411': '銀行業', '8572': 'その他金融業',
  '8593': 'その他金融業', '8729': '保険業', '8766': '保険業', '9101': '海運業', '9104': '海運業',
  '9432': '情報・通信業', '9433': '情報・通信業', '9434': '情報・通信業', '9501': '電気・ガス業',
  '9503': '電気・ガス業', '9509': '電気・ガス業', '9602': '情報・通信業', '9697': '情報・通信業',
  '9984': '情報・通信業',
};

function sectorOf(s) {
  return (s.sector && String(s.sector).trim()) || SECTOR_MAP[String(s.code)] || '未分類';
}

function parseTags(s) {
  if (!s.tags) return [];
  return String(s.tags).split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean);
}

// External per-stock pages (Yahoo!ファイナンス / 株探), opened in a new tab.
function extLinks(s) {
  const code = encodeURIComponent(String(s.code));
  return `<span class="ext-links"><a href="https://finance.yahoo.co.jp/quote/${code}.T" target="_blank" rel="noopener">Yahoo</a><a href="https://kabutan.jp/stock/?code=${code}" target="_blank" rel="noopener">株探</a></span>`;
}

function verdictBadge(v) {
  if (!v) return '<span class="badge none">未分析</span>';
  const c = (v === '買い' || v === '強い買い') ? 'buy' : (v.includes('待ち') ? 'wait' : (v === '見送り' ? 'none' : 'watch'));
  return `<span class="badge ${c}">${esc(v)}</span>`;
}

function isUnanalyzed(s) { return !s.last_analysis_date || !s.verdict; }

async function fetchData() {
  const [a, b, c, d] = await Promise.all([api('/api/stocks'), api('/api/prices'), api('/api/removed'), api('/api/summary')]);
  return { stocks: a.stocks, prices: b.series, removed: c.removed, summary: d };
}

// Cheap change detector for the auto-update poller: covers everything the
// views display (prices, verdicts, holdings, tags, last price point, archive).
function fingerprintOf(data) {
  const parts = [];
  for (const s of data.stocks) {
    parts.push([s.id, s.price, s.price_change_percent, s.verdict, s.score, s.shares, s.avg_cost, s.tags, s.memo, s.sector].join(':'));
    const pts = data.prices[s.id];
    if (pts && pts.length) { const l = pts[pts.length - 1]; parts.push(l.date + '@' + l.price); }
  }
  parts.push('removed:' + data.removed.map((r) => r.archive_id).join(','));
  return parts.join('|');
}

function applyData(data) {
  // Record price moves vs. the previous snapshot so freshly rendered cells
  // can flash. state.flash: stock id -> +1 (up) / -1 (down).
  const flash = new Map();
  const prev = new Map(state.stocks.map((s) => [s.id, s.price]));
  for (const s of data.stocks) {
    const p = prev.get(s.id);
    if (p != null && s.price != null && s.price !== p) flash.set(s.id, s.price > p ? 1 : -1);
  }
  state.flash = flash;
  state.stocks = data.stocks;
  state.prices = data.prices;
  state.removed = data.removed;
  state.fingerprint = fingerprintOf(data);
  state.lastCheckedAt = new Date();
  const d = data.summary;
  const parts = Object.entries(d.byVerdict).map(([k, v]) => `${k} ${v}`).join(' / ');
  $('#summary-line').textContent = `全${d.total}銘柄（${parts}）`;
  const sel = $('#verdict-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">判断：すべて</option>' + [...new Set(state.stocks.map((s) => s.verdict).filter(Boolean))].sort().map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = cur;
  const tsel = $('#tag-filter');
  const tcur = tsel.value;
  const allTags = [...new Set(state.stocks.flatMap((s) => parseTags(s)))].sort();
  tsel.innerHTML = '<option value="">タグ：すべて</option>' + allTags.map((t) => `<option>${esc(t)}</option>`).join('');
  tsel.value = allTags.includes(tcur) ? tcur : '';
}

async function loadAll() {
  applyData(await fetchData());
  render();
}

// CSS class for a numeric cell whose value just moved (flash effect).
function flashCls(s) {
  const f = state.flash.get(s.id);
  return f ? (f > 0 ? ' flash-up' : ' flash-down') : '';
}

// ---------- watchlist ----------
function sortedStocks(list) {
  const k = state.sortKey, dir = state.sortDir;
  return [...list].sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'ja')) * dir;
  });
}

function renderWatchlist() {
  const q = $('#search').value.trim();
  const vf = $('#verdict-filter').value;
  const tf = $('#tag-filter').value;
  const onlyH = $('#only-holdings').checked;
  let list = state.stocks.filter((s) =>
    (!q || s.name.includes(q) || String(s.code).includes(q)) &&
    (!vf || s.verdict === vf) &&
    (!tf || parseTags(s).includes(tf)) &&
    (!onlyH || s.is_holding || (s.shares ?? 0) > 0));
  list = sortedStocks(list);
  const cols = [
    ['code', 'コード', 'l'], ['name', '銘柄名', 'l'], ['price', '現在価格'], ['price_change_percent', '前日比%'],
    ['verdict', '判断', 'l'], ['score', 'スコア'], ['entry_price', '第一'], ['entry2_price', '第二'],
    ['stop_price', '損切り'], ['target_price', '利確'], ['shares', '株数'], ['last_analysis_date', '最終分析日', 'l'], ['', 'タグ・メモ', 'l'], ['', '', 'l'],
  ];
  $('#table-watchlist').innerHTML =
    '<tr>' + cols.map(([k, label, a]) => `<th class="${a || ''}" data-sort="${k}">${label}${state.sortKey === k ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>' +
    list.map((s) => {
      const tags = parseTags(s).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ');
      const memo = s.memo ? `<span class="memo-cell" title="${esc(s.memo)}">📝 ${esc(s.memo)}</span>` : '';
      return `<tr>
      <td class="l" data-label="コード">${esc(s.code)}</td><td class="l" data-label="銘柄名">${esc(s.name)}${s.is_holding ? ' <span class="badge wait">保有</span>' : ''} ${extLinks(s)}</td>
      <td data-label="現在価格" class="${flashCls(s).trim()}">${fmt(s.price, s.price < 100 ? 1 : 0)}</td>
      <td data-label="前日比%" class="${cls(s.price_change_percent)}${flashCls(s)}">${pct(s.price_change_percent)}</td>
      <td class="l" data-label="判断">${verdictBadge(s.verdict)}</td><td data-label="スコア">${fmt(s.score)}</td>
      <td data-label="第一">${fmt(s.entry_price)}</td><td data-label="第二" class="m-hide">${fmt(s.entry2_price)}</td><td data-label="損切り">${fmt(s.stop_price)}</td><td data-label="利確">${fmt(s.target_price)}</td>
      <td data-label="株数">${fmt(s.shares)}</td><td class="l m-hide" data-label="最終分析日">${esc(s.last_analysis_date || '-')}</td>
      <td class="l tags-cell" data-label="タグ・メモ">${tags}${tags && memo ? ' ' : ''}${memo}</td>
      <td class="l cell-action"><button data-edit="${s.id}">編集</button></td></tr>`;
    }).join('');
  bindTableCommon($('#table-watchlist'));
}

// ---------- movements ----------
function changeOver(points, daysBack) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const idx = Math.max(0, points.length - 1 - daysBack);
  const base = points[idx];
  if (!base || !base.price) return null;
  return ((last.price - base.price) / base.price) * 100;
}

function renderMovements() {
  const rows = sortedStocks(state.stocks).map((s) => {
    const pts = state.prices[s.id] || [];
    const last = pts[pts.length - 1];
    return { s, last, d5: changeOver(pts, 5), m1: changeOver(pts, 21), m3: changeOver(pts, 63), fromHigh: last && s.week52_high ? ((last.price - s.week52_high) / s.week52_high) * 100 : null };
  });
  $('#table-movements').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th>現在価格</th><th>前日比%</th><th>5日%</th><th>1か月%</th><th>3か月%</th><th>52週高値比%</th><th>基準日</th></tr>' +
    rows.map(({ s, last, d5, m1, m3, fromHigh }) => `<tr>
      <td class="l" data-label="コード">${esc(s.code)}</td><td class="l" data-label="銘柄名">${esc(s.name)}</td>
      <td data-label="現在価格" class="${flashCls(s).trim()}">${fmt(s.price, s.price < 100 ? 1 : 0)}</td>
      <td data-label="前日比%" class="${cls(s.price_change_percent)}${flashCls(s)}">${pct(s.price_change_percent)}</td>
      <td data-label="5日%" class="${cls(d5)}">${pct(d5)}</td><td data-label="1か月%" class="${cls(m1)}">${pct(m1)}</td><td data-label="3か月%" class="${cls(m3)}">${pct(m3)}</td>
      <td data-label="52週高値比%" class="${cls(fromHigh)}">${pct(fromHigh)}</td><td data-label="基準日">${last ? esc(last.date) : '-'}</td></tr>`).join('');
}

// ---------- holdings / portfolio ----------
function renderHoldings() {
  // Any open quick-entry panel belongs to a previous render; close it.
  const qp = $('#quick-panel');
  if (qp) qp.classList.add('hidden');
  quick = null;
  const holds = state.stocks.filter((s) => s.is_holding || (s.shares ?? 0) > 0);
  let totalVal = 0, totalCost = 0, totalPl = 0, hasCost = false;
  const rows = holds.map((s) => {
    const val = (s.shares ?? 0) * (s.price ?? 0);
    totalVal += val;
    let pl = null, plPct = null;
    if (s.avg_cost != null && s.price != null) {
      pl = (s.price - s.avg_cost) * (s.shares ?? 0);
      plPct = ((s.price - s.avg_cost) / s.avg_cost) * 100;
      totalCost += s.avg_cost * (s.shares ?? 0); totalPl += pl; hasCost = true;
    }
    return { s, val, pl, plPct };
  });
  const totalPlPct = hasCost && totalCost > 0 ? (totalPl / totalCost) * 100 : null;
  $('#holdings-summary').innerHTML =
    `<div class="card"><div class="k">保有銘柄数</div><div class="v">${holds.length}</div></div>
     <div class="card"><div class="k">評価額合計</div><div class="v">${fmt(totalVal)}円</div></div>
     <div class="card"><div class="k">取得額合計（単価が分かる分）</div><div class="v">${hasCost ? fmt(totalCost) + '円' : '-'}</div></div>
     <div class="card"><div class="k">含み損益合計</div><div class="v ${cls(hasCost ? totalPl : null)}">${hasCost ? fmt(totalPl) + '円' : '-'}</div></div>
     <div class="card"><div class="k">含み損益率</div><div class="v ${cls(totalPlPct)}">${totalPlPct != null ? pct(totalPlPct) : '-'}</div></div>`;
  $('#table-holdings').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th class="l">セクター</th><th>株数</th><th>平均取得単価</th><th>現在価格</th><th>評価額</th><th>評価損益</th><th>損益率</th><th class="l">判断</th><th class="l">買値・買い増し</th></tr>' +
    rows.map(({ s, val, pl, plPct }) => `<tr>
      <td class="l" data-label="コード">${esc(s.code)}</td><td class="l" data-label="銘柄名">${esc(s.name)}</td><td class="l" data-label="セクター">${esc(sectorOf(s))}</td><td data-label="株数">${fmt(s.shares)}</td>
      <td data-label="平均取得単価">${s.avg_cost != null ? fmt(s.avg_cost, 1) : '<span class="small">未設定</span>'}</td>
      <td data-label="現在価格" class="${flashCls(s).trim()}">${fmt(s.price, s.price < 100 ? 1 : 0)}</td><td data-label="評価額" class="${flashCls(s).trim()}">${fmt(val)}</td>
      <td data-label="評価損益" class="${cls(pl)}${flashCls(s)}">${pl != null ? fmt(pl) : '-'}</td>
      <td data-label="損益率" class="${cls(plPct)}">${plPct != null ? pct(plPct) : '-'}</td>
      <td class="l" data-label="判断">${verdictBadge(s.verdict)}</td>
      <td class="l quick-cell"><button data-costbtn="${s.id}">買値</button> <button data-addbtn="${s.id}">買い増し</button></td></tr>`).join('');
  document.querySelectorAll('[data-costbtn]').forEach((b) => b.addEventListener('click', () => openQuick(Number(b.dataset.costbtn), 'cost')));
  document.querySelectorAll('[data-addbtn]').forEach((b) => b.addEventListener('click', () => openQuick(Number(b.dataset.addbtn), 'add')));
  renderSectorPie();
}

// ---------- quick entry: 買値 (avg cost) / 買い増し (add shares) ----------
// Saves through the existing partial-update PUT /api/stocks/:id, then a full
// reload re-renders the holdings summary (評価額・含み損益) immediately.
let quick = null;

function openQuick(id, mode) {
  const s = state.stocks.find((x) => x.id === id);
  if (!s) return;
  quick = { id, mode };
  const panel = $('#quick-panel');
  $('#quick-title').textContent = mode === 'cost'
    ? `買値の登録：${s.code} ${s.name}`
    : `買い増しの登録：${s.code} ${s.name}`;
  $('#quick-fields').innerHTML = mode === 'cost'
    ? `<label>平均取得単価（円）<input id="quick-cost" type="number" min="0" step="0.1" value="${s.avg_cost ?? ''}" placeholder="例：1500"></label>
       <span class="small">現在の保有株数：${fmt(s.shares)}株</span>`
    : `<label>追加した株数<input id="quick-add-shares" type="number" min="0" step="1" placeholder="例：100"></label>
       <label>その取得単価（円）<input id="quick-add-price" type="number" min="0" step="0.1" placeholder="例：1620"></label>
       <span class="small">現在：${fmt(s.shares)}株／平均 ${s.avg_cost != null ? fmt(s.avg_cost, 1) + '円' : '未設定'}（保存時に加重平均で再計算します）</span>`;
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const first = panel.querySelector('input');
  if (first) first.focus();
}

$('#quick-cancel').addEventListener('click', () => {
  quick = null;
  $('#quick-panel').classList.add('hidden');
});

$('#quick-save').addEventListener('click', async () => {
  if (!quick) return;
  const s = state.stocks.find((x) => x.id === quick.id);
  if (!s) return;
  let body;
  if (quick.mode === 'cost') {
    const v = Number($('#quick-cost').value);
    if (!v || v <= 0) { toast('平均取得単価を入力してください'); return; }
    body = { avg_cost: v };
  } else {
    const addSh = Number($('#quick-add-shares').value);
    const addPr = Number($('#quick-add-price').value);
    if (!addSh || addSh <= 0 || !addPr || addPr <= 0) { toast('追加した株数と取得単価を入力してください'); return; }
    const oldSh = s.shares ?? 0;
    const newSh = oldSh + addSh;
    // Weighted average; if the old average is unknown, the new lot's price
    // is the only cost information available, so it becomes the average.
    const newAvg = s.avg_cost == null ? addPr : (oldSh * s.avg_cost + addSh * addPr) / newSh;
    body = { shares: newSh, avg_cost: Math.round(newAvg * 100) / 100, is_holding: true };
  }
  try {
    await api(`/api/stocks/${quick.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(quick.mode === 'cost' ? '買値を保存しました' : '買い増しを保存しました');
    quick = null;
    $('#quick-panel').classList.add('hidden');
    await loadAll();
  } catch (e) { toast(`保存に失敗: ${e.message}`); }
});

// ---------- sector pie chart (Canvas, no external deps) ----------
const PIE_COLORS = ['#2f6db3', '#2e7d5b', '#66bb6a', '#ffd54f', '#ff8a65', '#4fc3f7', '#9575cd', '#f06292',
  '#a1887f', '#90a4ae', '#dce775', '#ffb74d', '#64b5f6', '#81c784', '#e57373', '#ba68c8', '#4db6ac', '#aed581'];

function sectorEntries() {
  const map = new Map();
  if (state.sectorMode === 'all') {
    for (const s of state.stocks) {
      const k = sectorOf(s);
      const e = map.get(k) || { label: k, value: 0, unit: '銘柄' };
      e.value += 1;
      map.set(k, e);
    }
  } else {
    for (const s of state.stocks) {
      if (!(s.is_holding || (s.shares ?? 0) > 0)) continue;
      const v = (s.shares ?? 0) * (s.price ?? 0);
      if (v <= 0) continue;
      const k = sectorOf(s);
      const e = map.get(k) || { label: k, value: 0, unit: '円' };
      e.value += v;
      map.set(k, e);
    }
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}

function drawPie(canvas, entries) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 260, H = canvas.clientHeight || 260;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const total = entries.reduce((a, e) => a + e.value, 0);
  if (!total) {
    ctx.fillStyle = '#999'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('表示できるデータがありません', W / 2, H / 2);
    return;
  }
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 6;
  let ang = -Math.PI / 2;
  entries.forEach((e, i) => {
    const sweep = (e.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, ang, ang + sweep);
    ctx.closePath();
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    ang += sweep;
  });
}

function renderSectorPie() {
  const canvas = $('#sector-canvas');
  if (!canvas) return;
  const entries = sectorEntries();
  drawPie(canvas, entries);
  const total = entries.reduce((a, e) => a + e.value, 0);
  $('#sector-legend').innerHTML = entries.length && total
    ? entries.map((e, i) => `<div class="legend-row"><span class="swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
        <span class="legend-label">${esc(e.label)}</span>
        <span class="legend-val">${state.sectorMode === 'all' ? e.value + '銘柄' : fmt(e.value) + '円'}（${(e.value / total * 100).toFixed(1)}%）</span></div>`).join('')
    : '<p class="small">表示できるデータがありません。</p>';
}

// ---------- P&L simulation (in-page only, nothing is saved) ----------
function renderSim() {
  const sel = $('#sim-stock');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = state.stocks.map((s) => `<option value="${s.id}">${esc(s.code)} ${esc(s.name)}</option>`).join('');
  if (cur && state.stocks.some((s) => String(s.id) === cur)) sel.value = cur;
  updateSim();
}

function updateSim() {
  const out = $('#sim-result');
  if (!out) return;
  const s = state.stocks.find((x) => x.id === Number($('#sim-stock').value));
  const shares = Number($('#sim-shares').value);
  const cost = Number($('#sim-cost').value);
  if (!s || s.price == null) { out.textContent = '銘柄の現在価格がありません。'; return; }
  if (!shares || shares <= 0) { out.textContent = '株数を入力してください。'; return; }
  const val = shares * s.price;
  let html = `<span>現在価格 <b>${fmt(s.price, s.price < 100 ? 1 : 0)}円</b></span><span>評価額 <b>${fmt(val)}円</b></span>`;
  if (cost > 0) {
    const pl = (s.price - cost) * shares;
    const plPct = ((s.price - cost) / cost) * 100;
    html += `<span>取得額 <b>${fmt(shares * cost)}円</b></span><span>含み損益 <b class="${cls(pl)}">${fmt(pl)}円</b></span><span>損益率 <b class="${cls(plPct)}">${pct(plPct)}</b></span>`;
  } else {
    html += '<span class="small">買値を入れると含み損益も計算します</span>';
  }
  out.innerHTML = html;
}

// ---------- chart ----------
function renderChart() {
  const sel = $('#chart-stock');
  if (!sel.options.length) {
    sel.innerHTML = state.stocks.map((s) => `<option value="${s.id}">${esc(s.code)} ${esc(s.name)}</option>`).join('');
    const ntt = state.stocks.find((s) => String(s.code) === '9432');
    state.chartId = ntt ? ntt.id : (state.stocks[0] && state.stocks[0].id);
    sel.value = state.chartId;
  }
  const s = state.stocks.find((x) => x.id === Number(sel.value)) || state.stocks[0];
  if (!s) return;
  state.chartId = s.id;
  const all = state.prices[s.id] || [];
  const pts = state.chartRange > 0 ? all.slice(-state.chartRange) : all;
  $('#chart-meta').innerHTML =
    `<b>${esc(s.code)} ${esc(s.name)}</b> ${extLinks(s)} 現在 ${fmt(s.price, s.price < 100 ? 1 : 0)}円
     <span class="${cls(s.price_change_percent)}">${pct(s.price_change_percent)}</span>
     ${verdictBadge(s.verdict)} スコア ${fmt(s.score)} / 第一 ${fmt(s.entry_price)} / 損切り ${fmt(s.stop_price)} / 利確 ${fmt(s.target_price)}
     <span class="small">（${pts.length}営業日分を表示）</span>`;
  $('#chart-report').textContent = s.report || '（分析レポートなし）';
  state.chartPts = pts;
  state.chartAll = all;
  state.chartStockObj = s;
  state.chartHover = null;
  $('#chart-tip').classList.add('hidden');
  paintChart();
}

function paintChart() {
  const s = state.chartStockObj;
  if (!s) return;
  drawChart($('#chart-canvas'), state.chartPts, {
    bollinger: $('#opt-bb').checked, ma75: $('#opt-ma').checked,
    rsi: $('#opt-rsi').checked, macd: $('#opt-macd').checked,
    entry: s.entry_price, stop: s.stop_price, target: s.target_price,
    hoverIdx: state.chartHover,
  });
}

// ---------- chart crosshair / detail tooltip ----------
// Pointer (mouse + touch) over the canvas: the nearest data point gets a
// crosshair and a tooltip with that day's OHLC / change% / volume. The
// tooltip lives only while pointing; releasing or leaving hides it.
function chartIndexFromEvent(e) {
  const canvas = $('#chart-canvas');
  const g = canvas._geom;
  if (!g || !state.chartPts.length) return null;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const i = Math.round(((x - g.left) / g.plotW) * g.n - 0.5);
  return Math.max(0, Math.min(g.n - 1, i));
}

function showChartTip(i) {
  const tip = $('#chart-tip');
  const pts = state.chartPts, all = state.chartAll;
  const p = pts[i];
  if (!p) { tip.classList.add('hidden'); return; }
  const prev = all[all.length - pts.length + i - 1];
  const chg = prev && prev.price ? ((p.price - prev.price) / prev.price) * 100 : null;
  const dec = p.price < 100 ? 1 : 0;
  const o = p.open ?? p.price, h = p.high ?? Math.max(o, p.price), l = p.low ?? Math.min(o, p.price);
  tip.innerHTML =
    `<div class="tt-date">${esc(p.date)}</div>` +
    `<div>始値 ${fmt(o, dec)}　高値 ${fmt(h, dec)}</div>` +
    `<div>安値 ${fmt(l, dec)}　終値 ${fmt(p.price, dec)}</div>` +
    `<div>前日比 <span class="${cls(chg)}">${chg != null ? pct(chg) : '-'}</span></div>` +
    `<div>出来高 ${p.volume != null ? fmt(p.volume) : '-'}</div>`;
  tip.classList.remove('hidden');
  // Follow the point horizontally; flip to the left side near the right edge.
  const canvas = $('#chart-canvas');
  const g = canvas._geom;
  const wrapW = canvas.clientWidth;
  const gx = g.left + (g.plotW * (i + 0.5)) / g.n;
  const tw = tip.offsetWidth;
  tip.style.left = `${gx > wrapW * 0.55 ? Math.max(0, gx - tw - 12) : Math.min(wrapW - tw, gx + 12)}px`;
}

function chartPointTo(i) {
  if (i == null) return;
  if (i !== state.chartHover) { state.chartHover = i; paintChart(); }
  showChartTip(i);
}

function clearChartHover() {
  if (state.chartHover != null) { state.chartHover = null; paintChart(); }
  $('#chart-tip').classList.add('hidden');
}

{
  const canvas = $('#chart-canvas');
  canvas.addEventListener('pointerdown', (e) => { if (state.view === 'chart') chartPointTo(chartIndexFromEvent(e)); });
  canvas.addEventListener('pointermove', (e) => { if (state.view === 'chart') chartPointTo(chartIndexFromEvent(e)); });
  canvas.addEventListener('pointerleave', clearChartHover);
  canvas.addEventListener('pointerup', clearChartHover);
  canvas.addEventListener('pointercancel', clearChartHover);
}

// ---------- actions (要対応) ----------
function renderActions() {
  const entryHit = [], stopHit = [], nearEntry = [], unan = [];
  for (const s of state.stocks) {
    if (isUnanalyzed(s)) { unan.push(s); continue; }
    if (s.price != null && s.entry_price != null && s.price <= s.entry_price) entryHit.push(s);
    else if (s.price != null && s.entry_price != null && s.price <= s.entry_price * 1.03) nearEntry.push(s);
    if ((s.is_holding || (s.shares ?? 0) > 0) && s.price != null && s.stop_price != null && s.price <= s.stop_price) stopHit.push(s);
  }
  const row = (s, note) => `<tr><td class="l" data-label="コード">${esc(s.code)}</td><td class="l" data-label="銘柄名">${esc(s.name)}</td><td data-label="現在価格">${fmt(s.price, s.price < 100 ? 1 : 0)}</td><td class="l" data-label="判断">${verdictBadge(s.verdict)}</td><td data-label="スコア">${fmt(s.score)}</td><td data-label="第一">${fmt(s.entry_price)}</td><td data-label="損切り">${fmt(s.stop_price)}</td><td data-label="利確">${fmt(s.target_price)}</td><td class="l" data-label="メモ">${note}</td><td class="l cell-action"><button data-edit="${s.id}">編集</button></td></tr>`;
  const group = (title, list, noteFn) => list.length ? `<div class="action-group"><h3>${title}（${list.length}件）</h3><div class="table-wrap"><table>
    <tr><th class="l">コード</th><th class="l">銘柄名</th><th>現在価格</th><th class="l">判断</th><th>スコア</th><th>第一</th><th>損切り</th><th>利確</th><th class="l">メモ</th><th></th></tr>
    ${list.map((s) => row(s, noteFn(s))).join('')}</table></div></div>` : '';
  $('#actions-list').innerHTML =
    group('🔴 保有銘柄の損切り割れ', stopHit, () => '損切りラインを下回っています') +
    group('🟢 第一エントリー到達（買い目安）', entryHit, (s) => `目安 ${fmt(s.entry_price)}円 に到達`) +
    group('🟡 第一エントリー接近（3%以内）', nearEntry, (s) => `目安まで ${(((s.price - s.entry_price) / s.entry_price) * 100).toFixed(1)}%`) +
    group('⚪ 未分析', unan, () => '分析が未登録です') ||
    '<p>要対応の銘柄はありません。</p>';
  bindTableCommon($('#actions-list'));
}

// ---------- queue ----------
function renderQueue() {
  const list = state.stocks.filter(isUnanalyzed);
  $('#table-queue').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th>現在価格</th><th class="l">判断</th><th class="l">最終分析日</th><th></th></tr>' +
    (list.map((s) => `<tr><td class="l" data-label="コード">${esc(s.code)}</td><td class="l" data-label="銘柄名">${esc(s.name)}</td><td data-label="現在価格">${fmt(s.price)}</td><td class="l" data-label="判断">${verdictBadge(s.verdict)}</td><td class="l" data-label="最終分析日">${esc(s.last_analysis_date || '-')}</td><td class="l cell-action"><button data-edit="${s.id}">編集</button></td></tr>`).join('') ||
      '<tr><td class="l" colspan="6">未分析の銘柄はありません。</td></tr>');
  bindTableCommon($('#table-queue'));
}

// ---------- archive ----------
function renderArchive() {
  $('#table-archive').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th class="l">削除日時</th><th class="l">削除前の判断</th><th class="l">メモ（抜粋）</th><th></th></tr>' +
    (state.removed.map((r) => `<tr><td class="l" data-label="コード">${esc(r.code)}</td><td class="l" data-label="銘柄名">${esc(r.name)}</td><td class="l" data-label="削除日時">${esc((r.removed_at || '').slice(0, 10))}</td><td class="l" data-label="削除前の判断">${esc(r.prev_verdict || r.verdict || '-')}</td><td class="l memo-wrap" data-label="メモ（抜粋）">${esc((r.prev_memo || r.memo || '').slice(0, 140))}</td><td class="l cell-action"><button data-restore="${r.archive_id}">復元</button> <button data-purge="${r.archive_id}" class="danger">削除</button></td></tr>`).join('') ||
      '<tr><td class="l" colspan="6">アーカイブはありません。</td></tr>');
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/removed/${b.dataset.restore}/restore`, { method: 'POST' });
    toast('復元しました');
    await loadAll();
  }));
  document.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('このアーカイブ銘柄を完全に削除しますか？\n削除すると復元できなくなります。')) return;
    await api(`/api/removed/${b.dataset.purge}`, { method: 'DELETE' });
    toast('完全に削除しました');
    await loadAll();
  }));
}

function bindTableCommon(root) {
  root.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (!k) return;
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
    render();
  }));
  root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEdit(Number(b.dataset.edit))));
}

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${state.view}`).classList.remove('hidden');
  ({ watchlist: renderWatchlist, movements: renderMovements, holdings: renderHoldings, simulation: renderSim, chart: renderChart, actions: renderActions, queue: renderQueue, archive: renderArchive })[state.view]();
}

// ---------- edit dialog ----------
let editingId = null;
function openEdit(id) {
  const s = state.stocks.find((x) => x.id === id);
  editingId = id ?? null;
  $('#edit-title').textContent = s ? `銘柄編集：${s.code} ${s.name}` : '銘柄追加';
  $('#btn-delete').style.display = s ? '' : 'none';
  const form = $('#edit-form');
  form.reset();
  if (s) {
    for (const el of form.elements) {
      if (el.name && s[el.name] !== undefined && s[el.name] !== null) el.value = s[el.name];
    }
    // Pre-fill sector from the fallback map so saving persists it.
    const secEl = form.elements.namedItem('sector');
    if (secEl && !secEl.value && SECTOR_MAP[String(s.code)]) secEl.value = SECTOR_MAP[String(s.code)];
  }
  $('#edit-dialog').showModal();
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = $('#edit-form');
  const body = {};
  const numeric = ['score', 'price', 'entry_price', 'entry2_price', 'stop_price', 'target_price', 'shares', 'avg_cost'];
  for (const el of form.elements) {
    if (!el.name) continue;
    let v = el.value;
    if (numeric.includes(el.name)) v = v === '' ? null : Number(v);
    if (el.name === 'last_analysis_date' && v === '') v = null;
    body[el.name] = v;
  }
  body.is_holding = (Number(body.shares) || 0) > 0;
  try {
    if (editingId) await api(`/api/stocks/${editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/api/stocks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#edit-dialog').close();
    toast('保存しました');
    await loadAll();
  } catch (err) { toast(`保存に失敗: ${err.message}`); }
});
$('#btn-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#btn-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('この銘柄を削除しますか？（アーカイブに退避され、復元できます）')) return;
  await api(`/api/stocks/${editingId}`, { method: 'DELETE' });
  $('#edit-dialog').close();
  toast('アーカイブへ移動しました');
  await loadAll();
});
$('#btn-add').addEventListener('click', () => openEdit(null));

// ---------- header / tabs ----------
$('#btn-refresh').addEventListener('click', async () => {
  const btn = $('#btn-refresh');
  btn.disabled = true; btn.textContent = '更新中…（全銘柄）';
  try {
    const r = await api('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(`価格更新完了: ${r.updated}/${r.total}銘柄、新規ポイント ${r.addedPoints}件${r.failures.length ? `、失敗 ${r.failures.length}件` : ''}`);
    await loadAll();
  } catch (e) { toast(`価格更新に失敗: ${e.message}`); }
  btn.disabled = false; btn.textContent = '価格更新';
});
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; render(); }));
$('#search').addEventListener('input', renderWatchlist);
$('#verdict-filter').addEventListener('change', renderWatchlist);
$('#tag-filter').addEventListener('change', renderWatchlist);
$('#only-holdings').addEventListener('change', renderWatchlist);
document.querySelectorAll('#sector-mode button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#sector-mode button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.sectorMode = b.dataset.mode;
  renderSectorPie();
}));
$('#sim-stock').addEventListener('change', () => {
  // Prefill the buy price with the stock's first entry level (or price).
  const s = state.stocks.find((x) => x.id === Number($('#sim-stock').value));
  const costEl = $('#sim-cost');
  if (s && !costEl.value) costEl.value = s.entry_price ?? s.price ?? '';
  updateSim();
});
$('#sim-shares').addEventListener('input', updateSim);
$('#sim-cost').addEventListener('input', updateSim);
$('#auto-toggle').addEventListener('change', updateAutoStatus);
$('#chart-stock').addEventListener('change', renderChart);
document.querySelectorAll('#chart-range button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#chart-range button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.chartRange = Number(b.dataset.range);
  renderChart();
}));
['opt-bb', 'opt-ma', 'opt-rsi', 'opt-macd'].forEach((id) => $('#' + id).addEventListener('change', renderChart));
window.addEventListener('resize', () => {
  if (state.view === 'chart') renderChart();
  if (state.view === 'holdings') renderSectorPie();
});

// ---------- clock (JST) ----------
// Rendered into a dedicated fixed-width slot in the tab row; textContent
// updates only, so the clock never moves any other element. Runs on its
// own timer, independent of the lock state and the data polling.
const clockTimeFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const clockDateFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
// ---------- market session countdown (JST) ----------
// Displayed in its own row under the clock; the clock slot itself is never
// touched by this code. Sessions (weekdays only, holidays ignored — same
// treatment as the server auto-refresh): 前場 9:00-11:30, 後場 12:30-15:30.
// Only the single next milestone is shown (e.g. during 前場 it counts down
// to 前場終了); after the close (or on weekends) it rolls to the next
// weekday's 前場開始.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SESSION_MARKS = [
  { label: '前場開始まで', off: 9 * 3600e3, past: '開始済' },
  { label: '前場終了まで', off: 11.5 * 3600e3, past: '終了' },
  { label: '後場開始まで', off: 12.5 * 3600e3, past: '開始済' },
  { label: '後場終了まで', off: 15.5 * 3600e3, past: '終了' },
];
function jstDayStart(ms) { return Math.floor((ms + JST_OFFSET_MS) / 86400e3) * 86400e3 - JST_OFFSET_MS; }
function jstWeekday(dayStartMs) { return new Date(dayStartMs + JST_OFFSET_MS).getUTCDay(); }
function remainText(targetMs, nowMs) {
  const sec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  return `あと${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`;
}
function tickCountdown() {
  const el = $('#market-countdown');
  if (!el) return;
  const nowMs = Date.now();
  const todayStart = jstDayStart(nowMs);
  // Find the next session mark still in the future, scanning today first
  // and then the following weekdays (weekends skipped).
  let found = null;
  for (let add = 0; add < 8 && !found; add++) {
    const day = todayStart + add * 86400e3;
    const wd = jstWeekday(day);
    if (wd === 0 || wd === 6) continue;
    for (const m of SESSION_MARKS) {
      const t = day + m.off;
      if (t > nowMs) { found = { day, mark: m, target: t }; break; }
    }
  }
  if (!found) { el.textContent = ''; return; }
  const isToday = found.day === todayStart;
  const label = isToday ? found.mark.label : `${clockDateFmt.format(new Date(found.day + 12 * 3600e3))}の${found.mark.label}`;
  el.innerHTML = `<span class="mc-item">${label} <b>${remainText(found.target, nowMs)}</b></span>`;
}

function tickClock() {
  const now = new Date();
  const t = $('#clock-time');
  if (t) t.textContent = clockTimeFmt.format(now);
  const d = $('#clock-date');
  if (d) d.textContent = clockDateFmt.format(now);
  tickCountdown();
}
tickClock();
setInterval(tickClock, 1000);

// ---------- auto update (polling) ----------
// The server refreshes prices from Yahoo every 3 min during market hours;
// this page re-reads the data every 60 s and re-renders only when something
// actually changed (fingerprint check), flashing the cells that moved.
const POLL_MS = 60 * 1000;
let serverStatus = null;

function fmtTime(d) {
  return d ? d.toLocaleTimeString('ja-JP', { hour12: false }) : '';
}

function updateAutoStatus() {
  const el = $('#auto-status');
  if (!el) return;
  const on = $('#auto-toggle').checked;
  if (!on) { el.textContent = '自動更新：OFF'; return; }
  if (serverStatus && serverStatus.marketOpen) {
    const last = serverStatus.lastAutoRefreshAt ? fmtTime(new Date(serverStatus.lastAutoRefreshAt)) : '―';
    el.textContent = `自動更新中（市場開場中・サーバー前回更新 ${last}／画面確認 ${fmtTime(state.lastCheckedAt)}）`;
  } else if (serverStatus) {
    el.textContent = `自動更新：取引時間外のため停止中（画面確認 ${fmtTime(state.lastCheckedAt)}）`;
  } else {
    el.textContent = '自動更新：確認中…';
  }
}

async function pollOnce() {
  if (!$('#auto-toggle').checked) return;
  if (document.hidden) return;
  if (!$('#lock-screen').classList.contains('hidden')) return; // locked
  if ($('#edit-dialog').open) return; // don't disturb editing
  try { serverStatus = await api('/api/status'); } catch { /* keep old status */ }
  try {
    const data = await fetchData();
    if (fingerprintOf(data) !== state.fingerprint) {
      applyData(data);
      render();
    } else {
      state.lastCheckedAt = new Date();
    }
  } catch { /* 401 already re-showed the lock screen; network errors retry next tick */ }
  updateAutoStatus();
}

setInterval(pollOnce, POLL_MS);

// Boot: the lock overlay is visible from the start. If the server has no
// password configured, loadAll() succeeds and the overlay is hidden. If it
// returns 401, api() has already (re)shown the lock screen and data loads
// only after a successful unlock.
loadAll()
  .then(() => { hideLock(); hideLoading(); updateAutoStatus(); pollOnce(); })
  .catch((e) => { hideLoading(); if (!String(e.message).includes('401')) toast(`読み込み失敗: ${e.message}`); });
