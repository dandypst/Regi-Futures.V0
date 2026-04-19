// config.js — Central configuration loader
// Reads from .env and user-config.json
// Path selalu relatif ke folder project (bukan cwd) — aman dijalankan dari mana saja

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// __dirname untuk ES Module
const __dirname = dirname(fileURLToPath(import.meta.url));

// Semua path relatif ke folder project, bukan cwd
const ENV_PATH    = resolve(__dirname, '.env');
const CONFIG_PATH = resolve(__dirname, 'user-config.json');

// Load .env dari folder project
dotenv.config({ path: ENV_PATH });

const DEFAULTS = {
  mode: 'testnet',
  dryRun: true,
  pairs: ['BTCUSDT', 'ETHUSDT'],
  leverage: 5,
  maxPositions: 3,
  riskPerTrade: 0.02,
  takeProfitPct: 0.03,
  stopLossPct: 0.015,
  trailingStop: false,
  managementIntervalMin: 10,
  screeningIntervalMin: 30,
  evolveMinTrades: 5,
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: 'anthropic/claude-3-haiku',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  dashboardPort: 3000,
};

let userConfig = {};
try {
  if (existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    console.log(`[config] Loaded user-config.json dari ${CONFIG_PATH}`);
  } else {
    console.warn(`[config] user-config.json tidak ditemukan di ${CONFIG_PATH} — pakai defaults`);
    console.warn(`[config] Jalankan: cp user-config.example.json user-config.json`);
  }
} catch (e) {
  console.warn(`[config] Gagal baca user-config.json: ${e.message} — pakai defaults`);
}

export const config = { ...DEFAULTS, ...userConfig };

// Binance API endpoints
export const BINANCE = {
  testnet: {
    baseUrl: 'https://testnet.binancefuture.com',
    wsUrl: 'wss://stream.binancefuture.com/ws',
  },
  live: {
    baseUrl: 'https://fapi.binance.com',
    wsUrl: 'wss://fstream.binance.com/ws',
  },
};

// Pisah API key testnet dan live
// testnet → BINANCE_TESTNET_API_KEY, fallback ke BINANCE_API_KEY
// live    → BINANCE_LIVE_API_KEY,    fallback ke BINANCE_API_KEY
export function getBinanceConfig() {
  const mode = config.mode || 'testnet';
  let apiKey, apiSecret;

  if (mode === 'testnet') {
    apiKey    = process.env.BINANCE_TESTNET_API_KEY    || process.env.BINANCE_API_KEY    || '';
    apiSecret = process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET || '';
  } else {
    apiKey    = process.env.BINANCE_LIVE_API_KEY    || process.env.BINANCE_API_KEY    || '';
    apiSecret = process.env.BINANCE_LIVE_API_SECRET || process.env.BINANCE_API_SECRET || '';
  }

  return { ...BINANCE[mode], apiKey, apiSecret, mode };
}

// Persist perubahan ke user-config.json
export function saveUserConfig(updates) {
  try {
    let current = {};
    if (existsSync(CONFIG_PATH)) {
      current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
    const merged = { ...current, ...updates };
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    Object.assign(userConfig, updates);
    Object.assign(config, updates);
  } catch (e) {
    console.error('[config] Gagal simpan user config:', e.message);
  }
}
