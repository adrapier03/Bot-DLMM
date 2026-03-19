import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { BN } from '@coral-xyz/anchor';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const walletFile = JSON.parse(fs.readFileSync('./wallet.json', 'utf8'));
export const wallet = Keypair.fromSecretKey(new Uint8Array(walletFile));

// ─── RPC ROTATION (round-robin, proactive) ───────────────────────────────────
const RPC_KEYS = [
  'bf913512-1940-403c-8689-513d9424e57f', // key lama
  '5b4de084-7e1b-4cbe-bc71-dd93de01e561',
  '78be8195-17de-43a2-8305-bc9b5887500a',
  '83a0cc8a-8253-4d6c-9f23-2092880d2b9b',
  '1cd184e9-3336-406d-a2d9-c4c3b06ba187',
];
const RPC_URLS = RPC_KEYS.map(k => `https://mainnet.helius-rpc.com/?api-key=${k}`);
let _rpcIdx = 0;
export function getConnection() {
  const url = RPC_URLS[_rpcIdx % RPC_URLS.length];
  _rpcIdx++;
  return new Connection(url, 'confirmed');

}
// Backward compat — default connection untuk balance check dll
export const connection = getConnection();

// ─── BIN DATA CACHE (5 detik TTL) ─────────────────────────────────────────────
let _binDataCache = null;
let _binDataCachedAt = 0;
let _binDataCacheKey = ''; // invalidate kalau posisi/pool beda
const BIN_CACHE_TTL_MS = 5000;

const RANGE_BINS = parseInt(process.env.RANGE_BINS || '70');
const BUDGET_SOL = parseFloat(process.env.BUDGET_SOL || '0.5');
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || '500');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Fetch token decimals from on-chain
async function getTokenDecimals(mint) {
  try {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? 6;
  } catch {
    return 6;
  }
}

export async function openPosition(token) {
  const { mint, symbol, pool } = token;
  const poolPubkey = new PublicKey(pool.address);
  const dlmm = await DLMM.create(getConnection(), poolPubkey);

  const isSolX = pool.mintX === SOL_MINT;
  const tokenDecimals = await getTokenDecimals(mint);
  const budgetLamports = Math.floor(BUDGET_SOL * 1e9);
  const amount70 = new BN(Math.floor(budgetLamports * 0.7));
  const amount30 = new BN(Math.floor(budgetLamports * 0.3));

  const MAX_OPEN_RETRIES = 3;
  const OPEN_RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_OPEN_RETRIES; attempt++) {
    // Fetch active bin fresh tiap attempt — harga bisa bergeser antar retry
    const activeBin = await dlmm.getActiveBin();
    const entryPrice = parseFloat(activeBin.price) * Math.pow(10, tokenDecimals - 9);

    let minBinId, maxBinId;
    if (!isSolX) {
      maxBinId = activeBin.binId - 1;
      minBinId = activeBin.binId - RANGE_BINS;
    } else {
      minBinId = activeBin.binId + 1;
      maxBinId = activeBin.binId + RANGE_BINS;
    }

    const newPositionKeypair = Keypair.generate();

    try {
      // Layer 1: 70% BidAsk
      console.log(`[Open] Attempt #${attempt} | Active bin: ${activeBin.binId} | Range: ${minBinId} → ${maxBinId}`);
      console.log(`[Open] Layer 1 (70% BidAsk): ${amount70.toString()} lamports`);
      const tx1 = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPositionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount: isSolX ? amount70 : new BN(0),
        totalYAmount: isSolX ? new BN(0) : amount70,
        strategy: { maxBinId, minBinId, strategyType: StrategyType.BidAsk },
      });

      const txHash1 = await sendAndConfirmTransaction(getConnection(), tx1, [wallet, newPositionKeypair], {
        skipPreflight: true, commitment: 'confirmed',
      });
      console.log(`[Open] Layer 1 TX: ${txHash1}`);

      // Save state immediately after layer 1
      const posData = {
        positionKey: newPositionKeypair.publicKey.toBase58(),
        poolAddress: pool.address,
        mint,
        symbol,
        entryPrice,
        entryBin: activeBin.binId,
        minBinId,
        maxBinId,
        isSolX,
        budgetSol: BUDGET_SOL,
        txHash: txHash1,
        txHash2: null,
        openedAt: Date.now(),
        outOfRangeSince: null,
        oorDirection: null,
      };

      if (token._onPositionCreated) token._onPositionCreated(posData);

      // Layer 2: 30% Spot
      await new Promise(r => setTimeout(r, 3000));
      console.log(`[Open] Layer 2 (30% Spot): ${amount30.toString()} lamports`);
      try {
        const tx2 = await dlmm.addLiquidityByStrategy({
          positionPubKey: newPositionKeypair.publicKey,
          user: wallet.publicKey,
          totalXAmount: isSolX ? amount30 : new BN(0),
          totalYAmount: isSolX ? new BN(0) : amount30,
          strategy: { maxBinId, minBinId, strategyType: StrategyType.Spot },
        });
        const txHash2 = await sendAndConfirmTransaction(getConnection(), tx2, [wallet], {
          skipPreflight: true, commitment: 'confirmed',
        });
        posData.txHash2 = txHash2;
        console.log(`[Open] Layer 2 TX: ${txHash2}`);
      } catch (e) {
        console.error('[Open] Layer 2 failed (position still valid):', e.message);
      }

      // Layer 1 sukses → return posData
      return posData;

    } catch (e) {
      const isSlippageError = e.message?.includes('Custom:1') || e.message?.includes('SlippageExceeded') || e.message?.includes('custom program error: 0x1');
      if (isSlippageError && attempt < MAX_OPEN_RETRIES) {
        console.log(`[Open] Attempt #${attempt} gagal — active bin bergeser (${e.message}). Retry dalam ${OPEN_RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, OPEN_RETRY_DELAY_MS));
        continue; // fetch active bin baru di attempt berikutnya
      }
      // Error lain atau sudah habis retry → throw
      console.error(`[Open] Gagal setelah ${attempt} attempt: ${e.message}`);
      throw e;
    }
  }

  throw new Error(`[Open] Gagal buka posisi setelah ${MAX_OPEN_RETRIES} attempts`);
}

export async function monitorPosition(state) {
  const poolPubkey = new PublicKey(state.poolAddress);
  const dlmm = await DLMM.create(getConnection(), poolPubkey);
  const activeBin = await dlmm.getActiveBin();

  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  const pos = userPositions.find(p => p.publicKey.toBase58() === state.positionKey);
  if (!pos) return { error: 'position_not_found' };

  const { totalXAmount, totalYAmount, feeX, feeY, lowerBinId, upperBinId } = pos.positionData;
  const feeXRaw = new BN(feeX).toString();
  const feeYRaw = new BN(feeY).toString();

  // Fetch actual decimals from chain
  const tokenMint = state.isSolX ? (dlmm.tokenY?.publicKey?.toBase58?.() || state.poolAddress) : (dlmm.tokenX?.publicKey?.toBase58?.() || state.mint);
  const tokenDecimals = await getTokenDecimals(tokenMint);
  const tokenDivisor = Math.pow(10, tokenDecimals);

  // Normalize DLMM price to SOL per 1 token (human).
  const rawBinPrice = parseFloat(activeBin.price);
  const currentPrice = rawBinPrice * Math.pow(10, tokenDecimals - 9);
  const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId;

  // feeX/feeY
  let feeSol, feeToken;
  if (!state.isSolX) {
    feeToken = new BN(feeX).toNumber() / tokenDivisor;
    feeSol   = new BN(feeY).toNumber() / 1e9;
  } else {
    feeSol   = new BN(feeX).toNumber() / 1e9;
    feeToken = new BN(feeY).toNumber() / tokenDivisor;
  }

  // ── ACCURATE VALUATION: hitung value per-bin pakai harga masing-masing bin ──
  // Cache 5 detik agar tidak hammer RPC tiap 2 detik
  let totalValueSol = 0;
  let solInPos = 0;
  let tokenInPos = 0;

  const cacheKey = `${state.positionKey}:${lowerBinId}:${upperBinId}`;
  const now = Date.now();
  const cacheHit = _binDataCache && _binDataCacheKey === cacheKey && (now - _binDataCachedAt) < BIN_CACHE_TTL_MS;

  try {
    let bins;
    if (cacheHit) {
      bins = _binDataCache;
    } else {
      const result = await dlmm.getBinsBetweenLowerAndUpperBound(lowerBinId, upperBinId);
      bins = result.bins;
      _binDataCache = bins;
      _binDataCachedAt = now;
      _binDataCacheKey = cacheKey;
    }

    for (const bin of bins) {
      // Harga per bin: rawBinPrice * scale fix (sama seperti currentPrice tapi per-bin)
      const binRawPrice = parseFloat(bin.price);
      const binPriceSol = binRawPrice * Math.pow(10, tokenDecimals - 9);

      // Jumlah token/SOL di bin ini (dari liquiditySupply & perbandingan posisi)
      // Meteora bin expose xAmount & yAmount dalam raw
      const binXRaw = bin.xAmount ? new BN(bin.xAmount).toNumber() : 0;
      const binYRaw = bin.yAmount ? new BN(bin.yAmount).toNumber() : 0;

      let binSol, binToken;
      if (!state.isSolX) {
        // X = token, Y = SOL
        binToken = binXRaw / tokenDivisor;
        binSol   = binYRaw / 1e9;
      } else {
        // X = SOL, Y = token
        binSol   = binXRaw / 1e9;
        binToken = binYRaw / tokenDivisor;
      }

      solInPos   += binSol;
      tokenInPos += binToken;
      totalValueSol += binSol + (binToken * binPriceSol);
    }

    // Sanity fallback: kalau per-bin data kosong/nol, fallback ke simple valuation
    // Ini terjadi saat OOR — token di bin sudah converted ke SOL semua, bin kelihatan kosong
    if (totalValueSol === 0) {
      console.log('  [Monitor] Per-bin valuation returned 0 (kemungkinan OOR), fallback ke simple valuation');
      const tokenInPosSimple = !state.isSolX
        ? new BN(totalXAmount).toNumber() / tokenDivisor
        : new BN(totalYAmount).toNumber() / tokenDivisor;
      const solInPosSimple = !state.isSolX
        ? new BN(totalYAmount).toNumber() / 1e9
        : new BN(totalXAmount).toNumber() / 1e9;
      solInPos = solInPosSimple;
      tokenInPos = tokenInPosSimple;
      // Saat OOR Above: posisi mayoritas SOL (token habis dijual ke SOL)
      // Saat OOR Below: posisi mayoritas token (SOL habis dipakai beli token)
      // Pakai active bin price untuk valuasi token sisa
      totalValueSol = solInPosSimple + (tokenInPosSimple * currentPrice);
      // Invalidate cache supaya tick berikutnya fetch ulang
      _binDataCache = null;
      _binDataCachedAt = 0;
    }
  } catch (e) {
    // Fallback ke cara lama jika getBinsBetweenLowerAndUpperBound gagal
    console.log(`  [Monitor] Per-bin valuation failed (${e.message}), fallback to simple valuation`);
    tokenInPos = !state.isSolX
      ? new BN(totalXAmount).toNumber() / tokenDivisor
      : new BN(totalYAmount).toNumber() / tokenDivisor;
    solInPos = !state.isSolX
      ? new BN(totalYAmount).toNumber() / 1e9
      : new BN(totalXAmount).toNumber() / 1e9;
    totalValueSol = solInPos + (tokenInPos * currentPrice);
  }

  const totalFeeSol = feeSol + feeToken * currentPrice;
  const pnlSol = (totalValueSol + totalFeeSol) - state.budgetSol;
  const pnlPct = (pnlSol / state.budgetSol) * 100;

  // Sanity check — guard against bad decimal/price orientation spikes
  const safePnlPct = Math.abs(pnlPct) > 100 ? 0 : pnlPct;
  const safePnlSol = Math.abs(pnlSol) > state.budgetSol * 2 ? 0 : pnlSol;

  return {
    inRange,
    solInPos,
    tokenInPos,
    feeSol,
    feeToken,
    feeXRaw,
    feeYRaw,
    totalValueSol,
    totalFeeSol,
    pnlSol: safePnlSol,
    pnlPct: safePnlPct,
    currentPrice,
    rawBinPrice,
    activeBinId: activeBin.binId,
    tokenDecimals,
    dlmm,
    pos,
  };
}

// Scan all pools for any open positions (orphan detection)
export async function scanOrphanPositions(knownPools = []) {
  const orphans = [];
  for (const poolAddr of knownPools) {
    try {
      const dlmm = await DLMM.create(getConnection(), new PublicKey(poolAddr));
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
      for (const p of userPositions) {
        orphans.push({
          positionKey: p.publicKey.toBase58(),
          poolAddress: poolAddr,
          lowerBinId: p.positionData.lowerBinId,
          upperBinId: p.positionData.upperBinId,
          totalX: p.positionData.totalXAmount.toString(),
          totalY: p.positionData.totalYAmount.toString(),
        });
      }
    } catch {}
  }
  return orphans;
}

export async function claimFees(pos_state, dlmm, pos) {
  try {
    const claimTx = await dlmm.claimAllSwapFee({
      owner: wallet.publicKey,
      position: pos,
    });
    const txs = Array.isArray(claimTx) ? claimTx : [claimTx];
    const hashes = [];
    for (const tx of txs) {
      const h = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true, commitment: 'confirmed' });
      hashes.push(h);
    }
    return hashes;
  } catch (e) {
    console.error('[Claim] Error:', e.message);
    return [];
  }
}

export async function closePosition(state, maxRetries = 5) {
  const BACKOFF = [3, 5, 10, 20, 30]; // detik per retry

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const poolPubkey = new PublicKey(state.poolAddress);
      const dlmm = await DLMM.create(getConnection(), poolPubkey);
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
      const pos = userPositions.find(p => p.publicKey.toBase58() === state.positionKey);

      if (!pos) {
        console.log('[Close] Position not found on-chain — already closed ✅');
        return [];
      }

      const txs = await dlmm.removeLiquidity({
        position: new PublicKey(state.positionKey),
        user: wallet.publicKey,
        fromBinId: pos.positionData.lowerBinId,
        toBinId: pos.positionData.upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const txList = Array.isArray(txs) ? txs : [txs];
      const hashes = [];
      for (const tx of txList) {
        const h = await sendAndConfirmTransaction(getConnection(), tx, [wallet], {
          skipPreflight: true,
          commitment: 'confirmed',
          maxRetries: 3,
        });
        hashes.push(h);
      }
      console.log(`[Close] Success on attempt #${attempt} ✅`);
      return hashes;

    } catch (e) {
      const isAlreadyClosed = e.message?.includes('3007') || e.message?.includes('position_not_found');
      if (isAlreadyClosed) {
        console.log('[Close] Position no longer exists on-chain — already closed ✅');
        return [];
      }

      console.error(`[Close] Attempt #${attempt}/${maxRetries} failed: ${e.message}`);

      // Verifikasi ulang — mungkin TX berhasil tapi RPC timeout
      try {
        const poolPubkey = new PublicKey(state.poolAddress);
        const dlmm = await DLMM.create(getConnection(), poolPubkey);
        const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
        const stillExists = userPositions.some(p => p.publicKey.toBase58() === state.positionKey);
        if (!stillExists) {
          console.log('[Close] Verifikasi: posisi sudah tidak ada di chain — dianggap berhasil ✅');
          return [];
        }
      } catch (verifyErr) {
        console.error('[Close] Verifikasi error:', verifyErr.message);
      }

      if (attempt < maxRetries) {
        const waitSec = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
        console.log(`[Close] Retry dalam ${waitSec}s...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        throw new Error(`Close gagal setelah ${maxRetries} attempts: ${e.message}`);
      }
    }
  }
}

// Fetch token price in USD via Jupiter Price API v3
export async function fetchJupiterPriceUsd(mint) {
  const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
  try {
    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mint}`, {
      headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {},
      timeout: 6000,
    });
    const data = res.data?.[mint];
    return data?.usdPrice ?? null;
  } catch (e) {
    console.error('[JupPrice] Error:', e.message);
    return null;
  }
}

export async function swapTokenToSol(mint, slippageBps = 100) {
  const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
  const SOL_MINT_ADDR = 'So11111111111111111111111111111111111111112';
  // Progressive slippage: mulai 1%, naik tiap retry → 1% → 2% → 3% → 5%
  const SLIPPAGE_STEPS = [100, 200, 300, 500];

  try {
    // 1. Cek saldo token di wallet — cek Token standard + Token-2022
    const [stdAccounts, t22Accounts] = await Promise.all([
      getConnection().getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      }),
      getConnection().getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      }),
    ]);
    const allAccounts = [...stdAccounts.value, ...t22Accounts.value];
    const acc = allAccounts.find(a => a.account.data.parsed.info.mint === mint);
    if (!acc) { console.log('[Swap] No token account found'); return null; }

    const rawAmount = acc.account.data.parsed.info.tokenAmount.amount;
    if (rawAmount === '0') { console.log('[Swap] Token balance is 0, skip'); return null; }

    console.log(`[Swap] Token balance: ${rawAmount} raw | mint: ${mint}`);

    // Progressive slippage retry: 1% → 2% → 3% → 5%
    for (let attempt = 0; attempt < SLIPPAGE_STEPS.length; attempt++) {
      const currentSlippage = SLIPPAGE_STEPS[attempt];
      console.log(`[Swap] Attempt #${attempt + 1} | slippage: ${currentSlippage / 100}%`);
      try {
        // 2. Get order via Jupiter Ultra Swap API
        const orderRes = await axios.get('https://api.jup.ag/ultra/v1/order', {
          params: {
            inputMint: mint,
            outputMint: SOL_MINT_ADDR,
            amount: rawAmount,
            slippageBps: currentSlippage,
            taker: wallet.publicKey.toBase58(),
          },
          headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {},
          timeout: 12000,
        });

        const order = orderRes.data;
        if (!order.transaction) throw new Error(`Ultra order failed: ${JSON.stringify(order.error || order)}`);

        const outSol = parseInt(order.outAmount || 0) / 1e9;
        console.log(`[Swap] Ultra order: expect ${outSol.toFixed(6)} SOL out (slippage ${currentSlippage / 100}%)`);

        // 3. Sign transaction
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
        tx.sign([wallet]);
        const signedB64 = Buffer.from(tx.serialize()).toString('base64');

        // 4. Execute via Jupiter Ultra
        const execRes = await axios.post('https://api.jup.ag/ultra/v1/execute', {
          signedTransaction: signedB64,
          requestId: order.requestId,
        }, {
          headers: {
            'Content-Type': 'application/json',
            ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}),
          },
          timeout: 30000,
        });

        const result = execRes.data;
        if (result.status === 'Success') {
          console.log(`[Swap] Success! TX: ${result.signature} | out: ${outSol.toFixed(6)} SOL | slippage used: ${currentSlippage / 100}%`);
          return { txHash: result.signature, outSol, slippageBps: currentSlippage };
        } else {
          throw new Error(result.error || result.status);
        }
      } catch (e) {
        console.error(`[Swap] Attempt #${attempt + 1} gagal (slippage ${currentSlippage / 100}%): ${e?.response?.data || e.message}`);
        if (attempt < SLIPPAGE_STEPS.length - 1) {
          console.log(`[Swap] Naik slippage ke ${SLIPPAGE_STEPS[attempt + 1] / 100}% dan retry...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    console.error('[Swap] Semua slippage steps gagal.');
    return null;
  } catch (e) {
    console.error('[Swap] Error:', e?.response?.data || e.message);
    return null;
  }
}
