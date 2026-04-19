// dashboard-server.js — Express HTTP + WebSocket server for the web dashboard
// Serves public/index.html, REST API, and streams live logs via WebSocket

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getState } from './state.js';
import { config } from './config.js';
import { getLessons } from './lessons.js';
import { getAllMemory } from './pool-memory.js';
import { getEvolveSummary, loadTradeHistory } from './evolve.js';
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
  if (entry.level === 'TRADE' || entry.level === 'SYS') {
    broadcast({ type: 'state', data: getFullState() });
  }
});

function getFullState() {
  const state = getState();
  return {
    ...state,
    config: {
      mode:                   config.mode,
      pairs:                  config.pairs,
      leverage:               config.leverage,
      riskPerTrade:           config.riskPerTrade,
      takeProfitPct:          config.takeProfitPct,
      stopLossPct:            config.stopLossPct,
      maxPositions:           config.maxPositions,
      managementIntervalMin:  config.managementIntervalMin,
      screeningIntervalMin:   config.screeningIntervalMin,
    },
    evolve:       getEvolveSummary(),
    lessonsCount: getLessons().length,
    memoryPairs:  Object.keys(getAllMemory()).length,
    proxy:        getProxyStatus(),
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

app.get('/api/evolve/summary', (_req, res) => {
  res.json(getEvolveSummary());
});
