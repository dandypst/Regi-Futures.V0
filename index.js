// index.js — Main orchestrator untuk RRL-Futures
// Entry point: node index.js

import { mkdirSync } from 'fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { loadState, setRunning, getState, bumpCycle, updateBalance } from './state.js';
import { loadLessons, generateLessonsFromTrades } from './lessons.js';
import { loadMemory } from './pool-memory.js';
import { loadTradeHistory, evolveThresholds, getEvolveSummary, saveTradeToHistory } from './evolve.js';
import { runScreeningAgent, runManagementAgent } from './agent.js';
import { openPosition, closePositionWithReason, syncPositions } from './executor.js';
import { initTelegram, registerTelegramHandlers, send, sendCycleReport } from './telegram.js';
import { initDashboard } from './dashboard-server.js';
import { checkConnectivity, getBalance, getAllFuturesPairs } from './binance.js';
import { recordPairTrade } from './pool-memory.js';

mkdirSync('./data', { recursive: true });
mkdirSync('./logs', { recursive: true });

const MOD = 'INDEX';
let managementTimer = null;
let screeningTimer  = null;
let running = false;

// ── Auto-load pairs dari Binance ──────────────────────────────────────────────

async function loadPairs() {
  if (!config.autoPairs) {
    const pairs = config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    logger.info(MOD, `Pairs dari config: ${pairs.length} pairs`);
    return pairs;
  }
  try {
    logger.info(MOD, 'autoPairs — fetching semua pair dari Binance...');
    const allPairs = await getAllFuturesPairs({
      quoteAsset: config.autoPairsQuote    || 'USDT',
      perpOnly:   config.autoPairsPerpOnly !== false,
    });
    if (!allPairs.length) {
      logger.warn(MOD, 'Gagal fetch pairs — pakai config');
      return config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    }
    const blacklist = config.pairsBlacklist || [];
    const filtered  = blacklist.length ? allPairs.filter(p => !blacklist.includes(p)) : allPairs;
    config.pairs = filtered;
    logger.sys(MOD, `autoPairs: ${filtered.length} pairs aktif`);
    return filtered;
  } catch (e) {
    logger.error(MOD, `loadPairs gagal: ${e.message}`);
    return config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
  }
}

// ── Simulated trade untuk testnet/dry-run ────────────────────────────────────
// Saat testnet/dry-run, agent tidak punya real closed trades.
// Tapi kita tetap bisa record "paper trade" dari keputusan screening,
// sehingga lessons & pool-memory tetap terisi dan bisa belajar.

function recordPaperTrade(decision, marketData) {
  if (!decision || decision.action !== 'OPEN') return;
  if (!config.dryRun && process.env.DRY_RUN !== 'true') return; // hanya di dry-run

  const symbol = decision.pair;
  const side   = decision.side;
  const entry  = decision.suggestedEntry || marketData?.price || 0;
  if (!symbol || !entry) return;

  // Simulasi: tutup paper trade setelah beberapa cycle berdasarkan TP/SL
  // Untuk sekarang, record sebagai "pending paper trade" di memory
  // Paper trade akan "diselesaikan" di management cycle berikutnya
  const paper = {
    symbol,
    side,
    entryPrice:  entry,
    exitPrice:   null,       // akan diisi saat "ditutup"
    pnl:         null,
    pnlPct:      null,
    closeReason: 'paper',
    leverage:    config.leverage,
    openedAt:    new Date().toISOString(),
    closedAt:    null,
    isPaper:     true,
    confidence:  decision.confidence,
  };

  // Simpan ke pool-memory sebagai sinyal (bukan trade nyata)
  recordPairTrade(symbol, {
    symbol,
    side,
    pnl:         0,          // neutral saat baru dibuka
    pnlPct:      0,
    closeReason: 'paper_open',
    regime:      'UNKNOWN',
    holdMinutes: 0,
  });

  logger.info(MOD, `[PAPER] Trade dicatat untuk lessons: ${side} ${symbol} @ ${entry}`);
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
    logger.warn(MOD, 'OPENROUTER_API_KEY belum diset — pakai rule-based fallback');
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
  if (!connected) logger.warn(MOD, 'Binance connectivity gagal — cek API key & jaringan');

  try {
    const balances = await getBalance();
    const usdt = balances.find(b => b.asset === 'USDT');
    if (usdt) {
      updateBalance({ USDT: parseFloat(usdt.availableBalance).toFixed(2) });
      logger.info(MOD, `Balance USDT: ${usdt.availableBalance}`);
    }
  } catch (e) {
    logger.warn(MOD, `Gagal fetch balance: ${e.message}`);
  }

  await loadPairs();

  logger.sys(MOD, `Dashboard → http://localhost:${config.dashboardPort || 3000}`);
  logger.sys(MOD, `Pairs aktif: ${config.pairs?.length || 0}`);
  logger.sys(MOD, `Evolve: ${JSON.stringify(getEvolveSummary())}`);
  logger.sys(MOD, 'Siap. Gunakan dashboard atau Telegram untuk memulai agent.');
}

// ── Agent start / stop ────────────────────────────────────────────────────────

async function startAgent(mode) {
  if (running) { logger.warn(MOD, 'Agent sudah berjalan'); return; }

  const targetMode = mode || getState().mode || 'testnet';
  config.mode = targetMode;
  running = true;
  setRunning(true, targetMode);

  await loadPairs();

  logger.sys(MOD, `▶ Agent dimulai — mode: ${targetMode} | ${config.pairs?.length} pairs`);
  send(`▶️ *RRL-Futures dimulai* dalam mode \`${targetMode}\` | ${config.pairs?.length} pairs`);

  await runManageCycle();
  await runScreenCycle();

  const manageMs = (config.managementIntervalMin || 10) * 60 * 1000;
  const screenMs = (config.screeningIntervalMin  || 30) * 60 * 1000;

  managementTimer = setInterval(runManageCycle, manageMs);
  screeningTimer  = setInterval(runScreenCycle,  screenMs);

  logger.sys(MOD, `Manage setiap ${config.managementIntervalMin}m | Screen setiap ${config.screeningIntervalMin}m`);
}

function stopAgent() {
  if (!running) { logger.warn(MOD, 'Agent tidak sedang berjalan'); return; }
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
    const pairs = config.pairs?.length ? config.pairs : ['BTCUSDT', 'ETHUSDT'];
    logger.info(MOD, `Screening ${pairs.length} pairs...`);

    const decision = await runScreeningAgent(pairs);
    logger.ai(MOD, `Screening: ${decision.action} ${decision.pair || ''} confidence=${decision.confidence}%`);

    if (decision.action === 'OPEN' && (decision.confidence || 0) >= 60) {
      const isDryRun = process.env.DRY_RUN === 'true' || config.dryRun;

      if (isDryRun) {
        // ── Mode testnet/dry-run: catat sebagai paper trade ────────────────
        logger.trade(MOD, `[PAPER] ${decision.side} ${decision.pair} @ ${decision.suggestedEntry}`);
        send(`📝 *[PAPER]* Sinyal ${decision.side} \`${decision.pair}\` @ ${decision.suggestedEntry} (confidence: ${decision.confidence}%)`);

        // Catat ke trade history sebagai paper trade dengan hasil simulasi
        const entry   = decision.suggestedEntry || 0;
        const tp      = config.takeProfitPct || 0.03;
        const sl      = config.stopLossPct   || 0.015;

        // Simulasi sederhana: 50/50 win/loss berdasarkan confidence
        const won     = decision.confidence >= 65;
        const pnlPct  = won ? tp : -sl;
        const pnl     = entry * pnlPct * (config.riskPerTrade || 0.02) * (config.leverage || 5);

        const paperTrade = {
          symbol:      decision.pair,
          side:        decision.side,
          entryPrice:  entry,
          exitPrice:   won ? entry * (1 + (decision.side === 'LONG' ? tp : -tp))
                           : entry * (1 - (decision.side === 'LONG' ? sl : -sl)),
          pnl,
          pnlPct:      pnlPct * 100,
          closeReason: won ? 'take_profit' : 'stop_loss',
          leverage:    config.leverage,
          openedAt:    new Date().toISOString(),
          closedAt:    new Date().toISOString(),
          isPaper:     true,
          confidence:  decision.confidence,
        };

        saveTradeToHistory(paperTrade);

        // Update pool memory
        recordPairTrade(decision.pair, {
          ...paperTrade,
          regime: decision.regime || 'UNKNOWN',
          holdMinutes: config.managementIntervalMin || 10,
        });

        logger.info(MOD, `[PAPER] Trade disimpan: ${decision.pair} ${decision.side} pnl:${pnl.toFixed(2)} (${won ? 'WIN' : 'LOSS'})`);

        // Auto-generate lessons setiap 5 paper trades
        const history      = loadTradeHistory();
        const paperHistory = history.filter(t => t.isPaper && t.closedAt);
        if (paperHistory.length > 0 && paperHistory.length % 5 === 0) {
          logger.ai(MOD, `Auto-generate lessons dari ${paperHistory.length} paper trades...`);
          generateLessonsFromTrades(paperHistory).catch(() => {});
        }

      } else {
        // ── Mode live: buka posisi nyata ────────────────────────────────────
        const result = await openPosition(decision);
        if (result) {
          send(`📊 Dibuka \`${result.symbol}\` ${result.side} @ ${result.entryPrice} | TP: ${result.tpPrice} | SL: ${result.slPrice}`);
          await syncPositions();
        }
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
  logger.sys(MOD, 'SIGINT — shutdown...');
  if (running) stopAgent();
  setTimeout(() => process.exit(0), 800);
});

process.on('uncaughtException',  (e) => logger.error(MOD, `Uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (r) => logger.error(MOD, `Unhandled rejection: ${r?.message || r}`));
