'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, seedIfEmpty, insertStock, rowToStock, exportAll, importAll } = require('./db');
const { createPgStoreFromEnv } = require('./pgstore');

const app = express();
const PORT = process.env.PORT || 3000;

seedIfEmpty();

// Postgres (DATABASE_URL) is the source of truth when configured; SQLite
// stays the working store. init() runs before listen() in start() below.
const pgStore = createPgStoreFromEnv();

// ---- optional password lock (enabled only when APP_PASSWORD is set) ----
// Not Basic auth: browsers must not remember credentials. The client posts
// the password to POST /api/unlock and receives a random token that it keeps
// in page memory only (never localStorage/sessionStorage/Cookie), so every
// page reload drops the token and the lock screen comes back.
const APP_PASSWORD = process.env.APP_PASSWORD || null;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const unlockTokens = new Map(); // token -> expiresAt (epoch ms)

function hasValidToken(req) {
  const t = req.headers['x-app-token'];
  if (!t || typeof t !== 'string') return false;
  const exp = unlockTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { unlockTokens.delete(t); return false; }
  return true;
}

function passwordMatches(pw) {
  if (!APP_PASSWORD || typeof pw !== 'string') return false;
  const a = Buffer.from(pw);
  const b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

if (APP_PASSWORD) console.log('[auth] password lock enabled');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Unlock endpoint (exempt from the token guard below).
app.post('/api/unlock', (req, res) => {
  if (!APP_PASSWORD) return res.json({ locked: false, token: null });
  if (!passwordMatches(req.body && req.body.password)) {
    return res.status(401).json({ error: 'invalid password' });
  }
  // Opportunistically drop expired tokens.
  const now = Date.now();
  for (const [t, exp] of unlockTokens) if (now > exp) unlockTokens.delete(t);
  const token = crypto.randomBytes(32).toString('hex');
  unlockTokens.set(token, now + TOKEN_TTL_MS);
  return res.json({ locked: true, token });
});

// All other /api/* require a valid unlock token when the lock is enabled.
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || hasValidToken(req)) return next();
  return res.status(401).json({ error: 'locked' });
});

// Mirror successful API mutations to Postgres (debounced inside pgStore).
app.use('/api', (req, res, next) => {
  if (!pgStore.enabled) return next();
  res.on('finish', () => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && res.statusCode < 400) {
      pgStore.scheduleSave();
    }
  });
  return next();
});

// ---------------- API ----------------
app.get('/api/stocks', (req, res) => {
  const rows = db.prepare('SELECT * FROM stocks ORDER BY code').all();
  res.json({ stocks: rows.map(rowToStock) });
});

app.get('/api/stocks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM stocks WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ stock: rowToStock(row) });
});

const EDITABLE = ['code', 'name', 'verdict', 'score', 'price', 'entry_price', 'entry2_price',
  'stop_price', 'target_price', 'shares', 'avg_cost', 'is_holding', 'tags', 'memo', 'report',
  'last_analysis_date', 'holding_period', 'sector'];

app.post('/api/stocks', (req, res) => {
  const body = req.body || {};
  if (!body.code || !body.name) return res.status(400).json({ error: 'code and name are required' });
  const rec = { created_at: new Date().toISOString(), verdict: null, score: null };
  for (const k of EDITABLE) if (body[k] !== undefined) rec[k] = body[k];
  const { maxid } = db.prepare('SELECT COALESCE(MAX(id),0) AS maxid FROM stocks').get();
  rec.id = maxid + 1;
  insertStock(rec);
  res.status(201).json({ stock: rowToStock(db.prepare('SELECT * FROM stocks WHERE id = ?').get(rec.id)) });
});

app.put('/api/stocks/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM stocks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const rec = rowToStock(row);
  for (const k of EDITABLE) if (req.body && req.body[k] !== undefined) rec[k] = req.body[k];
  insertStock(rec);
  res.json({ stock: rowToStock(db.prepare('SELECT * FROM stocks WHERE id = ?').get(id)) });
});

// Delete = archive snapshot into removed_stocks first (mirrors the space's rule),
// then remove from the watchlist. Restorable via /api/removed/:id/restore.
app.delete('/api/stocks/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM stocks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const stock = rowToStock(row);
  const points = db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE stock_id = ?').get(id).n;
  const snapshot = {
    ...stock, prev_verdict: stock.verdict, prev_memo: stock.memo,
    history_points: points, removed_at: new Date().toISOString(), snapshot_valid: true,
  };
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO removed_stocks (code, name, removed_at, snapshot) VALUES (?,?,?,?)')
      .run(stock.code, stock.name, snapshot.removed_at, JSON.stringify(snapshot));
    db.prepare('DELETE FROM price_history WHERE stock_id = ?').run(id);
    db.prepare('DELETE FROM stocks WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, archived: snapshot });
});

app.get('/api/removed', (req, res) => {
  const rows = db.prepare('SELECT * FROM removed_stocks ORDER BY removed_at DESC').all();
  res.json({
    removed: rows.map((r) => {
      let snap = {};
      try { snap = JSON.parse(r.snapshot || '{}'); } catch { /* ignore */ }
      return { archive_id: r.id, code: r.code, name: r.name, removed_at: r.removed_at, ...snap };
    }),
  });
});

app.post('/api/removed/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM removed_stocks WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  let snap = {};
  try { snap = JSON.parse(row.snapshot || '{}'); } catch { /* ignore */ }
  const { archive_id, prev_verdict, prev_memo, history_points, snapshot_valid, ...rest } = snap;
  const rec = { ...rest };
  if (prev_verdict !== undefined && rec.verdict === undefined) rec.verdict = prev_verdict;
  if (!rec.id || db.prepare('SELECT id FROM stocks WHERE id = ?').get(rec.id)) {
    rec.id = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM stocks').get().m + 1;
  }
  insertStock(rec);
  db.prepare('DELETE FROM removed_stocks WHERE id = ?').run(row.id);
  res.json({ ok: true, stock: rec });
});

app.get('/api/stocks/:id/history', (req, res) => {
  const rows = db.prepare('SELECT date, open, high, low, close, volume FROM price_history WHERE stock_id = ? ORDER BY date')
    .all(Number(req.params.id));
  res.json({ points: rows.map((p) => ({ date: p.date, open: p.open, high: p.high, low: p.low, price: p.close, volume: p.volume })) });
});

// All series at once (used by 値動き / チャート views). ~27k points, a few MB.
app.get('/api/prices', (req, res) => {
  const rows = db.prepare('SELECT stock_id, date, open, high, low, close, volume FROM price_history ORDER BY stock_id, date').all();
  const series = {};
  for (const p of rows) {
    (series[p.stock_id] ||= []).push({ date: p.date, open: p.open, high: p.high, low: p.low, price: p.close, volume: p.volume });
  }
  res.json({ series });
});

app.get('/api/summary', (req, res) => {
  const stocks = db.prepare('SELECT * FROM stocks').all().map(rowToStock);
  const byVerdict = {};
  let unanalyzed = 0;
  for (const s of stocks) {
    const v = s.verdict || '未分析';
    byVerdict[v] = (byVerdict[v] || 0) + 1;
    if (!s.last_analysis_date || !s.verdict) unanalyzed++;
  }
  res.json({ total: stocks.length, byVerdict, unanalyzed });
});

// ---------------- Price refresh via Yahoo chart API (no key) ----------------
async function fetchYahoo(code) {
  const symbol = encodeURIComponent(`${code}.T`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=6mo&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (stock-watchlist refresh)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const result = j.chart && j.chart.result && j.chart.result[0];
  if (!result || !result.timestamp) throw new Error('no data');
  const q = result.indicators.quote[0];
  const points = [];
  result.timestamp.forEach((ts, i) => {
    const close = q.close[i];
    if (close == null) return;
    points.push({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open: q.open[i] ?? null, high: q.high[i] ?? null, low: q.low[i] ?? null,
      close, volume: q.volume[i] ?? null,
    });
  });
  return points;
}

let refreshing = false;

// Core refresh routine shared by POST /api/refresh and the market-hours
// auto-refresh scheduler below. Throws {status:409} if a run is in flight.
async function runPriceRefresh(codes) {
  if (refreshing) { const e = new Error('refresh already running'); e.status = 409; throw e; }
  refreshing = true;
  try {
    let stocks = db.prepare('SELECT * FROM stocks ORDER BY code').all().map(rowToStock);
    if (Array.isArray(codes) && codes.length) {
      const want = new Set(codes.map(String));
      stocks = stocks.filter((s) => want.has(String(s.code)));
    }
    const ins = db.prepare(
      'INSERT OR REPLACE INTO price_history (stock_id, date, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,?)'
    );
    let updated = 0, addedPoints = 0;
    const failures = [];
    const CONCURRENCY = 6;
    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (s) => {
        try {
          const points = await fetchYahoo(s.code);
          if (!points.length) throw new Error('empty');
          const before = db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE stock_id = ?').get(s.id).n;
          db.exec('BEGIN');
          try {
            for (const p of points) ins.run(s.id, p.date, p.open, p.high, p.low, p.close, p.volume, 'yahoo');
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          const after = db.prepare('SELECT COUNT(*) AS n FROM price_history WHERE stock_id = ?').get(s.id).n;
          addedPoints += Math.max(0, after - before);
          const last = points[points.length - 1];
          const prev = points.length > 1 ? points[points.length - 2] : null;
          const rec = { ...s };
          rec.price = last.close;
          rec.day_high = last.high; rec.day_low = last.low;
          if (prev && prev.close) {
            rec.price_change = +(last.close - prev.close).toFixed(4);
            rec.price_change_percent = +(((last.close - prev.close) / prev.close) * 100).toFixed(4);
          }
          const closes = points.map((p) => p.close);
          rec.week52_high = Math.max(...points.map((p) => p.high ?? p.close));
          rec.week52_low = Math.min(...points.map((p) => p.low ?? p.close));
          void closes;
          rec.price_as_of = new Date().toISOString();
          insertStock(rec);
          updated++;
        } catch (e) {
          failures.push({ code: s.code, name: s.name, error: String(e.message || e) });
        }
      }));
    }
    return { ok: true, updated, total: stocks.length, addedPoints, failures };
  } finally {
    refreshing = false;
  }
}

app.post('/api/refresh', async (req, res) => {
  try {
    const codes = req.body && Array.isArray(req.body.codes) ? req.body.codes : undefined;
    res.json(await runPriceRefresh(codes));
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e) });
  }
});

// ---------------- Auto refresh during TSE market hours ----------------
// Weekdays 09:00–15:30 JST (holidays not accounted for), every 3 minutes.
// Yahoo fetching is heavy, so this stays coarse; the client polls /api data
// every minute and picks up whatever the latest server-side run produced.
const AUTO_REFRESH_MS = 3 * 60 * 1000;
let lastAutoRefreshAt = null;

function tokyoNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function isMarketOpen(d = tokyoNow()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}

setInterval(async () => {
  if (!isMarketOpen() || refreshing) return;
  try {
    const r = await runPriceRefresh();
    lastAutoRefreshAt = new Date().toISOString();
    console.log(`[auto-refresh] updated ${r.updated}/${r.total} stocks, +${r.addedPoints} points`);
    // Server-side writes bypass the HTTP mutation middleware, so mirror
    // to Postgres explicitly.
    if (pgStore.enabled) pgStore.scheduleSave();
  } catch (e) {
    console.warn('[auto-refresh] failed:', String(e.message || e));
  }
}, AUTO_REFRESH_MS);

app.get('/api/status', (req, res) => {
  res.json({
    marketOpen: isMarketOpen(),
    autoRefreshIntervalMs: AUTO_REFRESH_MS,
    lastAutoRefreshAt,
    refreshing,
    serverTime: new Date().toISOString(),
  });
});

// Flush any pending Postgres save before the process goes away
// (Render restarts / redeploys send SIGTERM).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await pgStore.flush(); } catch { /* ignore */ }
    process.exit(0);
  });
}

async function start() {
  await pgStore.init({ exportAll, importAll });
  app.listen(PORT, () => console.log(`stock-watchlist listening on :${PORT} (db: ${require('./db').DB_PATH})`));
}

start();
