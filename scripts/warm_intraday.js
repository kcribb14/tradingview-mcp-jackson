#!/usr/bin/env node
/**
 * Warm intraday F&G data — fetches 1H OHLCV and calculates F&G for symbols missing it.
 *
 * Usage: node scripts/warm_intraday.js [--tf 60] [--limit 2000] [--timeout 600]
 *
 * Supports: Yahoo (stocks/ETFs), Binance (crypto), CryptoCompare (crypto fallback)
 */
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { computeFGFromBars, loadCache, saveCache, loadGlobals, cacheKey } from '../src/core/fg_cache.js';
import { detectAssetClass } from '../src/core/fg_calibrated.js';

const args = process.argv.slice(2);
const TF = args.includes('--tf') ? args[args.indexOf('--tf') + 1] : '60';
const LIMIT = parseInt(args.includes('--limit') ? args[args.indexOf('--limit') + 1] : '2000');
const TIMEOUT_S = parseInt(args.includes('--timeout') ? args[args.indexOf('--timeout') + 1] : '600');

const YAHOO_CFG = { '15': { range: '5d', interval: '15m' }, '60': { range: '1mo', interval: '1h' }, '240': { range: '3mo', interval: '1d' } };
const BINANCE_INT = { '15': '15m', '60': '1h', '240': '4h' };

async function fetchJSON(url, timeout = 5000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeout) });
  return r.ok ? r.json() : null;
}

function bar(time, o, h, l, c, v) {
  return { time: time > 1e12 ? Math.floor(time / 1000) : time, open: +o, high: +h, low: +l, close: +c, volume: +v || 0 };
}

async function yahooIntraday(symbol, tf) {
  const cfg = YAHOO_CFG[tf]; if (!cfg) return null;
  let d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`);
  if (!d?.chart?.result?.[0]?.timestamp && !symbol.includes('-') && !symbol.includes('.'))
    d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '-USD')}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`);
  const ch = d?.chart?.result?.[0]; if (!ch?.timestamp) return null;
  const q = ch.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ch.timestamp.length; i++)
    if (q.close[i] != null && q.open[i] != null) bars.push(bar(ch.timestamp[i], q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0));
  return bars.length >= 20 ? bars : null;
}

async function binanceIntraday(symbol, tf) {
  const interval = BINANCE_INT[tf]; if (!interval) return null;
  let pair = symbol.replace(/[-\/]/g, '').toUpperCase();
  if (!pair.endsWith('USDT') && !pair.endsWith('USD') && !pair.endsWith('BTC')) pair += 'USDT';
  const d = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=200`);
  return d?.length >= 20 ? d.map(b => bar(b[0], b[1], b[2], b[3], b[4], b[5])) : null;
}

async function ccIntraday(symbol, tf) {
  const fsym = symbol.toUpperCase().replace(/-USD$/, '').replace(/USDT$/, '').replace(/USD$/, '');
  const endpoint = tf === '15' ? 'histominute' : 'histohour';
  const limit = tf === '15' ? 200 : 200;
  const d = await fetchJSON(`https://min-api.cryptocompare.com/data/v2/${endpoint}?fsym=${fsym}&tsym=USD&limit=${limit}`);
  const candles = d?.Data?.Data?.filter(b => b.close > 0);
  return candles?.length >= 20 ? candles.map(b => bar(b.time, b.open, b.high, b.low, b.close, b.volumeto)) : null;
}

async function fetchBars(symbol, tf) {
  const cls = detectAssetClass(symbol);
  if (cls.includes('CRYPTO')) return await binanceIntraday(symbol, tf) || await ccIntraday(symbol, tf) || await yahooIntraday(symbol, tf);
  return await yahooIntraday(symbol, tf);
}

async function main() {
  const cache = loadCache();
  const globals = loadGlobals();
  const daily = Object.keys(cache).filter(k => k.endsWith(':D')).map(k => k.replace(':D', ''));
  const missing = daily.filter(s => !cache[cacheKey(s, TF)]);

  console.log(`Warming ${TF}m: ${missing.length} missing of ${daily.length} daily | limit=${LIMIT} timeout=${TIMEOUT_S}s`);
  const t0 = Date.now();
  let ok = 0, fail = 0;

  for (let i = 0; i < Math.min(missing.length, LIMIT); i++) {
    if (Date.now() - t0 > TIMEOUT_S * 1000) { console.log(`\nTimeout (${TIMEOUT_S}s)`); break; }
    const sym = missing[i];
    try {
      const bars = await fetchBars(sym, TF);
      if (bars) {
        const r = computeFGFromBars(bars, {}, globals);
        if (r) {
          cache[cacheKey(sym, TF)] = {
            lastScanTime: new Date().toISOString(), lastBarTime: r._state.lastBarTime,
            fgScore: r.fgScore, components: r.components, zone: r.zone, severity: r.severity,
            rsi: r.rsi, lastClose: r._state.lastClose, barCount: bars.length, _state: r._state,
          };
          ok++;
        } else fail++;
      } else fail++;
    } catch { fail++; }

    if ((i + 1) % 50 === 0) {
      console.log(`  [${i + 1}/${Math.min(missing.length, LIMIT)}] ${ok} ok ${fail} fail (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      saveCache(cache);
    }
    const cls = detectAssetClass(sym);
    await new Promise(r => setTimeout(r, cls.includes('CRYPTO') ? 200 : 100));
  }

  saveCache(cache);
  const total = Object.keys(cache).filter(k => k.endsWith(':' + TF)).length;
  console.log(`\nDone: ${ok} scored, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`${TF}m coverage: ${total} symbols`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
