// executor.js — Trade execution layer
// Sizing, precision dari exchangeInfo, leverage, TP/SL placement

import { config } from './config.js';
import { logger } from './logger.js';
import {
  getBalance, getTicker, setLeverage, setMarginType,
  placeOrder, closePosition, cancelAllOrders, getPositions,
  getSymbolPrecision,
} from './binance.js';
import { saveTradeToHistory } from './evolve.js';
import { recordPairTrade } from './pool-memory.js';
import { recordTrade, updatePositions } from './state.js';

const MOD = 'EXECUTOR';

// ── Rounding helper ───────────────────────────────────────────────────────────

function floorToPrecision(value, precision) {
  const factor = Math.pow(10, precision);
  return Math.floor(value * factor) / factor;
}

// ── Position sizing (pakai exchangeInfo untuk presisi akurat) ─────────────────

async function calcPositionSize(symbol, price) {
  try {
    const balances = await getBalance();
    const usdt = balances.find(b => b.asset === 'USDT');
    const available = usdt ? parseFloat(usdt.availableBalance) : 0;

    if (available <= 0) {
      logger.warn(MOD, 'Saldo USDT 0 atau tidak tersedia');
      return 0;
    }

    // Ambil presisi & minimum dari exchangeInfo (bukan hardcoded)
    const prec = await getSymbolPrecision(symbol);

    const riskAmount = available * (config.riskPerTrade || 0.02);
    const rawQty     = (riskAmount * (config.leverage || 5)) / price;
    let   qty        = floorToPrecision(rawQty, prec.qtyPrecision);

    // Pastikan qty >= minQty
    if (qty < prec.minQty) {
      qty = prec.minQty;
      logger.warn(MOD, `${symbol} qty di-set ke minQty: ${prec.minQty}`);
    }

    // Pastikan notional >= minNotional
    if (qty * price < prec.minNotional) {
      qty = floorToPrecision((prec.minNotional / price) * 1.05, prec.qtyPrecision);
      if (qty < prec.minQty) qty = prec.minQty;
      logger.warn(MOD, `${symbol} qty adjusted ke min notional: ${qty}`);
    }

    logger.info(MOD, `Size: ${qty} ${symbol} | balance: ${available.toFixed(2)} USDT | risk: ${riskAmount.toFixed(2)} USDT`);
    return qty;
  } catch (e) {
    logger.error(MOD, `Position sizing gagal: ${e.message}`);
    return 0;
  }
}

// ── Open position ─────────────────────────────────────────────────────────────

export async function openPosition(decision) {
  const { pair, side, confidence, reasoning, suggestedEntry } = decision;
  logger.trade(MOD, `Opening ${side} ${pair} (confidence: ${confidence}%)`, { reasoning });

  try {
    await setLeverage(pair, config.leverage);
    await setMarginType(pair, 'ISOLATED');

    const ticker = await getTicker(pair);
    const price  = parseFloat(ticker.lastPrice);
    if (!price || price <= 0) throw new Error(`Harga tidak valid: ${price}`);

    const qty = await calcPositionSize(pair, price);
    if (qty <= 0) {
      logger.error(MOD, `Qty tidak valid untuk ${pair}`);
      return null;
    }

    const order = await placeOrder({
      symbol:   pair,
      side:     side === 'LONG' ? 'BUY' : 'SELL',
      type:     'MARKET',
      quantity: qty.toString(),
    });

    logger.trade(MOD, `Entry order placed`, { orderId: order.orderId, qty, price });

    const entryPrice = suggestedEntry || price;
    const tp = config.takeProfitPct || 0.03;
    const sl = config.stopLossPct   || 0.015;

    // stopPrice harus STRING — sudah dipastikan oleh .toFixed()
    const tpPrice = (side === 'LONG'
      ? entryPrice * (1 + tp)
      : entryPrice * (1 - tp)
    ).toFixed(2);

    const slPrice = (side === 'LONG'
      ? entryPrice * (1 - sl)
      : entryPrice * (1 + sl)
    ).toFixed(2);

    // TP: closePosition='true' (string), TANPA quantity
    await placeOrder({
      symbol:        pair,
      side:          side === 'LONG' ? 'SELL' : 'BUY',
      type:          'TAKE_PROFIT_MARKET',
      stopPrice:     tpPrice,
      closePosition: 'true',
      timeInForce:   'GTE_GTC',
    }).catch(e => logger.warn(MOD, `TP order gagal (non-fatal): ${e.message}`));

    // SL: sama
    await placeOrder({
      symbol:        pair,
      side:          side === 'LONG' ? 'SELL' : 'BUY',
      type:          'STOP_MARKET',
      stopPrice:     slPrice,
      closePosition: 'true',
      timeInForce:   'GTE_GTC',
    }).catch(e => logger.warn(MOD, `SL order gagal (non-fatal): ${e.message}`));

    logger.trade(MOD, `${side} opened ${pair}`, { qty, entryPrice, tpPrice, slPrice });

    return { symbol: pair, side, entryPrice, qty, tpPrice, slPrice, orderId: order.orderId, openedAt: new Date().toISOString() };
  } catch (e) {
    logger.error(MOD, `Gagal buka ${pair}: ${e.message}`);
    return null;
  }
}

// ── Close position ────────────────────────────────────────────────────────────

export async function closePositionWithReason(position, reason) {
  const { symbol, positionAmt, entryPrice: rawEntry, markPrice: rawMark, unRealizedProfit: rawPnl } = position;
  const entryPrice    = parseFloat(rawEntry);
  const markPrice     = parseFloat(rawMark);
  const unrealizedPnl = parseFloat(rawPnl);

  logger.trade(MOD, `Closing ${symbol} — ${reason}`, { unrealizedPnl });

  try {
    await cancelAllOrders(symbol).catch(() => {});
    await closePosition(symbol, positionAmt);

    const posQty = Math.abs(parseFloat(positionAmt));
    const pnlPct = (posQty > 0 && entryPrice > 0)
      ? (unrealizedPnl / (posQty * entryPrice)) * 100 : 0;
    const side = parseFloat(positionAmt) > 0 ? 'LONG' : 'SHORT';

    const tradeRecord = {
      symbol, side, entryPrice,
      exitPrice:   markPrice,
      pnl:         unrealizedPnl,
      pnlPct,
      closeReason: reason,
      leverage:    config.leverage,
      closedAt:    new Date().toISOString(),
      holdMinutes: null,
    };

    saveTradeToHistory(tradeRecord);
    recordPairTrade(symbol, { ...tradeRecord, regime: 'UNKNOWN' });
    recordTrade(tradeRecord);

    logger.trade(MOD, `${symbol} closed — PnL: ${unrealizedPnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`);
    return tradeRecord;
  } catch (e) {
    logger.error(MOD, `Gagal close ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Sync positions ────────────────────────────────────────────────────────────

export async function syncPositions() {
  try {
    const positions = await getPositions();
    updatePositions(positions);
    return positions;
  } catch (e) {
    logger.error(MOD, `Gagal sync posisi: ${e.message}`);
    return [];
  }
}
