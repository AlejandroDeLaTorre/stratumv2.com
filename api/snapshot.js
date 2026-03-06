import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch live hashprice
    const base = new URL(req.url).origin;
    const hp = await fetch(`${base}/api/hashprice`).then(r => r.json());

    const sql = neon(process.env.DATABASE_URL);

    // Ensure table exists
    await sql`
      CREATE TABLE IF NOT EXISTS hashprice_snapshots (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        price_usd  NUMERIC(18,10) NOT NULL,
        price_btc  NUMERIC(18,14) NOT NULL,
        btc_price  NUMERIC(12,2)  NOT NULL,
        difficulty NUMERIC(20,0)  NOT NULL,
        fees_btc   NUMERIC(10,6)  NOT NULL DEFAULT 0
      )
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON hashprice_snapshots (ts DESC)`;

    // Insert snapshot
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
