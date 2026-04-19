// evolve.js — Threshold evolution system

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { config, saveUserConfig } from './config.js';
import { logger } from './logger.js';

const __dirname          = dirname(fileURLToPath(import.meta.url));
const DATA_DIR           = resolve(__dirname, 'data');
const TRADE_HISTORY_FILE = resolve(DATA_DIR, 'trade-history.json');
const MOD                = 'EVOLVE';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

export function loadTradeHistory() {
  try {
    if (existsSync(TRADE_HISTORY_FILE)) {
      return JSON.parse(readFileSync(TRADE_HISTORY_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

export function saveTradeToHistory(trade) {
  const history = loadTradeHistory();
  history.push({ ...trade, savedAt: new Date().toISOString() });
  const trimmed = history.slice(-200);
  writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  logger.info(MOD, `Trade saved to history (total: ${trimmed.length})`);
}

export async function evolveThresholds() {
  const history = loadTradeHistory();
  const closed  = history.filter(t => t.closedAt);

  if (closed.length < (config.evolveMinTrades || 5)) {
    logger.warn(MOD, `Need ${config.evolveMinTrades || 5}+ closed trades to evolve (have ${closed.length})`);
    return null;
  }

  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    logger.warn(MOD, 'No OpenRouter key — rule-based evolution');
    return ruleBasedEvolve(closed);
  }

  return aiEvolve(closed);
}

function ruleBasedEvolve(trades) {
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl < 0);
  const winRate = wins.length / trades.length;
  const changes = {};
  const rationale = [];

  if (winRate < 0.45 && config.leverage > 2) {
    changes.leverage = Math.max(2, config.leverage - 1);
    rationale.push(`Win rate ${(winRate*100).toFixed(1)}% < 45% → kurangi leverage ke ${changes.leverage}x`);
  } else if (winRate > 0.65 && config.leverage < 10) {
    changes.leverage = Math.min(10, config.leverage + 1);
    rationale.push(`Win rate ${(winRate*100).toFixed(1)}% > 65% → naikkan leverage ke ${changes.leverage}x`);
  }

  const slHits = losses.filter(t => t.closeReason === 'stop_loss').length;
  if (slHits / trades.length > 0.4) {
    changes.stopLossPct = parseFloat(Math.min(0.03, config.stopLossPct + 0.002).toFixed(3));
    rationale.push(`${slHits} SL hits → lebarkan SL ke ${(changes.stopLossPct*100).toFixed(1)}%`);
  }

  const tpHits = wins.filter(t => t.closeReason === 'take_profit').length;
  if (wins.length > 0 && tpHits / wins.length < 0.3) {
    changes.takeProfitPct = parseFloat(Math.max(0.01, config.takeProfitPct - 0.005).toFixed(3));
    rationale.push(`Hanya ${(tpHits/wins.length*100).toFixed(0)}% TP hits → turunkan TP ke ${(changes.takeProfitPct*100).toFixed(1)}%`);
  }

  const last5 = trades.slice(-5);
  if (last5.filter(t => t.pnl < 0).length >= 4 && config.riskPerTrade > 0.01) {
    changes.riskPerTrade = parseFloat(Math.max(0.01, config.riskPerTrade - 0.005).toFixed(3));
    rationale.push(`4/5 loss terakhir → kurangi risk ke ${(changes.riskPerTrade*100).toFixed(1)}%`);
  }

  if (!Object.keys(changes).length) rationale.push('Performa dalam range normal — tidak ada perubahan');

  applyChanges(changes, rationale);
  return { changes, rationale };
}

async function aiEvolve(trades) {
  const summary = trades.slice(-30).map(t =>
    `${t.symbol} ${t.side} lev:${t.leverage}x entry:${t.entryPrice} exit:${t.exitPrice} pnl:${t.pnl?.toFixed(2)} reason:${t.closeReason}`
  ).join('\n');

  const prompt = `You are a quant risk manager for a Binance Futures bot.
Current: leverage=${config.leverage}, riskPerTrade=${config.riskPerTrade}, TP=${config.takeProfitPct}, SL=${config.stopLossPct}

Last ${Math.min(30, trades.length)} trades:
${summary}

Respond ONLY with raw JSON:
{"changes":{"leverage":<omit if no change>,"riskPerTrade":<omit>,"takeProfitPct":<omit>,"stopLossPct":<omit>},"rationale":["reason1","reason2"]}`;

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model: config.openRouterModel || 'anthropic/claude-3-haiku', max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'Authorization': `Bearer ${config.openRouterApiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const clean  = res.data.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
    const result = JSON.parse(clean);
    applyChanges(result.changes || {}, result.rationale || []);
    return result;
  } catch (e) {
    logger.error(MOD, `AI evolve gagal: ${e.message} — fallback rule-based`);
    return ruleBasedEvolve(trades);
  }
}

function applyChanges(changes, rationale) {
  if (Object.keys(changes).length > 0) {
    if (changes.leverage)      changes.leverage      = Math.min(20, Math.max(1, changes.leverage));
    if (changes.riskPerTrade)  changes.riskPerTrade  = Math.min(0.05, Math.max(0.005, changes.riskPerTrade));
    if (changes.takeProfitPct) changes.takeProfitPct = Math.min(0.2, Math.max(0.01, changes.takeProfitPct));
    if (changes.stopLossPct)   changes.stopLossPct   = Math.min(0.1, Math.max(0.005, changes.stopLossPct));
    saveUserConfig(changes);
    logger.ai(MOD, `Thresholds evolved: ${JSON.stringify(changes)}`);
  }
  for (const r of rationale) logger.ai(MOD, `→ ${r}`);
}

export function getEvolveSummary() {
  const history = loadTradeHistory();
  const closed  = history.filter(t => t.closedAt);
  const wins    = closed.filter(t => t.pnl > 0);
  return {
    totalClosed: closed.length,
    winRate:     closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0',
    totalPnl:    closed.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
    avgPnl:      closed.length > 0 ? (closed.reduce((s, t) => s + (t.pnl || 0), 0) / closed.length).toFixed(2) : '0.00',
    canEvolve:   closed.length >= (config.evolveMinTrades || 5),
  };
}
