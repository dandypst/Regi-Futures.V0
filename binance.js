// binance.js — Binance Futures REST API wrapper
// Smart proxy: auto-fallback ke proxy jika koneksi langsung diblokir ISP
// Retry direct setiap 5 menit untuk kembali ke mode normal

import axios from 'axios';
import { createHmac } from 'crypto';
import { getBinanceConfig } from './config.js';
import { logger } from './logger.js';

const MOD = 'BINANCE';

// ── HMAC Signing ──────────────────────────────────────────────────────────────

function sign(params, secret) {
  const qs = new URLSearchParams(params).toString();
  return createHmac('sha256', secret).update(qs).digest('hex');
}

// ── Smart Proxy Manager ───────────────────────────────────────────────────────
// Logika:
// 1. Coba koneksi langsung (direct) terlebih dahulu
// 2. Jika terdeteksi diblokir ISP (SSL error, iiniternetpositif) → aktifkan proxy
// 3. Setiap 5 menit, coba direct lagi — jika berhasil, kembali ke direct mode
// 4. Proxy tetap standby (tidak dimatikan), hanya diaktifkan kalau perlu

const proxyState = {
  useProxy:      false,
  failCount:     0,
  lastRetryDirect: 0,
  RETRY_INTERVAL:  5 * 60 * 1000, // 5 menit
};

// Kata kunci yang menandakan koneksi diblokir ISP Indonesia
const BLOCK_SIGNATURES = [
  'iiniternetpositif',
  'internetpositif',
  'altnames',
  'CERT_',
  'ERR_CERT',
  'certificate',
  'self signed',
  'unable to verify',
];

function isBlockedByISP(err) {
  const msg = String(err?.message || '') + String(err?.code || '');
  return BLOCK_SIGNATURES.some(kw => msg.toLowerCase().includes(kw.toLowerCase()));
}

function parseProxy(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    return {
      protocol: u.protocol.replace(':', ''),
      host:     u.hostname,
      port:     parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
      ...(u.username ? {
        auth: {
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password || ''),
        },
      } : {}),
    };
  } catch (_) {
    return null;
  }
}

function buildAxios(useProxy) {
  const cfg      = getBinanceConfig();
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;

  const axConfig = {
    baseURL:  cfg.baseUrl,
    headers:  { 'X-MBX-APIKEY': cfg.apiKey },
    timeout:  12000,
    proxy:    false, // default: matikan proxy env-var agar tidak auto-detect
  };

  if (useProxy && proxyUrl) {
    const parsed = parseProxy(proxyUrl);
    if (parsed) {
      axConfig.proxy = parsed;
    } else {
      logger.warn(MOD, `Proxy URL tidak valid: ${proxyUrl}`);
    }
  }

  return { ax: axios.create(axConfig), cfg };
}

// Core request dengan smart fallback
async function smartRequest(method, url, options = {}) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const hasProxy = !!proxyUrl;

  // ── Coba retry koneksi langsung (jika sedang di proxy mode) ──────────────
  if (proxyState.useProxy && hasProxy) {
    const now = Date.now();
    if (now - proxyState.lastRetryDirect > proxyState.RETRY_INTERVAL) {
      proxyState.lastRetryDirect = now;
      logger.info(MOD, '🔁 Retry koneksi langsung (setiap 5 menit)...');
      try {
        const { ax } = buildAxios(false);
        const res = await ax.request({ method, url, ...options });
        // Berhasil → kembali ke direct mode
        proxyState.useProxy  = false;
        proxyState.failCount = 0;
        logger.sys(MOD, '✅ Koneksi langsung pulih — kembali ke direct mode');
        return res;
      } catch (_) {
        logger.info(MOD, 'Koneksi langsung masih gagal — tetap pakai proxy');
      }
    }
  }

  // ── Request dengan mode aktif saat ini ───────────────────────────────────
  const { ax } = buildAxios(proxyState.useProxy && hasProxy);

  try {
    const res = await ax.request({ method, url, ...options });
    if (proxyState.failCount > 0) proxyState.failCount = 0;
    return res;

  } catch (err) {
    const blocked = isBlockedByISP(err);

    // Terdeteksi blokir ISP → aktifkan proxy otomatis
    if (blocked && hasProxy && !proxyState.useProxy) {
      proxyState.useProxy        = true;
      proxyState.failCount       = 0;
      proxyState.lastRetryDirect = Date.now();
      logger.warn(MOD, '🔀 Diblokir ISP → proxy diaktifkan otomatis');

      const { ax: axProxy } = buildAxios(true);
      try {
        const res = await axProxy.request({ method, url, ...options });
        logger.sys(MOD, '✅ Request berhasil via proxy');
        return res;
      } catch (proxyErr) {
        logger.error(MOD, `Proxy juga gagal: ${proxyErr.message}`);
        throw proxyErr;
      }
    }

    // Gagal berulang (bukan blokir) → aktifkan proxy sebagai precaution
    if (!blocked && !proxyState.useProxy) {
      proxyState.failCount++;
      if (proxyState.failCount >= 3 && hasProxy) {
        proxyState.useProxy        = true;
        proxyState.lastRetryDirect = Date.now();
        logger.warn(MOD, `⚠️ ${proxyState.failCount}x gagal berturut-turut → proxy diaktifkan sebagai precaution`);
      }
    }

    throw err;
  }
}

// Expose status proxy untuk dashboard
export function getProxyStatus() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  return {
    configured: !!proxyUrl,
    active:     proxyState.useProxy,
    failCount:  proxyState.failCount,
    proxyUrl:   proxyUrl
      ? proxyUrl.replace(/(?<=:\/\/[^:]*):([^@]*)@/, ':***@')
      : null,
  };
}

// ── Internal HTTP helpers ─────────────────────────────────────────────────────

async function rawGet(path, params = {}) {
  try {
    const res = await smartRequest('GET', path, { params });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `GET ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

async function signedGet(path, params = {}) {
  const { cfg } = buildAxios(false);
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await smartRequest('GET', path, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `GET ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

async function signedPost(path, params = {}) {
  const { cfg } = buildAxios(false);
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await smartRequest('POST', path, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `POST ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

async function signedDelete(path, params = {}) {
  const { cfg } = buildAxios(false);
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, cfg.apiSecret);
  try {
    const res = await smartRequest('DELETE', path, { params: p });
    return res.data;
  } catch (e) {
    const msg = e.response?.data?.msg || e.message;
    logger.error(MOD, `DELETE ${path} failed: ${msg}`);
    throw new Error(msg);
  }
}

// ── Public endpoints ──────────────────────────────────────────────────────────

export async function getExchangeInfo() {
  return rawGet('/fapi/v1/exchangeInfo');
}

export async function getKlines(symbol, interval = '1h', limit = 100) {
  const data = await rawGet('/fapi/v1/klines', { symbol, interval, limit });
  return data.map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

export async function getTicker(symbol) {
  return rawGet('/fapi/v1/ticker/24hr', { symbol });
}

export async function getOrderBook(symbol, limit = 20) {
  return rawGet('/fapi/v1/depth', { symbol, limit });
}

export async function getFundingRate(symbol) {
  return rawGet('/fapi/v1/premiumIndex', { symbol });
}

export async function getOpenInterest(symbol) {
  return rawGet('/fapi/v1/openInterest', { symbol });
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
  return signedGet('/fapi/v1/openOrders', symbol ? { symbol } : {});
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
    if (e.message.includes('4046') || e.message.toLowerCase().includes('margin type')) {
      return { msg: 'already set' };
    }
    throw e;
  }
}

export async function placeOrder(params) {
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
  const qty  = Math.abs(parseFloat(positionAmt));
  const side = parseFloat(positionAmt) > 0 ? 'SELL' : 'BUY';
  return placeOrder({
    symbol,
    side,
    type:       'MARKET',
    quantity:   qty.toFixed(3),
    reduceOnly: true,
  });
}

// ── Connectivity check ────────────────────────────────────────────────────────

export async function checkConnectivity() {
  try {
    await rawGet('/fapi/v1/ping');
    const proxy = getProxyStatus();
    const via   = proxy.active ? ` (via proxy: ${proxy.proxyUrl})` : ' (direct)';
    logger.info(MOD, `Binance ${getBinanceConfig().mode} connectivity OK${via}`);
    return true;
  } catch (e) {
    logger.error(MOD, `Connectivity check failed: ${e.message}`);
    return false;
  }
}

// ── Pair discovery ────────────────────────────────────────────────────────────

let _exchangeInfoCache = null;
let _exchangeInfoTs    = 0;
const CACHE_TTL_MS     = 60 * 60 * 1000;

export async function getExchangeInfoCached() {
  if (_exchangeInfoCache && Date.now() - _exchangeInfoTs < CACHE_TTL_MS) {
    return _exchangeInfoCache;
  }
  _exchangeInfoCache = await getExchangeInfo();
  _exchangeInfoTs    = Date.now();
  return _exchangeInfoCache;
}

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
    logger.info(MOD, `USD-M Futures aktif: ${symbols.length} pairs`);
    return symbols;
  } catch (e) {
    logger.error(MOD, `getAllFuturesPairs gagal: ${e.message}`);
    return [];
  }
}

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
      minQty:         parseFloat(lot.minQty        || '0.001'),
      minNotional:    parseFloat(notional.notional || '5'),
    };
  } catch (_) {
    return { qtyPrecision: 3, pricePrecision: 2, minQty: 0.001, minNotional: 5 };
  }
}
