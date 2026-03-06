export const config = { runtime: 'edge' };

// Neon serverless HTTP endpoint — no pg driver needed in Edge runtime
// Docs: https://neon.tech/docs/serverless/serverless-driver
async function sql(query, params = []) {
  const res = await fetch(process.env.NEON_HTTP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${btoa(process.env.NEON_CREDENTIALS)}`,
      'Neon-Connection-String': process.env.DATABASE_URL,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Neon HTTP error ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Fetch live hashprice from our proxy
  const base = new URL(req.url).origin;
  const hp = await fetch(`${base}/api/hashprice`).then(r => r.json());

  // Ensure table exists (idempotent)
  await sql(`
    CREATE TABLE IF NOT EXISTS hashprice_snapshots (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      price_usd  NUMERIC(18,10) NOT NULL,
      price_btc  NUMERIC(18,14) NOT NULL,
      btc_price  NUMERIC(12,2)  NOT NULL,
      difficulty NUMERIC(20,0)  NOT NULL,
      fees_btc   NUMERIC(10,6)  NOT NULL DEFAULT 0
    )
  `);

  await sql(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON hashprice_snapshots (ts DESC)`);

  // Insert snapshot
  const result = await sql(
    `INSERT INTO hashprice_snapshots (price_usd, price_btc, btc_price, difficulty, fees_btc)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, ts`,
    [hp.priceUSD, hp.priceBTC, hp.btcPrice, hp.difficulty, hp.avgFeesBTC ?? 0]
  );

  return new Response(JSON.stringify({ ok: true, row: result.rows?.[0], hp }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
