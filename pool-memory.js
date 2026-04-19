// pool-memory.js — Per-pair performance memory

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATA_DIR     = resolve(__dirname, 'data');
const MEMORY_FILE  = resolve(DATA_DIR, 'pool-memory.json');
const MOD          = 'POOL-MEMORY';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let _memory = {};

export function loadMemory() {
  try {
    if (existsSync(MEMORY_FILE)) {
      _memory = JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
      logger.sys(MOD, `Pool memory loaded for ${Object.keys(_memory).length} pairs`);
    }
  } catch (e) {
    logger.warn(MOD, 'No pool memory found, starting fresh');
    _memory = {};
  }
}

export function saveMemory() {
  try { writeFileSync(MEMORY_FILE, JSON.stringify(_memory, null, 2)); }
  catch (e) { logger.error(MOD, `Could not save memory: ${e.message}`); }
}

function initPair(symbol) {
  if (!_memory[symbol]) {
    _memory[symbol] = {
      symbol, totalTrades: 0, wins: 0, losses: 0,
      totalPnl: 0, avgPnl: 0, winRate: 0,
      regimeHistory: [], avgHoldMinutes: 0,
      lastTrade: null, score: 50, skipUntil: null, notes: [],
    };
  }
  return _memory[symbol];
}

export function getPairMemory(symbol)  { return initPair(symbol); }
export function getAllMemory()          { return { ..._memory }; }

export function recordPairTrade(symbol, trade) {
  const mem = initPair(symbol);
  const won = trade.pnl > 0;

  mem.totalTrades++;
  mem.totalPnl += trade.pnl;
  mem.avgPnl    = mem.totalPnl / mem.totalTrades;
  if (won) mem.wins++; else mem.losses++;
  mem.winRate   = (mem.wins / mem.totalTrades) * 100;
  mem.lastTrade = new Date().toISOString();

  if (trade.holdMinutes) {
    mem.avgHoldMinutes = (mem.avgHoldMinutes * (mem.totalTrades - 1) + trade.holdMinutes) / mem.totalTrades;
  }

  if (trade.regime) {
    mem.regimeHistory.push({ regime: trade.regime, date: new Date().toISOString(), outcome: won ? 'win' : 'loss', pnl: trade.pnl });
    if (mem.regimeHistory.length > 50) mem.regimeHistory.shift();
  }

  const recent    = mem.regimeHistory.slice(-10);
  const recentWR  = recent.length > 0 ? recent.filter(r => r.outcome === 'win').length / recent.length : 0.5;
  mem.score       = Math.min(100, Math.max(0, 50 + (recentWR - 0.5) * 60 + Math.min(20, Math.max(-20, mem.avgPnl * 10))));

  const last3 = mem.regimeHistory.slice(-3);
  if (last3.length === 3 && last3.every(r => r.outcome === 'loss')) {
    mem.skipUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    logger.warn(MOD, `${symbol} cooldown 2h setelah 3 loss berturut-turut`);
  }

  saveMemory();
  logger.info(MOD, `${symbol} updated — score: ${mem.score.toFixed(1)}, WR: ${mem.winRate.toFixed(1)}%`);
}

export function isPairOnCooldown(symbol) {
  const mem = _memory[symbol];
  return mem?.skipUntil ? new Date(mem.skipUntil) > new Date() : false;
}

export function rankPairs(symbols) {
  return symbols
    .filter(s => !isPairOnCooldown(s))
    .map(s => ({ symbol: s, score: _memory[s]?.score ?? 50 }))
    .sort((a, b) => b.score - a.score);
}

export function getMemoryContext(symbol) {
  const mem = _memory[symbol];
  if (!mem || mem.totalTrades === 0) return `No memory for ${symbol}`;
  return `${symbol}: ${mem.totalTrades} trades, WR:${mem.winRate.toFixed(1)}%, avgPnl:${mem.avgPnl.toFixed(2)}, score:${mem.score.toFixed(1)}/100`;
}

export function addPairNote(symbol, note) {
  const mem = initPair(symbol);
  mem.notes.push({ note, ts: new Date().toISOString() });
  if (mem.notes.length > 20) mem.notes.shift();
  saveMemory();
}
