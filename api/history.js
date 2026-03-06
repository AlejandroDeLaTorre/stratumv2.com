import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(365, Math.max(1, parseInt(searchParams.get('days') ?? '30')));

  try {
    const sql = neon(process.env.DATABASE_URL);

    const rows = await sql`
      SELECT
        DATE_TRUNC('hour', ts)   AS hour,
        AVG(price_usd)::FLOAT    AS price_usd,
        AVG(price_btc)::FLOAT    AS price_btc,
        AVG(btc_price)::FLOAT    AS btc_price
      FROM hashprice_snapshots
      WHERE ts >= NOW() - (${days} || ' days')::INTERVAL
      GROUP BY hour
      ORDER BY hour ASC
    `;

    return new Response(JSON.stringify({ rows, days }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=300',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ rows: [], days, note: e.message }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
