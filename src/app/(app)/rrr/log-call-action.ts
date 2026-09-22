'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// What the dialog may post, and what each value stores. Derived from the single
// outcome table rather than retyped here: this whitelist and the dialog's
// buttons used to be two hand-maintained lists, and they had already drifted
// apart over `busy`.
import { ALIAS_TO_COLUMN } from './lib/outcomes';
import { istToday, istTodayPlus } from './lib/format';

export type LogCallInput = {
  /** Null only for a WATI Interested lead with no customer record yet. */
  customerId: string | null;
  /** The open follow-up this call answers, when the queue had one. */
  followupId: string | null;
  /** Parent for a call made with nothing scheduled — the customer's last order. */
  orderId: string | null;
  outcome: string;
  note: string;
  nextDueOn: string | null;      // 'YYYY-MM-DD'
  contactNumberId: string | null;
  workId?: string | null;
  /** An assigned WATI Interested lead. Its calls live in wati_work_calls, not
   *  followups: followups_one_parent wants a lead, consultation or order, and
   *  a WhatsApp prospect has none of the three. */
  watiWorkId?: string | null;
  medicineDaysLeft: number | null;
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
  // A WATI lead is identified by its task, not by a customer row it may not
  // have yet; every other call still has to name one.
  if (!input.watiWorkId && !uuid(input.customerId)) return { ok: false, error: 'Invalid customer.' };
  if (input.watiWorkId && !uuid(input.watiWorkId)) return { ok: false, error: 'Invalid assignment.' };
  if (!(input.outcome in ALIAS_TO_COLUMN)) return { ok: false, error: 'Choose a call outcome.' };
  if (input.nextDueOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.nextDueOn))
    return { ok: false, error: 'Next follow-up date is not a valid date.' };
  // Tomorrow at the earliest. A follow-up dated today leaves the task called
  // today and still due today, which is neither of the two lists a rep works
  // from — see the partition in my/my-work-list.tsx.
  if (input.nextDueOn && input.nextDueOn <= istToday())
    return { ok: false, error: 'Next follow-up date must be tomorrow or later.' };
  if (input.note.length > 2000) return { ok: false, error: 'Note is too long.' };
  if (!input.contactNumberId) return { ok: false, error: 'Choose the number the call was made from.' };
  if (!uuid(input.contactNumberId)) return { ok: false, error: 'Invalid number.' };
  if (input.workId && !uuid(input.workId)) return { ok: false, error: 'Invalid assignment.' };

  const outcome = ALIAS_TO_COLUMN[input.outcome];
  if (outcome === 'medicine_not_finished') {
    if (!Number.isInteger(input.medicineDaysLeft) || input.medicineDaysLeft! < 1
      || input.medicineDaysLeft! > 365)
      return { ok: false, error: 'Enter 1 to 365 medicine days remaining.' };
    if (input.nextDueOn !== istTodayPlus(input.medicineDaysLeft!))
      return { ok: false, error: 'Next call should be when medicine runs out.' };
  } else if (input.medicineDaysLeft != null) {
    return { ok: false, error: 'Medicine days only apply to medicine not finished.' };
  }
  if (outcome === 'will_buy' && input.nextDueOn !== istTodayPlus(1))
    return { ok: false, error: 'Interested follow-up is due tomorrow.' };
  // The whole point of `other` is the sentence the buttons could not hold, so
  // an empty one is not an outcome. It comes back tomorrow like an interested
  // customer, because somebody has to read that sentence.
  if (outcome === 'other') {
    if (!input.note.trim()) return { ok: false, error: 'Write what happened on this call.' };
    if (input.nextDueOn !== istTodayPlus(1))
      return { ok: false, error: 'Other follow-up is due tomorrow.' };
  }
  // An order ends the chain: the task closes here and the new order raises the
  // next call itself, when its course runs out. Booking a follow-up now would
  // put the customer back on a list about the course they have just replaced.
  // The note is required because this is the conversion number, claimed by the
  // person credited for it before the Medicine Order sheet can confirm it.
  if (outcome === 'order_placed') {
    if (!input.note.trim()) return { ok: false, error: 'Write what was ordered.' };
    if (input.nextDueOn)
      return { ok: false, error: 'An order placed closes this task; the next call comes from the new order.' };
  }
  if ((outcome === 'will_update_later' || outcome === 'connected') && !input.nextDueOn)
    return { ok: false, error: 'Ask when the customer will update and choose a date.' };
  const now = new Date().toISOString();
  const nextAt = input.nextDueOn ? `${input.nextDueOn}T00:00:00+05:30` : null;

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { ok: false, error: 'Your session expired. Sign in again.' };
  if (!input.workId && !input.watiWorkId) {
    const { data: profile } = await db.from('users').select('role').eq('id', user.id).single();
    if (profile?.role === 'sales_exec' || profile?.role === 'sales_manager')
      return { ok: false, error: 'Only your assigned RRR follow-ups can be updated.' };
  }

  if (input.watiWorkId) {
    const { data, error } = await db.rpc('fn_log_wati_call', {
      p_work_id: input.watiWorkId,
      p_outcome: outcome,
      p_note: input.note.trim(),
      p_next_due_on: input.nextDueOn,
      p_contact_number_id: input.contactNumberId,
      p_medicine_days_left: input.medicineDaysLeft,
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath('/rrr/my');
    revalidatePath('/rrr/work');
    // An order from a WhatsApp prospect can close RRR tasks too, when the
    // number already belongs to a customer with a course on the lists.
    revalidatePath('/rrr/ai');
    revalidatePath('/rrr/medicine-ending');
    revalidatePath('/leads/wati-interested');
    revalidatePath('/rrr/analytics');
    return { ok: true, scheduledNext: !!data?.scheduledNext };
  }

  if (input.workId) {
    const { data, error } = await db.rpc('fn_log_assigned_rrr_call', {
      p_work_id: input.workId,
      p_outcome: outcome,
      p_note: input.note.trim(),
      p_next_due_on: input.nextDueOn,
      p_contact_number_id: input.contactNumberId,
      p_medicine_days_left: input.medicineDaysLeft,
    });
    if (error) return { ok: false, error: error.message };
    revalidatePath('/rrr/my');
    revalidatePath('/rrr/ai');
    revalidatePath('/rrr/medicine-ending');
    revalidatePath('/rrr/work');
    return { ok: true, scheduledNext: !!data?.scheduledNext };
  }

  const done = {
    outcome,
    remark: outcome === 'medicine_not_finished'
      ? [input.note.trim(), `Medicine remaining: ${input.medicineDaysLeft} days`]
        .filter(Boolean).join(' | ')
      : input.note.trim() || null,
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
        // Past the WATI branch above, a customer row is required, and the
        // check at the top of this function has already proved there is one.
        customer_id: input.customerId!,
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
