import { NextResponse } from 'next/server';
import { serviceClient, syncZohoRecords } from '@/lib/zoho/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Drain the Zoho notifications that arrived but were never applied.
 *
 * Two jobs in one endpoint. The backlog: 91 notifications landed between the
 * channel being registered and this sync existing, and every one of them is
 * still in webhook_events with nothing applied. And the ongoing safety net: if
 * the inline sync in the webhook route throws, that row keeps processed_at null
 * and the next run of this picks it up.
 *
 * It is an HTTP route rather than a script so it runs the very same
 * syncZohoRecords the webhook runs. A change applied late is then byte-for-byte
 * a change applied instantly, instead of a second implementation that drifts.
 *
 *   curl -X POST https://<host>/api/zoho/catchup -H "x-zoho-token: $ZOHO_WEBHOOK_TOKEN"
 *   ?limit=20   do a slice first
 *   ?dry=1      report what it would fetch, change nothing
 */
function authorised(request: Request) {
  // Vercel Cron sends this; a human or another job passes the token directly.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') === `Bearer ${secret}`) return true;

  const token = process.env.ZOHO_WEBHOOK_TOKEN;
  return !!token && request.headers.get('x-zoho-token') === token;
}

/** Vercel Cron issues GET. Same work either way — the safety net that retries
 *  whatever the inline sync in the webhook could not finish.
 *
 *  Daily, not hourly: a Vercel Hobby account refuses any cron that runs more
 *  than once a day. That is a real limit on how stale a missed change can get,
 *  so this is a backstop and not the delivery path — the webhook applies
 *  changes inline within seconds, and only a failure there waits for this. */
export async function GET(request: Request) {
  return POST(request);
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 2000);

  let db;
  try {
    db = serviceClient();
  } catch {
    return NextResponse.json({ ok: false, error: 'server_not_configured' }, { status: 500 });
  }

  const { data, error } = await db
    .from('webhook_events')
    .select('id, payload')
    .eq('provider', 'zoho')
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(limit);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const events = (data ?? []) as { id: string; payload: { ids?: unknown[] } }[];
  if (!events.length) return NextResponse.json({ ok: true, pending: 0 });

  // One record edited eight times in a minute is eight notifications and a
  // single record to fetch. Collapsing before calling Zoho is what stops a
  // burst of edits becoming a burst of API calls against a daily credit limit.
  const eventsByRecord = new Map<string, string[]>();
  for (const e of events) {
    for (const raw of e.payload?.ids ?? []) {
      const id = String(raw);
      if (!eventsByRecord.has(id)) eventsByRecord.set(id, []);
      eventsByRecord.get(id)!.push(e.id);
    }
  }
  const ids = [...eventsByRecord.keys()];

  if (dry) {
    return NextResponse.json({
      ok: true, dry: true, pending: events.length, distinctRecords: ids.length, ids,
    });
  }

  const result = await syncZohoRecords(ids);

  // Only mark the notifications whose record actually landed. A skipped record
  // leaves its notifications unprocessed on purpose, so the next run retries
  // them rather than burying a change that never applied.
  const failed = new Set(result.skipped.map((s) => s.id.replace(/^zcrm_/, '')));
  const done: string[] = [];
  for (const [recordId, eventIds] of eventsByRecord) {
    if (!failed.has(recordId.replace(/^zcrm_/, ''))) done.push(...eventIds);
  }

  if (done.length) {
    await db.from('webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .in('id', done);
  }

  return NextResponse.json({
    ok: true,
    pending: events.length,
    distinctRecords: ids.length,
    ...result,
    markedProcessed: done.length,
    stillPending: events.length - done.length,
  });
}
