// binance.js — Binance Futures REST API wrapper
// Handles HMAC signing, testnet/live endpoint switching
// DRY_RUN=true → skip real order submission (still hits testnet for reads)

import axios from 'axios';
import { createHmac } from 'crypto';
import { getBinanceConfig } from './config.js';
import { logger } from './logger.js';

const MOD = 'BINANCE';

function sign(params, secret) {
  const qs = new URLSearchParams(params).toString();
  return createHmac('sha256', secret).update(qs).digest('hex');
}

function client() {
  const cfg = getBinanceConfig();

  // Proxy support — set HTTPS_PROXY di .env jika Binance diblokir ISP
  // Contoh: HTTPS_PROXY=http://127.0.0.1:7890
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;

  const axConfig = {
    baseURL: cfg.baseUrl,
    headers: { 'X-MBX-APIKEY': cfg.apiKey },
    timeout: 10000,
  };

  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      axConfig.proxy = {
        protocol: u.protocol.replace(':', ''),
        host:     u.hostname,
        port:     parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
        ...(u.username ? { auth: { username: u.username, password: u.password } } : {}),
      };
    } catch (e) {
      logger.warn(MOD, `Proxy URL tidak valid: ${proxyUrl}`);
    }
  }

  const ax = axios.create(axConfig);
  return { ax, cfg };
}

async function signedGet(path, params = {}) {
  const { ax, cfg } = client();
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await ax.get(path, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `GET ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

async function signedPost(path, params = {}) {
  const { ax, cfg } = client();
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await ax.post(path, null, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `POST ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

async function signedDelete(path, params = {}) {
  const { ax, cfg } = client();
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await ax.delete(path, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `DELETE ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

// ── Public endpoints ──────────────────────────────────────────────────────────

export async function getExchangeInfo() {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/exchangeInfo');
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

export async function getKlines(symbol, interval = '1h', limit = 100) {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/klines', { params: { symbol, interval, limit } });
    return res.data.map(k => ({
      time:   k[0],
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

export async function getTicker(symbol) {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/ticker/24hr', { params: { symbol } });
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

export async function getOrderBook(symbol, limit = 20) {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/depth', { params: { symbol, limit } });
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

export async function getFundingRate(symbol) {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/premiumIndex', { params: { symbol } });
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

export async function getOpenInterest(symbol) {
  const { ax } = client();
  try {
    const res = await ax.get('/fapi/v1/openInterest', { params: { symbol } });
    return res.data;
  } catch (e) {
    throw new Error(e.response?.data?.msg || e.message);
  }
}

// ── Account / Trade endpoints ─────────────────────────────────────────────────

export async function getBalance() {
  return signedGet('/fapi/v2/balance');
}

export async function getAccountInfo() {
  return signedGet('/fapi/v2/account');
}

export async function getPositions() {
  const data = await signedGet('/fapi/v2/positionRisk');
  return data.filter(p => parseFloat(p.positionAmt) !== 0);
}

export async function getAllPositions() {
  return signedGet('/fapi/v2/positionRisk');
}

export async function getOpenOrders(symbol) {
  const params = symbol ? { symbol } : {};
  return signedGet('/fapi/v1/openOrders', params);
}

export async function getOrderHistory(symbol, limit = 50) {
  return signedGet('/fapi/v1/allOrders', { symbol, limit });
}

export async function setLeverage(symbol, leverage) {
  return signedPost('/fapi/v1/leverage', { symbol, leverage });
}

export async function setMarginType(symbol, marginType = 'ISOLATED') {
  try {
    return await signedPost('/fapi/v1/marginType', { symbol, marginType });
  } catch (e) {
    // Code -4046: "No need to change margin type" — not an error
    if (e.message.includes('4046') || e.message.toLowerCase().includes('margin type')) {
      return { msg: 'already set' };
    }
    throw e;
  }
}

export async function placeOrder(params) {
  // FIX: DRY_RUN=true → simulate order (no real submission)
  // testnet mode → REAL orders go to testnet endpoint (not skipped)
  if (process.env.DRY_RUN === 'true') {
    logger.trade(MOD, `[DRY-RUN] Simulated order`, params);
    return {
      orderId:  `DRY_${Date.now()}`,
      status:   'FILLED',
      symbol:   params.symbol,
      side:     params.side,
      type:     params.type,
      origQty:  params.quantity || '0',
      price:    params.price || '0',
      avgPrice: params.price || '0',
    };
  }
  return signedPost('/fapi/v1/order', params);
}

export async function cancelOrder(symbol, orderId) {
  return signedDelete('/fapi/v1/order', { symbol, orderId });
}

export async function cancelAllOrders(symbol) {
  return signedDelete('/fapi/v1/allOpenOrders', { symbol });
}

export async function closePosition(symbol, positionAmt) {
  // FIX: do NOT send positionSide=BOTH with reduceOnly — conflicts in hedge mode
  // Use reduceOnly: true only, let Binance figure out the side
  const qty = Math.abs(parseFloat(positionAmt));
  const side = parseFloat(positionAmt) > 0 ? 'SELL' : 'BUY';
  return placeOrder({
    symbol,
    side,
    type: 'MARKET',
    quantity: qty.toFixed(3),
    reduceOnly: true,
  });
}

// ── Connectivity check ────────────────────────────────────────────────────────

export async function checkConnectivity() {
  try {
    const { ax } = client();
    await ax.get('/fapi/v1/ping');
    logger.info(MOD, `Binance ${getBinanceConfig().mode} connectivity OK`);
    return true;
  } catch (e) {
    logger.error(MOD, `Connectivity check failed: ${e.message}`);
    return false;
  }
}

// ── USD-M Futures pair discovery ─────────────────────────────────────────────

// Cache exchangeInfo agar tidak fetch berulang-ulang setiap screening cycle
let _exchangeInfoCache = null;
let _exchangeInfoTs    = 0;
const CACHE_TTL_MS     = 60 * 60 * 1000; // 1 jam

export async function getExchangeInfoCached() {
  if (_exchangeInfoCache && Date.now() - _exchangeInfoTs < CACHE_TTL_MS) {
    return _exchangeInfoCache;
  }
  _exchangeInfoCache = await getExchangeInfo();
  _exchangeInfoTs    = Date.now();
  return _exchangeInfoCache;
}

/**
 * Ambil semua pair USD-M Futures yang aktif tanpa SDK.
 * Satu GET ke /fapi/v1/exchangeInfo sudah cukup.
 *
 * @param {object}  opts
 * @param {string}  [opts.quoteAsset='USDT']  — filter quote (USDT, BUSD, dll)
 * @param {boolean} [opts.perpOnly=true]       — hanya PERPETUAL, bukan quarterly
 * @returns {string[]}  e.g. ['BTCUSDT','ETHUSDT','BNBUSDT',...]
 */
export async function getAllFuturesPairs({ quoteAsset = 'USDT', perpOnly = true } = {}) {
  try {
    const info = await getExchangeInfoCached();
    const symbols = info.symbols
      .filter(s =>
        s.status === 'TRADING' &&
        s.quoteAsset === quoteAsset &&
        (!perpOnly || s.contractType === 'PERPETUAL')
      )
      .map(s => s.symbol)
      .sort();
    logger.info(MOD, `USD-M Futures aktif: ${symbols.length} pair`);
    return symbols;
  } catch (e) {
    logger.error(MOD, `getAllFuturesPairs gagal: ${e.message}`);
    return [];
  }
}

/**
 * Ambil presisi qty (stepSize) dan harga (tickSize) per symbol.
 * Dipakai executor.js untuk rounding qty yang benar-benar akurat.
 *
 * @param {string} symbol
 * @returns {{ qtyPrecision, pricePrecision, minQty, minNotional }}
 */
export async function getSymbolPrecision(symbol) {
  try {
    const info = await getExchangeInfoCached();
    const sym  = info.symbols.find(s => s.symbol === symbol);
    if (!sym) return { qtyPrecision: 3, pricePrecision: 2, minQty: 0.001, minNotional: 5 };

    const lot      = sym.filters.find(f => f.filterType === 'LOT_SIZE')     || {};
    const notional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL') || {};
    const price    = sym.filters.find(f => f.filterType === 'PRICE_FILTER') || {};

    const stepSize = parseFloat(lot.stepSize   || '0.001');
    const tickSize = parseFloat(price.tickSize  || '0.01');

    return {
      qtyPrecision:   stepSize >= 1 ? 0 : Math.round(-Math.log10(stepSize)),
      pricePrecision: tickSize >= 1  ? 0 : Math.round(-Math.log10(tickSize)),
      minQty:         parseFloat(lot.minQty          || '0.001'),
      minNotional:    parseFloat(notional.notional   || '5'),
    };
  } catch (e) {
    return { qtyPrecision: 3, pricePrecision: 2, minQty: 0.001, minNotional: 5 };
  }
}
