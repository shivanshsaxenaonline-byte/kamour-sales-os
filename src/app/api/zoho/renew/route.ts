import { NextResponse } from 'next/server';
import { daysLeft, listChannels, renewChannel } from '@/lib/zoho/channel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NOTIFY_URL = process.env.ZOHO_NOTIFY_URL
  ?? 'https://kamour-sales-os.vercel.app/api/zoho/webhook';

/** Renew with more than a day in hand. A channel that lapses takes the whole
 *  live sync down silently, and a single failed cron run must not be enough to
 *  let that happen. */
const RENEW_UNDER_DAYS = 4;

function authorised(request: Request) {
  // Vercel Cron sends this header; a human or another job can pass the same
  // secret explicitly.
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth === `Bearer ${secret}`) return true;

  const token = process.env.ZOHO_WEBHOOK_TOKEN;
  return !!token && request.headers.get('x-zoho-token') === token;
}

/**
 * Keep the Zoho watch channel alive.
 *
 * GET because that is what Vercel Cron issues. Renews only when the channel is
 * close to lapsing, so the daily run is almost always a cheap no-op against
 * Zoho's API credit limit — and `?force=1` renews regardless.
 */
export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.ZOHO_WEBHOOK_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'ZOHO_WEBHOOK_TOKEN not set' }, { status: 500 });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';

  try {
    const channels = await listChannels();
    const left = daysLeft(channels);

    // No channel at all is not "nothing to do" — it means notifications have
    // stopped entirely, so register one.
    if (left !== null && left > RENEW_UNDER_DAYS && !force) {
      return NextResponse.json({ ok: true, renewed: false, daysLeft: Number(left.toFixed(2)) });
    }

    const result = await renewChannel(NOTIFY_URL, token);
    return NextResponse.json({ ok: true, renewed: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
