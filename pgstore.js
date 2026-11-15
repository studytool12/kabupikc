'use strict';
/**
 * Postgres persistence layer (Neon assumed, any Postgres works).
 *
 * When DATABASE_URL is set, Postgres is the source of truth. It holds the
 * same three tables as the local SQLite store (stocks / price_history /
 * removed_stocks, same columns and data model; SQLite REAL maps to
 * DOUBLE PRECISION, placeholders are $n instead of ?). The local SQLite DB
 * stays as the working store / cache; this module mirrors it:
 *
 *   boot:  PG tables are created if missing. If PG already has stocks,
 *          they are loaded into SQLite. If PG is empty, the current
 *          SQLite content (seed data on first boot) is written up to PG.
 *   write: scheduleSave() debounces changes (default 2s) and rewrites the
 *          three PG tables from the full SQLite export inside one
 *          transaction. Failures are logged, never thrown to callers.
 *
 * When DATABASE_URL is missing the store is disabled and the app behaves
 * exactly as before (SQLite only, for local development).
 *
 * Env:
 *   DATABASE_URL          Postgres connection string (Neon: from dashboard)
 *   PG_SAVE_DEBOUNCE_MS   optional, default 2000
 */
const { Pool } = require('pg');
const { STOCK_COLUMNS, rowToStock } = require('./db');

const STOCK_COLS = ['id', ...STOCK_COLUMNS.map(([c]) => c), 'data'];
const PRICE_COLS = ['stock_id', 'date', 'open', 'high', 'low', 'close', 'volume', 'source'];
const REMOVED_COLS = ['id', 'code', 'name', 'removed_at', 'snapshot'];
const INSERT_CHUNK = 500;

function pgType(sqliteType) {
  if (sqliteType === 'REAL') return 'DOUBLE PRECISION';
  return sqliteType; // TEXT / INTEGER exist in Postgres as-is
}

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY,
  ${STOCK_COLUMNS.map(([c, t]) => `${c} ${pgType(t)}`).join(',\n  ')},
  data TEXT
);
CREATE TABLE IF NOT EXISTS price_history (
  stock_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION,
  close DOUBLE PRECISION, volume DOUBLE PRECISION, source TEXT,
  PRIMARY KEY (stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_ph_stock ON price_history(stock_id, date);
CREATE TABLE IF NOT EXISTS removed_stocks (
  id INTEGER PRIMARY KEY,
  code TEXT, name TEXT, removed_at TEXT, snapshot TEXT
);
`;

/** Column values for one stock object, in STOCK_COLS order. */
function stockToValues(s) {
  const values = [s.id ?? null];
  for (const [col] of STOCK_COLUMNS) {
    let v = s[col];
    if (col === 'is_holding') v = v ? 1 : 0;
    values.push(v === undefined ? null : v);
  }
  values.push(JSON.stringify(s));
  return values;
}

function priceToValues(p) {
  return [
    p.stock_id, p.date,
    p.open ?? null, p.high ?? null, p.low ?? null,
    p.close ?? p.price ?? null,
    p.volume ?? null, p.source ?? null,
  ];
}

function removedToValues(r) {
  const snapshot = typeof r.snapshot === 'string' ? r.snapshot : JSON.stringify(r.snapshot ?? r);
  return [r.id ?? null, r.code ?? null, r.name ?? null, r.removed_at ?? null, snapshot];
}

/** Build the importAll()-shaped snapshot from raw Postgres table rows. */
function snapshotFromRows({ stockRows, priceRows, removedRows }) {
  return {
    app: 'stock-watchlist',
    version: 1,
    exported_at: new Date().toISOString(),
    stocks: (stockRows || []).map(rowToStock),
    price_history: priceRows || [],
    removed_stocks: removedRows || [],
    settings: {},
  };
}

async function insertChunked(client, table, cols, rows, toValues) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const params = [];
    const tuples = chunk.map((row, j) => {
      const vals = toValues(row);
      for (const v of vals) params.push(v);
      const base = j * cols.length;
      return `(${cols.map((_, k) => `$${base + k + 1}`).join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`,
      params
    );
  }
}

function createPgStore(options = {}) {
  const connectionString = options.connectionString || null;
  const debounceMs = options.debounceMs ?? 2000;
  const enabled = !!connectionString;

  let pool = options.pool || null;
  // Neon requires TLS. rejectUnauthorized:false still encrypts; it only
  // skips CA verification (Neon endpoints are *.neon.tech / AWS hosts
  // whose chain varies by region/pooler). Plain local Postgres without SSL
  // support is handled by the fallback in init().
  const sslDisabled = /sslmode=disable/i.test(connectionString || '');
  let sslOn = !sslDisabled;
  function makePool(useSsl) {
    const p = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    p.on('error', (e) => console.error('[pg] pool error:', e.message));
    return p;
  }
  if (enabled && !pool) pool = makePool(sslOn);

  let exportAllFn = null;
  let saveTimer = null;
  let saveInFlight = false;
  let savePending = false;

  async function loadFromPg(client) {
    const stockRows = (await client.query('SELECT * FROM stocks ORDER BY id')).rows;
    const priceRows = (await client.query(
      'SELECT stock_id, date, open, high, low, close, volume, source FROM price_history ORDER BY stock_id, date'
    )).rows;
    const removedRows = (await client.query(
      'SELECT id, code, name, removed_at, snapshot FROM removed_stocks ORDER BY id'
    )).rows;
    return snapshotFromRows({ stockRows, priceRows, removedRows });
  }

  async function saveToPg(client, data) {
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM price_history');
      await client.query('DELETE FROM stocks');
      await client.query('DELETE FROM removed_stocks');
      await insertChunked(client, 'stocks', STOCK_COLS, data.stocks || [], stockToValues);
      await insertChunked(client, 'price_history', PRICE_COLS, data.price_history || [], priceToValues);
      await insertChunked(client, 'removed_stocks', REMOVED_COLS, data.removed_stocks || [], removedToValues);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  async function runSave() {
    if (saveInFlight) {
      savePending = true;
      return;
    }
    if (!exportAllFn || !pool) return;
    saveInFlight = true;
    const client = await pool.connect().catch((e) => {
      console.error('[pg] save failed (local data kept, will retry on next change):', e.message);
      return null;
    });
    if (!client) {
      saveInFlight = false;
      return;
    }
    try {
      const data = exportAllFn();
      await saveToPg(client, data);
      console.log(`[pg] saved ${(data.stocks || []).length} stocks, ${(data.price_history || []).length} price points at ${new Date().toISOString()}`);
    } catch (e) {
      console.error('[pg] save failed (local data kept, will retry on next change):', e.message);
    } finally {
      client.release();
      saveInFlight = false;
      if (savePending) {
        savePending = false;
        scheduleSave();
      }
    }
  }

  /** Debounced save: bursts of changes within debounceMs collapse into one write. */
  function scheduleSave() {
    if (!enabled) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void runSave();
    }, debounceMs);
  }

  /** Save immediately if a debounced save is pending (e.g. on SIGTERM). */
  async function flush() {
    if (!enabled) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await runSave();
    }
  }

  /**
   * Boot sequence. Creates tables, then loads PG data into SQLite when PG
   * has stocks; otherwise writes the current (seed) export up to PG.
   * Never throws: on any failure the app keeps running on local data.
   */
  async function init({ exportAll, importAll }) {
    exportAllFn = exportAll;
    if (!enabled) {
      console.log('[pg] disabled (DATABASE_URL not set) — running on local SQLite only');
      return { enabled: false, source: 'local' };
    }
    let client = null;
    try {
      client = await pool.connect();
      await client.query(CREATE_TABLES_SQL);
      const { rows } = await client.query('SELECT COUNT(*) AS n FROM stocks');
      const n = Number(rows[0].n);
      if (n > 0) {
        const data = await loadFromPg(client);
        importAll(data);
        console.log(`[pg] loaded ${data.stocks.length} stocks, ${data.price_history.length} price points from Postgres`);
        return { enabled: true, source: 'postgres', stocks: data.stocks.length };
      }
      const data = exportAll();
      await saveToPg(client, data);
      console.log(`[pg] Postgres was empty — seeded ${(data.stocks || []).length} stocks, ${(data.price_history || []).length} price points from local data`);
      return { enabled: true, source: 'seeded-postgres', stocks: (data.stocks || []).length };
    } catch (e) {
      if (client) { try { client.release(true); } catch { /* ignore */ } client = null; }
      // A plain Postgres without SSL support rejects the TLS attempt;
      // swap the pool for a non-SSL one and retry once.
      if (sslOn && /ssl/i.test(e.message)) {
        console.log('[pg] server does not support SSL — retrying without SSL');
        sslOn = false;
        const old = pool;
        pool = makePool(false);
        if (old) old.end().catch(() => {});
        return init({ exportAll, importAll });
      }
      console.error('[pg] init failed — continuing with local data only:', e.message);
      return { enabled: true, source: 'local-fallback' };
    } finally {
      if (client) client.release();
    }
  }

  return {
    enabled,
    init,
    scheduleSave,
    flush,
    // exposed for tests / diagnostics
    _internals: { loadFromPg, saveToPg, get pool() { return pool; } },
  };
}

/** Default store built from environment variables. */
function createPgStoreFromEnv(overrides = {}) {
  return createPgStore({
    connectionString: process.env.DATABASE_URL,
    debounceMs: Number(process.env.PG_SAVE_DEBOUNCE_MS || 2000),
    ...overrides,
  });
}

module.exports = {
  createPgStore,
  createPgStoreFromEnv,
  CREATE_TABLES_SQL,
  // exposed for tests
  stockToValues,
  priceToValues,
  removedToValues,
  snapshotFromRows,
};
