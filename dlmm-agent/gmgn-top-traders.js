import { chromium } from 'playwright';

/**
 * Scrape top 10 holders + avg buy dari GMGN API
 * @param {string} mint - token mint address
 * @returns {Array} top traders list
 */
export async function scrapeGmgnTopTraders(mint) {
  const url = `https://gmgn.ai/sol/token/${mint}`;
  let browser;

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let holderList = null;

    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('gmgn.ai') && u.includes('holder')) {
        try {
          const json = await res.json();
          if (json?.data?.list?.length > 0) {
            holderList = json.data.list;
            console.log(`[GMGN] Caught holder API: ${u.slice(0, 80)}... (${holderList.length} holders)`);
          }
        } catch {}
      }
    });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch {}

    await page.waitForTimeout(8000);

    if (!holderList) {
      console.log('[GMGN] No holder data caught');
      return null;
    }

    // Ambil top 10, filter yang punya balance aktif
    const top10 = holderList
      .filter(h => h.amount_cur > 0)
      .slice(0, 10)
      .map((h, i) => ({
        rank: i + 1,
        address: h.address,
        shortAddr: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : '???',
        balance: h.amount_cur,
        balancePct: parseFloat((h.amount_percentage * 100).toFixed(2)),
        usdValue: h.usd_value,
        avgCostUsd: h.avg_cost,         // avg buy price dalam USD
        avgCostSol: h.cost_cur,         // cost dalam SOL
        realizedPnl: h.realized_profit,
        unrealizedPnl: h.unrealized_profit,
        tags: h.tags || [],
        walletTag: h.wallet_tag_v2 || '',
      }));

    return top10;

  } catch (e) {
    console.error('[GMGN TopTraders] Error:', e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Format top traders jadi pesan Telegram HTML
 */
export function formatTopTradersMsg(traders, symbol) {
  if (!traders || traders.length === 0) return '';

  const fmtUsd = (n) => {
    if (!n || isNaN(n)) return '$0';
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    if (n >= 0.01) return `$${n.toFixed(4)}`;
    if (n >= 0.000001) return `$${n.toFixed(8)}`;
    return `$${n.toExponential(3)}`;
  };

  let msg = `\n👥 <b>Top ${traders.length} Holders — ${symbol}</b>\n`;
  for (const t of traders) {
    const avgBuy = t.avgCostUsd ? fmtUsd(t.avgCostUsd) : 'N/A';
    const usdVal = fmtUsd(t.usdValue);
    const tag = t.walletTag ? ` [${t.walletTag}]` : '';
    msg += `${t.rank}. <code>${t.shortAddr}</code>${tag} | ${t.balancePct}% | Avg Buy: <b>${avgBuy}</b> | Val: ${usdVal}\n`;
  }

  return msg;
}

// ── CLI test langsung ──────────────────────────────────────────
// node gmgn-top-traders.js <mint>
if (process.argv[2]) {
  const mint = process.argv[2];
  console.log(`Scraping top traders for: ${mint}`);
  const traders = await scrapeGmgnTopTraders(mint);
  if (traders) {
    console.log('\n=== TOP 10 HOLDERS ===');
    for (const t of traders) {
      console.log(`${t.rank}. ${t.shortAddr} [${t.walletTag}] | ${t.balancePct}% | Avg Buy: $${t.avgCostUsd ?? 'N/A'} | Val: $${t.usdValue?.toFixed(2)}`);
    }
    console.log('\n=== TELEGRAM FORMAT ===');
    console.log(formatTopTradersMsg(traders, 'TEST').replace(/<[^>]+>/g, ''));
  }
}
