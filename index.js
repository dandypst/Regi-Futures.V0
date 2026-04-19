// index.js — Main orchestrator untuk RRL-Futures
// Entry point: node index.js

import { mkdirSync } from 'fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadState, setRunning, getState, bumpCycle, updateBalance } from './state.js';
import { loadLessons, generateLessonsFromTrades } from './lessons.js';
import { loadMemory } from './pool-memory.js';
import { loadTradeHistory, evolveThresholds, getEvolveSummary } from './evolve.js';
import { runScreeningAgent, runManagementAgent } from './agent.js';
import { openPosition, closePositionWithReason, syncPositions } from './executor.js';
import { initTelegram, registerTelegramHandlers, send, sendCycleReport } from './telegram.js';
import { initDashboard } from './dashboard-server.js';
import { checkConnectivity, getBalance, getAllFuturesPairs } from './binance.js';

mkdirSync('./data', { recursive: true });
mkdirSync('./logs', { recursive: true });

const MOD = 'INDEX';
let managementTimer = null;
let screeningTimer  = null;
let running = false;

// ── Auto-load pairs dari Binance ──────────────────────────────────────────────

async function loadPairs() {
  // Jika user set autoPairs: true di user-config.json → fetch semua pair dari Binance
  // Jika autoPairs: false atau tidak ada → pakai pairs dari user-config.json
  if (!config.autoPairs) {
    const pairs = config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    logger.info(MOD, `Pairs dari config: ${pairs.length} pairs`);
    return pairs;
  }

  try {
    logger.info(MOD, 'autoPairs aktif — fetching semua pair USD-M Futures dari Binance...');

    const allPairs = await getAllFuturesPairs({
      quoteAsset: config.autoPairsQuote || 'USDT',
      perpOnly:   config.autoPairsPerpOnly !== false, // default true
    });

    if (!allPairs.length) {
      logger.warn(MOD, 'Gagal fetch pairs dari Binance — pakai pairs dari config');
      return config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    }

    // Filter opsional: blacklist pair tertentu
    const blacklist = config.pairsBlacklist || [];
    const filtered  = blacklist.length
      ? allPairs.filter(p => !blacklist.includes(p))
      : allPairs;

    // Update config.pairs supaya agent.js, dashboard, dan modul lain bisa akses
    config.pairs = filtered;

    logger.sys(MOD, `autoPairs: ${filtered.length} pairs aktif${blacklist.length ? ` (${blacklist.length} diblacklist)` : ''}`);
    send(`📋 autoPairs: ${filtered.length} pairs USD-M Futures dimuat`);

    return filtered;
  } catch (e) {
    logger.error(MOD, `loadPairs gagal: ${e.message} — pakai pairs dari config`);
    return config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function startup() {
  logger.sys(MOD, '╔══════════════════════════════════════╗');
  logger.sys(MOD, '║         RRL-Futures v1.0             ║');
  logger.sys(MOD, '║   AI Binance Futures Trading Agent   ║');
  logger.sys(MOD, '╚══════════════════════════════════════╝');

  loadState();
  loadLessons();
  loadMemory();

  const dryRun = process.env.DRY_RUN === 'true' || config.dryRun;
  logger.sys(MOD, `Mode: ${config.mode} | DryRun: ${dryRun}`);

  if (!process.env.BINANCE_TESTNET_API_KEY && !process.env.BINANCE_API_KEY) {
    logger.warn(MOD, 'BINANCE API KEY belum diset di .env');
  }
  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    logger.warn(MOD, 'OPENROUTER_API_KEY belum diset — agent akan pakai rule-based fallback');
  }

  const handlers = {
    onStart:      (mode) => startAgent(mode),
    onStop:       ()     => stopAgent(),
    onModeChange: (mode) => changeMode(mode),
    onEvolve:     ()     => evolveThresholds(),
    onLearn: async () => {
      const history = loadTradeHistory();
      return generateLessonsFromTrades(history.filter(t => t.closedAt));
    },
  };

  registerTelegramHandlers(handlers);
  initTelegram();
  initDashboard(handlers);

  const connected = await checkConnectivity();
  if (!connected) {
    logger.warn(MOD, 'Binance connectivity gagal — cek API key dan jaringan');
  }

  // Fetch balance
  try {
    const balances = await getBalance();
    const usdt = balances.find(b => b.asset === 'USDT');
    if (usdt) {
      updateBalance({ USDT: parseFloat(usdt.availableBalance).toFixed(2) });
      logger.info(MOD, `Balance USDT: ${usdt.availableBalance}`);
    }
  } catch (e) {
    logger.warn(MOD, `Gagal fetch balance awal: ${e.message}`);
  }

  // Load pairs (auto dari Binance atau dari config)
  await loadPairs();

  logger.sys(MOD, `Dashboard → http://localhost:${config.dashboardPort || 3000}`);
  logger.sys(MOD, `Pairs aktif: ${config.pairs?.length || 0}`);
  logger.sys(MOD, `Evolve: ${JSON.stringify(getEvolveSummary())}`);
  logger.sys(MOD, 'Siap. Gunakan dashboard atau Telegram untuk memulai agent.');
}

// ── Agent start / stop ────────────────────────────────────────────────────────

async function startAgent(mode) {
  if (running) {
    logger.warn(MOD, 'Agent sudah berjalan');
    return;
  }

  const targetMode = mode || getState().mode || 'testnet';
  config.mode = targetMode;
  running = true;
  setRunning(true, targetMode);

  // Refresh pairs saat start (bisa saja ada pair baru/dihapus)
  await loadPairs();

  logger.sys(MOD, `▶ Agent dimulai — mode: ${targetMode} | ${config.pairs?.length} pairs`);
  send(`▶️ *RRL-Futures dimulai* dalam mode \`${targetMode}\` | ${config.pairs?.length} pairs`);

  await runManageCycle();
  await runScreenCycle();

  const manageMs = (config.managementIntervalMin || 10) * 60 * 1000;
  const screenMs  = (config.screeningIntervalMin  || 30) * 60 * 1000;

  managementTimer = setInterval(runManageCycle, manageMs);
  screeningTimer  = setInterval(runScreenCycle,  screenMs);

  logger.sys(MOD, `Manage setiap ${config.managementIntervalMin}m | Screen setiap ${config.screeningIntervalMin}m`);
}

function stopAgent() {
  if (!running) {
    logger.warn(MOD, 'Agent tidak sedang berjalan');
    return;
  }
  clearInterval(managementTimer);
  clearInterval(screeningTimer);
  managementTimer = null;
  screeningTimer  = null;
  running = false;
  setRunning(false);
  logger.sys(MOD, '🛑 Agent dihentikan');
  send('🛑 *RRL-Futures dihentikan*');
}

function changeMode(mode) {
  const wasRunning = running;
  if (wasRunning) stopAgent();
  logger.sys(MOD, `Mode diubah → ${mode}`);
  send(`🔄 Mode diubah ke \`${mode}\``);
  if (wasRunning) startAgent(mode);
  else config.mode = mode;
}

// ── Management cycle ──────────────────────────────────────────────────────────

async function runManageCycle() {
  if (!running) return;
  logger.info(MOD, '─── Management cycle ───');
  try {
    const positions = await syncPositions();
    bumpCycle('manage');

    if (!positions.length) {
      logger.info(MOD, 'Tidak ada posisi terbuka');
      return;
    }

    const decision = await runManagementAgent(positions);
    if (!decision.decisions?.length) return;

    for (const d of decision.decisions) {
      if (d.action === 'CLOSE') {
        const pos = positions.find(p => p.symbol === d.symbol);
        if (pos) {
          await closePositionWithReason(pos, d.reason);
          send(`💰 Closed \`${d.symbol}\`: _${d.reason}_`);
          await syncPositions();
        }
      } else {
        logger.info(MOD, `${d.symbol}: ${d.action} — ${d.reason}`);
      }
    }

    sendCycleReport('management', decision);
  } catch (e) {
    logger.error(MOD, `Management cycle error: ${e.message}`);
  }
}

// ── Screening cycle ───────────────────────────────────────────────────────────

async function runScreenCycle() {
  if (!running) return;
  logger.info(MOD, '─── Screening cycle ───');
  try {
    const state = getState();
    if (state.openPositions.length >= (config.maxPositions || 3)) {
      logger.info(MOD, 'Max posisi tercapai — skip screening');
      return;
    }

    bumpCycle('screen');

    // Pakai config.pairs yang sudah di-load (auto atau manual)
    const pairs = config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    logger.info(MOD, `Screening dari ${pairs.length} pairs...`);

    const decision = await runScreeningAgent(pairs);
    logger.ai(MOD, `Screening: ${decision.action} ${decision.pair || ''} confidence=${decision.confidence}%`);

    if (decision.action === 'OPEN' && (decision.confidence || 0) >= 60) {
      const result = await openPosition(decision);
      if (result) {
        send(`📊 Dibuka \`${result.symbol}\` ${result.side} @ ${result.entryPrice} | TP: ${result.tpPrice} | SL: ${result.slPrice}`);
        await syncPositions();
      }
    }

    sendCycleReport('screening', decision);
  } catch (e) {
    logger.error(MOD, `Screening cycle error: ${e.message}`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

startup().catch(e => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  logger.sys(MOD, 'SIGINT diterima — shutdown...');
  if (running) stopAgent();
  setTimeout(() => process.exit(0), 800);
});

process.on('uncaughtException', (e) => {
  logger.error(MOD, `Uncaught exception: ${e.message}\n${e.stack}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error(MOD, `Unhandled rejection: ${reason?.message || reason}`);
});
