// Razorpay -> razorpay_payments, live.
//
// Deployed as a public endpoint (no Supabase JWT — Razorpay cannot send one),
// so the ONLY thing standing between this and the open internet is Razorpay's
// own signature. That check happens before the body is parsed or trusted, and
// a delivery that fails it is still recorded in razorpay_events so a missing
// payment can be traced to whether it ever arrived.
//
//   supabase functions deploy razorpay-webhook --no-verify-jwt
//   supabase secrets set RAZORPAY_WEBHOOK_SECRET=... SB_URL=... SB_SERVICE_ROLE_KEY=...
//
// Events worth subscribing to in the Razorpay dashboard:
//   payment.captured · payment.failed · payment.authorized · refund.processed
//
// This endpoint does NOT decide which order a payment belongs to. It stores
// what Razorpay said. Matching is a separate, later, reversible decision —
// see v_razorpay_unmatched.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
const SB_URL = Deno.env.get('SB_URL') ?? Deno.env.get('SUPABASE_URL') ?? '';
const SB_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY') ??
               Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

/** HMAC-SHA256 of the raw body, compared in constant time.
 *  The RAW body — not a re-serialised object. JSON.stringify(JSON.parse(x))
 *  is not always x, and every byte that differs breaks the signature. */
async function signatureOk(raw: string, sent: string | null): Promise<boolean> {
  if (!sent || !SECRET) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== sent.length) return false;
  // Constant time: never return early on the first differing character.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sent.charCodeAt(i);
  return diff === 0;
}

const rupees = (paise: number | null | undefined) =>
  paise == null ? null : Math.round(paise) / 100;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  const sent = req.headers.get('x-razorpay-signature');
  const eventId = req.headers.get('x-razorpay-event-id');
  const ok = await signatureOk(raw, sent);

  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(raw); } catch { /* kept as {} and recorded below */ }

  const event = (payload?.event as string) ?? null;
  const entity = (payload as any)?.payload?.payment?.entity ?? null;

  // Log the delivery first, whatever it turned out to be.
  const { data: logged } = await db.from('razorpay_events').insert({
    event_id: eventId,
    event,
    payment_id: entity?.id ?? null,
    signature_ok: ok,
    payload: payload ?? {},
  }).select('id').single();

  const fail = async (status: number, msg: string) => {
    if (logged?.id) await db.from('razorpay_events').update({ error: msg }).eq('id', logged.id);
    // 200 on a bad signature would tell an attacker the endpoint accepts
    // anything; 401 tells Razorpay nothing it needs, since a genuine delivery
    // never lands here.
    return new Response(msg, { status });
  };

  if (!ok) return await fail(401, 'signature mismatch');
  if (!entity?.id) {
    // A subscribed event with no payment entity (an order or refund event we
    // do not model yet). Recorded, acknowledged, not an error.
    if (logged?.id) await db.from('razorpay_events').update({ handled: true }).eq('id', logged.id);
    return new Response('ok (no payment entity)', { status: 200 });
  }

  const row = {
    id: entity.id,
    razorpay_order_id: entity.order_id ?? null,
    invoice_id: entity.invoice_id ?? null,
    status: entity.status,
    method: entity.method ?? null,
    captured: !!entity.captured,
    amount: rupees(entity.amount),
    amount_refunded: rupees(entity.amount_refunded ?? 0),
    fee: rupees(entity.fee),
    tax: rupees(entity.tax),
    currency: entity.currency ?? 'INR',
    email: entity.email ?? null,
    contact_raw: entity.contact ? String(entity.contact) : null,
    vpa: entity.vpa ?? null,
    bank: entity.bank ?? null,
    wallet: entity.wallet ?? null,
    card_last4: entity.card?.last4 ?? null,
    description: entity.description ?? null,
    notes: entity.notes ?? {},
    acquirer_data: entity.acquirer_data ?? {},
    error_code: entity.error_code ?? null,
    error_description: entity.error_description ?? null,
    paid_at: new Date((entity.created_at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    raw: entity,
    source: 'webhook',
  };

  // Upsert on the payment id: Razorpay retries deliveries, and one payment
  // legitimately arrives twice (authorized, then captured). The later state
  // wins; a link somebody already made is untouched because this never writes
  // order_id, customer_id or matched_at.
  const { error } = await db.from('razorpay_payments').upsert(row, { onConflict: 'id' });

  if (error) {
    // 500 so Razorpay retries — the delivery was genuine and we dropped it.
    return await fail(500, `store failed: ${error.message}`);
  }

  if (logged?.id) await db.from('razorpay_events').update({ handled: true }).eq('id', logged.id);
  return new Response('ok', { status: 200 });
});
