# RRL-Futures — AI Trading Agent

Autonomous AI trading agent for Binance Futures, powered by LLMs via OpenRouter.  
Terinspirasi dari arsitektur [Meridian](https://github.com/yunus-0x/meridian), diadaptasi untuk Binance Futures.

---

## Struktur File (satu file = satu tanggung jawab)

```
index.js            — Orchestrator utama, start/stop cycle
config.js           — Loader konfigurasi (.env + user-config.json)
binance.js          — Binance Futures REST API (signing, testnet/live)
agent.js            — AI brain (ReAct reasoning + rule-based fallback)
executor.js         — Eksekusi trade (sizing, place order, close)
lessons.js          — Sistem lessons: simpan & generate dari trade history
pool-memory.js      — Memory per-pair: win rate, score, cooldown
evolve.js           — Auto-tuning threshold dari closed trade history
state.js            — State in-memory + disk (balance, posisi, metrics)
telegram.js         — Bot Telegram: notifikasi + commands
dashboard-server.js — Express HTTP + WebSocket untuk dashboard
logger.js           — Logger terpusat (console + file + broadcast WS)
public/index.html   — Web dashboard terminal gelap
.env                — API keys dan secrets (EDIT INI DULU)
user-config.json    — Parameter strategi trading
```

---

## Setup di VPS (langsung jalan)

**1. Clone dan masuk folder**
```bash
git clone <repo-url> rrl-futures
cd rrl-futures
```

**2. Install dependencies**
```bash
npm install
```

**3. Isi API keys di `.env`**
```bash
nano .env
```
Ganti nilai berikut:
- `BINANCE_API_KEY` — API key Binance kamu
- `BINANCE_API_SECRET` — Secret key Binance
- `OPENROUTER_API_KEY` — Key dari openrouter.ai (opsional, untuk AI brain)
- `TELEGRAM_BOT_TOKEN` — Token dari @BotFather (opsional)

**4. (Opsional) Sesuaikan strategi di `user-config.json`**
```bash
nano user-config.json
```
Default sudah aman: testnet + dry run.

**5. Jalankan dalam mode dry-run (aman, tidak ada order nyata)**
```bash
npm run dev
```

**6. Buka dashboard**
```
http://IP_VPS_KAMU:3000
```

**7. Setelah yakin, aktifkan live trading**

Di `.env`:
```
DRY_RUN=false
```
Di `user-config.json`:
```json
"mode": "live",
"dryRun": false
```
Lalu restart:
```bash
npm start
```

---

## Menjalankan di background (VPS, tanpa PM2)

```bash
# Dengan nohup
nohup npm start > logs/agent.log 2>&1 &

# Atau dengan PM2 (lebih disarankan)
npm install -g pm2
pm2 start index.js --name rrl-futures
pm2 save
pm2 startup
```

---

## Syarat

- Node.js 18+
- Akun Binance Futures (testnet atau live)
- OpenRouter API key → https://openrouter.ai (gratis, untuk AI brain)
- Telegram bot token → @BotFather (opsional)

---

## Cara kerja 3 sistem utama

### Lessons (`lessons.js`)
Setelah 3+ trade tertutup, tekan "Generate Lessons" di dashboard atau kirim `/learn` ke Telegram.
AI menganalisis pola dari trade history dan menyimpan insight ke `data/lessons.json`.
Setiap siklus agent berikutnya, lessons ini di-inject sebagai konteks ke prompt AI.

### Pool Memory (`pool-memory.js`)
Setiap trade dicatat per-pair: win rate, avg PnL, score 0–100.
Pair dengan 3 loss berturut-turut otomatis masuk cooldown 2 jam.
Saat screening, pairs diranking berdasarkan score historis sebelum dianalisis AI.

### Evolve (`evolve.js`)
Setelah 5+ trade tertutup (konfigurasi via `evolveMinTrades`), tekan "Evolve Thresholds".
AI (atau rule-based jika tidak ada OpenRouter key) menganalisis dan menyesuaikan:
leverage, riskPerTrade, takeProfitPct, stopLossPct.
Perubahan langsung aktif tanpa restart, disimpan ke `user-config.json`.

---

## Commands Telegram

```
/status        — Status agent + performa
/positions     — Posisi terbuka + PnL
/lessons       — Daftar lessons
/memory        — Score per pair
/evolve        — Jalankan evolusi threshold
/learn         — Generate lessons dari trade history
/stop          — Hentikan agent
/start_agent   — Mulai agent
/chat <pesan>  — Chat bebas dengan AI
```
Atau ketik apa saja untuk chat langsung dengan AI.

---

## File data (dibuat otomatis)

```
data/state.json          — State agent
data/lessons.json        — Lessons tersimpan
data/pool-memory.json    — Memory per pair
data/trade-history.json  — History trade tertutup
logs/agent.log           — Log lengkap
```

---

## Konfigurasi (`user-config.json`)

| Field | Default | Keterangan |
|---|---|---|
| `mode` | `testnet` | `testnet` atau `live` |
| `dryRun` | `true` | Simulasi tanpa order nyata |
| `pairs` | `[BTCUSDT, ETHUSDT, ...]` | Pair yang ditradingkan |
| `leverage` | `5` | Leverage futures (1–20) |
| `maxPositions` | `3` | Maks posisi terbuka sekaligus |
| `riskPerTrade` | `0.02` | Risiko per trade (2% balance) |
| `takeProfitPct` | `0.03` | Take profit 3% |
| `stopLossPct` | `0.015` | Stop loss 1.5% |
| `managementIntervalMin` | `10` | Interval siklus management |
| `screeningIntervalMin` | `30` | Interval siklus screening |
| `evolveMinTrades` | `5` | Min trade sebelum evolve bisa jalan |
| `openRouterModel` | `anthropic/claude-3-haiku` | Model AI via OpenRouter |
| `dashboardPort` | `3000` | Port HTTP dashboard |

---

## ⚠️ Disclaimer

Software ini disediakan apa adanya tanpa garansi apapun.
Trading futures otomatis membawa risiko finansial nyata — kamu bisa kehilangan dana.
Selalu mulai dengan `DRY_RUN=true` untuk memverifikasi perilaku sebelum live.
Jangan pernah trading lebih dari yang sanggup kamu rugikan.
Ini bukan saran finansial.
