// state.js — In-memory + persisted state
// Path selalu relatif ke folder project

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = resolve(__dirname, 'data');
const STATE_FILE = resolve(DATA_DIR, 'state.json');
const MOD        = 'STATE';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

const DEFAULT_STATE = {
  running: false,
  mode: 'testnet',
  startedAt: null,
  lastManageCycle: null,
  lastScreenCycle: null,
  cycles: 0,
  activePairs: [],
  openPositions: [],
  pendingOrders: [],
  balance: {},
  metrics: {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnl: 0,
    todayPnl: 0,
    winRate: 0,
  },
};

let _state = { ...DEFAULT_STATE };

export function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      _state = { ...DEFAULT_STATE, ...raw };
      _state.running = false; // selalu reset running saat boot
      logger.sys(MOD, 'State loaded from disk');
    }
  } catch (e) {
    logger.warn(MOD, 'Could not load state, starting fresh');
    _state = { ...DEFAULT_STATE };
  }
}

export function saveState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
  } catch (e) {
    logger.error(MOD, `Could not save state: ${e.message}`);
  }
}

export function getState()            { return { ..._state }; }
export function setState(updates)     { Object.assign(_state, updates); saveState(); }

export function setRunning(val, mode) {
  _state.running    = val;
  if (mode) _state.mode = mode;
  _state.startedAt  = val ? new Date().toISOString() : null;
  saveState();
}

export function updatePositions(positions) { _state.openPositions = positions; saveState(); }
export function updateBalance(balance)     { _state.balance = balance; saveState(); }

export function recordTrade(trade) {
  const won = trade.pnl > 0;
  _state.metrics.totalTrades++;
  _state.metrics.totalPnl += trade.pnl;
  if (won) _state.metrics.winningTrades++;
  else     _state.metrics.losingTrades++;
  _state.metrics.winRate = _state.metrics.totalTrades > 0
    ? (_state.metrics.winningTrades / _state.metrics.totalTrades) * 100 : 0;

  const today = new Date().toDateString();
  if (_state._todayDate !== today) {
    _state._todayDate     = today;
    _state.metrics.todayPnl = 0;
  }
  _state.metrics.todayPnl += trade.pnl;
  saveState();
}

export function bumpCycle(type) {
  _state.cycles++;
  if (type === 'manage') _state.lastManageCycle = new Date().toISOString();
  if (type === 'screen') _state.lastScreenCycle = new Date().toISOString();
  saveState();
}
