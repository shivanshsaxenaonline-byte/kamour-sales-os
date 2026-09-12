import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type ZohoNotification = {
  channel_id?: string | number;
  module?: string;
  operation?: string;
  ids?: Array<string | number>;
  server?: string | number;
  token?: string;
};

function eventId(payload: ZohoNotification) {
  const ids = Array.isArray(payload.ids) ? payload.ids.join(',') : 'no-ids';
  return [
    payload.channel_id ?? 'no-channel',
    payload.module ?? 'no-module',
    payload.operation ?? 'no-operation',
    payload.server ?? Date.now(),
    ids,
  ].join(':');
}

export async function GET() {
  return NextResponse.json({ ok: true, provider: 'zoho' });
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as ZohoNotification;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: 'server_not_configured' }, { status: 500 });
  }

  const db = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await db.from('webhook_events').upsert({
    provider: 'zoho',
    event_id: eventId(payload),
    payload,
    processed_at: new Date().toISOString(),
  }, { onConflict: 'provider,event_id', ignoreDuplicates: true });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
