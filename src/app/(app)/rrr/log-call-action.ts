'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// The nine outcomes the floor's own dropdown offers, and the nine migration
// 024 allows. `interested` is the label; the column has stored `will_buy`
// since 005, so the two are mapped rather than renamed under the existing data.
const OUTCOMES = new Set([
  'order_placed', 'interested', 'not_interested', 'no_answer',
  'busy', 'wrong_number', 'connected', 'medicine_not_finished', 'will_update_later',
]);
const TO_COLUMN: Record<string, string> = { interested: 'will_buy' };

export type LogCallInput = {
  customerId: string;
  /** The open follow-up this call answers, when the queue had one. */
  followupId: string | null;
  /** Parent for a call made with nothing scheduled — the customer's last order. */
  orderId: string | null;
  outcome: string;
  note: string;
  nextDueOn: string | null;      // 'YYYY-MM-DD'
  contactNumberId: string | null;
};

const uuid = (v: string | null) => !!v && /^[0-9a-f-]{36}$/i.test(v);

/**
 * Record what happened on a call, and — when a next date is given — open the
 * next follow-up so the customer cannot fall off the queue.
 *
 * Works both ways round, because the floor works both ways round: against a
 * follow-up the queue scheduled, or against a customer a rep simply decided
 * to ring (618 of the 1,769 rows in their own log are that second kind).
 *
 * No SECURITY DEFINER: `followups_write` already says a user may write their
 * own rows and an oversight role may write any, so RLS is the check. A caller
 * without permission updates zero rows, which is reported, never swallowed.
 */
export async function logCall(
  input: LogCallInput,
): Promise<{ ok: true; scheduledNext: boolean } | { ok: false; error: string }> {
  if (!uuid(input.customerId)) return { ok: false, error: 'Invalid customer.' };
  if (!OUTCOMES.has(input.outcome)) return { ok: false, error: 'Choose a call outcome.' };
  if (input.nextDueOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.nextDueOn))
    return { ok: false, error: 'Next follow-up date is not a valid date.' };
  if (input.note.length > 2000) return { ok: false, error: 'Note is too long.' };
  if (input.contactNumberId && !uuid(input.contactNumberId))
    return { ok: false, error: 'Invalid number.' };

  const outcome = TO_COLUMN[input.outcome] ?? input.outcome;
  const now = new Date().toISOString();
  const nextAt = input.nextDueOn ? `${input.nextDueOn}T00:00:00+05:30` : null;

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { ok: false, error: 'Your session expired. Sign in again.' };

  const done = {
    outcome,
    remark: input.note.trim() || null,
    completed_at: now,
    next_due_at: nextAt,
    contact_number_id: input.contactNumberId,
    owner_id: user.id,   // who actually called, not always who it was assigned to
  };

  let closed: { customer_id: string; kind: string; order_id: string | null;
                lead_id: string | null; consultation_id: string | null;
                attempt_no: number } | null = null;

  if (uuid(input.followupId)) {
    const { data, error } = await db
      .from('followups')
      .update(done)
      .eq('id', input.followupId!)
      .is('completed_at', null)
      .select('customer_id, kind, order_id, lead_id, consultation_id, attempt_no')
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: 'That call was already logged, or you cannot edit it.' };
    closed = data;
  } else {
    // Nothing was scheduled, so the call itself is the record. It still needs
    // a parent (followups_one_parent), and the customer's last order is the
    // only honest one — a repeat call is about what they already bought.
    if (!uuid(input.orderId))
      return { ok: false, error: 'This customer has no order to log a call against.' };
    const { data, error } = await db
      .from('followups')
      .insert({
        customer_id: input.customerId,
        kind: 'order',
        order_id: input.orderId,
        due_at: now,
        attempt_no: 1,
        ...done,
      })
      .select('customer_id, kind, order_id, lead_id, consultation_id, attempt_no')
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: 'Could not save this call.' };
    closed = data;
  }

  let scheduledNext = false;
  if (nextAt) {
    // Same parent as the call it follows: changing it would move the work
    // onto a different order.
    const { error: nextError } = await db.from('followups').insert({
      customer_id: closed.customer_id,
      kind: closed.kind,
      order_id: closed.order_id,
      lead_id: closed.lead_id,
      consultation_id: closed.consultation_id,
      due_at: nextAt,
      owner_id: user.id,
      attempt_no: (closed.attempt_no ?? 1) + 1,
    });
    // The call is already saved. Failing here loses the reminder, not the
    // record, and the message says exactly that rather than "failed".
    if (nextError)
      return { ok: false, error: `Call saved, but the next follow-up was not scheduled: ${nextError.message}` };
    scheduledNext = true;
  }

  revalidatePath('/rrr');
  revalidatePath('/today');
  return { ok: true, scheduledNext };
}
