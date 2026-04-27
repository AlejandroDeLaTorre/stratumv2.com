#!/usr/bin/env node
// scan-jd-blocks.js
// Run by GitHub Actions every 6h (alongside the existing snapshot step).
// Walks recent Bitcoin blocks, classifies DMND ones via shared detect-dmnd.js,
// and inserts/upserts into the `jd_blocks` Neon table.
//
// Strategy:
//   - High-water mark = MAX(height) in jd_blocks (NULL on first run).
//   - Scan window = max(highWater - LOOKBACK + 1, tip - INITIAL_DEPTH) .. tip - CONFIRM_DEPTH.
//     (LOOKBACK gives reorg coverage on the trailing edge; CONFIRM_DEPTH avoids tip churn.)
//   - ON CONFLICT (height, block_hash) DO NOTHING — orphans naturally coexist.
//
// Env:
//   DATABASE_URL          (Neon Postgres connection string)
//   MEMPOOL_BASE          (default https://mempool.space)
//   SCAN_LOOKBACK         (default 50)
//   SCAN_CONFIRM_DEPTH    (default 3)
//   SCAN_INITIAL_DEPTH    (default 1000)  // first run, when table is empty

'use strict';

const { Client } = require('pg');
const { detectDmnd } = require('../lib/detect-dmnd');

const MEMPOOL_BASE       = process.env.MEMPOOL_BASE       || 'https://mempool.space';
const LOOKBACK           = parseInt(process.env.SCAN_LOOKBACK || '50', 10);
const CONFIRM_DEPTH      = parseInt(process.env.SCAN_CONFIRM_DEPTH || '3', 10);
const INITIAL_DEPTH      = parseInt(process.env.SCAN_INITIAL_DEPTH || '1000', 10);
const SUBSIDY_HALVENING  = 210000;

function currentSubsidyBtc(height) {
  const era = Math.floor(height / SUBSIDY_HALVENING);
  if (era >= 64) return 0;
  return 50 / Math.pow(2, era);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'accept': 'text/plain' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${r.statusText}`);
  return r.text();
}

async function getTipHeight() {
  return parseInt(await fetchText(`${MEMPOOL_BASE}/api/blocks/tip/height`), 10);
}
async function getBlockHash(height) {
  return (await fetchText(`${MEMPOOL_BASE}/api/block-height/${height}`)).trim();
}
async function getBlock(hash) {
  // includes extras: { reward, totalFees, feeRange, pool, ... } and tx_count, timestamp
  return fetchJson(`${MEMPOOL_BASE}/api/v1/block/${hash}`);
}
async function getCoinbaseScriptsig(hash) {
  // /api/v1/block/:hash/txs/0 returns the coinbase tx as the first element of an array
  const txs = await fetchJson(`${MEMPOOL_BASE}/api/v1/block/${hash}/txs/0`);
  const coinbase = Array.isArray(txs) ? txs[0] : txs;
  return coinbase && coinbase.vin && coinbase.vin[0] && coinbase.vin[0].scriptsig
    ? coinbase.vin[0].scriptsig
    : null;
}

async function processHeight(client, height) {
  const hash = await getBlockHash(height);
  const block = await getBlock(hash);
  const scriptsig = await getCoinbaseScriptsig(hash);

  const detection = detectDmnd(scriptsig);
  if (!detection) return { height, hash, hit: false };

  const subsidyBtc = currentSubsidyBtc(height);
  const feesBtc = (block.extras && typeof block.extras.totalFees === 'number')
    ? block.extras.totalFees / 1e8
    : null;
  const totalBtc = feesBtc !== null ? subsidyBtc + feesBtc : null;

  const minedAt = new Date((block.timestamp || 0) * 1000);

  await client.query(
    `INSERT INTO jd_blocks
       (height, block_hash, mined_at, is_jd, miner_name,
        fees_btc, subsidy_btc, total_btc, tx_count, coinbase_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (height, block_hash) DO NOTHING`,
    [
      height, hash, minedAt,
      detection.type === 'jd',
      detection.miner,
      feesBtc, subsidyBtc, totalBtc,
      block.tx_count || null,
      scriptsig,
    ]
  );

  return { height, hash, hit: true, type: detection.type, miner: detection.miner };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const tip = await getTipHeight();
    const { rows } = await client.query('SELECT MAX(height)::bigint AS h FROM jd_blocks');
    const highWater = rows[0] && rows[0].h !== null ? Number(rows[0].h) : null;

    const upper = tip - CONFIRM_DEPTH;
    const lower = highWater === null
      ? upper - INITIAL_DEPTH + 1
      : Math.min(upper, highWater - LOOKBACK + 1);

    if (lower > upper) {
      console.log(`No range to scan (lower=${lower} > upper=${upper}). Tip=${tip}.`);
      return;
    }

    console.log(`Scanning heights ${lower}..${upper} (tip=${tip}, highWater=${highWater})`);

    let dmnd = 0, jd = 0;
    for (let h = lower; h <= upper; h++) {
      try {
        const r = await processHeight(client, h);
        if (r.hit) {
          dmnd++;
          if (r.type === 'jd') jd++;
          console.log(`  hit ${h} ${r.type}${r.miner ? ' miner=' + r.miner : ''}`);
        }
      } catch (e) {
        console.error(`  err ${h}: ${e.message}`);
      }
    }

    console.log(`Done. Range=${upper - lower + 1} blocks, DMND=${dmnd} (JD=${jd}, non-JD=${dmnd - jd}).`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
