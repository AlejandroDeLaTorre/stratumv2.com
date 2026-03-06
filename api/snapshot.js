import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const base = new URL(req.url).origin;
    const hp = await fetch(`${base}/api/hashprice`).then(r => r.json());

    if (!hp.priceUSD) throw new Error('hashprice fetch failed');

    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`
      INSERT INTO hashprice_snapshots (price_usd, price_btc, btc_price, difficulty, fees_btc)
      VALUES (${hp.priceUSD}, ${hp.priceBTC}, ${hp.btcPrice}, ${hp.difficulty}, ${hp.avgFeesBTC ?? 0})
      RETURNING id, ts
    `;

    return new Response(JSON.stringify({ ok: true, row: rows[0], hp }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
