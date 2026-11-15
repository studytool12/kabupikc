'use strict';
/* Canvas stock chart: candlesticks + volume + MA75 + Bollinger(20,2) + RSI(14) + MACD(12,26,9).
   All indicators computed client-side. No external dependencies. */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) { out[i] = null; continue; }
    sum += values[i];
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) { out[i] = prev; continue; }
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = i >= period - 1 ? prev : null;
  }
  return out;
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const m = mid[i];
    const sd = Math.sqrt(win.reduce((a, v) => a + (v - m) ** 2, 0) / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const rawForSignal = line.map((v) => (v == null ? 0 : v));
  const sigRaw = ema(rawForSignal, signalPeriod);
  const signal = line.map((v, i) => (v == null ? null : sigRaw[i]));
  const hist = line.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { line, signal, hist };
}

function fmtNum(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '-';
  return Number(v).toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/**
 * drawChart(canvas, points, opts)
 * points: [{date, open, high, low, price(close), volume}]
 * opts: {ma75:bool, bollinger:bool, rsi:bool, macd:bool, entry, stop, target,
 *        hoverIdx:number|null} — when hoverIdx is set, a crosshair (vertical
 *        line across all panels + horizontal line at that day's close on the
 *        main panel + marker) is drawn for that data point.
 * The plot geometry is stored on canvas._geom so callers can convert a
 * pointer x-coordinate back into a data index.
 */
function drawChart(canvas, points, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H || !points.length) { canvas._geom = null; return; }
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#666';

  const closes = points.map((p) => p.price);
  const ma75 = sma(closes, 75);
  const bb = bollinger(closes);
  const rsiArr = rsi(closes);
  const macdObj = macd(closes);

  const panels = [{ key: 'main', h: 0.52 }, { key: 'volume', h: 0.14 }];
  if (opts.rsi !== false) panels.push({ key: 'rsi', h: 0.15 });
  if (opts.macd !== false) panels.push({ key: 'macd', h: 0.19 });
  const totalH = panels.reduce((a, p) => a + p.h, 0);
  const axisW = 56, padTop = 6, padBottom = 16;
  const plotW = W - axisW - 8;
  let y = padTop;
  for (const p of panels) { p.y0 = y; p.hPx = (H - padTop - padBottom) * (p.h / totalH); y += p.hPx + 4; }

  const n = points.length;
  const xAt = (i) => 4 + (plotW * (i + 0.5)) / n;
  const candleW = Math.max(1, Math.min(9, (plotW / n) * 0.7));

  function linePath(values, yFor, color, width = 1) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v == null) { started = false; return; }
      const X = xAt(i), Y = yFor(v);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    });
    ctx.stroke();
  }
  function hline(panel, v, yFor, color, label) {
    if (v == null) return;
    const Y = yFor(v);
    if (Y < panel.y0 || Y > panel.y0 + panel.hPx) return;
    ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.beginPath();
    ctx.moveTo(4, Y); ctx.lineTo(4 + plotW, Y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.fillText(label, 6, Y - 2); ctx.fillStyle = '#666';
  }

  for (const panel of panels) {
    ctx.strokeStyle = '#e2e2e2'; ctx.strokeRect(4, panel.y0, plotW, panel.hPx);
    if (panel.key === 'main') {
      let lo = Infinity, hi = -Infinity;
      points.forEach((p, i) => {
        lo = Math.min(lo, p.low ?? p.price); hi = Math.max(hi, p.high ?? p.price);
        if (opts.bollinger !== false) {
          if (bb.lower[i] != null) lo = Math.min(lo, bb.lower[i]);
          if (bb.upper[i] != null) hi = Math.max(hi, bb.upper[i]);
        }
      });
      const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
      const yFor = (v) => panel.y0 + panel.hPx - ((v - lo) / (hi - lo)) * panel.hPx;
      panel.yFor = yFor;
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4, Y = yFor(v);
        ctx.fillText(fmtNum(v, v < 100 ? 1 : 0), 6 + plotW + 4, Y + 3);
        ctx.strokeStyle = '#f0f0f0'; ctx.beginPath(); ctx.moveTo(4, Y); ctx.lineTo(4 + plotW, Y); ctx.stroke();
      }
      if (opts.bollinger !== false) {
        linePath(bb.upper, yFor, 'rgba(90,140,220,0.55)');
        linePath(bb.lower, yFor, 'rgba(90,140,220,0.55)');
        linePath(bb.mid, yFor, 'rgba(90,140,220,0.8)');
      }
      if (opts.ma75 !== false) linePath(ma75, yFor, '#e8a13a', 1.2);
      points.forEach((p, i) => {
        const o = p.open ?? p.price, c = p.price;
        const up = c >= o;
        ctx.strokeStyle = up ? '#d33' : '#2979ff';
        ctx.fillStyle = up ? '#d33' : '#2979ff';
        const X = xAt(i);
        ctx.beginPath(); ctx.moveTo(X, yFor(p.high ?? Math.max(o, c))); ctx.lineTo(X, yFor(p.low ?? Math.min(o, c))); ctx.stroke();
        const yO = yFor(o), yC = yFor(c);
        const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
        ctx.fillRect(X - candleW / 2, top, candleW, hgt);
      });
      hline(panel, opts.entry, yFor, '#2e7d32', '第一エントリー');
      hline(panel, opts.stop, yFor, '#c62828', '損切り');
      hline(panel, opts.target, yFor, '#6a1b9a', '利確');
      ctx.fillStyle = '#888';
      ctx.fillText('青:ボリンジャー / 橙:75日線', 8, panel.y0 + 11);
      ctx.fillStyle = '#666';
    } else if (panel.key === 'volume') {
      const vols = points.map((p) => p.volume ?? 0);
      const vmax = Math.max(...vols, 1);
      points.forEach((p, i) => {
        const o = p.open ?? p.price;
        ctx.fillStyle = p.price >= o ? 'rgba(221,51,51,0.6)' : 'rgba(41,121,255,0.6)';
        const hgt = ((p.volume ?? 0) / vmax) * panel.hPx;
        ctx.fillRect(xAt(i) - candleW / 2, panel.y0 + panel.hPx - hgt, candleW, hgt);
      });
      ctx.fillStyle = '#888'; ctx.fillText('出来高', 8, panel.y0 + 11); ctx.fillStyle = '#666';
    } else if (panel.key === 'rsi') {
      const yFor = (v) => panel.y0 + panel.hPx - (v / 100) * panel.hPx;
      [30, 70].forEach((lv) => {
        ctx.strokeStyle = '#ddd'; ctx.beginPath(); ctx.moveTo(4, yFor(lv)); ctx.lineTo(4 + plotW, yFor(lv)); ctx.stroke();
        ctx.fillText(String(lv), 6 + plotW + 4, yFor(lv) + 3);
      });
      linePath(rsiArr, yFor, '#6a1b9a', 1.2);
      ctx.fillStyle = '#888'; ctx.fillText('RSI(14)', 8, panel.y0 + 11); ctx.fillStyle = '#666';
    } else if (panel.key === 'macd') {
      const vals = [...macdObj.line, ...macdObj.signal, ...macdObj.hist].filter((v) => v != null);
      const mx = Math.max(...vals.map(Math.abs), 1);
      const yFor = (v) => panel.y0 + panel.hPx / 2 - (v / mx) * (panel.hPx / 2);
      ctx.strokeStyle = '#ddd'; ctx.beginPath(); ctx.moveTo(4, yFor(0)); ctx.lineTo(4 + plotW, yFor(0)); ctx.stroke();
      macdObj.hist.forEach((v, i) => {
        if (v == null) return;
        ctx.fillStyle = v >= 0 ? 'rgba(221,51,51,0.55)' : 'rgba(41,121,255,0.55)';
        ctx.fillRect(xAt(i) - candleW / 2, Math.min(yFor(v), yFor(0)), candleW, Math.abs(yFor(v) - yFor(0)) || 1);
      });
      linePath(macdObj.line, yFor, '#e8a13a', 1.1);
      linePath(macdObj.signal, yFor, '#2979ff', 1.1);
      ctx.fillStyle = '#888'; ctx.fillText('MACD(12,26,9)', 8, panel.y0 + 11); ctx.fillStyle = '#666';
    }
  }
  // date labels
  ctx.fillStyle = '#888';
  const steps = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += steps) {
    ctx.fillText(points[i].date.slice(0, 7), xAt(i) - 14, H - 3);
  }
  ctx.fillStyle = '#666';

  // ---- crosshair for the hovered / touched data point ----
  canvas._geom = { n, plotW, left: 4 };
  if (opts.hoverIdx != null && points[opts.hoverIdx]) {
    const i = opts.hoverIdx;
    const X = xAt(i);
    const main = panels[0];
    const lastPanel = panels[panels.length - 1];
    ctx.strokeStyle = 'rgba(70,70,70,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X, main.y0); ctx.lineTo(X, lastPanel.y0 + lastPanel.hPx); ctx.stroke();
    if (main.yFor) {
      const Y = main.yFor(points[i].price);
      ctx.beginPath(); ctx.moveTo(4, Y); ctx.lineTo(4 + plotW, Y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(X, Y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(X, Y, 2.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#666';
  }
}
