// agent.js — AI brain / ReAct reasoning engine
// Indicators: EMA, RSI, BB, MACD, ATR, Stoch RSI, Volume Spike,
//             Candle Patterns, Fibonacci (Retracement/Extension/Channel),
//             Ichimoku Cloud
// Calls OpenRouter → returns trading decisions
// Falls back to rule-based logic if no API key

import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';
import { getLessonsContext } from './lessons.js';
import { getMemoryContext, rankPairs } from './pool-memory.js';
import { getState } from './state.js';
import {
  getKlines, getTicker,
  getFundingRate, getOpenInterest,
} from './binance.js';

const MOD = 'AGENT';

// ═══════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════

// ── EMA ───────────────────────────────────────────────────
function calcEMA(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// EMA array (semua nilai, bukan hanya terakhir) — dibutuhkan MACD & Ichimoku
function calcEMAArray(data, period) {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ── RSI ───────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

// ── Stochastic RSI ────────────────────────────────────────
function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  if (!closes || closes.length < rsiPeriod + stochPeriod + kPeriod + dPeriod) {
    return { k: 50, d: 50 };
  }
  // Build RSI array
  const rsiArr = [];
  for (let i = rsiPeriod; i <= closes.length; i++) {
    rsiArr.push(calcRSI(closes.slice(0, i), rsiPeriod));
  }
  if (rsiArr.length < stochPeriod) return { k: 50, d: 50 };

  // Stoch of RSI
  const stochArr = [];
  for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
    const slice = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...slice);
    const hi = Math.max(...slice);
    stochArr.push(hi === lo ? 50 : ((rsiArr[i] - lo) / (hi - lo)) * 100);
  }

  // %K = SMA of stoch
  const kArr = [];
  for (let i = kPeriod - 1; i < stochArr.length; i++) {
    kArr.push(stochArr.slice(i - kPeriod + 1, i + 1).reduce((s, v) => s + v, 0) / kPeriod);
  }

  // %D = SMA of %K
  if (kArr.length < dPeriod) return { k: kArr[kArr.length - 1] ?? 50, d: 50 };
  const d = kArr.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod;
  return { k: kArr[kArr.length - 1], d };
}

// ── Bollinger Bands ───────────────────────────────────────
function calcBB(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return {
    upper:     mean + 2 * std,
    middle:    mean,
    lower:     mean - 2 * std,
    bandwidth: mean > 0 ? (4 * std) / mean : 0,
    pct:       std > 0 ? (closes[closes.length - 1] - (mean - 2 * std)) / (4 * std) : 0.5,
  };
}

// ── MACD ──────────────────────────────────────────────────
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;
  const emaFastArr = calcEMAArray(closes, fast);
  const emaSlowArr = calcEMAArray(closes, slow);

  // Align arrays (emaFast longer than emaSlow by slow-fast)
  const diff = slow - fast;
  const macdLine = emaSlowArr.map((v, i) => emaFastArr[i + diff] - v);

  if (macdLine.length < signal) return null;
  const signalArr = calcEMAArray(macdLine, signal);
  const lastMACD  = macdLine[macdLine.length - 1];
  const lastSig   = signalArr[signalArr.length - 1];
  const prevMACD  = macdLine[macdLine.length - 2];
  const prevSig   = signalArr[signalArr.length - 2];

  return {
    macd:      lastMACD,
    signal:    lastSig,
    histogram: lastMACD - lastSig,
    // Crossover detection
    bullCross: prevMACD <= prevSig && lastMACD > lastSig,
    bearCross: prevMACD >= prevSig && lastMACD < lastSig,
  };
}

// ── ATR ───────────────────────────────────────────────────
function calcATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high  = klines[i].high;
    const low   = klines[i].low;
    const prev  = klines[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const slice = trs.slice(-period);
  const atr   = slice.reduce((s, v) => s + v, 0) / period;
  const price = klines[klines.length - 1].close;
  return {
    atr,
    atrPct: price > 0 ? (atr / price) * 100 : 0, // ATR sebagai % harga
  };
}

// ── Volume Spike ──────────────────────────────────────────
function calcVolumeSpike(klines, period = 20) {
  if (!klines || klines.length < period + 1) return null;
  const volumes  = klines.map(k => k.volume);
  const recent   = volumes[volumes.length - 1];
  const avgVol   = volumes.slice(-period - 1, -1).reduce((s, v) => s + v, 0) / period;
  return {
    ratio:    avgVol > 0 ? recent / avgVol : 1,
    isSpike:  avgVol > 0 && recent > avgVol * 1.5,  // >150% average = spike
    avgVol,
    curVol:   recent,
  };
}

// ── Candle Patterns ───────────────────────────────────────
function detectCandlePattern(klines) {
  if (!klines || klines.length < 3) return 'NONE';
  const c  = klines[klines.length - 1]; // current
  const p  = klines[klines.length - 2]; // previous
  const p2 = klines[klines.length - 3]; // 2 bars ago

  const body    = c => Math.abs(c.close - c.open);
  const range   = c => c.high - c.low;
  const isBull  = c => c.close > c.open;
  const isBear  = c => c.close < c.open;
  const upWick  = c => c.high - Math.max(c.open, c.close);
  const downWick= c => Math.min(c.open, c.close) - c.low;

  // Doji
  if (body(c) < range(c) * 0.1) return 'DOJI';

  // Hammer (bullish reversal)
  if (isBull(c) && downWick(c) > body(c) * 2 && upWick(c) < body(c) * 0.5)
    return 'HAMMER';

  // Shooting Star (bearish reversal)
  if (isBear(c) && upWick(c) > body(c) * 2 && downWick(c) < body(c) * 0.5)
    return 'SHOOTING_STAR';

  // Bullish Engulfing
  if (isBull(c) && isBear(p) && c.open < p.close && c.close > p.open)
    return 'BULL_ENGULFING';

  // Bearish Engulfing
  if (isBear(c) && isBull(p) && c.open > p.close && c.close < p.open)
    return 'BEAR_ENGULFING';

  // Morning Star (3-candle bullish reversal)
  if (isBear(p2) && body(p) < range(p) * 0.3 && isBull(c) && c.close > (p2.open + p2.close) / 2)
    return 'MORNING_STAR';

  // Evening Star (3-candle bearish reversal)
  if (isBull(p2) && body(p) < range(p) * 0.3 && isBear(c) && c.close < (p2.open + p2.close) / 2)
    return 'EVENING_STAR';

  // Marubozu (strong momentum)
  if (body(c) > range(c) * 0.9 && isBull(c)) return 'BULL_MARUBOZU';
  if (body(c) > range(c) * 0.9 && isBear(c)) return 'BEAR_MARUBOZU';

  return 'NONE';
}

// ── Fibonacci Retracement ─────────────────────────────────
// Cari swing high/low dalam N candle terakhir, hitung level retracement
function calcFibRetracement(klines, lookback = 50) {
  if (!klines || klines.length < lookback) return null;
  const slice    = klines.slice(-lookback);
  const high     = Math.max(...slice.map(k => k.high));
  const low      = Math.min(...slice.map(k => k.low));
  const diff     = high - low;
  const cur      = klines[klines.length - 1].close;

  const levels = {
    0:     high,
    0.236: high - diff * 0.236,
    0.382: high - diff * 0.382,
    0.5:   high - diff * 0.5,
    0.618: high - diff * 0.618,
    0.786: high - diff * 0.786,
    1:     low,
  };

  // Tentukan harga sekarang ada di zone mana
  const entries = Object.entries(levels).sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
  let zone = 'below_all';
  for (let i = 0; i < entries.length - 1; i++) {
    const upper = parseFloat(entries[i][1]);
    const lower = parseFloat(entries[i + 1][1]);
    if (cur <= upper && cur >= lower) {
      zone = `${entries[i + 1][0]}_to_${entries[i][0]}`;
      break;
    }
  }

  // Nearest support & resistance
  const allLevels = Object.values(levels).sort((a, b) => a - b);
  const support   = allLevels.filter(v => v <= cur).pop()  ?? low;
  const resistance= allLevels.filter(v => v >= cur).shift() ?? high;

  return { high, low, levels, zone, support, resistance, swingRange: diff };
}

// ── Trend-Based Fibonacci Extension ──────────────────────
// Proyeksikan target harga setelah breakout dari swing
function calcFibExtension(klines, lookback = 50) {
  if (!klines || klines.length < lookback) return null;
  const slice = klines.slice(-lookback);
  const high  = Math.max(...slice.map(k => k.high));
  const low   = Math.min(...slice.map(k => k.low));
  const diff  = high - low;

  // Uptrend extension (dari low)
  const upTargets = {
    1.0:   low + diff * 1.0,
    1.272: low + diff * 1.272,
    1.414: low + diff * 1.414,
    1.618: low + diff * 1.618,
    2.0:   low + diff * 2.0,
    2.618: low + diff * 2.618,
  };

  // Downtrend extension (dari high)
  const downTargets = {
    1.0:   high - diff * 1.0,
    1.272: high - diff * 1.272,
    1.414: high - diff * 1.414,
    1.618: high - diff * 1.618,
    2.0:   high - diff * 2.0,
    2.618: high - diff * 2.618,
  };

  const cur = klines[klines.length - 1].close;

  // Next upside & downside extension target
  const nextUp   = Object.values(upTargets).filter(v => v > cur).sort((a,b) => a - b)[0] ?? null;
  const nextDown = Object.values(downTargets).filter(v => v < cur).sort((a,b) => b - a)[0] ?? null;

  return { upTargets, downTargets, nextUp, nextDown };
}

// ── Fibonacci Channel ─────────────────────────────────────
// Parallel channel berdasarkan swing high/low & slope trend
function calcFibChannel(klines, lookback = 50) {
  if (!klines || klines.length < lookback) return null;
  const slice = klines.slice(-lookback);

  // Least squares linear regression untuk slope
  const n    = slice.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = slice.reduce((s, k) => s + k.close, 0);
  const sumXY= slice.reduce((s, k, i) => s + i * k.close, 0);
  const sumX2= slice.reduce((s, _, i) => s + i * i, 0);

  const slope     = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Trendline value di candle terakhir
  const trendVal  = intercept + slope * (n - 1);

  // Deviasi max dari trendline
  const deviations = slice.map((k, i) => k.close - (intercept + slope * i));
  const maxDev     = Math.max(...deviations.map(Math.abs));

  const cur = klines[klines.length - 1].close;

  return {
    trendValue:  trendVal,
    slope:       slope,           // positif = uptrend, negatif = downtrend
    channelUpper: trendVal + maxDev,
    channelLower: trendVal - maxDev,
    channelMid:   trendVal,
    // Fib channel levels
    fib618Upper:  trendVal + maxDev * 0.618,
    fib618Lower:  trendVal - maxDev * 0.618,
    fib382Upper:  trendVal + maxDev * 0.382,
    fib382Lower:  trendVal - maxDev * 0.382,
    // Posisi harga di dalam channel
    positionInChannel: maxDev > 0 ? (cur - (trendVal - maxDev)) / (2 * maxDev) : 0.5,
    // 0 = bawah channel, 0.5 = tengah, 1 = atas channel
  };
}

// ── Ichimoku Cloud ────────────────────────────────────────
function calcIchimoku(klines, tenkan = 9, kijun = 26, senkou = 52) {
  if (!klines || klines.length < senkou + kijun) return null;

  const midpoint = (arr, start, len) => {
    const slice = arr.slice(start, start + len);
    return (Math.max(...slice.map(k => k.high)) + Math.min(...slice.map(k => k.low))) / 2;
  };

  const last = klines.length - 1;

  // Tenkan-sen (Conversion Line) — 9 period midpoint
  const tenkanSen = midpoint(klines, last - tenkan + 1, tenkan);

  // Kijun-sen (Base Line) — 26 period midpoint
  const kijunSen  = midpoint(klines, last - kijun + 1, kijun);

  // Senkou Span A — (tenkan + kijun) / 2, plotted 26 ahead
  const senkouA   = (tenkanSen + kijunSen) / 2;

  // Senkou Span B — 52 period midpoint, plotted 26 ahead
  const senkouB   = midpoint(klines, last - senkou + 1, senkou);

  // Chikou Span — current close shifted 26 back (compare with price 26 ago)
  const chikouClose    = klines[last].close;
  const chikouCompare  = klines[last - kijun]?.close ?? null;

  const cur = klines[last].close;

  // Cloud analysis
  const cloudTop    = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const aboveCloud  = cur > cloudTop;
  const belowCloud  = cur < cloudBottom;
  const inCloud     = !aboveCloud && !belowCloud;
  const bullishCloud= senkouA > senkouB; // kumo berwarna hijau (bullish)

  // TK Cross
  const prevTenkan = midpoint(klines, last - tenkan, tenkan);
  const prevKijun  = midpoint(klines, last - kijun,  kijun);
  const tkBullCross = prevTenkan <= prevKijun && tenkanSen > kijunSen;
  const tkBearCross = prevTenkan >= prevKijun && tenkanSen < kijunSen;

  return {
    tenkanSen,
    kijunSen,
    senkouA,
    senkouB,
    cloudTop,
    cloudBottom,
    aboveCloud,
    belowCloud,
    inCloud,
    bullishCloud,
    tkBullCross,
    tkBearCross,
    chikouBullish: chikouCompare ? chikouClose > chikouCompare : null,
    // Signal strength: lebih banyak kondisi terpenuhi = lebih kuat
    bullSignals: [aboveCloud, bullishCloud, tkBullCross, tenkanSen > kijunSen,
                  chikouCompare ? chikouClose > chikouCompare : false].filter(Boolean).length,
    bearSignals: [belowCloud, !bullishCloud, tkBearCross, tenkanSen < kijunSen,
                  chikouCompare ? chikouClose < chikouCompare : false].filter(Boolean).length,
  };
}

// ── Regime Detection (EMA-based) ─────────────────────────
function detectRegime(klines) {
  if (!klines || klines.length < 50) return 'UNKNOWN';
  const closes = klines.map(k => k.close);
  const ema20  = calcEMA(closes.slice(-20), 20);
  const ema50  = calcEMA(closes.slice(-50), 50);
  if (!ema20 || !ema50) return 'UNKNOWN';
  const cur = closes[closes.length - 1];
  if (cur > ema20 && ema20 > ema50) return 'UPTREND';
  if (cur < ema20 && ema20 < ema50) return 'DOWNTREND';
  return 'RANGING';
}

// ═══════════════════════════════════════════════════════════
//  MARKET DATA GATHERING
// ═══════════════════════════════════════════════════════════

async function gatherMarketData(symbol) {
  const [klines4h, klines1h, klines15m, ticker, funding, oi] = await Promise.all([
    getKlines(symbol, '4h', 100).catch(() => []),
    getKlines(symbol, '1h', 100).catch(() => []),
    getKlines(symbol, '15m', 60).catch(() => []),  // untuk candle pattern & entry
    getTicker(symbol).catch(() => null),
    getFundingRate(symbol).catch(() => null),
    getOpenInterest(symbol).catch(() => null),
  ]);

  const c1h  = klines1h.map(k => k.close);
  const c4h  = klines4h.map(k => k.close);
  const c15m = klines15m.map(k => k.close);

  // Kalkulasi semua indikator
  const bb1h      = calcBB(c1h);
  const macd1h    = calcMACD(c1h);
  const macd4h    = calcMACD(c4h);
  const atr1h     = calcATR(klines1h);
  const atr4h     = calcATR(klines4h);
  const volSpike  = calcVolumeSpike(klines1h);
  const stochRSI  = calcStochRSI(c1h);
  const candle15m = detectCandlePattern(klines15m);
  const candle1h  = detectCandlePattern(klines1h);
  const fib       = calcFibRetracement(klines4h);
  const fibExt    = calcFibExtension(klines4h);
  const fibCh     = calcFibChannel(klines4h);
  const ichimoku  = calcIchimoku(klines4h);

  return {
    symbol,
    // Price & market
    price:           ticker ? parseFloat(ticker.lastPrice) : null,
    change24h:       ticker ? parseFloat(ticker.priceChangePercent) : null,
    volume24h:       ticker ? parseFloat(ticker.quoteVolume) : null,
    fundingRate:     funding ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) : null,
    openInterest:    oi ? parseFloat(oi.openInterest).toFixed(0) : null,

    // Trend / regime
    regime4h:        detectRegime(klines4h),
    regime1h:        detectRegime(klines1h),
    ema20_1h:        calcEMA(c1h.slice(-20), 20)?.toFixed(2) ?? null,
    ema50_1h:        calcEMA(c1h.slice(-50), 50)?.toFixed(2) ?? null,

    // Momentum
    rsi4h:           calcRSI(c4h).toFixed(1),
    rsi1h:           calcRSI(c1h).toFixed(1),
    stochK:          stochRSI.k.toFixed(1),
    stochD:          stochRSI.d.toFixed(1),

    // MACD
    macd1h_hist:     macd1h?.histogram.toFixed(4) ?? null,
    macd1h_bull:     macd1h?.bullCross ?? false,
    macd1h_bear:     macd1h?.bearCross ?? false,
    macd4h_hist:     macd4h?.histogram.toFixed(4) ?? null,
    macd4h_bull:     macd4h?.bullCross ?? false,

    // Volatility
    bb_bandwidth:    bb1h?.bandwidth.toFixed(4) ?? null,
    bb_pct:          bb1h?.pct.toFixed(3) ?? null,  // 0=bawah band, 1=atas band
    atr1h_pct:       atr1h?.atrPct.toFixed(3) ?? null,
    atr4h_pct:       atr4h?.atrPct.toFixed(3) ?? null,
    atr1h_val:       atr1h?.atr ?? null,

    // Volume
    vol_spike:       volSpike?.isSpike ?? false,
    vol_ratio:       volSpike?.ratio.toFixed(2) ?? null,

    // Candle patterns
    candle_15m:      candle15m,
    candle_1h:       candle1h,

    // Fibonacci Retracement
    fib_zone:        fib?.zone ?? null,
    fib_support:     fib?.support?.toFixed(2) ?? null,
    fib_resistance:  fib?.resistance?.toFixed(2) ?? null,
    fib_swing_range: fib?.swingRange?.toFixed(2) ?? null,

    // Fibonacci Extension
    fib_ext_next_up:   fibExt?.nextUp?.toFixed(2) ?? null,
    fib_ext_next_down: fibExt?.nextDown?.toFixed(2) ?? null,

    // Fibonacci Channel
    fib_ch_slope:    fibCh?.slope?.toFixed(6) ?? null,
    fib_ch_upper:    fibCh?.channelUpper?.toFixed(2) ?? null,
    fib_ch_lower:    fibCh?.channelLower?.toFixed(2) ?? null,
    fib_ch_pos:      fibCh?.positionInChannel?.toFixed(3) ?? null, // 0=bawah,1=atas

    // Ichimoku
    ichi_above_cloud:  ichimoku?.aboveCloud ?? null,
    ichi_below_cloud:  ichimoku?.belowCloud ?? null,
    ichi_in_cloud:     ichimoku?.inCloud ?? null,
    ichi_bull_cloud:   ichimoku?.bullishCloud ?? null,
    ichi_tk_bull:      ichimoku?.tkBullCross ?? false,
    ichi_tk_bear:      ichimoku?.tkBearCross ?? false,
    ichi_bull_signals: ichimoku?.bullSignals ?? 0,  // 0-5
    ichi_bear_signals: ichimoku?.bearSignals ?? 0,  // 0-5
    ichi_chikou_bull:  ichimoku?.chikouBullish ?? null,
  };
}

// ═══════════════════════════════════════════════════════════
//  SCREENING AGENT
// ═══════════════════════════════════════════════════════════

export async function runScreeningAgent(pairs) {
  logger.ai(MOD, `Screening ${pairs.length} pairs dengan full indicator suite...`);

  const ranked   = rankPairs(pairs);
  const topPairs = ranked.length > 0
    ? ranked.slice(0, 6).map(r => r.symbol)
    : pairs.slice(0, 6);

  const marketDataAll = await Promise.all(
    topPairs.map(s => gatherMarketData(s).catch(e => {
      logger.warn(MOD, `Data gagal untuk ${s}: ${e.message}`);
      return { symbol: s, error: e.message };
    }))
  );

  const valid = marketDataAll.filter(d => !d.error && d.price);
  if (!valid.length) {
    logger.warn(MOD, 'Tidak ada data pasar valid — skip screening');
    return { action: 'WAIT', reasoning: 'No valid market data', confidence: 0 };
  }

  const state      = getState();
  const lessonsCtx = getLessonsContext();

  const marketSummary = valid.map(d => {
    const lines = [
      `${d.symbol}: price=${d.price} chg24h=${d.change24h}% vol24h=${d.volume24h?.toFixed(0)}`,
      `  Trend: regime4h=${d.regime4h} regime1h=${d.regime1h} ema20=${d.ema20_1h} ema50=${d.ema50_1h}`,
      `  Momentum: rsi4h=${d.rsi4h} rsi1h=${d.rsi1h} stochK=${d.stochK} stochD=${d.stochD}`,
      `  MACD: hist1h=${d.macd1h_hist} bullCross=${d.macd1h_bull} hist4h=${d.macd4h_hist} bullCross4h=${d.macd4h_bull}`,
      `  Volatility: bb_bw=${d.bb_bandwidth} bb_pct=${d.bb_pct} atr1h=${d.atr1h_pct}% atr4h=${d.atr4h_pct}%`,
      `  Volume: spike=${d.vol_spike} ratio=${d.vol_ratio}x`,
      `  Candles: 15m=${d.candle_15m} 1h=${d.candle_1h}`,
      `  Fib Ret: zone=${d.fib_zone} support=${d.fib_support} resistance=${d.fib_resistance}`,
      `  Fib Ext: nextUp=${d.fib_ext_next_up} nextDown=${d.fib_ext_next_down}`,
      `  Fib Channel: slope=${d.fib_ch_slope} pos=${d.fib_ch_pos} upper=${d.fib_ch_upper} lower=${d.fib_ch_lower}`,
      `  Ichimoku: aboveCloud=${d.ichi_above_cloud} bullCloud=${d.ichi_bull_cloud} tkBull=${d.ichi_tk_bull} bullSigs=${d.ichi_bull_signals}/5 bearSigs=${d.ichi_bear_signals}/5`,
      `  Market: funding=${d.fundingRate}% oi=${d.openInterest}`,
      `  Memory: ${getMemoryContext(d.symbol)}`,
    ];
    return lines.join('\n');
  }).join('\n\n');

  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    logger.warn(MOD, 'OpenRouter key tidak ada — pakai rule-based screening');
    return ruleBasedScreening(valid, state);
  }

  return callAI(buildScreeningPrompt(marketSummary, state, lessonsCtx), 'screening');
}

// ═══════════════════════════════════════════════════════════
//  MANAGEMENT AGENT
// ═══════════════════════════════════════════════════════════

export async function runManagementAgent(positions) {
  if (!positions?.length) return { decisions: [] };

  logger.ai(MOD, `Managing ${positions.length} positions...`);

  const positionData = await Promise.all(
    positions.map(async p => ({
      ...p,
      market: await gatherMarketData(p.symbol).catch(() => ({})),
    }))
  );

  const lessonsCtx = getLessonsContext();

  const posSummary = positionData.map(p => {
    const qty    = Math.abs(parseFloat(p.positionAmt));
    const side   = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry  = parseFloat(p.entryPrice);
    const pnl    = parseFloat(p.unRealizedProfit);
    const pnlPct = (qty > 0 && entry > 0) ? ((pnl / (qty * entry)) * 100).toFixed(2) : '0.00';
    const m      = p.market;
    return [
      `${p.symbol} ${side} qty=${qty} entry=${entry} mark=${p.markPrice} pnl=${pnl.toFixed(2)}USDT (${pnlPct}%) liq=${p.liquidationPrice}`,
      `  Trend: regime4h=${m.regime4h} rsi1h=${m.rsi1h} macd1h_hist=${m.macd1h_hist}`,
      `  Ichimoku: aboveCloud=${m.ichi_above_cloud} bullSigs=${m.ichi_bull_signals}/5 bearSigs=${m.ichi_bear_signals}/5`,
      `  Fib: zone=${m.fib_zone} support=${m.fib_support} resistance=${m.fib_resistance}`,
      `  Candle 1h=${m.candle_1h} vol_spike=${m.vol_spike} atr1h=${m.atr1h_pct}%`,
      `  Funding=${m.fundingRate}% | Memory: ${getMemoryContext(p.symbol)}`,
    ].join('\n');
  }).join('\n\n');

  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    return ruleBasedManagement(positionData);
  }

  return callAI(buildManagementPrompt(posSummary, lessonsCtx), 'management');
}

// ═══════════════════════════════════════════════════════════
//  PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════

function buildScreeningPrompt(marketSummary, state, lessonsCtx) {
  return `You are Hunter Alpha, an autonomous Binance Futures trading agent with access to a comprehensive indicator suite.

Settings: positions=${state.openPositions.length}/${config.maxPositions}, leverage=${config.leverage}x, risk=${(config.riskPerTrade*100).toFixed(1)}%, TP=${(config.takeProfitPct*100).toFixed(1)}%, SL=${(config.stopLossPct*100).toFixed(1)}%
${lessonsCtx}

INDICATOR LEGEND:
- regime4h/1h: UPTREND/DOWNTREND/RANGING (EMA20 vs EMA50)
- rsi: 0-100, oversold<30, overbought>70
- stochK/D: 0-100, oversold<20, overbought>80
- macd hist: positive=bullish momentum, negative=bearish; bullCross=signal crossover
- bb_pct: 0=lower band, 0.5=middle, 1=upper band
- vol_ratio: current vs 20-period average volume (>1.5=spike)
- fib_zone: e.g. "0.382_to_0.5" means price between 38.2% and 50% retracement
- fib_ch_pos: 0=bottom of channel, 0.5=middle, 1=top; slope>0=uptrend
- ichi_bull_signals/bear_signals: 0-5, higher=stronger signal
- ichi_aboveCloud: true=bullish bias, false=bearish
- candle patterns: HAMMER/BULL_ENGULFING=bullish reversal, SHOOTING_STAR/BEAR_ENGULFING=bearish

MARKET DATA:
${marketSummary}

ANALYSIS GUIDELINES:
- Best LONG setup: uptrend regime + rsi<50 bouncing + macd bullCross + above ichimoku cloud + price near fib support (0.382-0.618) + bullish candle + vol spike
- Best SHORT setup: downtrend regime + rsi>50 declining + macd bearCross + below ichimoku cloud + price near fib resistance + bearish candle
- Avoid: funding>0.05%, price in ichimoku cloud (unclear direction), fib_ch_pos extremes without reversal signal
- Confluence is key: require at least 4-5 indicators aligned

Rules: Only OPEN if confidence >65%. Trade WITH 4h trend.

Respond ONLY with raw JSON (no markdown):
{"action":"OPEN","pair":"BTCUSDT","side":"LONG","confidence":78,"reasoning":"reason max 200 chars","suggestedEntry":65000.00,"keyRisk":"risk factor"}
OR: {"action":"WAIT","reasoning":"reason","confidence":0}`;
}

function buildManagementPrompt(posSummary, lessonsCtx) {
  return `You are Healer Alpha, managing open Binance Futures positions with full indicator context.

Settings: TP=${(config.takeProfitPct*100).toFixed(1)}%, SL=${(config.stopLossPct*100).toFixed(1)}%
${lessonsCtx}

POSITIONS WITH INDICATORS:
${posSummary}

Consider: Close early if ichimoku turns against position, fib resistance hit, bearish candle pattern on 1h, MACD cross against position.
Hold if: ichimoku still aligned, price bouncing off fib support, volume spike in direction.

Respond ONLY with raw JSON (no markdown):
{"decisions":[{"symbol":"BTCUSDT","action":"HOLD","reason":"reason max 150 chars","newSL":null,"newTP":null}]}`;
}

// ═══════════════════════════════════════════════════════════
//  AI CALLER
// ═══════════════════════════════════════════════════════════

async function callAI(prompt, type) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      config.openRouterModel || 'anthropic/claude-3-haiku',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openRouterApiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/rrl-futures',
          'X-Title':       'RRL-Futures',
        },
        timeout: 30000,
      }
    );

    const raw    = res.data.choices[0].message.content.trim();
    const clean  = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(clean);
    logger.ai(MOD, `${type}: ${result.action || result.decisions?.length + ' decisions'}`);
    return result;
  } catch (e) {
    logger.error(MOD, `AI call gagal (${type}): ${e.message}`);
    return type === 'screening'
      ? { action: 'WAIT', reasoning: 'AI unavailable', confidence: 0 }
      : { decisions: [] };
  }
}

// ═══════════════════════════════════════════════════════════
//  RULE-BASED FALLBACKS (tanpa OpenRouter)
// ═══════════════════════════════════════════════════════════

function ruleBasedScreening(marketData, state) {
  if (state.openPositions.length >= (config.maxPositions || 3)) {
    return { action: 'WAIT', reasoning: 'Max posisi tercapai', confidence: 0 };
  }

  for (const d of marketData) {
    if (d.regime4h === 'UNKNOWN') continue;
    const rsi      = parseFloat(d.rsi1h);
    const ichiBull = d.ichi_bull_signals >= 3;
    const ichiBear = d.ichi_bear_signals >= 3;
    const macdBull = d.macd1h_bull || parseFloat(d.macd1h_hist || 0) > 0;
    const macdBear = d.macd1h_bear || parseFloat(d.macd1h_hist || 0) < 0;
    const bullCandle = ['HAMMER','BULL_ENGULFING','MORNING_STAR','BULL_MARUBOZU'].includes(d.candle_1h);
    const bearCandle = ['SHOOTING_STAR','BEAR_ENGULFING','EVENING_STAR','BEAR_MARUBOZU'].includes(d.candle_1h);

    // LONG: uptrend + oversold RSI + ichimoku bullish + macd bullish + bull candle/pattern
    const longScore = [
      d.regime4h === 'UPTREND',
      rsi < 45 && rsi > 20,
      ichiBull,
      macdBull,
      bullCandle || d.vol_spike,
      d.ichi_above_cloud,
    ].filter(Boolean).length;

    // SHORT: downtrend + overbought RSI + ichimoku bearish + macd bearish + bear candle
    const shortScore = [
      d.regime4h === 'DOWNTREND',
      rsi > 55 && rsi < 80,
      ichiBear,
      macdBear,
      bearCandle || d.vol_spike,
      d.ichi_below_cloud,
    ].filter(Boolean).length;

    if (longScore >= 4) {
      return {
        action: 'OPEN', pair: d.symbol, side: 'LONG',
        confidence: 55 + longScore * 5,
        reasoning: `${d.symbol} LONG: ${longScore}/6 signals aligned (regime+RSI+ichimoku+MACD)`,
        suggestedEntry: d.price, keyRisk: 'Trend reversal',
      };
    }
    if (shortScore >= 4) {
      return {
        action: 'OPEN', pair: d.symbol, side: 'SHORT',
        confidence: 55 + shortScore * 5,
        reasoning: `${d.symbol} SHORT: ${shortScore}/6 signals aligned (regime+RSI+ichimoku+MACD)`,
        suggestedEntry: d.price, keyRisk: 'Short squeeze',
      };
    }
  }

  return { action: 'WAIT', reasoning: 'Tidak ada konfluensi sinyal yang cukup', confidence: 0 };
}

function ruleBasedManagement(positions) {
  return {
    decisions: positions.map(p => {
      const qty    = Math.abs(parseFloat(p.positionAmt));
      const entry  = parseFloat(p.entryPrice);
      const pnl    = parseFloat(p.unRealizedProfit);
      const pnlPct = (qty > 0 && entry > 0) ? pnl / (qty * entry) : 0;
      const m      = p.market;

      // Close jika TP/SL hit
      if (pnlPct >=  (config.takeProfitPct || 0.03))
        return { symbol: p.symbol, action: 'CLOSE', reason: `TP: ${(pnlPct*100).toFixed(2)}%`, newSL: null, newTP: null };
      if (pnlPct <= -(config.stopLossPct || 0.015))
        return { symbol: p.symbol, action: 'CLOSE', reason: `SL: ${(pnlPct*100).toFixed(2)}%`, newSL: null, newTP: null };

      // Close early jika ichimoku berbalik kuat
      const isLong  = parseFloat(p.positionAmt) > 0;
      if (isLong  && m.ichi_bear_signals >= 4)
        return { symbol: p.symbol, action: 'CLOSE', reason: `Ichimoku berbalik bearish (${m.ichi_bear_signals}/5)`, newSL: null, newTP: null };
      if (!isLong && m.ichi_bull_signals >= 4)
        return { symbol: p.symbol, action: 'CLOSE', reason: `Ichimoku berbalik bullish (${m.ichi_bull_signals}/5)`, newSL: null, newTP: null };

      return { symbol: p.symbol, action: 'HOLD', reason: `PnL ${(pnlPct*100).toFixed(2)}% — dalam range`, newSL: null, newTP: null };
    }),
  };
}

// ═══════════════════════════════════════════════════════════
//  FREE-FORM AI CHAT
// ═══════════════════════════════════════════════════════════

let chatHistory = [];

export async function chat(userMessage) {
  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    return 'OpenRouter API key belum diset di .env';
  }

  const state  = getState();
  const sysMsg = {
    role: 'system',
    content: `You are a helpful assistant for RRL-Futures AI trading bot.
State: mode=${state.mode}, running=${state.running}, positions=${state.openPositions.length}, balance=${JSON.stringify(state.balance)}
${getLessonsContext()}
Be concise. Reply in the same language as the user.`,
  };

  const messages = [sysMsg, ...chatHistory, { role: 'user', content: userMessage }];

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model: config.openRouterModel || 'anthropic/claude-3-haiku', max_tokens: 500, messages },
      {
        headers: {
          'Authorization': `Bearer ${config.openRouterApiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/rrl-futures',
          'X-Title':       'RRL-Futures',
        },
        timeout: 20000,
      }
    );

    const reply = res.data.choices[0].message.content;
    chatHistory.push({ role: 'user', content: userMessage }, { role: 'assistant', content: reply });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    return reply;
  } catch (e) {
    logger.error(MOD, `Chat error: ${e.message}`);
    return `AI error: ${e.message}`;
  }
}
