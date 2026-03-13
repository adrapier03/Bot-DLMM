import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { sendTelegram } from './telegram.js';
import { scanTokens } from './scanner.js';
import { openPosition, monitorPosition, claimFees, closePosition, swapTokenToSol, fetchJupiterPriceUsd, scanOrphanPositions, connection, wallet } from './meteora.js';
import { scrapeCookinToken, passCookinFilter, formatCookinSummary } from './cookin-scraper.js';

const STATE_FILE = './state.json';
const LOG_FILE = './trade_log.json';
const POOLS_FILE = './known_pools.json'; // track semua pool yang pernah dipakai
const PID_FILE = './agent.pid';

const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '20');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '10');
const FEE_CLAIM_THRESHOLD_SOL = parseFloat(process.env.FEE_CLAIM_THRESHOLD_SOL || '0.03');
const CYCLE_INTERVAL_SEC = parseInt(process.env.CYCLE_INTERVAL_SEC || '300');
const AUTO_SWAP = process.env.AUTO_SWAP === 'true';
const BUDGET_SOL = parseFloat(process.env.BUDGET_SOL || '0.5');
const OOR_ABOVE_LIMIT_MIN = parseFloat(process.env.OOR_ABOVE_LIMIT_MIN || '60');
const OOR_BELOW_LIMIT_MIN = parseFloat(process.env.OOR_BELOW_LIMIT_MIN || '20');
const VOL_DRY_THRESHOLD_USD = parseFloat(process.env.VOL_DRY_THRESHOLD_USD || '20000');
const VOL_DRY_CYCLES = parseInt(process.env.VOL_DRY_CYCLES || '3');

let cycleCount = 0;

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

function fmtSol(n) { return typeof n === 'number' ? n.toFixed(4) : '0.0000'; }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtUsd(n) { return '$' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

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

// ─── VOLUME CHECK ─────────────────────────────────────────────
async function fetchVol5m(poolAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`;
    const res = await axios.get(url, { timeout: 8000 });
    const pair = res.data?.pair || res.data?.pairs?.[0];
    return pair?.volume?.m5 ?? null;
  } catch (e) {
    console.error('[VolCheck] Fetch error:', e.message);
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
    console.log('[Mode] MONITOR —', state.activePosition.symbol);
    let data;
    try {
      data = await monitorPosition(state.activePosition);
    } catch (e) {
      console.error('[Monitor] Error:', e.message);
      return;
    }

    if (data.error === 'position_not_found') {
      console.log('[Monitor] Position not found on-chain, clearing state.');
      saveState({ activePosition: null });
      return;
    }

    const { inRange, pnlSol, pnlPct, totalFeeSol, feeXRaw, feeYRaw, currentPrice, activeBinId, solInPos, tokenInPos, feeSol, feeToken, tokenDecimals, dlmm, pos } = data;
    const pos_state = state.activePosition;

    // ── EST PnL via Jupiter Price API (lebih akurat dari activeBin.price)
    let estPnlSol = pnlSol;
    let estPnlPct = pnlPct;
    try {
      const jupPriceUsd = await fetchJupiterPriceUsd(pos_state.mint);
      const solPriceUsd = await fetchJupiterPriceUsd('So11111111111111111111111111111111111111112');
      if (jupPriceUsd && solPriceUsd && solPriceUsd > 0) {
        const tokenPriceInSol = jupPriceUsd / solPriceUsd;
        const tokenValueSol = tokenInPos * tokenPriceInSol;
        const feeTokenSol = feeToken * tokenPriceInSol;
        const totalValueSol = solInPos + tokenValueSol + feeSol + feeTokenSol;
        estPnlSol = totalValueSol - pos_state.budgetSol;
        estPnlPct = (estPnlSol / pos_state.budgetSol) * 100;
        console.log(`  [EstPnL] Jupiter price: $${jupPriceUsd.toFixed(8)} | tokenInPos: ${tokenInPos.toFixed(2)} | est: ${fmtPct(estPnlPct)}`);
      }
    } catch (e) {
      console.error('[EstPnL] Jupiter price fetch error:', e.message);
    }

    // ── VOLUME HEALTH CHECK
    const vol5m = await fetchVol5m(pos_state.poolAddress);
    console.log(`  Vol5m: ${vol5m !== null ? fmtUsd(vol5m) : 'N/A'} (threshold: ${fmtUsd(VOL_DRY_THRESHOLD_USD)})`);

    // vol5m null = fetch gagal (429/timeout) — anggap volume dry juga
    const isVolDry = vol5m === null || vol5m < VOL_DRY_THRESHOLD_USD;

    if (isVolDry) {
      pos_state.volDryCycles = (pos_state.volDryCycles || 0) + 1;
      const reason429 = vol5m === null ? ' (fetch error)' : '';
      console.log(`  [VolDry] Low volume cycle ${pos_state.volDryCycles}/${VOL_DRY_CYCLES}${reason429}`);
      if (pos_state.volDryCycles === 1) {
        await sendTelegram(
          `📉 <b>Volume Mulai Sepi!</b>\n` +
          `Token: <b>${pos_state.symbol}</b>\n` +
          `Vol 5m: <b>${vol5m !== null ? fmtUsd(vol5m) : 'N/A (fetch error)'}</b> (threshold: ${fmtUsd(VOL_DRY_THRESHOLD_USD)})\n` +
          `Cycle: ${pos_state.volDryCycles}/${VOL_DRY_CYCLES} — pantau terus...`
        );
      }
      saveState(state);
      if (pos_state.volDryCycles >= VOL_DRY_CYCLES) {
        console.log(`[Action] VOL_DRY triggered after ${VOL_DRY_CYCLES} cycles!`);
        await handleClose(state, pos_state, 'VOL_DRY', estPnlSol, estPnlPct, totalFeeSol);
        return;
      }
    } else {
      if (pos_state.volDryCycles > 0) {
        console.log(`  [VolDry] Volume recovered, reset counter`);
        pos_state.volDryCycles = 0;
        saveState(state);
      }
    }

    const oorDir = getOORDirection(activeBinId, pos_state.minBinId, pos_state.maxBinId);
    const oorLimit = oorDir === 'ABOVE' ? OOR_ABOVE_LIMIT_MIN : OOR_BELOW_LIMIT_MIN;

    // Track OOR
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
          `PnL: ${fmtPct(estPnlPct)} | Fee: ${fmtSol(totalFeeSol)} SOL\n` +
          `Fee mulai masuk lagi 💰`
        );
      }
      pos_state.outOfRangeSince = null;
      pos_state.oorDirection = null;
      saveState(state);
    }

    const outOfRangeMinutes = pos_state.outOfRangeSince
      ? (Date.now() - pos_state.outOfRangeSince) / 60000 : 0;

    console.log(`  PnL: ${fmtPct(estPnlPct)} | Fee: ${fmtSol(totalFeeSol)} SOL | InRange: ${inRange} | OOR: ${outOfRangeMinutes.toFixed(1)}min (${oorDir}) | Limit: ${oorLimit}min`);

    // ── STOP LOSS
    if (estPnlPct <= -STOP_LOSS_PCT) {
      console.log('[Action] STOP LOSS triggered!');
      await handleClose(state, pos_state, 'STOP_LOSS', estPnlSol, estPnlPct, totalFeeSol);
      return;
    }

    // ── TAKE PROFIT
    if (estPnlPct >= TAKE_PROFIT_PCT) {
      console.log('[Action] TAKE PROFIT triggered!');
      await handleClose(state, pos_state, 'TAKE_PROFIT', estPnlSol, estPnlPct, totalFeeSol);
      return;
    }

    // ── OOR smart limit
    if (!inRange && outOfRangeMinutes >= oorLimit) {
      const reason = oorDir === 'ABOVE' ? 'OOR_ABOVE' : 'OOR_BELOW';
      console.log(`[Action] OOR ${oorDir} limit reached (${outOfRangeMinutes.toFixed(1)}/${oorLimit}min), closing.`);
      await handleClose(state, pos_state, reason, estPnlSol, estPnlPct, totalFeeSol);
      return;
    }

    // ── CLAIM FEE (disabled — fee akan terclaim otomatis saat close position)
    // if (totalFeeSol >= FEE_CLAIM_THRESHOLD_SOL) {
    //   console.log(`[Action] Claiming fees: ${fmtSol(totalFeeSol)} SOL`);
    //   try {
    //     await claimFees(pos_state, dlmm, pos);
    //     await sendTelegram(...);
    //   } catch (e) {
    //     console.error('[Claim] Error:', e.message);
    //   }
    //   return;
    // }

    // ── STATUS update tiap 3 cycle (15 menit)
    if (cycleCount % 3 === 0) {
      await sendTelegram(
        `📊 <b>Position Update</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `PnL: <b>${fmtPct(estPnlPct)}</b>\n` +
        `Fee: ${fmtSol(totalFeeSol)} SOL\n` +
        `Price: ${currentPrice.toFixed(8)}\n` +
        `Status: ${inRange ? '✅ In Range' : `⚠️ OOR ${oorDir} (${outOfRangeMinutes.toFixed(0)}/${oorLimit}min)`}`
      );
    }

    console.log(`[Status] Healthy. PnL: ${fmtPct(estPnlPct)}`);
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
      `Rejected:\n` +
      `• Spike 5m: ${rejected.price_spike || 0}\n` +
      `• Spike 1h: ${rejected.price_spike_1h || 0}\n` +
      `• No pool Meteora: ${rejected.no_pool || 0}\n` +
      `• Liq kecil: ${rejected.low_liquidity || 0}\n` +
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
    `Entry price: <b>${posData.entryPrice.toFixed(8)}</b>\n` +
    `Range: Bin ${posData.minBinId} → ${posData.maxBinId} (${Math.abs(posData.maxBinId - posData.minBinId)} bins)\n` +
    `Modal: <b>${posData.budgetSol} SOL</b>\n` +
    `Layer 1 (70% BidAsk): <a href="https://solscan.io/tx/${posData.txHash}">TX1</a>\n` +
    (posData.txHash2 ? `Layer 2 (30% Spot): <a href="https://solscan.io/tx/${posData.txHash2}">TX2</a>` : `Layer 2: skipped`) +
    (best.cookin ? `\n${formatCookinSummary(best.cookin)}` : '')
  );
}

async function handleClose(state, pos_state, reason, pnlSol, pnlPct, totalFeeSol) {
  const duration = Math.floor((Date.now() - pos_state.openedAt) / 60000);

  const baselineSol = Number.isFinite(pos_state.walletBalanceBeforeOpenSol)
    ? pos_state.walletBalanceBeforeOpenSol
    : ((await connection.getBalance(wallet.publicKey)) / 1e9);

  try {
    await closePosition(pos_state);
  } catch (e) {
    console.error('[Close] Error:', e.message);
    await sendTelegram(`❌ <b>Gagal close!</b>\nError: ${e.message}\nClose manual ya!`);
    return;
  }

  // Tunggu chain settle dulu
  await new Promise(r => setTimeout(r, 5000));

  let swapResult = null;
  if (AUTO_SWAP && pos_state.mint) {
    console.log('[Swap] Auto-swap token → SOL via Jupiter Ultra...');
    swapResult = await swapTokenToSol(pos_state.mint);
    if (swapResult) {
      console.log(`[Swap] Got ${swapResult.outSol.toFixed(6)} SOL`);
      // Tunggu swap settle
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log('[Swap] Swap gagal atau tidak ada token — skip');
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
    swap_result: swapResult,
  });

  state.activePosition = null;
  saveState(state);

  const emoji = { TAKE_PROFIT: '🎉', STOP_LOSS: '🛑', OOR_ABOVE: '📈', OOR_BELOW: '📉', VOL_DRY: '🌵' }[reason] || '⚠️';
  const label = {
    TAKE_PROFIT: 'Take Profit',
    STOP_LOSS: 'Stop Loss',
    OOR_ABOVE: 'OOR Pump — habis waktu tunggu',
    OOR_BELOW: 'OOR Dump — cut cepat',
    VOL_DRY: 'Volume Sepi — keluar sebelum terlambat',
  }[reason] || reason;

  let msg =
    `${emoji} <b>Position Closed — ${label}</b>\n` +
    `Token: <b>${pos_state.symbol}</b>\n` +
    `Durasi: ${duration} menit\n` +
    `PnL Realized: <b>${fmtPct(realizedPnlPct)} (${fmtSol(realizedPnlSol)} SOL)</b>\n` +
    `Fee (est): ${fmtSol(totalFeeSol)} SOL\n`;

  if (swapResult) {
    msg += `\n🔄 Auto-swap: +${fmtSol(swapResult.outSol)} SOL\n`;
    msg += `<a href="https://solscan.io/tx/${swapResult.txHash}">Swap TX</a>`;
  } else if (AUTO_SWAP) {
    msg += `\n⚠️ Auto-swap gagal — swap manual di jup.ag jika ada token sisa.`;
  }

  await sendTelegram(msg);
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  ensureSingleInstance();
  console.log('🤖 DLMM Agent starting...');
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`SL: -${STOP_LOSS_PCT}% | TP: +${TAKE_PROFIT_PCT}%`);
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
