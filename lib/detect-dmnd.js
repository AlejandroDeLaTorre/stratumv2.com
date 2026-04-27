// detect-dmnd.js
// Single source of truth for "is this a DMND block, and was it Job-Declared?"
// Consumed by:
//   - stratumv2.com scan-jd-blocks.js  (writes to Neon)
//   - dmnd-twitter-bot                 (decides whether to tweet as a JD block)
//
// Coinbase scriptsig conventions:
//   /DMND/<miner_name>/   ->  JD block (pool's miners selected the txs)
//   DDxDD                  ->  non-JD block (pool selected the txs)
//   anything else          ->  not DMND
//
// Detection runs on the raw coinbase scriptsig hex from mempool.space:
//   GET https://mempool.space/api/v1/block/<hash>/txs/0  -> .vin[0].scriptsig

'use strict';

const JD_HEX     = '2f444d4e442f';   // "/DMND/"
const NONJD_HEX  = '4444784444';     // "DDxDD"

function hexToPrintableAscii(hex) {
  if (!hex) return '';
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.substr(i, 2), 16);
    if (Number.isNaN(code)) continue;
    s += (code >= 0x20 && code <= 0x7e) ? String.fromCharCode(code) : '\x00';
  }
  return s;
}

/**
 * Classify a coinbase scriptsig.
 * @param {string} coinbaseHex  - hex string of the coinbase scriptsig
 * @returns {null | { type: 'jd', miner: string|null } | { type: 'nonjd', miner: null }}
 */
function detectDmnd(coinbaseHex) {
  if (!coinbaseHex || typeof coinbaseHex !== 'string') return null;
  const hex = coinbaseHex.toLowerCase();

  if (hex.includes(JD_HEX)) {
    // Extract miner name between /DMND/ and the next /
    const ascii = hexToPrintableAscii(hex);
    const m = ascii.match(/\/DMND\/([^\/\x00]*)\//);
    return { type: 'jd', miner: m && m[1] ? m[1] : null };
  }

  if (hex.includes(NONJD_HEX)) {
    return { type: 'nonjd', miner: null };
  }

  return null;
}

module.exports = { detectDmnd, hexToPrintableAscii, JD_HEX, NONJD_HEX };
