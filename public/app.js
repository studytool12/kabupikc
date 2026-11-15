'use strict';
const state = { stocks: [], prices: {}, removed: [], view: 'watchlist', sortKey: 'code', sortDir: 1, chartRange: 252, chartId: null };

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

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function verdictBadge(v) {
  if (!v) return '<span class="badge none">未分析</span>';
  const c = (v === '買い' || v === '強い買い') ? 'buy' : (v.includes('待ち') ? 'wait' : (v === '見送り' ? 'none' : 'watch'));
  return `<span class="badge ${c}">${esc(v)}</span>`;
}

function isUnanalyzed(s) { return !s.last_analysis_date || !s.verdict; }

async function loadAll() {
  const [a, b, c, d] = await Promise.all([api('/api/stocks'), api('/api/prices'), api('/api/removed'), api('/api/summary')]);
  state.stocks = a.stocks;
  state.prices = b.series;
  state.removed = c.removed;
  const parts = Object.entries(d.byVerdict).map(([k, v]) => `${k} ${v}`).join(' / ');
  $('#summary-line').textContent = `全${d.total}銘柄（${parts}）`;
  const sel = $('#verdict-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">判断：すべて</option>' + [...new Set(state.stocks.map((s) => s.verdict).filter(Boolean))].sort().map((v) => `<option>${esc(v)}</option>`).join('');
  sel.value = cur;
  render();
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
  const onlyH = $('#only-holdings').checked;
  let list = state.stocks.filter((s) =>
    (!q || s.name.includes(q) || String(s.code).includes(q)) &&
    (!vf || s.verdict === vf) &&
    (!onlyH || s.is_holding || (s.shares ?? 0) > 0));
  list = sortedStocks(list);
  const cols = [
    ['code', 'コード', 'l'], ['name', '銘柄名', 'l'], ['price', '現在価格'], ['price_change_percent', '前日比%'],
    ['verdict', '判断', 'l'], ['score', 'スコア'], ['entry_price', '第一'], ['entry2_price', '第二'],
    ['stop_price', '損切り'], ['target_price', '利確'], ['shares', '株数'], ['last_analysis_date', '最終分析日', 'l'], ['', '', 'l'],
  ];
  $('#table-watchlist').innerHTML =
    '<tr>' + cols.map(([k, label, a]) => `<th class="${a || ''}" data-sort="${k}">${label}${state.sortKey === k ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>' +
    list.map((s) => `<tr>
      <td class="l">${esc(s.code)}</td><td class="l">${esc(s.name)}${s.is_holding ? ' <span class="badge wait">保有</span>' : ''}</td>
      <td>${fmt(s.price, s.price < 100 ? 1 : 0)}</td>
      <td class="${cls(s.price_change_percent)}">${pct(s.price_change_percent)}</td>
      <td class="l">${verdictBadge(s.verdict)}</td><td>${fmt(s.score)}</td>
      <td>${fmt(s.entry_price)}</td><td>${fmt(s.entry2_price)}</td><td>${fmt(s.stop_price)}</td><td>${fmt(s.target_price)}</td>
      <td>${fmt(s.shares)}</td><td class="l">${esc(s.last_analysis_date || '-')}</td>
      <td class="l"><button data-edit="${s.id}">編集</button></td></tr>`).join('');
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
      <td class="l">${esc(s.code)}</td><td class="l">${esc(s.name)}</td>
      <td>${fmt(s.price, s.price < 100 ? 1 : 0)}</td>
      <td class="${cls(s.price_change_percent)}">${pct(s.price_change_percent)}</td>
      <td class="${cls(d5)}">${pct(d5)}</td><td class="${cls(m1)}">${pct(m1)}</td><td class="${cls(m3)}">${pct(m3)}</td>
      <td class="${cls(fromHigh)}">${pct(fromHigh)}</td><td>${last ? esc(last.date) : '-'}</td></tr>`).join('');
}

// ---------- holdings ----------
function renderHoldings() {
  const holds = state.stocks.filter((s) => s.is_holding || (s.shares ?? 0) > 0);
  let totalVal = 0, totalCost = 0, hasCost = false;
  const rows = holds.map((s) => {
    const val = (s.shares ?? 0) * (s.price ?? 0);
    totalVal += val;
    let pl = null, plPct = null;
    if (s.avg_cost != null && s.price != null) {
      pl = (s.price - s.avg_cost) * (s.shares ?? 0);
      plPct = ((s.price - s.avg_cost) / s.avg_cost) * 100;
      totalCost += s.avg_cost * (s.shares ?? 0); hasCost = true;
    }
    return { s, val, pl, plPct };
  });
  $('#holdings-summary').innerHTML =
    `<div class="card"><div class="k">保有銘柄数</div><div class="v">${holds.length}</div></div>
     <div class="card"><div class="k">評価額合計</div><div class="v">${fmt(totalVal)}円</div></div>
     <div class="card"><div class="k">評価損益（取得単価が分かる分）</div><div class="v ${cls(hasCost ? totalVal - totalCost : null)}">${hasCost ? fmt(totalVal - totalCost) + '円' : '-'}</div></div>`;
  $('#table-holdings').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th>株数</th><th>平均取得単価</th><th>現在価格</th><th>評価額</th><th>評価損益</th><th>損益率</th><th class="l">判断</th></tr>' +
    rows.map(({ s, val, pl, plPct }) => `<tr>
      <td class="l">${esc(s.code)}</td><td class="l">${esc(s.name)}</td><td>${fmt(s.shares)}</td>
      <td>${s.avg_cost != null ? fmt(s.avg_cost, 1) : '<span class="small">未設定</span>'}</td>
      <td>${fmt(s.price, s.price < 100 ? 1 : 0)}</td><td>${fmt(val)}</td>
      <td class="${cls(pl)}">${pl != null ? fmt(pl) : '-'}</td>
      <td class="${cls(plPct)}">${plPct != null ? pct(plPct) : '-'}</td>
      <td class="l">${verdictBadge(s.verdict)}</td></tr>`).join('');
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
    `<b>${esc(s.code)} ${esc(s.name)}</b> 現在 ${fmt(s.price, s.price < 100 ? 1 : 0)}円
     <span class="${cls(s.price_change_percent)}">${pct(s.price_change_percent)}</span>
     ${verdictBadge(s.verdict)} スコア ${fmt(s.score)} / 第一 ${fmt(s.entry_price)} / 損切り ${fmt(s.stop_price)} / 利確 ${fmt(s.target_price)}
     <span class="small">（${pts.length}営業日分を表示）</span>`;
  $('#chart-report').textContent = s.report || '（分析レポートなし）';
  drawChart($('#chart-canvas'), pts, {
    bollinger: $('#opt-bb').checked, ma75: $('#opt-ma').checked,
    rsi: $('#opt-rsi').checked, macd: $('#opt-macd').checked,
    entry: s.entry_price, stop: s.stop_price, target: s.target_price,
  });
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
  const row = (s, note) => `<tr><td class="l">${esc(s.code)}</td><td class="l">${esc(s.name)}</td><td>${fmt(s.price, s.price < 100 ? 1 : 0)}</td><td class="l">${verdictBadge(s.verdict)}</td><td>${fmt(s.score)}</td><td>${fmt(s.entry_price)}</td><td>${fmt(s.stop_price)}</td><td>${fmt(s.target_price)}</td><td class="l">${note}</td><td class="l"><button data-edit="${s.id}">編集</button></td></tr>`;
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
    (list.map((s) => `<tr><td class="l">${esc(s.code)}</td><td class="l">${esc(s.name)}</td><td>${fmt(s.price)}</td><td class="l">${verdictBadge(s.verdict)}</td><td class="l">${esc(s.last_analysis_date || '-')}</td><td class="l"><button data-edit="${s.id}">編集</button></td></tr>`).join('') ||
      '<tr><td class="l" colspan="6">未分析の銘柄はありません。</td></tr>');
  bindTableCommon($('#table-queue'));
}

// ---------- archive ----------
function renderArchive() {
  $('#table-archive').innerHTML =
    '<tr><th class="l">コード</th><th class="l">銘柄名</th><th class="l">削除日時</th><th class="l">削除前の判断</th><th class="l">メモ（抜粋）</th><th></th></tr>' +
    (state.removed.map((r) => `<tr><td class="l">${esc(r.code)}</td><td class="l">${esc(r.name)}</td><td class="l">${esc((r.removed_at || '').slice(0, 10))}</td><td class="l">${esc(r.prev_verdict || r.verdict || '-')}</td><td class="l" style="white-space:normal;min-width:280px">${esc((r.prev_memo || r.memo || '').slice(0, 140))}</td><td class="l"><button data-restore="${r.archive_id}">復元</button></td></tr>`).join('') ||
      '<tr><td class="l" colspan="6">アーカイブはありません。</td></tr>');
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/removed/${b.dataset.restore}/restore`, { method: 'POST' });
    toast('復元しました');
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
  ({ watchlist: renderWatchlist, movements: renderMovements, holdings: renderHoldings, chart: renderChart, actions: renderActions, queue: renderQueue, archive: renderArchive })[state.view]();
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
$('#only-holdings').addEventListener('change', renderWatchlist);
$('#chart-stock').addEventListener('change', renderChart);
document.querySelectorAll('#chart-range button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#chart-range button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  state.chartRange = Number(b.dataset.range);
  renderChart();
}));
['opt-bb', 'opt-ma', 'opt-rsi', 'opt-macd'].forEach((id) => $('#' + id).addEventListener('change', renderChart));
window.addEventListener('resize', () => { if (state.view === 'chart') renderChart(); });

loadAll().catch((e) => toast(`読み込み失敗: ${e.message}`));
