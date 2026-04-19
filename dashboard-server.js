// dashboard-server.js — Express HTTP + WebSocket server for the web dashboard
// Serves public/index.html, REST API, and streams live logs via WebSocket

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getState } from './state.js';
import { config, saveUserConfig } from './config.js';
import { getLessons } from './lessons.js';
import { getAllMemory } from './pool-memory.js';
import { getEvolveSummary, loadTradeHistory } from './evolve.js';
import { getRadarData } from './agent.js';
import { closePositionWithReason } from './executor.js';
import { getProxyStatus } from './binance.js';
import { onLog, logger } from './logger.js'; // FIX: single import line

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = 'DASHBOARD';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(resolve(__dirname, 'public')));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  logger.sys(MOD, 'Dashboard client connected');
  // Send full state immediately on connect
  try {
    ws.send(JSON.stringify({ type: 'state', data: getFullState() }));
  } catch (_) {}
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

// Stream logs to dashboard in real time
onLog((entry) => {
  broadcast({ type: 'log', data: entry });
  if (entry.level === 'TRADE' || entry.level === 'SYS' || (entry.level === 'AI' && entry.msg?.includes('Radar'))) {
    broadcast({ type: 'state', data: getFullState() });
  }
});

function getFullState() {
  const state = getState();
  return {
    ...state,
    config: {
      mode:                   config.mode,
      dryRun:                 process.env.DRY_RUN === 'true' || !!config.dryRun,
      pairs:                  config.pairs,
      leverage:               config.leverage,
      riskPerTrade:           config.riskPerTrade,
      takeProfitPct:          config.takeProfitPct,
      stopLossPct:            config.stopLossPct,
      trailingStop:           config.trailingStop,
      maxPositions:           config.maxPositions,
      managementIntervalMin:  config.managementIntervalMin,
      screeningIntervalMin:   config.screeningIntervalMin,
      autoPairs:              config.autoPairs,
      pairsBlacklist:         config.pairsBlacklist,
      openRouterModel:        config.openRouterModel,
      ollamaMode:             config.ollamaMode,
      ollamaBaseUrl:          config.ollamaBaseUrl,
      evolveMinTrades:        config.evolveMinTrades,
    },
    evolve:       getEvolveSummary(),
    lessonsCount: getLessons().length,
    memoryPairs:  Object.keys(getAllMemory()).length,
    proxy:        getProxyStatus(),
    dryRun:       process.env.DRY_RUN === 'true' || config.dryRun === true,
  };
}

// ── REST API ──────────────────────────────────────────────────────────────────

let _handlers = {};

// Broadcast state update ke semua WS client — dipanggil dari luar (misal setelah loadPairs)
export function broadcastState() {
  broadcast({ type: 'state', data: getFullState() });
}

export function initDashboard(handlers) {
  _handlers = handlers;
  const PORT = config.dashboardPort || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.sys(MOD, `Dashboard → http://localhost:${PORT}`);
  });
}

app.get('/api/state', (_req, res) => {
  res.json(getFullState());
});

// FIX: await the async onStart handler properly
app.post('/api/start', async (req, res) => {
  const { mode } = req.body;
  if (!_handlers.onStart) return res.status(500).json({ error: 'Handler not registered' });
  try {
    await _handlers.onStart(mode || 'testnet');
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true, mode: mode || 'testnet' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (_req, res) => {
  if (!_handlers.onStop) return res.status(500).json({ error: 'Handler not registered' });
  try {
    _handlers.onStop();
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (!['testnet', 'live'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode. Use "testnet" or "live"' });
  }
  if (!_handlers.onModeChange) return res.status(500).json({ error: 'Handler not registered' });
  try {
    _handlers.onModeChange(mode);
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true, mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/evolve', async (_req, res) => {
  if (!_handlers.onEvolve) return res.status(500).json({ error: 'Handler not registered' });
  try {
    const result = await _handlers.onEvolve();
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/learn', async (_req, res) => {
  if (!_handlers.onLearn) return res.status(500).json({ error: 'Handler not registered' });
  try {
    const count = await _handlers.onLearn();
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true, count: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/lessons', (_req, res) => {
  res.json(getLessons());
});

app.get('/api/memory', (_req, res) => {
  res.json(getAllMemory());
});

app.get('/api/history', (_req, res) => {
  res.json(loadTradeHistory().slice(-50));
});

// Manual close position dari dashboard
app.post('/api/close', async (req, res) => {
  const { symbol, positionAmt } = req.body;
  if (!symbol || positionAmt === undefined) {
    return res.status(400).json({ ok: false, error: 'symbol dan positionAmt wajib diisi' });
  }
  try {
    // Build position object minimal yang dibutuhkan closePositionWithReason
    const { getPositions } = await import('./binance.js');
    const positions = await getPositions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos) return res.status(404).json({ ok: false, error: `Posisi ${symbol} tidak ditemukan` });

    await closePositionWithReason(pos, 'manual close dari dashboard');
    broadcast({ type: 'state', data: getFullState() });
    logger.sys(MOD, `Manual close: ${symbol}`);
    res.json({ ok: true, symbol });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/radar', (_req, res) => {
  res.json(getRadarData());
});

// ── Settings API ─────────────────────────────────────────────────────────────

// GET current editable config
app.get('/api/settings', (_req, res) => {
  res.json({
    leverage:              config.leverage,
    maxPositions:          config.maxPositions,
    riskPerTrade:          config.riskPerTrade,
    takeProfitPct:         config.takeProfitPct,
    stopLossPct:           config.stopLossPct,
    trailingStop:          config.trailingStop,
    managementIntervalMin: config.managementIntervalMin,
    screeningIntervalMin:  config.screeningIntervalMin,
    evolveMinTrades:       config.evolveMinTrades,
    autoPairs:             config.autoPairs,
    pairs:                 (config.pairs || []).join(','),
    pairsBlacklist:        (config.pairsBlacklist || []).join(','),
    openRouterModel:       config.openRouterModel,
    ollamaMode:            config.ollamaMode,
    ollamaBaseUrl:         config.ollamaBaseUrl,
  });
});

// POST update config — validates then persists to user-config.json
app.post('/api/settings', (req, res) => {
  const body    = req.body;
  const updates = {};
  const errors  = [];

  // Numeric fields with bounds
  const numFields = {
    leverage:              [1, 20],
    maxPositions:          [1, 10],
    riskPerTrade:          [0.001, 0.1],
    takeProfitPct:         [0.005, 0.5],
    stopLossPct:           [0.002, 0.2],
    managementIntervalMin: [1, 60],
    screeningIntervalMin:  [5, 1440],
    evolveMinTrades:       [3, 50],
  };

  for (const [field, [min, max]] of Object.entries(numFields)) {
    if (body[field] !== undefined && body[field] !== '') {
      const val = parseFloat(body[field]);
      if (isNaN(val)) { errors.push(`${field}: harus angka`); continue; }
      if (val < min || val > max) { errors.push(`${field}: harus antara ${min}–${max}`); continue; }
      updates[field] = val;
    }
  }

  // Boolean
  if (body.dryRun       !== undefined) updates.dryRun       = body.dryRun       === true || body.dryRun       === 'true';
  if (body.trailingStop !== undefined) updates.trailingStop = body.trailingStop === true || body.trailingStop === 'true';
  if (body.autoPairs    !== undefined) updates.autoPairs    = body.autoPairs    === true || body.autoPairs    === 'true';
  if (body.ollamaMode   !== undefined) updates.ollamaMode   = body.ollamaMode   === true || body.ollamaMode   === 'true';

  // String fields
  if (body.openRouterModel !== undefined) updates.openRouterModel = String(body.openRouterModel).trim();
  if (body.ollamaBaseUrl   !== undefined) updates.ollamaBaseUrl   = String(body.ollamaBaseUrl).trim();

  // Pairs — comma-separated string → array
  if (body.pairs !== undefined && body.pairs !== '') {
    const parsed = String(body.pairs).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!parsed.length) errors.push('pairs: minimal 1 pair');
    else updates.pairs = parsed;
  }

  // Blacklist
  if (body.pairsBlacklist !== undefined) {
    updates.pairsBlacklist = body.pairsBlacklist === ''
      ? []
      : String(body.pairsBlacklist).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  if (errors.length) return res.status(400).json({ ok: false, errors });

  try {
    saveUserConfig(updates);
    logger.sys(MOD, `Settings updated: ${JSON.stringify(updates)}`);
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true, updated: updates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Manual close position dari dashboard
app.post('/api/close-position', async (req, res) => {
  const { symbol, posAmt } = req.body;
  if (!symbol || !posAmt) return res.status(400).json({ error: 'symbol dan posAmt diperlukan' });
  if (!_handlers.onClosePosition) return res.status(500).json({ error: 'Handler tidak terdaftar' });
  try {
    await _handlers.onClosePosition(symbol, posAmt);
    broadcast({ type: 'state', data: getFullState() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/evolve/summary', (_req, res) => {
  res.json(getEvolveSummary());
});
