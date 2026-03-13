import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { BN } from '@coral-xyz/anchor';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const walletFile = JSON.parse(fs.readFileSync('./wallet.json', 'utf8'));
export const wallet = Keypair.fromSecretKey(new Uint8Array(walletFile));

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');

const RANGE_BINS = parseInt(process.env.RANGE_BINS || '70');
const BUDGET_SOL = parseFloat(process.env.BUDGET_SOL || '0.5');
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || '500');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Fetch token decimals from on-chain
async function getTokenDecimals(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? 6;
  } catch {
    return 6;
  }
}

export async function openPosition(token) {
  const { mint, symbol, pool } = token;
  const poolPubkey = new PublicKey(pool.address);
  const dlmm = await DLMM.create(connection, poolPubkey);
  const activeBin = await dlmm.getActiveBin();

  const isSolX = pool.mintX === SOL_MINT;
  const budgetLamports = Math.floor(BUDGET_SOL * 1e9);
  const amount70 = new BN(Math.floor(budgetLamports * 0.7));
  const amount30 = new BN(Math.floor(budgetLamports * 0.3));

  let minBinId, maxBinId;
  if (!isSolX) {
    maxBinId = activeBin.binId - 1;
    minBinId = activeBin.binId - RANGE_BINS;
  } else {
    minBinId = activeBin.binId + 1;
    maxBinId = activeBin.binId + RANGE_BINS;
  }

  const newPositionKeypair = Keypair.generate();

  // Layer 1: 70% BidAsk
  console.log(`[Open] Layer 1 (70% BidAsk): ${amount70.toString()} lamports`);
  const tx1 = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: newPositionKeypair.publicKey,
    user: wallet.publicKey,
    totalXAmount: isSolX ? amount70 : new BN(0),
    totalYAmount: isSolX ? new BN(0) : amount70,
    strategy: { maxBinId, minBinId, strategyType: StrategyType.BidAsk },
  });

  const txHash1 = await sendAndConfirmTransaction(connection, tx1, [wallet, newPositionKeypair], {
    skipPreflight: true, commitment: 'confirmed',
  });
  console.log(`[Open] Layer 1 TX: ${txHash1}`);

  // Save state immediately after layer 1 — before layer 2
  // so even if layer 2 fails, we don't lose track of position
  const posData = {
    positionKey: newPositionKeypair.publicKey.toBase58(),
    poolAddress: pool.address,
    mint,
    symbol,
    entryPrice: parseFloat(activeBin.price),
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

  // Yield posData early so caller can save state before layer 2
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
    const txHash2 = await sendAndConfirmTransaction(connection, tx2, [wallet], {
      skipPreflight: true, commitment: 'confirmed',
    });
    posData.txHash2 = txHash2;
    console.log(`[Open] Layer 2 TX: ${txHash2}`);
  } catch (e) {
    console.error('[Open] Layer 2 failed (position still valid):', e.message);
  }

  return posData;
}

export async function monitorPosition(state) {
  const poolPubkey = new PublicKey(state.poolAddress);
  const dlmm = await DLMM.create(connection, poolPubkey);
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

  const currentPrice = parseFloat(activeBin.price); // SOL per 1 token (human-readable), sudah adjust decimal
  const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId;

  // feeX = token side (raw, pakai tokenDivisor)
  // feeY = SOL side (raw lamports, pakai 1e9)
  // totalXAmount/totalYAmount sama
  let solInPos, tokenInPos, feeSol, feeToken;
  if (!state.isSolX) {
    // X = token, Y = SOL
    tokenInPos = new BN(totalXAmount).toNumber() / tokenDivisor;
    solInPos   = new BN(totalYAmount).toNumber() / 1e9;
    feeToken   = new BN(feeX).toNumber() / tokenDivisor;
    feeSol     = new BN(feeY).toNumber() / 1e9;
  } else {
    // X = SOL, Y = token
    solInPos   = new BN(totalXAmount).toNumber() / 1e9;
    tokenInPos = new BN(totalYAmount).toNumber() / tokenDivisor;
    feeSol     = new BN(feeX).toNumber() / 1e9;
    feeToken   = new BN(feeY).toNumber() / tokenDivisor;
  }

  // currentPrice = SOL per 1 token (pakai activeBin.price yang sudah human-readable)
  // feeToken sudah human-readable → perkalian konsisten
  const tokenValueSol = tokenInPos * currentPrice;
  const totalValueSol = solInPos + tokenValueSol;
  const totalFeeSol   = feeSol + feeToken * currentPrice;
  const pnlSol = (totalValueSol + totalFeeSol) - state.budgetSol;
  const pnlPct = (pnlSol / state.budgetSol) * 100;

  // Sanity check — guard against bad decimal/price orientation spikes
  // Keep monitor stable so TP/SL tidak ke-trigger palsu.
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
      const dlmm = await DLMM.create(connection, new PublicKey(poolAddr));
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
      const h = await sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'confirmed' });
      hashes.push(h);
    }
    return hashes;
  } catch (e) {
    console.error('[Claim] Error:', e.message);
    return [];
  }
}

export async function closePosition(state) {
  const poolPubkey = new PublicKey(state.poolAddress);
  const dlmm = await DLMM.create(connection, poolPubkey);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  const pos = userPositions.find(p => p.publicKey.toBase58() === state.positionKey);
  if (!pos) {
    console.log('[Close] Position not found on-chain, already closed?');
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
    const h = await sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true, commitment: 'confirmed' });
    hashes.push(h);
  }
  return hashes;
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

export async function swapTokenToSol(mint) {
  const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
  const SOL_MINT_ADDR = 'So11111111111111111111111111111111111111112';

  try {
    // 1. Cek saldo token di wallet — cek Token standard + Token-2022
    const [stdAccounts, t22Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      }),
    ]);
    const allAccounts = [...stdAccounts.value, ...t22Accounts.value];
    const acc = allAccounts.find(a => a.account.data.parsed.info.mint === mint);
    if (!acc) { console.log('[Swap] No token account found'); return null; }

    const rawAmount = acc.account.data.parsed.info.tokenAmount.amount;
    if (rawAmount === '0') { console.log('[Swap] Token balance is 0, skip'); return null; }

    console.log(`[Swap] Token balance: ${rawAmount} raw | mint: ${mint}`);

    // 2. Get order via Jupiter Ultra Swap API
    const orderRes = await axios.get('https://api.jup.ag/ultra/v1/order', {
      params: {
        inputMint: mint,
        outputMint: SOL_MINT_ADDR,
        amount: rawAmount,
        slippageBps: MAX_SLIPPAGE_BPS,
        taker: wallet.publicKey.toBase58(),
      },
      headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {},
      timeout: 12000,
    });

    const order = orderRes.data;
    if (!order.transaction) throw new Error(`Ultra order failed: ${JSON.stringify(order.error || order)}`);

    const outSol = parseInt(order.outAmount || 0) / 1e9;
    console.log(`[Swap] Ultra order: expect ${outSol.toFixed(6)} SOL out`);

    // 3. Sign transaction
    const { VersionedTransaction } = await import('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    tx.sign([wallet]);
    const signedB64 = Buffer.from(tx.serialize()).toString('base64');

    // 4. Execute via Jupiter Ultra (managed landing)
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
      console.log(`[Swap] Success! TX: ${result.signature} | out: ${outSol.toFixed(6)} SOL`);
      return { txHash: result.signature, outSol };
    } else {
      console.error('[Swap] Execute failed:', result.error || result.status);
      return null;
    }
  } catch (e) {
    console.error('[Swap] Error:', e?.response?.data || e.message);
    return null;
  }
}
