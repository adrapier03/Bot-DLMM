import { chromium } from 'playwright';
import dotenv from 'dotenv';
dotenv.config();

const COOKIE_VALUE = process.env.COOKIN_COOKIE || '';
const COOKIN_URL = 'https://cookin.fun';

let browser = null;
let context = null;

async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    context = await browser.newContext();
    if (COOKIE_VALUE) {
      await context.addCookies([{
        name: '_pump_key',
        value: COOKIE_VALUE,
        domain: 'cookin.fun',
        path: '/',
      }]);
    }
    console.log('[Cookin] Browser initialized');
  }
  return context;
}

export async function closeBrowser() {
  if (browser) { await browser.close(); browser = null; context = null; }
}

export async function scrapeCookinToken(mint) {
  if (!COOKIE_VALUE) return null;
  try {
    const ctx = await initBrowser();
    const page = await ctx.newPage();
    await page.goto(`${COOKIN_URL}/token/${mint}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(3000);
    const text = await page.evaluate(() => document.body.innerText);
    await page.close();
    return parseCookinData(text, mint);
  } catch (e) {
    console.error(`[Cookin] Scrape error for ${mint.slice(0,20)}:`, e.message);
    return null;
  }
}

function pf(str) {
  if (str === null || str === undefined) return null;
  const n = parseFloat(str.toString().replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function parseCookinData(text, mint) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const getPct = (keyword) => {
    const idx = lines.findIndex(l => l.toLowerCase().startsWith(keyword.toLowerCase()));
    if (idx === -1) return null;
    for (let i = idx; i <= idx + 2; i++) {
      const m = (lines[i] || '').match(/(\d+\.?\d*)%/);
      if (m) return parseFloat(m[1]);
    }
    return null;
  };

  // Score
  const scoreIdx = lines.findIndex(l => l.startsWith('Score:'));
  const score = scoreIdx !== -1 ? pf(lines[scoreIdx].replace('Score:', '').trim()) : null;

  // Pump/Dump conditions
  const pumpMatch = text.match(/Pump Conditions \((\d+)\/(\d+)\)/);
  const dumpMatch = text.match(/Dump Conditions \((\d+)\/(\d+)\)/);
  const pumpMet   = pumpMatch ? parseInt(pumpMatch[1]) : null;
  const pumpTotal = pumpMatch ? parseInt(pumpMatch[2]) : null;
  const dumpMet   = dumpMatch ? parseInt(dumpMatch[1]) : null;
  const dumpTotal = dumpMatch ? parseInt(dumpMatch[2]) : null;

  // Per-metric
  const dumpers    = getPct('Dumpers:');
  const dirty      = getPct('Dirty:');
  const bundle     = getPct('Bundle:');
  const alphaHands = getPct('AlphaHands:');
  const inProfit   = getPct('InProfit:');
  const bots       = getPct('Bots:');
  const nuke       = getPct('Nuke:');       // Sell Impact → Nuke
  const jeets      = getPct('Jeets:');

  // Top 10 holders %
  const top10Match = text.match(/Top 10\s*([\d.]+)%/);
  const top10pct   = top10Match ? parseFloat(top10Match[1]) : null;

  // Sell Impact = Nuke% (dominan)
  const sellImpact = nuke;

  // Hold <1min
  const hold1minMatch = text.match(/< 1min:\s*([\d.]+)%/);
  const holdUnder1min = hold1minMatch ? parseFloat(hold1minMatch[1]) : null;

  // Conviction & Smart Wallets
  const convIdx   = lines.findIndex(l => l.startsWith('Conviction:'));
  const conviction = convIdx !== -1 ? pf(lines[convIdx].replace('Conviction:', '').trim()) : null;
  const swIdx      = lines.findIndex(l => l.startsWith('Smart Wallets:'));
  const smartWallets = swIdx !== -1 ? parseInt(lines[swIdx].replace('Smart Wallets:', '').trim()) : null;

  // Top 3 holders
  const top3idx  = lines.findIndex(l => l === 'Top 3');
  const top3pct  = top3idx !== -1 ? pf(lines[top3idx + 1]) : null;

  // ─── Rating per metric (dari tabel Rafi) ───────────────────────────────
  //  Metric     | Bullish      | Neutral      | Bearish
  //  Bundles    | <40%         | 40-60%       | >60%
  //  Dirty      | <50%         | 50-70%       | >70%
  //  Dumpers    | <25%         | 25-35%       | >35%
  //  Alpha      | >45%         | 30-45%       | <30%
  //  In Profit  | >60%         | 40-60%       | <40%
  //  Top 10     | <30%         | 30-35%       | >35%
  //  Sell Impact| <10%         | 10-12%       | >12%
  // ──────────────────────────────────────────────────────────────────────

  function rateMetric(name, val) {
    if (val === null) return { name, val: null, rating: 'unknown' };
    let rating;
    switch (name) {
      case 'bundle':
        rating = val < 40 ? 'bullish' : val <= 60 ? 'neutral' : 'bearish'; break;
      case 'dirty':
        rating = val < 50 ? 'bullish' : val <= 70 ? 'neutral' : 'bearish'; break;
      case 'dumpers':
        rating = val < 40 ? 'bullish' : val <= 70 ? 'neutral' : 'bearish'; break;
      case 'alphaHands':
        rating = val > 40 ? 'bullish' : val >= 25 ? 'neutral' : 'bearish'; break;
      case 'inProfit':
        rating = val > 60 ? 'bullish' : val >= 40 ? 'neutral' : 'bearish'; break;
      case 'top10':
        rating = val < 30 ? 'bullish' : val <= 35 ? 'neutral' : 'bearish'; break;
      case 'sellImpact':
        rating = val < 10 ? 'bullish' : val <= 12 ? 'neutral' : 'bearish'; break;
      default:
        rating = 'unknown';
    }
    return { name, val, rating };
  }

  const ratings = {
    bundle:     rateMetric('bundle', bundle),
    dirty:      rateMetric('dirty', dirty),
    dumpers:    rateMetric('dumpers', dumpers),
    alphaHands: rateMetric('alphaHands', alphaHands),
    inProfit:   rateMetric('inProfit', inProfit),
    top10:      rateMetric('top10', top10pct),
    sellImpact: rateMetric('sellImpact', sellImpact),
  };

  const bullishCount = Object.values(ratings).filter(r => r.rating === 'bullish').length;
  const bearishCount = Object.values(ratings).filter(r => r.rating === 'bearish').length;
  const unknownCount = Object.values(ratings).filter(r => r.rating === 'unknown').length;
  const totalRated   = 7 - unknownCount;

  // Overall signal
  let overallSignal;
  if (bearishCount >= 4)                            overallSignal = '🔴 BEARISH';
  else if (bullishCount >= 5)                       overallSignal = '🟢 BULLISH';
  else if (bullishCount >= 3 && bearishCount <= 2)  overallSignal = '🟡 NEUTRAL-BULL';
  else                                              overallSignal = '🟡 NEUTRAL';

  const emoji = { bullish: '🟢', neutral: '🟡', bearish: '🔴', unknown: '⚪' };

  const result = {
    mint,
    score, pumpMet, pumpTotal, dumpMet, dumpTotal,
    dumpers, dirty, bundle, alphaHands, inProfit,
    bots, jeets, nuke, sellImpact,
    holdUnder1min, conviction, smartWallets,
    top3pct, top10pct,
    ratings, bullishCount, bearishCount, overallSignal,
  };

  // Log ringkas
  const rStr = Object.entries(ratings)
    .map(([k, r]) => `${emoji[r.rating]}${k}=${r.val !== null ? r.val+'%' : 'N/A'}`)
    .join(' ');

  console.log(`[Cookin] ${mint.slice(0,20)}... Score=${score} Pump=${pumpMet}/${pumpTotal} Dump=${dumpMet}/${dumpTotal}`);
  console.log(`[Cookin] ${overallSignal} | Bull=${bullishCount} Bear=${bearishCount} | ${rStr}`);

  return result;
}

// ─── Filter: return true jika LAYAK dibuka posisi ──────────────────────────
export function passCookinFilter(data) {
  if (!data) return { pass: true, reasons: [] }; // gagal scrape → jangan block

  const reasons = [];

  // Reject jika semua metrik N/A (token belum ter-index di Cookin)
  const r = data.ratings;
  const allUnknown = Object.values(r).every(m => m.rating === 'unknown' || m.val === null);
  if (allUnknown) {
    reasons.push(`Semua metrik N/A — token belum ter-index di Cookin.fun`);
    console.log(`[Cookin] ❌ REJECT: Semua metrik N/A`);
    return { pass: false, reasons };
  }

  // Syarat utama: Harus maksimal 2 sinyal merah (bearish max 2)
  if (data.bearishCount > 2) {
    reasons.push(`Terlalu banyak bearish/merah (${data.bearishCount}/7)`);
  }

  // SEMUA HARD REJECT DISINI SUDAH DIMATIKAN SESUAI REQUEST
  // Termasuk Bundle > 70%, Dumpers > 80%, dll 
  // Sekarang murni ikut rule "minimal 3 merah baru reject"

  if (reasons.length > 0) {
    console.log(`[Cookin] ❌ REJECT: ${reasons.join(' | ')}`);
    return { pass: false, reasons };
  }

  console.log(`[Cookin] ✅ PASS — ${data.overallSignal}`);
  return { pass: true, reasons: [] };
}

// ─── Format ringkas untuk Telegram ────────────────────────────────────────
export function formatCookinSummary(data) {
  if (!data) return '';
  const emoji = { bullish: '🟢', neutral: '🟡', bearish: '🔴', unknown: '⚪' };
  const r = data.ratings;
  return (
    `\n📊 <b>Cookin.fun</b> — ${data.overallSignal}\n` +
    `Score: ${data.score ?? 'N/A'} | Pump: ${data.pumpMet}/${data.pumpTotal} | Dump: ${data.dumpMet}/${data.dumpTotal}\n` +
    `${emoji[r.bundle.rating]}Bundle: ${r.bundle.val ?? 'N/A'}%  ` +
    `${emoji[r.dirty.rating]}Dirty: ${r.dirty.val ?? 'N/A'}%  ` +
    `${emoji[r.dumpers.rating]}Dumpers: ${r.dumpers.val ?? 'N/A'}%\n` +
    `${emoji[r.alphaHands.rating]}Alpha: ${r.alphaHands.val ?? 'N/A'}%  ` +
    `${emoji[r.inProfit.rating]}InProfit: ${r.inProfit.val ?? 'N/A'}%  ` +
    `${emoji[r.top10.rating]}Top10: ${r.top10.val ?? 'N/A'}%\n` +
    `${emoji[r.sellImpact.rating]}SellImpact: ${r.sellImpact.val ?? 'N/A'}%  ` +
    `Bots: ${data.bots ?? 'N/A'}%  Hold&lt;1m: ${data.holdUnder1min ?? 'N/A'}%`
  );
}
