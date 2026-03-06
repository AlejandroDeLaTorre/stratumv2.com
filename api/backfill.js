import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const SUBSIDY = 3.125;

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 1. Fetch 90-day BTC price history from CoinGecko
    // Returns [[timestamp_ms, price], ...]
    const cgRes = await fetch(
      'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90&interval=daily'
    );
    if (!cgRes.ok) throw new Error(`CoinGecko ${cgRes.status}`);
    const { prices: cgPrices } = await cgRes.json();

    // 2. Fetch historical difficulty from mempool.space (3m = ~90 days)
    const mpRes = await fetch('https://mempool.space/api/v1/mining/hashrate/3m');
    if (!mpRes.ok) throw new Error(`mempool.space ${mpRes.status}`);
    const { difficulty: diffHistory } = await mpRes.json();
    // diffHistory: [{ timestamp, difficulty, height }, ...]

    if (!cgPrices?.length || !diffHistory?.length) {
      throw new Error('Empty data from upstream APIs');
    }

    // 3. Build a difficulty map by day (use nearest difficulty for each day)
    // diffHistory entries are per-adjustment (~2 weeks apart), interpolate between them
    const diffMap = {};
    for (let i = 0; i < diffHistory.length; i++) {
      const entry = diffHistory[i];
      const next  = diffHistory[i + 1];
      const startDay = Math.floor(entry.time / 86400);
      const endDay   = next ? Math.floor(next.time / 86400) : startDay + 14;
      for (let d = startDay; d < endDay; d++) {
        diffMap[d] = entry.difficulty;
      }
    }

    // 4. Build daily rows — one per day from cgPrices
    const rows = [];
    for (const [tsMs, btcPrice] of cgPrices) {
      const dayKey   = Math.floor(tsMs / 86400_000);
      const difficulty = diffMap[dayKey] || diffMap[dayKey - 1] || diffMap[dayKey + 1];
      if (!difficulty || !btcPrice) continue;

      const ts       = new Date(tsMs).toISOString();
      const priceUSD = (86400 * SUBSIDY * btcPrice * 1e12) / (difficulty * Math.pow(2, 32));
      const priceBTC = priceUSD / btcPrice;

      rows.push({ ts, priceUSD, priceBTC, btcPrice, difficulty, fees_btc: 0 });
    }

    if (!rows.length) throw new Error('No rows to insert');

    // 5. Insert into Neon, skip duplicates by checking existing ts range
    const sql = neon(process.env.DATABASE_URL);

    // Delete any existing backfill data older than 2 days ago (keep recent live snapshots)
    await sql`
      DELETE FROM hashprice_snapshots
      WHERE ts < NOW() - INTERVAL '2 days'
      AND fees_btc = 0
    `;

    // Bulk insert all rows
    let inserted = 0;
    for (const r of rows) {
      await sql`
        INSERT INTO hashprice_snapshots (ts, price_usd, price_btc, btc_price, difficulty, fees_btc)
        VALUES (${r.ts}, ${r.priceUSD}, ${r.priceBTC}, ${r.btcPrice}, ${r.difficulty}, ${r.fees_btc})
        ON CONFLICT DO NOTHING
      `;
      inserted++;
    }

    return new Response(JSON.stringify({
      ok: true,
      inserted,
      days: rows.length,
      sample: rows[0],
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
