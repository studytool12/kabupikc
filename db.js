'use strict';
/**
 * SQLite layer (Node built-in node:sqlite, no native deps).
 * - DB path: env DATABASE_PATH, default ./data/watchlist.db
 * - On first boot (empty stocks table), seeds from ./seed/*.json
 *   (the unmodified export of the original Muse space).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'watchlist.db');
const SEED_DIR = process.env.SEED_DIR || path.join(__dirname, 'seed');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// Columns mirrored as real columns (for filtering/sorting) + `data` keeps the
// full original record so no field from the source space is ever lost.
const STOCK_COLUMNS = [
  ['code', 'TEXT'], ['name', 'TEXT'], ['verdict', 'TEXT'], ['score', 'REAL'],
  ['price', 'REAL'], ['price_change', 'REAL'], ['price_change_percent', 'REAL'],
  ['price_as_of', 'TEXT'], ['day_high', 'REAL'], ['day_low', 'REAL'],
  ['week52_high', 'REAL'], ['week52_low', 'REAL'],
  ['entry_price', 'REAL'], ['entry2_price', 'REAL'],
  ['stop_price', 'REAL'], ['target_price', 'REAL'],
  ['shares', 'REAL'], ['avg_cost', 'REAL'], ['is_holding', 'INTEGER'],
  ['tags', 'TEXT'], ['memo', 'TEXT'], ['report', 'TEXT'],
  ['last_analysis_date', 'TEXT'], ['holding_period', 'TEXT'], ['created_at', 'TEXT'],
];

db.exec(`
CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY,
  ${STOCK_COLUMNS.map(([c, t]) => `${c} ${t}`).join(',\n  ')},
  data TEXT
);
CREATE TABLE IF NOT EXISTS price_history (
  stock_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT,
  PRIMARY KEY (stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ph_stock ON price_history(stock_id, date);
CREATE TABLE IF NOT EXISTS removed_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT, name TEXT, removed_at TEXT, snapshot TEXT
);
`);

function stockToRow(s) {
  const row = { id: s.id ?? null, data: JSON.stringify(s) };
  for (const [col] of STOCK_COLUMNS) {
    let v = s[col];
    if (col === 'is_holding') v = v ? 1 : 0;
    row[col] = v === undefined ? null : v;
  }
  return row;
}

function insertStock(s) {
  const row = stockToRow(s);
  const cols = ['id', ...STOCK_COLUMNS.map(([c]) => c), 'data'];
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO stocks (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
  );
  stmt.run(row);
}

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM stocks').get();
  if (n > 0) return { seeded: false, stocks: n };

  const stocksFile = path.join(SEED_DIR, 'stocks.json');
  const historyFile = path.join(SEED_DIR, 'price-history.json');
  const removedFile = path.join(SEED_DIR, 'removed-stocks.json');
  if (!fs.existsSync(stocksFile)) return { seeded: false, stocks: 0, note: 'seed file missing' };

  const stocks = JSON.parse(fs.readFileSync(stocksFile, 'utf8')).stocks || [];
  db.exec('BEGIN');
  try {
    for (const s of stocks) insertStock(s);
    if (fs.existsSync(historyFile)) {
      const series = JSON.parse(fs.readFileSync(historyFile, 'utf8')).series || [];
      const ins = db.prepare(
        'INSERT OR REPLACE INTO price_history (stock_id, date, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,?)'
      );
      for (const s of series) {
        for (const p of s.points || []) {
          ins.run(s.stock_id, p.date, p.open ?? null, p.high ?? null, p.low ?? null, p.price ?? null, p.volume ?? null, p.source ?? null);
        }
      }
    }
    if (fs.existsSync(removedFile)) {
      const removed = JSON.parse(fs.readFileSync(removedFile, 'utf8')).removed || [];
      const ins = db.prepare('INSERT INTO removed_stocks (code, name, removed_at, snapshot) VALUES (?,?,?,?)');
      for (const r of removed) ins.run(r.code ?? null, r.name ?? null, r.removed_at ?? null, JSON.stringify(r));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM stocks').get().n;
  const pts = db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n;
  console.log(`[seed] inserted ${after} stocks, ${pts} price points`);
  return { seeded: true, stocks: after, points: pts };
}

/**
 * Full snapshot of the DB as one JSON-able object. This is the format stored
 * on Google Drive (watchlist-data.json). `settings` is reserved for app-level
 * values (e.g. cash balance) so they round-trip through Drive as well.
 */
function exportAll() {
  const stocks = db.prepare('SELECT * FROM stocks ORDER BY id').all().map(rowToStock);
  const priceHistory = db
    .prepare('SELECT stock_id, date, open, high, low, close, volume, source FROM price_history ORDER BY stock_id, date')
    .all();
  const removed = db
    .prepare('SELECT id, code, name, removed_at, snapshot FROM removed_stocks ORDER BY id')
    .all();
  return {
    app: 'stock-watchlist',
    version: 1,
    exported_at: new Date().toISOString(),
    stocks,
    price_history: priceHistory,
    removed_stocks: removed,
    settings: {},
  };
}

/** Replace the entire DB content with a snapshot produced by exportAll(). */
function importAll(data) {
  if (!data || !Array.isArray(data.stocks)) {
    throw new Error('invalid data file: "stocks" array missing');
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM price_history');
    db.exec('DELETE FROM stocks');
    db.exec('DELETE FROM removed_stocks');
    for (const s of data.stocks) insertStock(s);
    const insP = db.prepare(
      'INSERT OR REPLACE INTO price_history (stock_id, date, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const p of data.price_history || []) {
      insP.run(
        p.stock_id, p.date,
        p.open ?? null, p.high ?? null, p.low ?? null,
        p.close ?? p.price ?? null,
        p.volume ?? null, p.source ?? null
      );
    }
    const insR = db.prepare(
      'INSERT INTO removed_stocks (id, code, name, removed_at, snapshot) VALUES (?,?,?,?,?)'
    );
    for (const r of data.removed_stocks || []) {
      const snapshot = typeof r.snapshot === 'string' ? r.snapshot : JSON.stringify(r.snapshot ?? r);
      insR.run(r.id ?? null, r.code ?? null, r.name ?? null, r.removed_at ?? null, snapshot);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM stocks').get().n;
  const pts = db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n;
  console.log(`[db] imported ${n} stocks, ${pts} price points`);
}

function rowToStock(row) {
  if (!row) return null;
  let extra = {};
  try { extra = JSON.parse(row.data || '{}'); } catch { /* ignore */ }
  const out = { ...extra };
  for (const [col] of STOCK_COLUMNS) out[col] = row[col];
  out.id = row.id;
  out.is_holding = !!row.is_holding;
  return out;
}

module.exports = { db, seedIfEmpty, insertStock, rowToStock, exportAll, importAll, STOCK_COLUMNS, DB_PATH };
