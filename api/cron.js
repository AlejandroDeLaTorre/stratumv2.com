export const config = { runtime: 'edge' };

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID  = process.env.TELEGRAM_CHANNEL_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const V1_REJECT = 0.0047;
const V2_REJECT = 0.000151;

function fmtUSD(v) {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '' : '-';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(3) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(2) + 'k';
  return sign + '$' + abs.toFixed(2);
}

function minerLine(name, wth, hashTH, hp, powerCost) {
  const netPerTH      = hp * (1 - V2_REJECT) - (wth / 1000 * 24 * powerCost);
  const netPerMachine = netPerTH * hashTH;
  const v2Extra       = (V1_REJECT - V2_REJECT) * hp * hashTH;
  const status        = netPerMachine > 0 ? '✅' : '❌';
  return `${status} <b>${name}</b> (${hashTH}T): ${fmtUSD(netPerMachine)}/day  💚 +${fmtUSD(v2Extra)} vs V1`;
}

const MINERS = [
  { name: 'S21 XP+ Hyd',          wth: 11.0, hashTH: 500 },
  { name: 'S21 XP Hyd',           wth: 12.0, hashTH: 473 },
  { name: 'S21 Hydro',            wth: 16.0, hashTH: 335 },
  { name: 'S21 XP',               wth: 13.5, hashTH: 270 },
  { name: 'S21 Pro',              wth: 15.0, hashTH: 234 },
  { name: 'S19j Pro',             wth: 29.5, hashTH: 104 },
  { name: 'SealMiner A2 Pro Hyd', wth: 14.9, hashTH: 500 },
  { name: 'SealMiner A2 Pro Air', wth: 14.9, hashTH: 265 },
  { name: 'M66S++',               wth: 15.5, hashTH: 348 },
  { name: 'M66S+',                wth: 17.0, hashTH: 318 },
  { name: 'M63S Hydro',           wth: 18.5, hashTH: 390 },
];

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  let hp;
  try {
    const res = await fetch('https://stratumv2.com/api/hashprice');
    if (!res.ok) throw new Error(`hashprice API ${res.status}`);
    hp = await res.json();
  } catch (e) {
    return new Response(`Failed to fetch hashprice: ${e.message}`, { status: 500 });
  }

  const POWER     = 0.05;
  const hpPerPH   = hp.priceUSD * 1000;
  const v1Cost100 = hp.priceUSD * V1_REJECT * 100 * 1000;
  const v2Cost100 = hp.priceUSD * V2_REJECT * 100 * 1000;
  const saving    = v1Cost100 - v2Cost100;
  const monthly   = saving * 30;
  const yearly    = saving * 365;

  const minerLines = MINERS
    .map(m => minerLine(m.name, m.wth, m.hashTH, hp.priceUSD, POWER))
    .join('\n');

  const now = new Date().toUTCString().replace(/:\d{2} GMT/, ' UTC');

  const msg = [
    `⛏ <b>HASHPRICE UPDATE</b> — ${now}`,
    ``,
    `💰 <b>$${hp.priceUSD.toFixed(6)}</b> / TH / day`,
    `💰 <b>$${hpPerPH.toFixed(4)}</b> / PH / day`,
    `₿ ${hp.priceBTC.toFixed(10)} BTC / TH / day`,
    `📊 BTC: <b>$${hp.btcPrice.toLocaleString()}</b>`,
    ``,
    `<b>V1 vs V2 @ 100 PH/s ($0.05/kWh)</b>`,
    `  V1 stale cost: ${fmtUSD(v1Cost100)}/day`,
    `  V2 stale cost: ${fmtUSD(v2Cost100)}/day`,
    `  💚 V2 saves: <b>${fmtUSD(saving)}/day · ${fmtUSD(monthly)}/mo · ${fmtUSD(yearly)}/yr</b>`,
    ``,
    `<b>Per Machine @ $0.05/kWh — net profit + V2 upside</b>`,
    minerLines,
    ``,
    `📈 <a href="https://stratumv2.com">stratumv2.com</a>`,
  ].join('\n');

  const tgRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    }
  );

  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    return new Response(`Telegram error: ${JSON.stringify(tgJson)}`, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, hashprice: hp.priceUSD, saved: saving }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
