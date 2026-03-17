# Solana DLMM + GMGN Bot (Unified Project)

Project ini menggabungkan 2 komponen dalam **1 folder**:

- `gmgn-script/` → scraper GMGN (ambil kandidat token ke JSON)
- `dlmm-agent/` → bot executor DLMM Meteora (scan JSON, open/monitor/close posisi)

---

## Struktur Folder

```bash
/root/solana-dlmm-project
├── gmgn-script/
│   ├── gmgn.py                  # scraper GMGN via Playwright
│   ├── gmgn_api_response.json   # output token list
│   ├── gmgn_bot.log
│   └── restart.sh
└── dlmm-agent/
    ├── agent.js                 # main orchestrator (scan + monitor + close)
    ├── scanner.js               # filter token dari JSON GMGN + Meteora
    ├── meteora.js               # open/monitor/close posisi DLMM + Jupiter swap
    ├── cookin-scraper.js        # behavioral filter via cookin.fun
    ├── gmgn-top-traders.js      # scrape top 10 holders → support level
    ├── telegram.js              # module kirim notifikasi Telegram
    ├── close-token-accounts.js  # utility close token accounts manual
    ├── .env                     # konfigurasi semua parameter
    ├── state.json               # state posisi aktif
    ├── trade_log.json           # histori semua trade
    ├── known_pools.json         # cache pool yang pernah dipakai (orphan check)
    ├── agent.log                # log runtime
    ├── agent.pid                # PID guard single instance
    └── scripts/restart.sh       # restart bot dengan bersih
```

---

## Logic Kerja Bot (End-to-End)

### 1) GMGN Scraper (`gmgn-script/gmgn.py`)
- Buka `https://gmgn.ai/trend?chain=sol` via Playwright.
- Tangkap response API rank (`/api/v1/rank/sol/swaps/`).
- Simpan hasil terbaru ke:
  - `gmgn-script/gmgn_api_response.json`

### 2) DLMM Scanner (`dlmm-agent/scanner.js`)
- Baca `GMGN_JSON_PATH` dari `.env`.
- Parse token list dari JSON GMGN.
- Cari pair Meteora DLMM yang match token + SOL (pakai cache 30 menit).
- Terapkan filter aktif:
  - **Pool tersedia** → wajib ada pair SOL di Meteora DLMM
  - **Cookin.fun behavioral filter** → reject jika bearish count **> 2** dari 7 metrik:
    - Bundle, Dirty, Dumpers, AlphaHands, InProfit, Top10, SellImpact
- Filter yang sudah **DINONAKTIFKAN** (commented out di code):
  - ~~Spike 5m~~ (MAX_PRICE_CHANGE_5M)
  - ~~Spike 1h~~ (MAX_PRICE_CHANGE_1H)
  - ~~Minimum liquidity pool~~ (MIN_POOL_LIQUIDITY)
  - ~~Hard reject individual Cookin~~ (bundle > 70%, dumpers > 80%, dll)
  - **MC filter** → reject jika MC ≥ `MAX_MC_USD` (default **$2.000.000**)
- Hasil scan:
  - `passed[]` kandidat untuk dieksekusi
  - `rejected` counter alasan reject
  - `scannedTokens[]` daftar token yang discan (untuk notifikasi Telegram)

> Catatan: filter **MC** dan **Vol 5m** sudah dinonaktifkan (diasumsikan pre-filter dari JSON source).

### 3) DLMM Executor (`dlmm-agent/agent.js`)
- Jika belum ada posisi aktif:
  - pilih kandidat terbaik (sort by volume tertinggi)
  - buka posisi DLMM dengan 2 layer:
    - Layer 1: 70% modal → strategi **BidAsk**
    - Layer 2: 30% modal → strategi **Spot**
  - simpan state ke `state.json`
  - background scrape GMGN top 10 holders → hitung **Support Level** (weighted avg buy price)
- Jika ada posisi aktif:
  - **Monitor Tick** (tiap `MONITOR_INTERVAL_SEC`, default 2 detik): cek PnL realtime, trigger TP/SL/OOR
  - **Cycle** (tiap `CYCLE_INTERVAL_SEC`, default 60 detik): cek volume, TVL, kirim status Telegram
  - PnL diambil dari **Meteora datapi** (cocok sama angka di UI Meteora) — bukan estimasi lokal
  - opsional swap token sisa ke SOL via Jupiter Ultra API setelah close
- Kirim update ke Telegram (start, scan, open, status, close, crash).

### 4) Support Level (`dlmm-agent/gmgn-top-traders.js`)
- Setelah posisi dibuka, bot scrape GMGN top 10 holders token tersebut
- Hitung **weighted average buy price** berdasarkan % kepemilikan tiap holder
- Dijadikan acuan Stop Loss utama (menggantikan SL %)
- Disimpan ke `state.json` → digunakan di monitor tick

### 5) Kondisi Close Posisi (Auto-Close Triggers)

Bot punya **7 kondisi** yang bisa trigger close otomatis. Dicek di 2 tempat berbeda:

**Monitor Tick** (tiap `MONITOR_INTERVAL_SEC` = 2 detik) — realtime:

| Kondisi | Trigger | Nilai Aktif (.env) | Keterangan |
|---|---|---|---|
| 🔻 `SUPPORT_BROKEN` | Harga < avg buy top 10 holders & PnL minus | Dinamis (hasil scrape GMGN) | **SL utama** — menggantikan SL % jika data tersedia |
| 🛑 `STOP_LOSS` | PnL ≤ -N% | `STOP_LOSS_PCT=10` → **-10%** | **Fallback only** — hanya aktif jika support level tidak ada |
| 🎉 `TAKE_PROFIT` | PnL ≥ +N% | `TAKE_PROFIT_PCT=2` → **+2%** | Langsung close begitu nyentuh angka ini |
| 📈 `OOR_ABOVE` | Harga pump keluar range atas > N menit | `OOR_ABOVE_LIMIT_MIN=5` → **5 menit** | Cek volume dulu sebelum close — jika volume masih deres → **re-open** di range baru |

**Logic OOR Above detail:**
```
OOR Above > 5 menit
    ↓
Cek volume 5m token
    ↓
Vol >= OOR_ABOVE_REOPEN_VOL_USD ($30K) DAN reopenCount < OOR_ABOVE_MAX_REOPEN (2)?
    ├── YA → close posisi lama → swap sisa token → re-open di active bin baru (sama seperti open biasa)
    └── TIDAK → close total, scan token baru
```

> Env vars terkait: `OOR_ABOVE_REOPEN_VOL_USD=30000` (threshold vol re-open) | `OOR_ABOVE_MAX_REOPEN=2` (max re-open berturut, safety limit)
| 📉 `OOR_BELOW` | Harga dump keluar range bawah > N menit | `OOR_BELOW_LIMIT_MIN=20` → **20 menit** | Lebih toleran dari OOR_ABOVE karena dump kadang reversal |

**Run Cycle** (tiap `CYCLE_INTERVAL_SEC` = 60 detik) — per siklus:

| Kondisi | Trigger | Nilai Aktif (.env) | Keterangan |
|---|---|---|---|
| 🌵 `VOL_DRY` | Vol 5m < threshold selama N cycle berturut | `VOL_DRY_THRESHOLD_USD=15000`, `VOL_DRY_CYCLES=6` → **< $15K selama 6 menit** | Counter reset jika volume recover. Alert Telegram dikirim di cycle pertama |
| 🏊 `TVL_DILUTED` | TVL pool ≥ threshold setelah hold N menit | `TVL_DILUTED_THRESHOLD_USD=60000`, `TVL_DILUTED_MIN_HOLD_MIN=45` → **> $60K setelah 45 menit** | TVL membengkak = fee makin encer karena LP lain masuk banyak |

**Urutan prioritas check di Monitor Tick:**
```
SUPPORT_BROKEN → STOP_LOSS (fallback) → TAKE_PROFIT → OOR timeout
```

**Urutan prioritas check di Run Cycle:**
```
VOL_DRY → TVL_DILUTED → (Telegram status update)
```

---

### 6) Orphan Position Safety
- Secara periodik cek posisi orphan (posisi ada di chain tapi tidak ke-track state lokal).
- Jika ketemu orphan, bot coba close otomatis.

---

## Anti-Duplicate Process (Sudah Dipasang)

Untuk mencegah kasus banyak instance bot jalan bareng:

- `dlmm-agent/agent.js` punya **single-instance guard** berbasis `agent.pid`.
- `dlmm-agent/scripts/restart.sh` selalu:
  1. stop PID lama
  2. sapu proses nyangkut `node agent.js`
  3. start instance baru

Pakai ini setiap habis ubah logic:

```bash
cd /root/solana-dlmm-project/dlmm-agent
npm run restart:bg
```

---

## Setup Cepat

### 1) Siapkan environment
```bash
cd /root/solana-dlmm-project/dlmm-agent
cp .env.example .env
```

Lalu edit `.env` dan isi minimal:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `HELIUS_API_KEY` (+ `RPC_URL` jika pakai Helius)
- `JUPITER_API_KEY`
- `COOKIN_COOKIE` (opsional tapi direkomendasikan untuk filter cookin penuh)

---

## Menjalankan Komponen

### A. Jalankan GMGN scraper loop
```bash
cd /root/solana-dlmm-project/gmgn-script
./restart.sh
```

### B. Jalankan DLMM agent
```bash
cd /root/solana-dlmm-project/dlmm-agent
npm run restart:bg
```

---

## File Penting Operasional

- GMGN output: `gmgn-script/gmgn_api_response.json`
- DLMM state aktif: `dlmm-agent/state.json`
- Trade history: `dlmm-agent/trade_log.json`
- Log agent: `dlmm-agent/agent.log`
- PID agent: `dlmm-agent/agent.pid`
- Known pools cache: `dlmm-agent/known_pools.json`

---

## Quick Troubleshoot

- **Scan 0 token** → cek `gmgn_api_response.json` kosong/null.
- **Bot dobel notif** → cek duplicate process, lalu jalankan `npm run restart:bg`.
- **No candidate terus** → longgarkan filter spike/liquidity/cookin.
- **Crash** → lihat tail `dlmm-agent/agent.log`.
