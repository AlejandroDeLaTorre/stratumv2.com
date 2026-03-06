import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

function esc(str) {
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export default async function handler(req) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch current difficulty adjustment info from mempool.space
    const mpRes = await fetch('https://mempool.space/api/v1/difficulty-adjustment');
    if (!mpRes.ok) throw new Error(`mempool ${mpRes.status}`);
    const da = await mpRes.json();

    // da.previousRetarget = % change of last adjustment
    // da.progressPercent  = how far through current epoch we are
    // da.remainingBlocks  = blocks until next adjustment
    // da.difficultyChange = estimated next adjustment %

    // Check Neon for the last recorded difficulty
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT difficulty, ts FROM hashprice_snapshots
      ORDER BY ts DESC LIMIT 2
    `;

    if (rows.length < 2) {
      return new Response(JSON.stringify({ ok: true, skipped: 'not enough data' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const latestDiff = parseFloat(rows[0].difficulty);
    const prevDiff   = parseFloat(rows[1].difficulty);
    const diffChange = ((latestDiff - prevDiff) / prevDiff) * 100;

    // Only alert if difficulty changed by more than 1% between snapshots
    // (real adjustments are typically 1-10%)
    if (Math.abs(diffChange) < 1.0) {
      return new Response(JSON.stringify({ ok: true, skipped: 'no adjustment detected', diffChange }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const direction = diffChange > 0 ? '📈 DIFFICULTY UP' : '📉 DIFFICULTY DOWN';
    const emoji     = diffChange > 0 ? '🔴' : '🟢';
    const impact    = diffChange > 0
      ? 'Hashprice will decrease — margins tighten'
      : 'Hashprice will increase — margins improve';

    const V1 = 0.0047;
    const V2 = 0.000151;
    const hp = await fetch(`${new URL(req.url).origin}/api/hashprice`).then(r => r.json());
    const saving = (hp.priceUSD * (V1 - V2) * 100 * 1000).toFixed(2); // at 100 PH/s

    const msg = [
      `⚡ *DIFFICULTY ADJUSTMENT*`,
      ``,
      `${direction}: *${esc(diffChange > 0 ? '+' : '')}${esc(diffChange.toFixed(2))}%*`,
      `${emoji} ${esc(impact)}`,
      ``,
      `*Current hashprice:* ${esc('$' + hp.priceUSD.toFixed(6))}/TH/day`,
      `*Est\\. next adjustment:* ${esc(da.difficultyChange > 0 ? '+' : '')}${esc(da.difficultyChange.toFixed(2))}% in ${esc(String(da.remainingBlocks))} blocks`,
      ``,
      `💚 V2 still saves *${esc('$' + saving)}/day* @ 100 PH/s regardless`,
      ``,
      `📈 [stratumv2\\.com](https://stratumv2.com)`,
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text: msg,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: false,
      }),
    });

    return new Response(JSON.stringify({ ok: true, alerted: true, diffChange }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
