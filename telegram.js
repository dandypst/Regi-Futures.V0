// telegram.js — Telegram bot integration untuk RRL-Futures

import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config.js';
import { logger, onLog } from './logger.js';
import { getState } from './state.js';
import { getLessons } from './lessons.js';
import { getAllMemory } from './pool-memory.js';
import { chat } from './agent.js';

const MOD = 'TELEGRAM';

let bot = null;
let registeredChatId = null;

const handlers = {
  onStop:   null,
  onStart:  null,
  onEvolve: null,
  onLearn:  null,
};

export function registerTelegramHandlers(h) {
  Object.assign(handlers, h);
}

// Helper: kirim pesan dengan .catch() selalu — tidak pernah throw
function reply(cid, text, opts = {}) {
  return bot.sendMessage(cid, text, opts).catch(e => {
    logger.warn(MOD, `sendMessage gagal: ${e.message}`);
  });
}

export function initTelegram() {
  const token = config.telegramBotToken;
  if (!token || token.startsWith('GANTI_')) {
    logger.warn(MOD, 'Telegram token tidak diset — Telegram dinonaktifkan');
    return null;
  }

  try {
    // Gunakan proxy jika HTTPS_PROXY diset (untuk bypass blokir ISP)
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    const botOptions = { polling: true };

    if (proxyUrl) {
      const agent = new HttpsProxyAgent(proxyUrl);
      botOptions.request = { agent };
      logger.info(MOD, `Telegram pakai proxy: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
    }

    bot = new TelegramBot(token, botOptions);
  } catch (e) {
    logger.error(MOD, `Gagal start Telegram bot: ${e.message}`);
    return null;
  }

  logger.sys(MOD, 'Telegram bot aktif — kirim pesan apa saja untuk registrasi');

  bot.on('message', async (msg) => {
    const cid  = msg.chat.id;
    const text = msg.text?.trim() || '';

    // Auto-register pengguna pertama
    if (!registeredChatId) {
      registeredChatId = cid;
      logger.sys(MOD, `Telegram chat terdaftar: ${cid}`);
      await reply(cid, '🤖 *RRL-Futures terhubung!*\nKetik /help untuk daftar perintah.', { parse_mode: 'Markdown' });
      return;
    }

    if (cid !== registeredChatId) return;

    if (text === '/help') {
      await reply(cid, helpText(), { parse_mode: 'Markdown' });

    } else if (text === '/status') {
      await reply(cid, statusText(), { parse_mode: 'Markdown' });

    } else if (text === '/positions') {
      await reply(cid, positionsText(), { parse_mode: 'Markdown' });

    } else if (text === '/lessons') {
      await reply(cid, lessonsText(), { parse_mode: 'Markdown' });

    } else if (text === '/memory') {
      await reply(cid, memoryText(), { parse_mode: 'Markdown' });

    } else if (text === '/evolve') {
      await reply(cid, '⚙️ Menjalankan evolusi threshold...');
      if (handlers.onEvolve) {
        try {
          const result = await handlers.onEvolve();
          await reply(cid, evolveResultText(result), { parse_mode: 'Markdown' });
        } catch (e) {
          await reply(cid, `❌ Evolve error: ${e.message}`);
        }
      }

    } else if (text === '/learn') {
      await reply(cid, '📚 Generating lessons dari trade history...');
      if (handlers.onLearn) {
        try {
          const count = await handlers.onLearn();
          await reply(cid, `✅ Generated ${count || 0} lessons baru`);
        } catch (e) {
          await reply(cid, `❌ Learn error: ${e.message}`);
        }
      }

    } else if (text === '/stop') {
      await reply(cid, '🛑 Menghentikan agent...');
      if (handlers.onStop) handlers.onStop();

    } else if (text === '/start_agent') {
      await reply(cid, '▶️ Memulai agent...');
      if (handlers.onStart) handlers.onStart();

    } else if (text.startsWith('/chat ')) {
      const q = text.slice(6).trim();
      await reply(cid, '💭 Thinking...');
      const res = await chat(q);
      await reply(cid, `🤖 ${res}`);

    } else if (text.startsWith('/')) {
      await reply(cid, '❓ Perintah tidak dikenal. Ketik /help');

    } else {
      // Free-form chat
      const res = await chat(text);
      await reply(cid, `🤖 ${res}`);
    }
  });

  // Polling error: 409 = duplicate instance saat restart — bukan error fatal
  bot.on('polling_error', (e) => {
    if (!(e.code === 'ETELEGRAM' && e.message.includes('409'))) {
      logger.error(MOD, `Polling error: ${e.message}`);
    }
  });

  // Forward TRADE dan ERROR log ke Telegram
  onLog((entry) => {
    if (!registeredChatId || !bot) return;
    if (entry.level === 'TRADE') {
      const emoji = entry.msg.toLowerCase().includes('close') ? '💰' : '📊';
      send(`${emoji} *[TRADE]* ${escMd(entry.msg)}`);
    } else if (entry.level === 'ERROR') {
      send(`🚨 *[ERROR]* \`${entry.module}\`: ${escMd(entry.msg)}`);
    }
  });

  return bot;
}

// send() pakai .catch() — tidak pernah throw ke caller
export function send(text) {
  if (!bot || !registeredChatId) return;
  bot.sendMessage(registeredChatId, text, { parse_mode: 'Markdown' }).catch(() => {});
}

export function sendCycleReport(type, data) {
  if (!bot || !registeredChatId) return;
  const state = getState();
  const emoji = type === 'screening' ? '🔍' : '⚙️';
  const lines = [
    `${emoji} *${type.toUpperCase()} CYCLE*`,
    `Mode: \`${state.mode}\` | Posisi: ${(state.openPositions||[]).length}/${config.maxPositions}`,
  ];
  if (data.action)           lines.push(`Aksi: \`${data.action}\`${data.pair ? ` → \`${data.pair}\`` : ''}`);
  if (data.reasoning)        lines.push(`_${escMd(String(data.reasoning))}_`);
  if (data.decisions?.length) lines.push(data.decisions.map(d => `${d.symbol}: \`${d.action}\``).join(' | '));
  send(lines.join('\n'));
}

// ── Text builders ─────────────────────────────────────────────────────────────

function helpText() {
  return `*RRL-Futures — Perintah*\n\n` +
    `/status — Status agent & performa\n` +
    `/positions — Posisi terbuka\n` +
    `/lessons — Daftar lessons\n` +
    `/memory — Skor per pair\n` +
    `/evolve — Evolusi threshold strategi\n` +
    `/learn — Generate lessons dari trade history\n` +
    `/stop — Hentikan agent\n` +
    `/start\\_agent — Mulai agent\n` +
    `/chat <pesan> — Chat dengan AI\n\n` +
    `_Atau ketik apa saja untuk chat langsung_`;
}

function statusText() {
  const state = getState();
  const m = state.metrics || {};
  return `*RRL-Futures Status*\n` +
    `Status: ${state.running ? '✅ Berjalan' : '🔴 Berhenti'}\n` +
    `Mode: \`${state.mode}\`\n` +
    `Siklus: ${state.cycles || 0}\n` +
    `Posisi: ${(state.openPositions||[]).length}/${config.maxPositions}\n\n` +
    `*Performa*\n` +
    `Total trade: ${m.totalTrades || 0}\n` +
    `Win rate: ${(m.winRate || 0).toFixed(1)}%\n` +
    `Total PnL: ${(m.totalPnl || 0).toFixed(2)} USDT\n` +
    `Hari ini: ${(m.todayPnl || 0).toFixed(2)} USDT`;
}

function positionsText() {
  const positions = getState().openPositions || [];
  if (!positions.length) return '📭 Tidak ada posisi terbuka';
  return '*Posisi Terbuka*\n' + positions.map(p => {
    const side = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const pnl  = parseFloat(p.unRealizedProfit || 0).toFixed(2);
    return `${parseFloat(pnl) >= 0 ? '📈' : '📉'} \`${p.symbol}\` ${side} | *${pnl}* USDT`;
  }).join('\n');
}

function lessonsText() {
  const lessons = getLessons();
  if (!lessons.length) return '📭 Belum ada lessons. Jalankan /learn setelah 3+ trades.';
  return `*Lessons (${lessons.length} total)*\n` +
    lessons.slice(-8).map((l, i) =>
      `${i+1}. [${l.pair||'GENERAL'}] ${escMd(l.insight||'')}`
    ).join('\n');
}

function memoryText() {
  const pairs = Object.values(getAllMemory());
  if (!pairs.length) return '📭 Belum ada memory pair';
  return '*Pair Memory*\n' +
    pairs.sort((a,b) => (b.score||0)-(a.score||0)).slice(0,8).map(p =>
      `\`${p.symbol}\` score:${(p.score||0).toFixed(0)} WR:${(p.winRate||0).toFixed(0)}% trades:${p.totalTrades||0}`
    ).join('\n');
}

function evolveResultText(result) {
  if (!result) return '❌ Evolve gagal atau data tidak cukup';
  const changes  = Object.entries(result.changes||{}).map(([k,v]) => `${k}: \`${v}\``).join(', ') || 'Tidak ada perubahan';
  const rational = (result.rationale||[]).map(r => `• ${escMd(r)}`).join('\n');
  return `*Evolve Selesai*\n${changes}\n\n${rational}`;
}

// Escape karakter Markdown v1 agar tidak error di Telegram
function escMd(text) {
  return String(text).replace(/[_*`\[]/g, '\\$&');
}
