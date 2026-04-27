// Cloudflare Pages Function: GET /api/jd-blocks
// Returns: { stats, blocks, pagination }
//
// Query params:
//   limit  (default 50, max 500)
//   offset (default 0)
//   filter (jd | nonjd | all - default all)

import { Pool } from '@neondatabase/serverless';

export const onRequestGet = async ({ request, env }) => {
  const url = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50',  10), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0',   10), 0);
  const filterRaw = url.searchParams.get('filter') || 'all';
  const filter = ['jd', 'nonjd', 'all'].includes(filterRaw) ? filterRaw : 'all';

  if (!env.DATABASE_URL) {
    return json({ error: 'DATABASE_URL not configured' }, 500);
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    const where =
      filter === 'jd'    ? 'WHERE is_jd = TRUE'  :
      filter === 'nonjd' ? 'WHERE is_jd = FALSE' :
                           '';

    const statsQ = pool.query(`
      SELECT
        COUNT(*)::bigint                                            AS total,
        COUNT(*) FILTER (WHERE is_jd)::bigint                       AS jd,
        COUNT(*) FILTER (WHERE NOT is_jd)::bigint                   AS nonjd,
        MAX(height)::bigint                                         AS latest_height,
        MAX(mined_at)                                               AS latest_at,
        COALESCE(SUM(fees_btc), 0)::numeric                         AS total_fees_btc,
        COALESCE(SUM(total_btc), 0)::numeric                        AS total_btc,
        COALESCE(SUM(fees_btc) FILTER (WHERE is_jd), 0)::numeric    AS jd_fees_btc
      FROM jd_blocks
    `);

    const blocksQ = pool.query(
      `SELECT height, block_hash, mined_at, is_jd, miner_name,
              fees_btc, subsidy_btc, total_btc, tx_count
         FROM jd_blocks
         ${where}
         ORDER BY height DESC
         LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const [statsRes, blocksRes] = await Promise.all([statsQ, blocksQ]);
    const s = statsRes.rows[0] || {};

    return json({
      stats: {
        total:         Number(s.total || 0),
        jd:            Number(s.jd || 0),
        nonjd:         Number(s.nonjd || 0),
        jdShare:       Number(s.total) > 0 ? Number(s.jd) / Number(s.total) : 0,
        latestHeight:  s.latest_height !== null ? Number(s.latest_height) : null,
        latestAt:      s.latest_at,
        totalFeesBtc:  Number(s.total_fees_btc || 0),
        totalBtc:      Number(s.total_btc || 0),
        jdFeesBtc:     Number(s.jd_fees_btc || 0),
      },
      blocks: blocksRes.rows.map((b) => ({
        height:     Number(b.height),
        hash:       b.block_hash,
        minedAt:    b.mined_at,
        isJd:       b.is_jd,
        miner:      b.miner_name,
        feesBtc:    b.fees_btc !== null ? Number(b.fees_btc) : null,
        subsidyBtc: b.subsidy_btc !== null ? Number(b.subsidy_btc) : null,
        totalBtc:   b.total_btc !== null ? Number(b.total_btc) : null,
        txCount:    b.tx_count !== null ? Number(b.tx_count) : null,
      })),
      pagination: { limit, offset, filter },
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  } finally {
    // Pool cleanup is implicit on the worker; pool.end() optional.
    try { await pool.end(); } catch {}
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}
