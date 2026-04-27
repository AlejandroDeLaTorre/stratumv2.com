#!/usr/bin/env node
// backfill-jd-blocks.js
// One-shot history backfill. Run locally or as a manual GitHub Actions dispatch.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/backfill-jd-blocks.js --from 850000 [--to 870000]
//
// --from is required. --to defaults to current tip - CONFIRM_DEPTH (3).

'use strict';

const { Client } = require('pg');
const { detectDmnd } = require('../lib/detect-dmnd');

const MEMPOOL_BASE  = process.env.MEMPOOL_BASE || 'https://mempool.space';
const CONFIRM_DEPTH = parseInt(process.env.SCAN_CONFIRM_DEPTH || '3', 10);
const HALVENING    = 210000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function subsidyBtc(h) {
  const era = Math.floor(h / HALVENING);
  return era >= 64 ? 0 : 50 / Math.pow(2, era);
}
async function fJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); }
async function fText(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.text(); }

async function main() {
  const from = parseInt(arg('--from'), 10);
  if (!from) throw new Error('--from <height> required');
  const tip = parseInt(await fText(`${MEMPOOL_BASE}/api/blocks/tip/height`), 10);
  const to  = parseInt(arg('--to') || (tip - CONFIRM_DEPTH), 10);
  if (to < from) throw new Error(`--to (${to}) < --from (${from})`);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log(`Backfilling heights ${from}..${to} (${to - from + 1} blocks)`);
  let scanned = 0, dmnd = 0, jd = 0;
  try {
    for (let h = from; h <= to; h++) {
      try {
        const hash = (await fText(`${MEMPOOL_BASE}/api/block-height/${h}`)).trim();
        const block = await fJson(`${MEMPOOL_BASE}/api/v1/block/${hash}`);
        const txs = await fJson(`${MEMPOOL_BASE}/api/v1/block/${hash}/txs/0`);
        const cb = Array.isArray(txs) ? txs[0] : txs;
        const ss = cb && cb.vin && cb.vin[0] && cb.vin[0].scriptsig;

        const det = detectDmnd(ss);
        scanned++;
        if (!det) continue;

        const sub = subsidyBtc(h);
        const fees = (block.extras && typeof block.extras.totalFees === 'number')
          ? block.extras.totalFees / 1e8
          : null;
        const total = fees !== null ? sub + fees : null;

        await client.query(
          `INSERT INTO jd_blocks
             (height, block_hash, mined_at, is_jd, miner_name,
              fees_btc, subsidy_btc, total_btc, tx_count, coinbase_raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (height, block_hash) DO NOTHING`,
          [h, hash, new Date((block.timestamp || 0) * 1000),
           det.type === 'jd', det.miner,
           fees, sub, total, block.tx_count || null, ss],
        );
        dmnd++;
        if (det.type === 'jd') jd++;
        if (dmnd % 5 === 0) console.log(`  ... h=${h} dmnd=${dmnd} jd=${jd}`);
      } catch (e) {
        console.error(`  err ${h}: ${e.message}`);
      }
    }
  } finally {
    await client.end();
  }
  console.log(`Done. Scanned=${scanned}, DMND=${dmnd}, JD=${jd}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
