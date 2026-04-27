import { Pool } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method Not Allowed');

  const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 500);
  const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);
  const filterRaw = req.query.filter || 'all';
  const filter = ['jd', 'nonjd', 'all'].includes(filterRaw) ? filterRaw : 'all';

  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL not configured' });

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const where = filter === 'jd' ? 'WHERE is_jd = TRUE' : filter === 'nonjd' ? 'WHERE is_jd = FALSE' : '';
    const [statsRes, blocksRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE is_jd)::bigint AS jd, COUNT(*) FILTER (WHERE NOT is_jd)::bigint AS nonjd, MAX(height)::bigint AS latest_height, MAX(mined_at) AS latest_at, COALESCE(SUM(fees_btc),0)::numeric AS total_fees_btc, COALESCE(SUM(total_btc),0)::numeric AS total_btc, COALESCE(SUM(fees_btc) FILTER (WHERE is_jd),0)::numeric AS jd_fees_btc FROM jd_blocks`),
      pool.query(`SELECT height, block_hash, mined_at, is_jd, miner_name, fees_btc, subsidy_btc, total_btc, tx_count FROM jd_blocks ${where} ORDER BY height DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    ]);
    const s = statsRes.rows[0] || {};
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      stats: { total: Number(s.total||0), jd: Number(s.jd||0), nonjd: Number(s.nonjd||0), jdShare: Number(s.total)>0 ? Number(s.jd)/Number(s.total) : 0, latestHeight: s.latest_height!==null ? Number(s.latest_height) : null, latestAt: s.latest_at, totalFeesBtc: Number(s.total_fees_btc||0), totalBtc: Number(s.total_btc||0), jdFeesBtc: Number(s.jd_fees_btc||0) },
      blocks: blocksRes.rows.map(b => ({ height: Number(b.height), hash: b.block_hash, minedAt: b.mined_at, isJd: b.is_jd, miner: b.miner_name, feesBtc: b.fees_btc!==null?Number(b.fees_btc):null, subsidyBtc: b.subsidy_btc!==null?Number(b.subsidy_btc):null, totalBtc: b.total_btc!==null?Number(b.total_btc):null, txCount: b.tx_count!==null?Number(b.tx_count):null })),
      pagination: { limit, offset, filter },
    });
  } catch(e) { return res.status(500).json({ error: e.message }); }
  finally { try { await pool.end(); } catch {} }
}