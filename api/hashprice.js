export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const [priceRes, diffRes, blocksRes] = await Promise.allSettled([
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'),
    fetch('https://blockchain.info/q/getdifficulty'),
    fetch('https://mempool.space/api/blocks'),
  ]);

  const btcPrice   = priceRes.status  === 'fulfilled' ? (await priceRes.value.json()).bitcoin.usd : null;
  const difficulty = diffRes.status   === 'fulfilled' ? parseFloat(await diffRes.value.text())    : null;
  const blocks     = blocksRes.status === 'fulfilled' ? await blocksRes.value.json()              : [];

  if (!btcPrice || !difficulty) {
    return res.status(502).json({ error: 'upstream fetch failed' });
  }

  const avgFeesBTC = blocks.length
    ? blocks.slice(0, 6).reduce((s, b) => s + (b?.extras?.totalFees ?? 0) / 1e8, 0) / Math.min(blocks.length, 6)
    : 0;

  const SUBSIDY  = 3.125;
  const priceUSD = (86400 * (SUBSIDY + avgFeesBTC) * btcPrice * 1e12) / (difficulty * Math.pow(2, 32));

  res.json({
    priceUSD,
    priceBTC:    priceUSD / btcPrice,
    btcPrice,
    difficulty,
    avgFeesBTC,
    timestamp:   new Date().toISOString(),
  });
}
```
