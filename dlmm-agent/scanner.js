import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

import { scrapeCookinToken, passCookinFilter, formatCookinSummary } from './cookin-scraper.js';
import DLMM, { getBinArrayKeysCoverage } from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

const HELIUS_API_KEYS = process.env.HELIUS_API_KEYS
  ? process.env.HELIUS_API_KEYS.split(',').map(k => k.trim())
  : [process.env.HELIUS_API_KEY || ''];
const _conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEYS[0]}`, 'confirmed');

const GMGN_JSON_PATH = process.env.GMGN_JSON_PATH;
const SOL = 'So11111111111111111111111111111111111111112';
const BLACKLIST_FILE = './blacklist.json';

function loadBlacklist() {
  try {
    if (!fs.existsSync(BLACKLIST_FILE)) return new Set();
    const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
    return new Set(data.mints || []);
  } catch { return new Set(); }
}

// Filter dari .env
const MIN_POOL_LIQUIDITY = parseFloat(process.env.MIN_POOL_LIQUIDITY || '50000');
const MIN_TVL_USD = parseFloat(process.env.MIN_TVL_USD || '10000');
const MAX_PRICE_CHANGE_5M = parseFloat(process.env.MAX_PRICE_CHANGE_5M || '15');
const MAX_PRICE_CHANGE_1H = parseFloat(process.env.MAX_PRICE_CHANGE_1H || '50');
const MAX_MC_USD = parseFloat(process.env.MAX_MC_USD || '2000000'); // reject jika MC >= 2M

// Cache pairs — fetch ulang tiap 30 menit
let pairsCache = null;
let pairsCacheTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getAllPairs() {
  const now = Date.now();
  if (pairsCache && (now - pairsCacheTime) < CACHE_TTL_MS) {
    return pairsCache;
  }
  console.log('[Scanner] Fetching all Meteora pairs (cache refresh)...');
  const res = await axios.get('https://dlmm-api.meteora.ag/pair/all', { timeout: 30000 });
  pairsCache = Array.isArray(res.data) ? res.data : [];
  pairsCacheTime = now;
  console.log(`[Scanner] Cached ${pairsCache.length} pairs`);
  return pairsCache;
}

export async function scanTokens() {
  const results = {
    scanned: 0,
    scannedTokens: [],
    passed: [],
    rejected: { not_meteora: 0, no_pool: 0, cookin_reject: 0 },
    cookinRejectDetails: [], // Menyimpan detail reject cookin
  };

  if (!fs.existsSync(GMGN_JSON_PATH)) {
    console.log('[Scanner] GMGN JSON not found:', GMGN_JSON_PATH);
    return results;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(GMGN_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error('[Scanner] Failed to parse GMGN JSON:', e.message);
    return results;
  }

  const tokens = Array.isArray(raw) ? raw : (raw.data?.rank || raw.tokens || raw.items || null);
  if (!tokens || tokens.length === 0) {
    console.log('[Scanner] No tokens in JSON (rank is null or empty)');
    return results;
  }
  results.scanned = tokens.length;

  // Fetch/load pairs cache sekali untuk semua token di cycle ini
  let allPairs;
  try {
    allPairs = await getAllPairs();
  } catch (e) {
    console.error('[Scanner] Failed to fetch pairs:', e.message);
    return results;
  }

  const fmtUsd = (n) => {
    if (!n || isNaN(n)) return '$0';
    if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };

  const separator = '─'.repeat(55);
  let idx = 0;

  for (const token of tokens) {
    idx++;
    const mint = token.address || token.mint || token.token_address;
    const symbol = token.symbol || token.name || mint?.slice(0, 8);
    results.scannedTokens.push(`${symbol}${mint ? ` (${mint.slice(0, 6)}...)` : ''}`);
    const mc = parseFloat(token.market_cap || token.mc || 0);
    const vol = parseFloat(token.volume || token.volume_5m || 0);
    const priceChange5m = parseFloat(token.price_change_percent5m || 0);
    const priceChange1h = parseFloat(token.price_change_percent1h || 0);
    const price = parseFloat(token.price || 0);

    console.log(`\n${separator}`);
    console.log(`[Scanner #${idx}] ${symbol} | ${mint?.slice(0,20)}...`);
    console.log(`  Price   : $${price.toFixed(8)}`);
    console.log(`  MC      : ${fmtUsd(mc)}`);
    console.log(`  Vol 5m  : ${fmtUsd(vol)}`);
    console.log(`  Δ5m     : ${priceChange5m >= 0 ? '+' : ''}${priceChange5m.toFixed(2)}% (max: ±${MAX_PRICE_CHANGE_5M}%)`);
    console.log(`  Δ1h     : ${priceChange1h >= 0 ? '+' : ''}${priceChange1h.toFixed(2)}% (max: ±${MAX_PRICE_CHANGE_1H}%)`);

    if (!mint) { console.log(`  ❌ REJECT: mint address tidak ada`); continue; }

    // Filter blacklist — reject token yang di-blacklist manual
    const blacklist = loadBlacklist();
    if (blacklist.has(mint)) {
      console.log(`  ❌ REJECT: Token di-blacklist (${symbol})`);
      results.rejected.blacklisted = (results.rejected.blacklisted || 0) + 1;
      continue;
    }

    // Filter MC — reject jika MC >= MAX_MC_USD
    if (mc >= MAX_MC_USD) {
      console.log(`  ❌ REJECT: MC terlalu besar (${fmtUsd(mc)} >= ${fmtUsd(MAX_MC_USD)})`);
      results.rejected.mc_too_large = (results.rejected.mc_too_large || 0) + 1;
      continue;
    }

    // Filter price change 5m (DIMATIKAN)
    // if (Math.abs(priceChange5m) > MAX_PRICE_CHANGE_5M) {
    //   console.log(`  ❌ REJECT: Price spike 5m terlalu besar (${priceChange5m.toFixed(2)}%, max ±${MAX_PRICE_CHANGE_5M}%)`);
    //   results.rejected.price_spike = (results.rejected.price_spike || 0) + 1;
    //   continue;
    // }

    // Filter price change 1h (DIMATIKAN)
    // if (Math.abs(priceChange1h) > MAX_PRICE_CHANGE_1H) {
    //   console.log(`  ❌ REJECT: Price spike 1h terlalu besar (${priceChange1h.toFixed(2)}%, max ±${MAX_PRICE_CHANGE_1H}%)`);
    //   results.rejected.price_spike_1h = (results.rejected.price_spike_1h || 0) + 1;
    //   continue;
    // }

    // Cari pool Meteora
    const matched = allPairs.filter(p =>
      (p.mint_x === mint || p.mint_y === mint) &&
      (p.mint_x === SOL || p.mint_y === SOL)
    );

    if (matched.length === 0) {
      console.log(`  ❌ REJECT: Tidak ada pool SOL di Meteora DLMM`);
      results.rejected.no_pool++;
      continue;
    }

    matched.sort((a, b) => parseFloat(b.liquidity || 0) - parseFloat(a.liquidity || 0));
    const best = matched[0];

    const pool = {
      address: best.address,
      liquidity: parseFloat(best.liquidity || 0),
      apr: parseFloat(best.apr || 0),
      fees24h: parseFloat(best.fees_24h || 0),
      mintX: best.mint_x,
      mintY: best.mint_y,
    };

    console.log(`  Pool    : ${pool.address}`);
    console.log(`  Liq     : ${fmtUsd(pool.liquidity)} | APR: ${pool.apr.toFixed(1)}% | Fee24h: ${fmtUsd(pool.fees24h)}`);

    // ── CEK BIN ARRAYS — pool baru akan kena non-refundable rent ~0.07 SOL ──
    try {
      const dlmm = await DLMM.create(_conn, new PublicKey(pool.address));
      const activeBin = await dlmm.getActiveBin();
      const RANGE_BINS = parseInt(process.env.RANGE_BINS || '50');
      const isSolX = pool.mintX === SOL;
      const activeBinIdBN = new BN(activeBin.binId.toString());
      const minBinId = isSolX ? activeBinIdBN.addn(1) : activeBinIdBN.subn(RANGE_BINS);
      const maxBinId = isSolX ? activeBinIdBN.addn(RANGE_BINS) : activeBinIdBN.subn(1);

      const binArrayKeys = await getBinArrayKeysCoverage(
        minBinId,
        maxBinId,
        new PublicKey(pool.address),
        dlmm.program.programId
      );

      // Cek apakah bin array accounts sudah exist di chain
      const accountInfos = await _conn.getMultipleAccountsInfo(binArrayKeys);
      const missingCount = accountInfos.filter(a => a === null).length;

      if (missingCount > 0) {
        console.log(`  ❌ REJECT: Pool baru — ${missingCount} bin array belum ada di chain → non-refundable ~0.07 SOL`);
        results.rejected.new_pool = (results.rejected.new_pool || 0) + 1;
        continue;
      }
      console.log(`  ✅ Bin arrays sudah exist (${binArrayKeys.length} arrays) — tidak kena non-refundable`);
    } catch (e) {
      console.log(`  ⚠️ Gagal cek bin arrays (${e.message}) — lanjut dengan risiko`);
    }

    // Filter liquidity — reject jika TVL terlalu kecil
    if (pool.liquidity < MIN_TVL_USD) {
      console.log(`  ❌ REJECT: TVL terlalu kecil (${fmtUsd(pool.liquidity)} < ${fmtUsd(MIN_TVL_USD)})`);
      results.rejected.low_tvl = (results.rejected.low_tvl || 0) + 1;
      continue;
    }

    // Filter liquidity — reject jika TVL Meteora >= MIN_POOL_LIQUIDITY (terlalu besar)
    if (pool.liquidity >= MIN_POOL_LIQUIDITY) {
      console.log(`  ❌ REJECT: TVL terlalu besar (${fmtUsd(pool.liquidity)} >= ${fmtUsd(MIN_POOL_LIQUIDITY)})`);
      results.rejected.high_liquidity = (results.rejected.high_liquidity || 0) + 1;
      continue;
    }

    console.log(`  ✅ LOLOS filter GMGN+Meteora — cek Cookin.fun...`);

    // ── Cookin.fun behavioral filter ──
    const cookin = await scrapeCookinToken(mint);
    if (cookin) {
      const cookinSummary = formatCookinSummary(cookin);
      console.log(cookinSummary.replace(/<[^>]+>/g, '')); // strip HTML tags untuk log
      const check = passCookinFilter(cookin);
      if (check.pass === false) {
        results.rejected.cookin_reject = (results.rejected.cookin_reject || 0) + 1;
        results.cookinRejectDetails.push(`${symbol}: ${check.reasons.join(' | ')}`);
        continue;
      }
    } else {
      console.log(`  ❌ REJECT: Cookin.fun tidak ada data (token belum ter-index atau scrape gagal)`);
      results.rejected.cookin_reject = (results.rejected.cookin_reject || 0) + 1;
      results.cookinRejectDetails.push(`${symbol}: No Cookin data (N/A)`);
      continue;
    }

    console.log(`  ✅ LOLOS semua filter — masuk kandidat!`);
    results.passed.push({ mint, symbol, mc, vol, pool, cookin });
  }

  console.log(`\n${separator}`);
  console.log(`[Scanner] Hasil: ${results.scanned} scanned | ${results.passed.length} lolos | rejected: MC=${results.rejected.mc_too_large||0} LowTVL=${results.rejected.low_tvl||0} HighTVL=${results.rejected.high_liquidity||0} NoPool=${results.rejected.no_pool||0} Cookin=${results.rejected.cookin_reject||0} NewPool=${results.rejected.new_pool||0} Blacklist=${results.rejected.blacklisted||0}`);
  console.log(separator);

  return results;
}
