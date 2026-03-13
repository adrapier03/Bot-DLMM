# Solana DLMM + GMGN Bot (Unified Project)

Project ini menggabungkan 2 komponen dalam **1 folder**:

- `gmgn-script/` → scraper GMGN (ambil kandidat token ke JSON)
- `dlmm-agent/` → bot executor DLMM Meteora (scan JSON, open/monitor/close posisi)

---

## Struktur Folder

```bash
/root/solana-dlmm-project
├── gmgn-script/
│   ├── gmgn.py
│   ├── gmgn_api_response.json
│   └── gmgn_bot.log
└── dlmm-agent/
    ├── agent.js
    ├── scanner.js
    ├── meteora.js
    ├── cookin-scraper.js
    ├── .env
    ├── state.json
    ├── trade_log.json
    ├── known_pools.json
    ├── agent.log
    └── scripts/restart.sh
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
- Cari pair Meteora DLMM yang match token + SOL.
- Terapkan filter aktif:
  - Spike 5m
  - Spike 1h
  - Pool tersedia / no pool
  - Minimum liquidity pool
  - Cookin.fun behavioral filter
- Hasil scan:
  - `passed[]` kandidat untuk dieksekusi
  - `rejected` counter alasan reject
  - `scannedTokens[]` daftar token yang discan (untuk notifikasi Telegram)

> Catatan: filter **MC** dan **Vol 5m** sudah dinonaktifkan (diasumsikan pre-filter dari JSON source).

### 3) DLMM Executor (`dlmm-agent/agent.js`)
- Jika belum ada posisi aktif:
  - pilih kandidat terbaik
  - buka posisi DLMM
  - simpan state ke `state.json`
- Jika ada posisi aktif:
  - monitor PnL + fee
  - cek in-range / out-of-range
  - auto close kalau TP/SL/OOR/volume-dry condition terpenuhi
  - opsional swap token ke SOL
- Kirim update ke Telegram (start, scan, open, status, close, crash).

### 4) Orphan Position Safety
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
