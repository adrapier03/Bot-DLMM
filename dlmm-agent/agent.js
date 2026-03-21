import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// ── Timestamp semua console.log ──────────────────────────────────────────────
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function _ts() { return new Date().toISOString().replace('T',' ').slice(0,19); }
console.log   = (...a) => _origLog(`[${_ts()}]`, ...a);
console.warn  = (...a) => _origWarn(`[${_ts()}]`, ...a);
console.error = (...a) => _origError(`[${_ts()}]`, ...a);
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import { sendTelegram } from './telegram.js';
import { scanTokens } from './scanner.js';
import { openPosition, monitorPosition, claimFees, closePosition, swapTokenToSol, fetchJupiterPriceUsd, scanOrphanPositions, connection, wallet } from './meteora.js';
import { scrapeCookinToken, passCookinFilter, formatCookinSummary } from './cookin-scraper.js';
import { scrapeGmgnTopTraders } from './gmgn-top-traders.js';

const STATE_FILE = './state.json';
const LOG_FILE = './trade_log.json';
const POOLS_FILE = './known_pools.json'; // track semua pool yang pernah dipakai
const PID_FILE = './agent.pid';

const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '20');
const EMERGENCY_STOP_LOSS_PCT = parseFloat(process.env.EMERGENCY_STOP_LOSS_PCT || '30'); // emergency SL — aktif meski ada support level
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '10');
const FEE_CLAIM_THRESHOLD_SOL = parseFloat(process.env.FEE_CLAIM_THRESHOLD_SOL || '0.03');
const CYCLE_INTERVAL_SEC = parseInt(process.env.CYCLE_INTERVAL_SEC || '300');
const SL_GRACE_PERIOD_MIN = parseFloat(process.env.SL_GRACE_PERIOD_MIN || '1'); // menit pertama setelah open, SL/TP tidak aktif
const AUTO_SWAP = process.env.AUTO_SWAP === 'true';
const BUDGET_SOL = parseFloat(process.env.BUDGET_SOL || '0.5');
const OOR_ABOVE_LIMIT_MIN = parseFloat(process.env.OOR_ABOVE_LIMIT_MIN || '60');
const PNL_STUCK_THRESHOLD_PCT = parseFloat(process.env.PNL_STUCK_THRESHOLD_PCT || '1');   // PnL threshold "udah naik"
const PNL_STUCK_TIMEOUT_MS = parseFloat(process.env.PNL_STUCK_TIMEOUT_MIN || '2') * 60 * 1000; // waktu tunggu setelah nyentuh threshold
const OOR_ABOVE_REOPEN_VOL_USD = parseFloat(process.env.OOR_ABOVE_REOPEN_VOL_USD || '30000'); // threshold vol untuk re-open
const OOR_ABOVE_MAX_REOPEN = parseInt(process.env.OOR_ABOVE_MAX_REOPEN || '2'); // max re-open berturut
const OOR_BELOW_LIMIT_MIN = parseFloat(process.env.OOR_BELOW_LIMIT_MIN || '20');
const VOL_DRY_THRESHOLD_USD = parseFloat(process.env.VOL_DRY_THRESHOLD_USD || '20000');
const VOL_DRY_CYCLES = parseInt(process.env.VOL_DRY_CYCLES || '3');
const TVL_DILUTED_MIN_HOLD_MIN = parseFloat(process.env.TVL_DILUTED_MIN_HOLD_MIN || '45');
const TVL_DILUTED_THRESHOLD_USD = parseFloat(process.env.TVL_DILUTED_THRESHOLD_USD || '60000');
const TVL_LOW_WARN_USD = parseFloat(process.env.TVL_LOW_WARN_USD || '2000');
const MONITOR_INTERVAL_SEC = parseInt(process.env.MONITOR_INTERVAL_SEC || '5');

let cycleCount = 0;
let monitorLoopActive = false; // flag agar hanya 1 monitor loop jalan
let monitorLoopStarted = false; // flag strict — sekali start, tidak bisa start lagi sampai posisi clear
let handleCloseInProgress = false; // guard agar handleClose tidak dipanggil 2x

function stopMonitorLoop() {
  monitorLoopActive = false;
  monitorLoopStarted = false;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { activePosition: null };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { activePosition: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function loadKnownPools() {
  if (!fs.existsSync(POOLS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8')); } catch { return []; }
}

function addKnownPool(poolAddress) {
  const pools = loadKnownPools();
  if (!pools.includes(poolAddress)) {
    pools.push(poolAddress);
    fs.writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2));
  }
}

// ─── SUPPORT LEVEL (Top 10 Holders Avg Buy) ──────────────────────────────────
async function calcSupportLevel(mint, symbol) {
  try {
    console.log(`[Support] Scraping top 10 holders for ${symbol}...`);
    const traders = await scrapeGmgnTopTraders(mint);
    if (!traders || traders.length === 0) {
      console.log('[Support] No holder data, skip support level.');
      return null;
    }

    // Weighted avg buy berdasarkan balancePct, skip yang N/A
    const withData = traders.filter(t => t.avgCostUsd && t.avgCostUsd > 0);
    if (withData.length === 0) {
      console.log('[Support] Semua holder N/A avg buy, skip.');
      return null;
    }

    const totalPct = withData.reduce((s, t) => s + t.balancePct, 0);
    const weightedAvgUsd = withData.reduce((s, t) => s + (t.avgCostUsd * t.balancePct), 0) / totalPct;

    // Convert ke SOL menggunakan Jupiter price
    const solPriceUsd = await fetchJupiterPriceUsd('So11111111111111111111111111111111111111112');
    if (!solPriceUsd || solPriceUsd <= 0) {
      console.log('[Support] Gagal fetch SOL price, skip convert.');
      return null;
    }

    const supportLevelSol = weightedAvgUsd / solPriceUsd;
    const holderCount = withData.length;
    const skipped = traders.length - holderCount;

    console.log(`[Support] Weighted avg buy: $${weightedAvgUsd.toFixed(10)} | SOL price: $${solPriceUsd.toFixed(2)} | Support: ${supportLevelSol.toFixed(12)} SOL/token`);
    console.log(`[Support] Data dari ${holderCount}/10 holders (${skipped} N/A dilewati)`);

    return { supportLevelSol, supportLevelUsd: weightedAvgUsd, solPriceUsd, holderCount, skipped, traders };
  } catch (e) {
    console.error('[Support] Error:', e.message);
    return null;
  }
}

function fmtSol(n) { return typeof n === 'number' ? n.toFixed(4) : '0.0000'; }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtUsd(n) { return '$' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtPrice(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  const a = Math.abs(n);
  if (a < 0.000001) return n.toFixed(12);
  if (a < 0.001) return n.toFixed(10);
  return n.toFixed(8);
}

function isAgentProcess(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes('node agent.js');
  } catch {
    return false;
  }
}

function ensureSingleInstance() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(oldPid) && oldPid > 1 && oldPid !== process.pid && isAgentProcess(oldPid)) {
        console.log(`[Guard] Found old agent PID ${oldPid}, stopping it...`);
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}

  fs.writeFileSync(PID_FILE, String(process.pid));

  const cleanup = () => {
    try {
      const pidInFile = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pidInFile === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// ─── TVL FETCH ────────────────────────────────────────────────────────────────
async function fetchPoolTvl(poolAddress) {
  try {
    const res = await axios.get(`https://dlmm-api.meteora.ag/pair/${poolAddress}`, { timeout: 8000 });
    const liquidity = parseFloat(res.data?.liquidity);
    return Number.isFinite(liquidity) ? liquidity : null;
  } catch (e) {
    console.error('[TVL] Fetch error:', e.message);
    return null;
  }
}

// ─── TVL DILUTION CHECK (dipanggil dari runCycle) ─────────────────────────────
async function checkTvlDilution(state) {
  const pos_state = state.activePosition;
  if (!pos_state) return false;

  const holdMin = (Date.now() - pos_state.openedAt) / 60000;
  if (holdMin < TVL_DILUTED_MIN_HOLD_MIN) {
    console.log(`  [TVL] Hold ${holdMin.toFixed(1)}min — belum cek TVL (min ${TVL_DILUTED_MIN_HOLD_MIN}min)`);
    return false;
  }

  const currentTvl = await fetchPoolTvl(pos_state.poolAddress);
  if (currentTvl === null) {
    console.log(`  [TVL] Fetch gagal, skip check.`);
    return false;
  }

  console.log(`  [TVL] Current: ${fmtUsd(currentTvl)} | Threshold: ${fmtUsd(TVL_DILUTED_THRESHOLD_USD)} | Hold: ${holdMin.toFixed(1)}min`);

  // Warning jika TVL pool sudah sangat rendah
  if (currentTvl < TVL_LOW_WARN_USD) {
    const warnKey = `_tvlLowWarnSent_${pos_state.poolAddress}`;
    if (!pos_state[warnKey]) {
      pos_state[warnKey] = true;
      console.log(`  [TVL] ⚠️ TVL sangat rendah! ${fmtUsd(currentTvl)} < ${fmtUsd(TVL_LOW_WARN_USD)}`);
      await sendTelegram(
        `⚠️ <b>TVL Pool Rendah!</b>\n` +
        `Token: ${pos_state.symbol}\n` +
        `TVL Pool: ${fmtUsd(currentTvl)} (di bawah $${TVL_LOW_WARN_USD.toLocaleString()})\n` +
        `Hold: ${holdMin.toFixed(0)} menit\n` +
        `PnL: ${fmtPct(pos_state._lastPnlPct ?? 0)}\n` +
        `⚠️ Likuiditas mengering — pertimbangkan manual close`
      );
    }
  } else {
    // Reset flag kalau TVL naik lagi
    delete pos_state[`_tvlLowWarnSent_${pos_state.poolAddress}`];
  }

  if (currentTvl >= TVL_DILUTED_THRESHOLD_USD) {
    // Skip jika PnL masih minus — tunggu recovery dulu
    const currentPnlPct = pos_state._lastPnlPct ?? 0;
    if (currentPnlPct < 0) {
      console.log(`  [TVL] DILUTED tapi PnL masih minus (${fmtPct(currentPnlPct)}) — skip, tunggu recovery`);
      return false;
    }
    console.log(`  [TVL] DILUTED! TVL ${fmtUsd(currentTvl)} >= ${fmtUsd(TVL_DILUTED_THRESHOLD_USD)} setelah ${holdMin.toFixed(1)}min`);
    return true;
  }

  return false;
}


async function fetchVol5m(tokenMint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    const res = await axios.get(url, { timeout: 8000 });
    const pairs = res.data?.pairs || [];
    
    if (pairs.length === 0) return 0; // Token beneran mati/gak ada pair aktif

    // Totalkan volume dari semua pair yang ada untuk token ini (Raydium, Meteora, dll)
    let totalVol5m = 0;
    for (const p of pairs) {
      if (p.chainId === 'solana' && p.volume && typeof p.volume.m5 === 'number') {
        totalVol5m += p.volume.m5;
      }
    }

    return totalVol5m;
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.error('[VolCheck] Rate limit 429 hit');
      return null; // Asli error limit
    }
    console.error('[VolCheck] Fetch error:', e.message);
    return null;
  }
}

// ─── METEORA PORTFOLIO DATAPI (samakan angka dengan UI Meteora) ─────────
async function fetchMeteoraPortfolioPool(userAddress, poolAddress, positionKey) {
  try {
    const { data } = await axios.get('https://dlmm.datapi.meteora.ag/portfolio/open', {
      params: { user: userAddress, page: 1, page_size: 50 },
      timeout: 10000,
    });

    const pools = Array.isArray(data?.pools) ? data.pools : [];
    const pool = pools.find((p) => {
      if (p.poolAddress !== poolAddress) return false;
      if (!positionKey) return true;
      const list = Array.isArray(p.listPositions) ? p.listPositions : [];
      return list.includes(positionKey);
    });

    if (!pool) return null;

    const pnlUsd = parseFloat(pool.pnl);
    const pnlSol = parseFloat(pool.pnlSol);
    const pnlPct = parseFloat(pool.pnlPctChange);
    const unclaimedFeesSol = parseFloat(pool.unclaimedFeesSol);
    const poolPrice = parseFloat(pool.poolPrice);

    return {
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
      pnlSol: Number.isFinite(pnlSol) ? pnlSol : null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      unclaimedFeesSol: Number.isFinite(unclaimedFeesSol) ? unclaimedFeesSol : null,
      poolPrice: Number.isFinite(poolPrice) ? poolPrice : null,
    };
  } catch (e) {
    console.error('[MeteoraDatapi] Fetch error:', e.message);
    return null;
  }
}

function getOORDirection(activeBinId, minBinId, maxBinId) {
  if (activeBinId > maxBinId) return 'ABOVE';
  if (activeBinId < minBinId) return 'BELOW';
  return 'IN';
}

// ─── ORPHAN CHECK ────────────────────────────────────────────
async function checkOrphanPositions(state) {
  if (state.activePosition) return; // ada posisi yang ke-track, skip

  const knownPools = loadKnownPools();
  if (knownPools.length === 0) return;

  console.log('[Orphan] Checking for untracked positions...');
  const orphans = await scanOrphanPositions(knownPools);

  if (orphans.length === 0) return;

  console.log(`[Orphan] Found ${orphans.length} untracked position(s)!`);
  for (const o of orphans) {
    console.log(`  Pool: ${o.poolAddress} | Pos: ${o.positionKey}`);
    await sendTelegram(
      `⚠️ <b>Orphan Position Detected!</b>\n` +
      `Pool: <code>${o.poolAddress.slice(0, 20)}...</code>\n` +
      `Position: <code>${o.positionKey.slice(0, 20)}...</code>\n` +
      `X: ${o.totalX} | Y: ${o.totalY}\n` +
      `Closing automatically...`
    );

    // Close orphan position
    try {
      const fakeState = {
        positionKey: o.positionKey,
        poolAddress: o.poolAddress,
        minBinId: o.lowerBinId,
        maxBinId: o.upperBinId,
        mint: null,
        symbol: 'ORPHAN',
        budgetSol: BUDGET_SOL,
        openedAt: Date.now(),
      };
      await closePosition(fakeState);
      await sendTelegram(`✅ Orphan position closed successfully.`);
    } catch (e) {
      await sendTelegram(`❌ Failed to close orphan: ${e.message}`);
    }
  }
}

// ─── MONITOR TICK (dipanggil tiap MONITOR_INTERVAL_SEC) ─────────────────────
// Khusus baca PnL + trigger TP/SL/OOR/VOL_DRY secara realtime.
// Telegram status update TIDAK dikirim di sini — itu tugas runCycle.
async function monitorTick() {
  const state = loadState();
  if (!state.activePosition) return; // tidak ada posisi, skip

  const pos_state = state.activePosition;
  let data;
  try {
    data = await monitorPosition(pos_state);
  } catch (e) {
    console.error('[MonitorTick] Error:', e.message);
    return;
  }

  if (data.error === 'position_not_found') {
    console.log('[MonitorTick] Position not found on-chain, clearing state.');
    saveState({ activePosition: null });
    stopMonitorLoop();
    return;
  }

  if (data.error === 'data_not_settled') {
    console.log('[MonitorTick] Data belum settle (totalValue ~0), skip tick ini.');
    return;
  }

  const { inRange, pnlSol, pnlPct, totalFeeSol, currentPrice, activeBinId } = data;

  // Prioritaskan angka Meteora datapi
  let estPnlSol = pnlSol;
  let estPnlPct = pnlPct;
  let estPnlUsd = null;
  let displayFeeSol = totalFeeSol;
  let displayPrice = currentPrice;

  const mData = await fetchMeteoraPortfolioPool(
    wallet.publicKey.toBase58(),
    pos_state.poolAddress,
    pos_state.positionKey
  );

  if (mData) {
    if (mData.pnlSol !== null) estPnlSol = mData.pnlSol;
    if (mData.pnlPct !== null) estPnlPct = mData.pnlPct;
    if (mData.pnlUsd !== null) estPnlUsd = mData.pnlUsd;
    if (mData.unclaimedFeesSol !== null) displayFeeSol = mData.unclaimedFeesSol;
    if (mData.poolPrice !== null) displayPrice = mData.poolPrice;
  } else {
    try {
      const solPriceUsd = await fetchJupiterPriceUsd('So11111111111111111111111111111111111111112');
      if (solPriceUsd && solPriceUsd > 0) estPnlUsd = estPnlSol * solPriceUsd;
    } catch {}
  }

  const oorDir = getOORDirection(activeBinId, pos_state.minBinId, pos_state.maxBinId);
  const oorLimit = oorDir === 'ABOVE' ? OOR_ABOVE_LIMIT_MIN : OOR_BELOW_LIMIT_MIN;

  // Track OOR state
  if (!inRange) {
    if (!pos_state.outOfRangeSince) {
      pos_state.outOfRangeSince = Date.now();
      pos_state.oorDirection = oorDir;
      saveState(state);
      await sendTelegram(
        `📍 <b>Out of Range!</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `Arah: ${oorDir === 'ABOVE' ? '📈 Pump — tunggu reversal' : '📉 Dump — close lebih cepat'}\n` +
        `Batas: ${oorLimit} menit\n` +
        `PnL saat ini: ${fmtPct(estPnlPct)}`
      );
    }
  } else {
    if (pos_state.outOfRangeSince) {
      await sendTelegram(
        `✅ <b>Kembali In-Range!</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `PnL: ${fmtPct(estPnlPct)} | Fee: ${fmtSol(displayFeeSol)} SOL\n` +
        `Fee mulai masuk lagi 💰`
      );
      pos_state.outOfRangeSince = null;
      pos_state.oorDirection = null;
      saveState(state);
    }
  }

  const outOfRangeMinutes = pos_state.outOfRangeSince
    ? (Date.now() - pos_state.outOfRangeSince) / 60000 : 0;

  console.log(`  [Tick] PnL: ${fmtPct(estPnlPct)} | Fee: ${fmtSol(displayFeeSol)} SOL | InRange: ${inRange} | OOR: ${outOfRangeMinutes.toFixed(1)}min | Support: ${pos_state.supportLevelSol ? fmtPrice(pos_state.supportLevelSol) : 'N/A'}`);

  // ── GRACE PERIOD — SL/TP tidak aktif di menit pertama setelah open
  const holdMin = (Date.now() - pos_state.openedAt) / 60000;
  if (holdMin < SL_GRACE_PERIOD_MIN) {
    console.log(`  [Grace] Hold ${holdMin.toFixed(1)}min < ${SL_GRACE_PERIOD_MIN}min — SL/TP belum aktif`);
    return;
  }

  // ── SUPPORT LEVEL BROKEN — jika support level tersedia, ini MENGGANTIKAN SL %
  if (pos_state.supportLevelSol && estPnlPct < 0) {
    const currentPriceTick = displayPrice || data.currentPrice;
    if (currentPriceTick > 0 && currentPriceTick < pos_state.supportLevelSol) {
      console.log(`[Action] SUPPORT BROKEN! Price ${fmtPrice(currentPriceTick)} < Support ${fmtPrice(pos_state.supportLevelSol)}`);
      stopMonitorLoop();
      await handleClose(state, pos_state, 'SUPPORT_BROKEN', estPnlSol, estPnlPct, displayFeeSol);
      return;
    }
    // Support level ada → cek emergency SL dulu sebelum skip SL %
    console.log(`  [SL] Support level aktif (${fmtPrice(pos_state.supportLevelSol)}) — SL % dinonaktifkan`);
    // Emergency SL — tetap trigger meski ada support level
    if (estPnlPct <= -EMERGENCY_STOP_LOSS_PCT) {
      console.log(`[Action] EMERGENCY STOP LOSS -${EMERGENCY_STOP_LOSS_PCT}% triggered! PnL: ${fmtPct(estPnlPct)}`);
      stopMonitorLoop();
      await handleClose(state, pos_state, 'STOP_LOSS', estPnlSol, estPnlPct, displayFeeSol);
      return;
    }
  } else {
    // ── STOP LOSS fallback (hanya jika tidak ada support level)
    if (estPnlPct <= -STOP_LOSS_PCT) {
      console.log(`[Action] STOP LOSS -${STOP_LOSS_PCT}% triggered! (fallback — no support level data)`);
      stopMonitorLoop();
      await handleClose(state, pos_state, 'STOP_LOSS', estPnlSol, estPnlPct, displayFeeSol);
      return;
    }
  }

  // ── PNL STUCK — jika PnL nyentuh threshold tapi tidak naik ke TP dalam timeout → close di threshold
  if (estPnlPct >= PNL_STUCK_THRESHOLD_PCT) {
    if (!pos_state._pnlStuckFirstHitAt) {
      // Pertama kali nyentuh threshold — catat waktunya, mulai timer
      pos_state._pnlStuckFirstHitAt = Date.now();
      console.log(`  [Stuck] PnL nyentuh +${PNL_STUCK_THRESHOLD_PCT}% — mulai timer ${PNL_STUCK_TIMEOUT_MS/60000} menit`);
    } else {
      // Sudah dalam timer — cek apakah timeout
      const elapsedMs = Date.now() - pos_state._pnlStuckFirstHitAt;
      const elapsedMin = (elapsedMs / 60000).toFixed(1);
      console.log(`  [Stuck] PnL masih di +${fmtPct(estPnlPct)} — elapsed: ${elapsedMin}/${PNL_STUCK_TIMEOUT_MS/60000} menit`);
      if (elapsedMs >= PNL_STUCK_TIMEOUT_MS) {
        // Timeout habis dan PnL masih >= threshold → close sekarang selagi masih profit
        console.log(`[Action] PNL_STUCK! Timeout ${elapsedMin} menit — close selagi masih +${fmtPct(estPnlPct)}`);
        stopMonitorLoop();
        await handleClose(state, pos_state, 'PNL_STUCK', estPnlSol, estPnlPct, displayFeeSol);
        return;
      }
    }
  } else {
    // PnL turun di bawah threshold — reset timer, tunggu naik lagi
    if (pos_state._pnlStuckFirstHitAt) {
      console.log(`  [Stuck] PnL turun di bawah +${PNL_STUCK_THRESHOLD_PCT}% (${fmtPct(estPnlPct)}) — reset timer, tunggu naik lagi`);
      pos_state._pnlStuckFirstHitAt = null;
    }
  }

  // ── TAKE PROFIT
  if (estPnlPct >= TAKE_PROFIT_PCT) {
    console.log('[Action] TAKE PROFIT triggered!');
    stopMonitorLoop();
    await handleClose(state, pos_state, 'TAKE_PROFIT', estPnlSol, estPnlPct, displayFeeSol);
    return;
  }

  // ── OOR smart limit
  if (!inRange && outOfRangeMinutes >= oorLimit) {
    // Set flag agar runCycle tidak kirim notif update dulu — langsung close
    pos_state._oorLimitReached = true;
    saveState(state);

    if (oorDir === 'ABOVE') {
      // Cek volume dulu sebelum close
      const vol5m = await fetchVol5m(pos_state.mint);
      const reopenCount = pos_state.reopenCount || 0;

      if (vol5m !== null && vol5m >= OOR_ABOVE_REOPEN_VOL_USD && reopenCount < OOR_ABOVE_MAX_REOPEN) {
        // Volume masih deres → close lalu re-open di range baru
        console.log(`[Action] OOR_ABOVE timeout TAPI volume masih ${fmtUsd(vol5m)} >= ${fmtUsd(OOR_ABOVE_REOPEN_VOL_USD)} → RE-OPEN (attempt ${reopenCount + 1}/${OOR_ABOVE_MAX_REOPEN})`);
        stopMonitorLoop();

        await sendTelegram(
          `🔄 <b>OOR Above — Re-Open!</b>\n` +
          `Token: <b>${pos_state.symbol}</b>\n` +
          `Volume 5m masih kencang: <b>${fmtUsd(vol5m)}</b>\n` +
          `Close posisi lama → buka ulang di range baru...\n` +
          `Re-open attempt: ${reopenCount + 1}/${OOR_ABOVE_MAX_REOPEN}`
        );

        // Close posisi lama
        try {
          await closePosition(pos_state);
        } catch (e) {
          // Kalau posisi sudah tidak ada di chain → anggap sudah closed, lanjut re-open
          const isAlreadyClosed = e.message?.includes('3007') || e.message?.includes('position_not_found') || e.message?.includes('not found');
          if (isAlreadyClosed) {
            console.log('[ReOpen] Posisi sudah tidak ada di chain, lanjut re-open...');
          } else {
            console.error('[ReOpen] Close error:', e.message);
            await sendTelegram(`❌ <b>Gagal close untuk re-open!</b>\nError: ${e.message}`);
            monitorLoopActive = true;
            return;
          }
        }

        // Tunggu settlement
        await new Promise(r => setTimeout(r, 15000));

        // Swap token sisa ke SOL dulu jika ada
        if (AUTO_SWAP && pos_state.mint) {
          console.log(`[ReOpen] Tunggu token balance settle sebelum swap...`);
          const swapRes = await swapTokenToSol(pos_state.mint);
          if (swapRes) console.log(`[ReOpen] Swap token sisa → ${swapRes.outSol.toFixed(6)} SOL`);
          else console.log(`[ReOpen] Swap skip (token balance 0 atau gagal)`);
          // Tunggu SOL settlement setelah swap
          await new Promise(r => setTimeout(r, 5000));
        }

        // Re-open dengan token + pool yang sama
        const bestToken = {
          mint: pos_state.mint,
          symbol: pos_state.symbol,
          pool: {
            address: pos_state.poolAddress,
            mintX: pos_state.isSolX ? 'So11111111111111111111111111111111111111112' : pos_state.mint,
            mintY: pos_state.isSolX ? pos_state.mint : 'So11111111111111111111111111111111111111112',
            liquidity: 0,
          },
          _onPositionCreated: (data) => {
            const s = loadState();
            s.activePosition = {
              ...data,
              reopenCount: reopenCount + 1, // track jumlah re-open
              walletBalanceBeforeOpenSol: pos_state.walletBalanceBeforeOpenSol,
            };
            saveState(s);
            addKnownPool(data.poolAddress);
            console.log(`[ReOpen] State saved after re-open layer 1 ✅`);
          },
        };

        let newPosData;
        try {
          newPosData = await openPosition(bestToken);
        } catch (e) {
          console.error('[ReOpen] Open error:', e.message);
          await sendTelegram(`❌ <b>Gagal re-open posisi!</b>\nToken: ${pos_state.symbol}\nError: ${e.message}\nBot kembali ke scan mode.`);
          state.activePosition = null;
          saveState(state);
          return;
        }

        // Update txHash2
        const freshState = loadState();
        if (freshState.activePosition) {
          freshState.activePosition.txHash2 = newPosData.txHash2;
          saveState(freshState);
        }

        appendLog({
          action: 'REOPEN',
          reason: 'OOR_ABOVE_VOL_HIGH',
          symbol: pos_state.symbol,
          mint: pos_state.mint,
          reopenCount: reopenCount + 1,
          vol5m,
          ...newPosData,
        });

        await sendTelegram(
          `🎯 <b>Re-Open Berhasil!</b>\n` +
          `Token: <b>${newPosData.symbol}</b>\n` +
          `Entry price baru: <b>${fmtPrice(newPosData.entryPrice)}</b>\n` +
          `Range: Bin ${newPosData.minBinId} → ${newPosData.maxBinId}\n` +
          `Modal: <b>${newPosData.budgetSol} SOL</b>\n` +
          `<a href="https://solscan.io/tx/${newPosData.txHash}">TX Layer 1</a>` +
          (newPosData.txHash2 ? ` | <a href="https://solscan.io/tx/${newPosData.txHash2}">TX Layer 2</a>` : '')
        );

        // Pastikan loop lama benar-benar berhenti sebelum start loop baru
        stopMonitorLoop();
        await new Promise(r => setTimeout(r, 2000));
        startMonitorLoop();
        return;
      }
      if (reopenCount >= OOR_ABOVE_MAX_REOPEN) {
        console.log(`[Action] OOR_ABOVE — max re-open (${reopenCount}) tercapai, close total.`);
      } else {
        console.log(`[Action] OOR_ABOVE — volume sepi (${vol5m !== null ? fmtUsd(vol5m) : 'N/A'}), close total.`);
      }
      stopMonitorLoop();
      await handleClose(state, pos_state, 'OOR_ABOVE', estPnlSol, estPnlPct, displayFeeSol);
      return;
    }

    // OOR_BELOW → langsung close
    console.log(`[Action] OOR BELOW limit reached (${outOfRangeMinutes.toFixed(1)}/${oorLimit}min), closing.`);
    stopMonitorLoop();
    await handleClose(state, pos_state, 'OOR_BELOW', estPnlSol, estPnlPct, displayFeeSol);
    return;
  }

  // Simpan nilai terbaru ke pos_state agar runCycle bisa baca untuk Telegram update
  pos_state._lastPnlPct = estPnlPct;
  pos_state._lastPnlUsd = estPnlUsd;
  pos_state._lastFeeSol = displayFeeSol;
  pos_state._lastPrice = displayPrice;
  pos_state._lastFeeToken = data.feeToken ?? null;
  pos_state._lastTokenInPos = data.tokenInPos ?? null;
  pos_state._lastInRange = inRange;
  pos_state._lastOorDir = oorDir;
  pos_state._lastOorMin = outOfRangeMinutes;
  pos_state._lastOorLimit = oorLimit;
  saveState(state);
}

// ─── VOLUME CHECK (dipanggil dari runCycle, bukan monitorTick) ───────────────
// Vol check tetap per cycle karena data 5m dari DexScreener tidak berubah per detik
async function checkVolume(state) {
  const pos_state = state.activePosition;
  if (!pos_state) return false; // false = tidak ada alasan close

  const vol5m = await fetchVol5m(pos_state.mint);
  console.log(`  Vol5m: ${vol5m !== null ? fmtUsd(vol5m) : 'N/A'} (threshold: ${fmtUsd(VOL_DRY_THRESHOLD_USD)})`);

  if (vol5m === null) {
    console.log(`  [VolDry] API Fetch Error - volume check skipped. Anggap aman.`);
    return false;
  }

  if (vol5m < VOL_DRY_THRESHOLD_USD) {
    // Skip VOL_DRY jika PnL masih minus — tunggu recovery dulu
    const currentPnlPct = pos_state._lastPnlPct ?? 0;
    if (currentPnlPct < 0) {
      console.log(`  [VolDry] Volume sepi tapi PnL minus (${fmtPct(currentPnlPct)}) — skip VOL_DRY, tunggu recovery`);
      return false;
    }

    pos_state.volDryCycles = (pos_state.volDryCycles || 0) + 1;
    console.log(`  [VolDry] Low volume cycle ${pos_state.volDryCycles}/${VOL_DRY_CYCLES}`);
    if (pos_state.volDryCycles === 1) {
      await sendTelegram(
        `📉 <b>Volume Mulai Sepi!</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `Vol 5m: <b>${fmtUsd(vol5m)}</b> (threshold: ${fmtUsd(VOL_DRY_THRESHOLD_USD)})\n` +
        `Cycle: ${pos_state.volDryCycles}/${VOL_DRY_CYCLES} — pantau terus...`
      );
    }
    saveState(state);
    if (pos_state.volDryCycles >= VOL_DRY_CYCLES) return true; // sinyal close
  } else {
    if ((pos_state.volDryCycles || 0) > 0) {
      console.log(`  [VolDry] Volume recovered, reset counter`);
      pos_state.volDryCycles = 0;
      saveState(state);
    }
  }
  return false;
}

// ─── MONITOR LOOP — jalan tiap MONITOR_INTERVAL_SEC selama ada posisi ────────
async function startMonitorLoop() {
  if (monitorLoopStarted) {
    return; // strict guard — tidak bisa start 2x
  }
  monitorLoopStarted = true;
  monitorLoopActive = true;
  console.log(`[MonitorLoop] Started — interval ${MONITOR_INTERVAL_SEC}s`);

  const loop = async () => {
    if (!monitorLoopActive) return;
    const state = loadState();
    if (!state.activePosition) {
      console.log('[MonitorLoop] No active position, stopping loop.');
      stopMonitorLoop();
      return;
    }
    try {
      await monitorTick();
    } catch (e) {
      console.error('[MonitorLoop] Tick error:', e.message);
    }
    if (monitorLoopActive) {
      setTimeout(loop, MONITOR_INTERVAL_SEC * 1000);
    }
  };

  setTimeout(loop, MONITOR_INTERVAL_SEC * 1000);
}

async function runCycle() {
  cycleCount++;
  const state = loadState();
  console.log(`\n[Cycle #${cycleCount}] ${new Date().toISOString()}`);

  // Check for orphan positions every 3 cycles
  if (cycleCount % 3 === 0) {
    try { await checkOrphanPositions(state); } catch (e) {
      console.error('[Orphan] Check error:', e.message);
    }
  }

  // ─── MONITOR MODE ───────────────────────────────────────────
  if (state.activePosition) {
    const pos_state = state.activePosition;

    // Pastikan monitor loop jalan
    startMonitorLoop();

    // ── VOLUME CHECK (per cycle)
    const shouldClose = await checkVolume(state);
    if (shouldClose) {
      const pnlPct = pos_state._lastPnlPct ?? 0;
      const pnlSol = 0;
      const feeSol = pos_state._lastFeeSol ?? 0;
      console.log(`[Action] VOL_DRY triggered after ${VOL_DRY_CYCLES} cycles!`);
      stopMonitorLoop();
      await handleClose(state, pos_state, 'VOL_DRY', pnlSol, pnlPct, feeSol);
      return;
    }

    // ── TVL DILUTION CHECK (per cycle)
    const tvlDiluted = await checkTvlDilution(state);
    if (tvlDiluted) {
      const pnlPct = pos_state._lastPnlPct ?? 0;
      const feeSol = pos_state._lastFeeSol ?? 0;
      console.log(`[Action] TVL_DILUTED triggered!`);
      stopMonitorLoop();
      await handleClose(state, pos_state, 'TVL_DILUTED', 0, pnlPct, feeSol);
      return;
    }

    // ── OOR LIMIT REACHED — monitorTick sedang proses close, skip notif update
    if (pos_state._oorLimitReached) {
      console.log(`[runCycle] OOR limit reached — monitorTick sedang handle close, skip notif update`);
      return;
    }

    // ── TELEGRAM STATUS UPDATE (per cycle, pakai data terbaru dari monitorTick)
    const pnlPct = pos_state._lastPnlPct ?? null;
    const pnlUsd = pos_state._lastPnlUsd ?? null;
    const feeSol = pos_state._lastFeeSol ?? 0;
    const price = pos_state._lastPrice ?? 0;
    const inRange = pos_state._lastInRange ?? true;
    const oorDir = pos_state._lastOorDir ?? 'IN';
    const oorMin = pos_state._lastOorMin ?? 0;
    const oorLimit = pos_state._lastOorLimit ?? OOR_ABOVE_LIMIT_MIN;

    if (pnlPct !== null) {
      const pnlText = pnlUsd !== null
        ? `${fmtPct(pnlPct)} (~$${pnlUsd.toFixed(2)})`
        : fmtPct(pnlPct);
      await sendTelegram(
        `📊 <b>Position Update</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `PnL: <b>${pnlText}</b>\n` +
        `Fee: ${fmtSol(feeSol)} SOL\n` +
        `Price: ${fmtPrice(price)}\n` +
        `Status: ${inRange ? '✅ In Range' : `⚠️ OOR ${oorDir} (${oorMin.toFixed(0)}/${oorLimit}min)`}`
      );
    }

    console.log(`[Status] Monitoring active. PnL: ${pnlPct !== null ? fmtPct(pnlPct) : 'pending...'}`);
    return;
  }

  // ─── SCAN MODE ──────────────────────────────────────────────
  console.log('[Mode] SCAN — looking for token...');

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / 1e9;
  if (balanceSol < BUDGET_SOL + 0.05) {
    console.log(`[Scan] Insufficient balance: ${fmtSol(balanceSol)} SOL`);
    await sendTelegram(`⚠️ <b>Balance tidak cukup!</b>\nBalance: ${fmtSol(balanceSol)} SOL\nButuh: ${BUDGET_SOL + 0.05} SOL`);
    return;
  }

  let scanResult;
  try {
    scanResult = await scanTokens();
  } catch (e) {
    console.error('[Scan] Error:', e.message);
    return;
  }

  const { scanned, scannedTokens = [], passed, rejected, cookinRejectDetails = [] } = scanResult;
  console.log(`[Scan] Scanned: ${scanned} | Passed: ${passed.length}`);

  if (passed.length === 0) {
    const scannedList = scannedTokens.length
      ? scannedTokens.map((t) => `• ${t}`).join('\n')
      : '• (tidak ada data token)';

    const cookinDetailsStr = cookinRejectDetails.length > 0
      ? `\n<b>Detail Cookin Reject:</b>\n${cookinRejectDetails.map(d => `- ${d}`).join('\n')}`
      : '';

    await sendTelegram(
      `🔍 <b>DLMM Scan #${cycleCount}</b>\n` +
      `Scanned: ${scanned} tokens | Lolos: 0\n\n` +
      `<b>Token yang discan:</b>\n${scannedList}\n\n` +
      `<b>Rejected:</b>\n` +
      `• MC terlalu besar: ${rejected.mc_too_large || 0}\n` +
      `• No pool Meteora: ${rejected.no_pool || 0}\n` +
      `• Pool baru (non-refundable): ${rejected.new_pool || 0}\n` +
      `• TVL terlalu besar: ${rejected.high_liquidity || 0}\n` +
      `• Cookin reject: ${rejected.cookin_reject || 0}\n` +
      `${cookinDetailsStr}\n\n` +
      `😴 Belum ada token cocok...`
    );
    return;
  }

  const best = passed.sort((a, b) => b.vol - a.vol)[0];
  console.log(`[Scan] Best: ${best.symbol} | MC: $${best.mc.toLocaleString()} | Vol: $${(best.vol || 0).toLocaleString()}`);

  console.log('[Action] Opening position...');
  let posData;
  try {
    // Pass callback so state saved immediately after layer 1
    best._onPositionCreated = (data) => {
      const state = loadState();
      state.activePosition = {
        ...data,
        walletBalanceBeforeOpenSol: balanceSol,
      };
      saveState(state);
      addKnownPool(data.poolAddress);
      console.log('[State] Saved after layer 1 ✅');
    };

    posData = await openPosition(best);
  } catch (e) {
    console.error('[Open] Error:', e.message);
    await sendTelegram(`❌ <b>Gagal buka posisi!</b>\nToken: ${best.symbol}\nError: ${e.message}`);
    return;
  }

  // Update state with final data (including txHash2)
  const finalState = loadState();
  if (finalState.activePosition) {
    finalState.activePosition.txHash2 = posData.txHash2;
    finalState.activePosition.walletBalanceBeforeOpenSol = balanceSol;
    saveState(finalState);
  }

  // Scrape top 10 holders → hitung support level (async, tidak block open)
  calcSupportLevel(best.mint, best.symbol).then(supportData => {
    if (!supportData) return;
    const s = loadState();
    if (!s.activePosition) return;

    // Validasi: support level harus LEBIH RENDAH dari entry price
    // Kalau support >= entry price → tidak valid, tidak dipakai
    const entryPrice = s.activePosition.entryPrice;
    if (supportData.supportLevelSol >= entryPrice) {
      console.log(`[Support] SKIP — support level (${fmtPrice(supportData.supportLevelSol)}) >= entry price (${fmtPrice(entryPrice)}). Tidak valid.`);
      sendTelegram(
        `⚠️ <b>Support Level Tidak Valid</b>\n` +
        `Token: <b>${best.symbol}</b>\n` +
        `Support: <b>${fmtPrice(supportData.supportLevelSol)}</b> ≥ Entry: <b>${fmtPrice(entryPrice)}</b>\n` +
        `Support level diabaikan — pakai SL % biasa.`
      );
      return;
    }

    s.activePosition.supportLevelSol = supportData.supportLevelSol;
    s.activePosition.supportLevelUsd = supportData.supportLevelUsd;
    s.activePosition.supportHolderCount = supportData.holderCount;
    saveState(s);
    console.log(`[Support] Saved to state: ${fmtPrice(supportData.supportLevelSol)} SOL/token ($${supportData.supportLevelUsd.toFixed(10)})`);

    // Kirim info support level ke Telegram
    const skipNote = supportData.skipped > 0 ? ` (${supportData.skipped} holder N/A dilewati)` : '';
    sendTelegram(
      `📊 <b>Support Level Top 10 Holders</b>\n` +
      `Token: <b>${best.symbol}</b>\n` +
      `Weighted Avg Buy: <b>$${supportData.supportLevelUsd.toFixed(10)}</b>\n` +
      `Support (SOL): <b>${fmtPrice(supportData.supportLevelSol)}</b>\n` +
      `Data dari: ${supportData.holderCount}/10 holders${skipNote}\n\n` +
      `⚠️ Jika harga turun di bawah support ini saat PnL minus → auto close!`
    );
  }).catch(e => console.error('[Support] Background scrape error:', e.message));

  appendLog({
    action: 'OPEN',
    ...posData,
    walletBalanceBeforeOpenSol: balanceSol,
    mc: best.mc,
    vol: best.vol,
  });

  await sendTelegram(
    `🎯 <b>DLMM Position Opened!</b>\n` +
    `Token: <b>${posData.symbol}</b>\n` +
    `Pool: <code>${posData.poolAddress.slice(0, 20)}...</code>\n` +
    `Entry price: <b>${fmtPrice(posData.entryPrice)}</b>\n` +
    `Range: Bin ${posData.minBinId} → ${posData.maxBinId} (${Math.abs(posData.maxBinId - posData.minBinId)} bins)\n` +
    `Modal: <b>${posData.budgetSol} SOL</b>\n` +
    `💰 Balance sebelum open: <b>${fmtSol(balanceSol)} SOL</b>\n` +
    `Layer 1 (70% BidAsk): <a href="https://solscan.io/tx/${posData.txHash}">TX1</a>\n` +
    (posData.txHash2 ? `Layer 2 (30% Spot): <a href="https://solscan.io/tx/${posData.txHash2}">TX2</a>` : `Layer 2: skipped`) +
    (best.cookin ? `\n${formatCookinSummary(best.cookin)}` : '')
  );
}

async function getTokenBalance(mint) {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const [std, t22] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      }),
    ]);
    const acc = [...std.value, ...t22.value]
      .find(a => a.account.data.parsed.info.mint === mint);
    if (!acc) return { raw: '0', ui: 0, decimals: 0 };
    const info = acc.account.data.parsed.info.tokenAmount;
    return { raw: info.amount, ui: info.uiAmount || 0, decimals: info.decimals };
  } catch {
    return { raw: '0', ui: 0, decimals: 0 };
  }
}

async function handleClose(state, pos_state, reason, pnlSol, pnlPct, totalFeeSol) {
  // Guard: pastikan tidak dipanggil 2x bersamaan (race condition antar tick)
  if (handleCloseInProgress) {
    console.log(`[handleClose] Already in progress, skip duplicate call (reason: ${reason})`);
    return;
  }
  handleCloseInProgress = true;

  const duration = Math.floor((Date.now() - pos_state.openedAt) / 60000);

  const baselineSol = Number.isFinite(pos_state.walletBalanceBeforeOpenSol)
    ? pos_state.walletBalanceBeforeOpenSol
    : ((await connection.getBalance(wallet.publicKey)) / 1e9);

  // Snapshot token balance SEBELUM close (biasanya 0, tapi safe)
  const tokenBefore = await getTokenBalance(pos_state.mint);
  console.log(`[Close] Token balance before close: ${tokenBefore.ui} (${tokenBefore.raw} raw)`);

  try {
    await closePosition(pos_state);
  } catch (e) {
    // Kalau posisi sudah tidak ada di chain → anggap sudah closed, lanjut cleanup
    const isAlreadyClosed = e.message?.includes('3007') || e.message?.includes('position_not_found') || e.message?.includes('not found');
    if (isAlreadyClosed) {
      console.log('[Close] Posisi sudah tidak ada di chain, anggap sudah closed. Lanjut cleanup...');
      state.activePosition = null;
      saveState(state);
      stopMonitorLoop();
      await sendTelegram(`⚠️ <b>Posisi sudah tidak ada di chain</b>\nToken: <b>${pos_state.symbol}</b>\nKemungkinan sudah closed sebelumnya. State dibersihkan.`);
      return;
    }
    console.error('[Close] Error:', e.message);
    await sendTelegram(`❌ <b>Gagal close!</b>\nError: ${e.message}\nClose manual ya!`);
    return;
  }

  // Polling sampai token landing di wallet (max 10x × 3 detik = 30 detik)
  let tokenAfter = { raw: '0', ui: 0, decimals: tokenBefore.decimals };
  let retries = 0;
  console.log('[Close] Waiting for token to land in wallet...');
  while (retries < 10) {
    await new Promise(r => setTimeout(r, 3000));
    tokenAfter = await getTokenBalance(pos_state.mint);
    if (tokenAfter.raw !== '0') {
      console.log(`[Close] Token landed: ${tokenAfter.ui} (after ${retries + 1} retries)`);
      break;
    }
    retries++;
    console.log(`[Close] Waiting... (${retries}/10) token still 0`);
  }

  // Hitung breakdown token yang diterima
  const tokenReceived = tokenAfter.ui - tokenBefore.ui;
  // Estimasi dari data monitor terakhir
  const estFeeToken = pos_state._lastFeeToken ?? null;
  const estLpToken = pos_state._lastTokenInPos ?? null;
  console.log(`[Close] Token received: ${tokenReceived.toFixed(4)} | from LP: ${estLpToken ?? 'N/A'} | fee: ${estFeeToken ?? 'N/A'}`);

  let swapResult = null;
  if (AUTO_SWAP && pos_state.mint) {
    if (tokenAfter.raw === '0') {
      console.log('[Swap] Token still 0 after 30s — skip swap');
      // Tidak perlu alert — memang tidak ada token (seperti kasus neet)
    } else {
      // Infinite retry swap sampai berhasil, dengan backoff bertahap
      // Alert Telegram dikirim tiap 5x gagal agar tidak spam tapi tetap informatif
      let swapAttempt = 0;
      const SWAP_ALERT_EVERY = 5; // alert tiap N kali gagal
      const SWAP_BACKOFF = [5, 10, 15, 30, 60]; // detik, index capped di akhir
      while (!swapResult) {
        swapAttempt++;
        const backoffSec = SWAP_BACKOFF[Math.min(swapAttempt - 1, SWAP_BACKOFF.length - 1)];
        console.log(`[Swap] Attempt #${swapAttempt} | ${tokenAfter.ui} ${pos_state.symbol} → SOL`);
        swapResult = await swapTokenToSol(pos_state.mint);
        if (swapResult) {
          console.log(`[Swap] Success at attempt #${swapAttempt}! Got ${swapResult.outSol.toFixed(6)} SOL`);
          await new Promise(r => setTimeout(r, 3000));
          break;
        }

        console.log(`[Swap] Attempt #${swapAttempt} gagal, retry dalam ${backoffSec}s...`);

        // Kirim alert Telegram tiap SWAP_ALERT_EVERY kali gagal
        if (swapAttempt % SWAP_ALERT_EVERY === 0) {
          await sendTelegram(
            `⚠️ <b>Swap Masih Gagal (attempt #${swapAttempt})</b>\n` +
            `Token: <b>${pos_state.symbol}</b>\n` +
            `Jumlah: <b>${tokenAfter.ui.toFixed(4)} token</b>\n` +
            `Bot akan terus retry otomatis.\n` +
            `Manual swap jika mendesak: <a href="https://jup.ag/swap/${pos_state.mint}-SOL">jup.ag</a>`
          );
        }

        await new Promise(r => setTimeout(r, backoffSec * 1000));

        // Re-cek balance token — mungkin sudah ke-swap eksternal atau habis
        const recheck = await getTokenBalance(pos_state.mint);
        if (recheck.raw === '0') {
          console.log('[Swap] Token balance jadi 0 saat recheck — anggap sudah ter-handle, stop retry.');
          break;
        }
      }
    }
  }

  // Ambil balance SETELAH swap selesai → realized PnL akurat
  const afterCloseLamports = await connection.getBalance(wallet.publicKey);
  const afterCloseSol = afterCloseLamports / 1e9;

  const realizedPnlSol = afterCloseSol - baselineSol;
  const realizedPnlPct = (pos_state.budgetSol || BUDGET_SOL) > 0
    ? (realizedPnlSol / (pos_state.budgetSol || BUDGET_SOL)) * 100
    : 0;

  appendLog({
    action: 'CLOSE', reason,
    symbol: pos_state.symbol, mint: pos_state.mint,
    pnl_sol: realizedPnlSol, pnl_pct: realizedPnlPct,
    est_pnl_sol: pnlSol, est_pnl_pct: pnlPct,
    fee_sol: totalFeeSol, duration_min: duration,
    oor_direction: pos_state.oorDirection || null,
    balance_before_open_sol: baselineSol,
    balance_after_close_sol: afterCloseSol,
    token_received: tokenReceived,
    token_from_lp: estLpToken,
    token_from_fee: estFeeToken,
    swap_result: swapResult,
  });

  state.activePosition = null;
  saveState(state);

  const emoji = { TAKE_PROFIT: '🎉', STOP_LOSS: '🛑', OOR_ABOVE: '📈', OOR_BELOW: '📉', VOL_DRY: '🌵', TVL_DILUTED: '🏊', SUPPORT_BROKEN: '🔻', PNL_STUCK: '😐' }[reason] || '⚠️';
  const label = {
    TAKE_PROFIT: 'Take Profit',
    STOP_LOSS: 'Stop Loss',
    OOR_ABOVE: 'OOR Pump — habis waktu tunggu',
    OOR_BELOW: 'OOR Dump — cut cepat',
    VOL_DRY: 'Volume Sepi — keluar sebelum terlambat',
    TVL_DILUTED: 'TVL Terlalu Besar — fee makin encer, cabut!',
    SUPPORT_BROKEN: 'Support Level Jebol — top holders avg buy ditembus!',
  }[reason] || reason;

  // Build token breakdown line
  let tokenBreakdownLine = '';
  if (tokenReceived > 0) {
    let breakdown = `${tokenReceived.toFixed(4)} ${pos_state.symbol}`;
    if (estLpToken !== null && estFeeToken !== null) {
      breakdown += ` (LP: ${estLpToken.toFixed(4)} + Fee: ${estFeeToken.toFixed(4)})`;
    }
    tokenBreakdownLine = `\nToken Diterima: <b>${breakdown}</b>`;
  }

  let msg =
    `${emoji} <b>Position Closed — ${label}</b>\n` +
    `Token: <b>${pos_state.symbol}</b>\n` +
    `Durasi: ${duration} menit\n` +
    `PnL Realized: <b>${fmtPct(realizedPnlPct)} (${fmtSol(realizedPnlSol)} SOL)</b>\n` +
    `Fee (est): ${fmtSol(totalFeeSol)} SOL` +
    tokenBreakdownLine + `\n` +
    `💰 Balance setelah close+swap: <b>${fmtSol(afterCloseSol)} SOL</b>\n`;

  if (swapResult) {
    msg += `\n🔄 Auto-swap: +${fmtSol(swapResult.outSol)} SOL\n`;
    msg += `<a href="https://solscan.io/tx/${swapResult.txHash}">Swap TX</a>`;
  } else if (AUTO_SWAP) {
    msg += `\n⚠️ Auto-swap gagal — swap manual di jup.ag jika ada token sisa.`;
  }

  await sendTelegram(msg);
  handleCloseInProgress = false;
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  ensureSingleInstance();
  console.log('🤖 DLMM Agent starting...');
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`SL: -${STOP_LOSS_PCT}% | TP: +${TAKE_PROFIT_PCT}% | Monitor: tiap ${MONITOR_INTERVAL_SEC}s | Cycle: tiap ${CYCLE_INTERVAL_SEC/60}min`);
  console.log(`OOR Above: ${OOR_ABOVE_LIMIT_MIN}min | OOR Below: ${OOR_BELOW_LIMIT_MIN}min`);

  // Patch dlmm bytes import
  try {
    const dlmmPath = './node_modules/@meteora-ag/dlmm/dist/index.mjs';
    let content = fs.readFileSync(dlmmPath, 'utf8');
    if (content.includes('"@coral-xyz/anchor/dist/cjs/utils/bytes"')) {
      content = content.replace(/from "@coral-xyz\/anchor\/dist\/cjs\/utils\/bytes"/g,
        'from "@coral-xyz/anchor/dist/cjs/utils/bytes/index.js"');
      fs.writeFileSync(dlmmPath, content);
      console.log('[Patch] Fixed dlmm bytes import');
    }
  } catch {}

  await sendTelegram(
    `🤖 <b>DLMM Agent Started!</b>\n` +
    `Wallet: <code>${wallet.publicKey.toBase58()}</code>\n` +
    `Budget: ${BUDGET_SOL} SOL | Bins: ${process.env.RANGE_BINS}\n` +
    `TP: +${TAKE_PROFIT_PCT}% | SL: -${STOP_LOSS_PCT}%\n` +
    `Monitor: tiap ${MONITOR_INTERVAL_SEC}s | Cycle: tiap ${CYCLE_INTERVAL_SEC / 60} menit\n` +
    `OOR Pump: ${OOR_ABOVE_LIMIT_MIN}min | OOR Dump: ${OOR_BELOW_LIMIT_MIN}min\n` +
    `Cycle: tiap ${CYCLE_INTERVAL_SEC / 60} menit\n` +
    `Orphan check: tiap 3 cycles ✅`
  );

  await runCycle();
  setInterval(runCycle, CYCLE_INTERVAL_SEC * 1000);
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  await sendTelegram(`🚨 <b>DLMM Agent CRASH!</b>\n${e.message}`);
  process.exit(1);
});
