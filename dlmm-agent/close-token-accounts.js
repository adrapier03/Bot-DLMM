import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const walletFile = JSON.parse(fs.readFileSync('./wallet.json', 'utf8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletFile));
const connection = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || '500');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

console.log('🔑 Wallet:', wallet.publicKey.toBase58());

async function getAllTokenAccounts() {
  const [std, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  return [
    ...std.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t22.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM_ID })),
  ];
}

async function swapTokenToSol(mint, rawAmount) {
  try {
    console.log(`  [Swap] Swapping ${rawAmount} raw of ${mint.slice(0,20)}...`);
    const orderRes = await axios.get('https://api.jup.ag/ultra/v1/order', {
      params: { inputMint: mint, outputMint: SOL_MINT, amount: rawAmount, slippageBps: MAX_SLIPPAGE_BPS, taker: wallet.publicKey.toBase58() },
      headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {},
      timeout: 12000,
    });
    const order = orderRes.data;
    if (!order.transaction) throw new Error(`Order failed: ${JSON.stringify(order.error || order)}`);

    const outSol = parseInt(order.outAmount || 0) / 1e9;
    console.log(`  [Swap] Expected out: ${outSol.toFixed(6)} SOL`);

    const { VersionedTransaction } = await import('@solana/web3.js');
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    tx.sign([wallet]);
    const signedB64 = Buffer.from(tx.serialize()).toString('base64');

    const execRes = await axios.post('https://api.jup.ag/ultra/v1/execute', {
      signedTransaction: signedB64,
      requestId: order.requestId,
    }, {
      headers: { 'Content-Type': 'application/json', ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}) },
      timeout: 30000,
    });

    const result = execRes.data;
    if (result.status === 'Success') {
      console.log(`  ✅ Swap success! TX: ${result.signature} | out: ${outSol.toFixed(6)} SOL`);
      return true;
    } else {
      console.log(`  ⚠️ Swap failed: ${result.error || result.status} — skip, lanjut close account`);
      return false;
    }
  } catch (e) {
    console.log(`  ⚠️ Swap error: ${e?.response?.data?.error || e.message} — skip, lanjut close account`);
    return false;
  }
}

async function closeTokenAccount(accountPubkey, programId) {
  try {
    const ix = createCloseAccountInstruction(
      accountPubkey,      // account to close
      wallet.publicKey,   // rent destination
      wallet.publicKey,   // authority
      [],
      programId
    );
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      skipPreflight: true,
      commitment: 'confirmed',
    });
    return sig;
  } catch (e) {
    throw new Error(e.message);
  }
}

async function main() {
  const solBefore = await connection.getBalance(wallet.publicKey);
  console.log(`\n💰 SOL sebelum: ${(solBefore / 1e9).toFixed(6)} SOL\n`);

  const accounts = await getAllTokenAccounts();
  console.log(`📋 Total token accounts: ${accounts.length}\n`);

  let swapped = 0;
  let closed = 0;
  let rentReclaimed = 0;
  let failed = 0;

  for (const acc of accounts) {
    const info = acc.account.data.parsed.info;
    const mint = info.mint;
    const rawAmount = info.tokenAmount.amount;
    const uiAmount = info.tokenAmount.uiAmount;
    const rentLamports = acc.account.lamports;
    const accountPubkey = new PublicKey(acc.pubkey);
    const programLabel = acc.programId === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'Token';

    console.log(`🪙 [${programLabel}] ${mint.slice(0, 20)}... | balance: ${uiAmount} | rent: ${(rentLamports/1e9).toFixed(6)} SOL`);

    // Swap dulu kalau ada balance
    if (rawAmount !== '0' && uiAmount > 0) {
      await new Promise(r => setTimeout(r, 2000));
      const ok = await swapTokenToSol(mint, rawAmount);
      if (ok) swapped++;
      await new Promise(r => setTimeout(r, 3000));
    }

    // Close account
    try {
      const sig = await closeTokenAccount(accountPubkey, acc.programId);
      console.log(`  ✅ Closed! Rent +${(rentLamports/1e9).toFixed(6)} SOL | TX: ${sig.slice(0,20)}...`);
      rentReclaimed += rentLamports;
      closed++;
    } catch (e) {
      console.log(`  ❌ Close failed: ${e.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  await new Promise(r => setTimeout(r, 3000));
  const solAfter = await connection.getBalance(wallet.publicKey);

  console.log('\n═══════════════════════════════════');
  console.log('         SUMMARY');
  console.log('═══════════════════════════════════');
  console.log(`Total accounts    : ${accounts.length}`);
  console.log(`Swapped tokens    : ${swapped}`);
  console.log(`Closed accounts   : ${closed}`);
  console.log(`Failed            : ${failed}`);
  console.log(`Rent reclaimed    : ${(rentReclaimed/1e9).toFixed(6)} SOL`);
  console.log(`SOL sebelum       : ${(solBefore/1e9).toFixed(6)} SOL`);
  console.log(`SOL sesudah       : ${(solAfter/1e9).toFixed(6)} SOL`);
  console.log(`Net gain          : +${((solAfter-solBefore)/1e9).toFixed(6)} SOL`);
  console.log('═══════════════════════════════════');
}

main().catch(console.error);
