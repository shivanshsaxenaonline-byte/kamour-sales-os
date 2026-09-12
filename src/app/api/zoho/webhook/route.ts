import { NextResponse } from 'next/server';
import { serviceClient, syncZohoRecords } from '@/lib/zoho/sync';

export const runtime = 'nodejs';
// A notification must never be served from a cache, and the work it triggers
// takes longer than the default edge budget.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type ZohoNotification = {
  channel_id?: string | number;
  module?: string;
  operation?: string;
  ids?: Array<string | number>;
  server_time?: string | number;
  server?: string | number;
  token?: string;
};

/** One delivery, identified the way Zoho retries it: same channel, module,
 *  operation, instant and ids means the same event. */
function eventId(payload: ZohoNotification) {
  const ids = Array.isArray(payload.ids) ? payload.ids.join(',') : 'no-ids';
  return [
    payload.channel_id ?? 'no-channel',
    payload.module ?? 'no-module',
    payload.operation ?? 'no-operation',
    payload.server_time ?? payload.server ?? Date.now(),
    ids,
  ].join(':');
}

export async function GET() {
  return NextResponse.json({ ok: true, provider: 'zoho' });
}

/**
 * Zoho CRM instant notification.
 *
 * The payload says WHICH records changed and which field names changed — never
 * the values. So this records the delivery, then goes back to Zoho for those
 * records and writes them into our tables. Recording first means a failure in
 * the second half leaves a row with processed_at still null, which is a queue
 * entry the catch-up route can retry, not a lost change.
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as ZohoNotification;

  // The token registered with the channel, echoed back on every notification.
  // Checked before anything is written: without this the endpoint is a public
  // insert into webhook_events for anyone who knows the URL.
  const expected = process.env.ZOHO_WEBHOOK_TOKEN;
  if (expected && payload.token !== expected) {
    return NextResponse.json({ ok: false, error: 'bad_token' }, { status: 401 });
  }

  let db;
  try {
    db = serviceClient();
  } catch {
    return NextResponse.json({ ok: false, error: 'server_not_configured' }, { status: 500 });
  }

  // processed_at stays NULL here. The previous version stamped it on insert,
  // which made every row claim it had been handled and left the partial index
  // `where processed_at is null` — built in 006 precisely to find outstanding
  // work — permanently empty.
  const { data: event, error } = await db.from('webhook_events').upsert({
    provider: 'zoho',
    event_id: eventId(payload),
    payload,
  }, { onConflict: 'provider,event_id', ignoreDuplicates: false }).select('id, processed_at').maybeSingle();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const row = event as { id: string; processed_at: string | null } | null;
  // A redelivery of something already applied is acknowledged and dropped.
  if (row?.processed_at) return NextResponse.json({ ok: true, already: true });

  const ids = (payload.ids ?? []).map(String).filter(Boolean);
  if (!ids.length) {
    if (row) await db.from('webhook_events')
      .update({ processed_at: new Date().toISOString() }).eq('id', row.id);
    return NextResponse.json({ ok: true, applied: 0 });
  }

  try {
    const result = await syncZohoRecords(ids);
    if (row) {
      await db.from('webhook_events').update({
        processed_at: new Date().toISOString(),
        error: result.skipped.length ? JSON.stringify(result.skipped).slice(0, 1000) : null,
      }).eq('id', row.id);
    }
    // 200 even with skips: the delivery WAS handled, and a skip is recorded on
    // the row. Returning an error would make Zoho retry something that will
    // skip again for the same reason.
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (row) await db.from('webhook_events').update({ error: message.slice(0, 1000) }).eq('id', row.id);
    // processed_at left null so the catch-up route picks it up. 500 also asks
    // Zoho to redeliver, which is safe — every write here is idempotent.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
