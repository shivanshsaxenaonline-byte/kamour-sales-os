import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { ContactNumber } from '../log-call-dialog';
import { addDaysIso, daysBetween, istDateFromTimestamp, istToday } from '../lib/format';
import { MedicineEndingTable, type MedicineEndingRow } from './medicine-ending-table';

const CAN_ASSIGN = ['admin', 'ceo', 'coo', 'auditor'];

export const dynamic = 'force-dynamic';

const COLUMNS = `
  id,
  order_no,
  customer_id,
  amount,
  course_duration_days,
  delivered_at,
  customers!inner(full_name, phone_e164, is_dnd, merged_into_id)
`;

type RawOrder = {
  id: string;
  order_no: string;
  customer_id: string;
  amount: number;
  course_duration_days: number | null;
  delivered_at: string | null;
  customers: {
    full_name: string;
    phone_e164: string;
    is_dnd: boolean;
    merged_into_id: string | null;
  } | null;
};

export default async function MedicineEndingPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await supabase.from('users').select('role').eq('id', user.id).single();
  if (me?.role === 'sales_exec' || me?.role === 'sales_manager') redirect('/rrr/my');

  const today = istToday();
  // Somebody rung today or yesterday has been dealt with; putting them back on
  // this list is how a customer gets called twice in two days about the same
  // course. Two days, not one, because the floor works the list in the morning
  // and yesterday's calls are still fresh — the customer said what they had to
  // say. They come back the day after, if their medicine is still ending.
  const yesterday = addDaysIso(today, -1);
  const sinceYesterday = `${yesterday}T00:00:00+05:30`;

  // The two reads do not feed each other, so they go together rather than one
  // after the other.
  //
  // The 750 cap stays: the window filter runs in the browser because the "all"
  // option genuinely means all, and measuring says the whole set is 130 rows
  // (41.6 KB) — the cap is nowhere near binding, so bounding this by date
  // would narrow a user-facing filter to buy back nothing.
  const [orders, numbers, usualNumber, reps, work, calls, watiCalls,
    medicineCalls, openFollowups] = await Promise.all([
    supabase
      .from('orders')
      .select(COLUMNS)
      .eq('stage', 'delivered')
      .not('delivered_at', 'is', null)
      .in('course_duration_days', [15, 30])
      .order('delivered_at', { ascending: false })
      .limit(750),
    supabase.from('contact_numbers').select('id, label_en')
      .eq('is_active', true).order('sort_order'),
    // See fn_my_calling_number: the number this rep last dialled.
    supabase.rpc('fn_my_calling_number'),
    supabase.from('users').select('id, full_name').in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
    supabase.from('rrr_work_items')
      .select('order_id, customer_id, assigned_to, assigned_at, due_on, last_outcome, medicine_days_left, completed_at, last_called_at')
      .order('updated_at', { ascending: false }).limit(3000),
    // Every call logged since yesterday morning, whichever screen logged it:
    // followups is where an RRR call lands whether it came from a rep's own
    // list, the All tab or this one.
    supabase.from('followups')
      .select('customer_id')
      .not('completed_at', 'is', null)
      .gte('completed_at', sinceYesterday)
      .limit(3000),
    // A WATI hand-over does not write followups (its prospect has no order to
    // hang one on), so the same customer could be rung there this morning and
    // here this afternoon without the query above noticing.
    supabase.from('wati_work_items')
      .select('customer_id, last_called_at')
      .not('customer_id', 'is', null)
      .gte('last_called_at', sinceYesterday)
      .limit(1000),
    // Calls where the customer said how much medicine is actually left, and
    // the follow-ups those calls booked. See statedEndsOn below for why this
    // beats delivery date + course length. Both are small — 55 such calls in
    // the last year, 188 open follow-ups — so neither needs narrowing.
    supabase.from('followups')
      .select('customer_id, completed_at')
      .eq('outcome', 'medicine_not_finished')
      .not('completed_at', 'is', null)
      .gte('completed_at', `${addDaysIso(today, -365)}T00:00:00+05:30`)
      .order('completed_at', { ascending: false })
      .limit(2000),
    supabase.from('followups')
      .select('customer_id, due_at')
      .is('completed_at', null)
      .limit(3000),
  ]);

  if (orders.error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>Medicine Ending</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load delivered medicine orders.</p>
          <p className="muted">{orders.error.message}</p>
        </div>
      </section>
    );
  }

  const workByOrder = new Map<string, NonNullable<typeof work.data>[number]>();
  for (const item of work.data ?? [])
    if (!workByOrder.has(item.order_id)) workByOrder.set(item.order_id, item);

  // Already spoken to today or yesterday. A failed read here must not empty the
  // list — that would hide work rather than a handful of finished rows — so a
  // broken query means nobody is excluded, and the page still loads.
  const calledSince = new Set<string>();
  for (const call of calls.data ?? []) if (call.customer_id) calledSince.add(call.customer_id);
  for (const lead of watiCalls.data ?? []) if (lead.customer_id) calledSince.add(lead.customer_id);
  for (const item of work.data ?? [])
    if (item.customer_id && item.last_called_at
      && istDateFromTimestamp(item.last_called_at) >= yesterday) calledSince.add(item.customer_id);

  // What the customer themselves said.
  //
  // Delivery date + course length is a guess: it assumes the box was opened
  // the day it arrived and a dose never missed. When a rep rings and the
  // customer says "28 days left", that is evidence, and the follow-up the call
  // books is dated the day that medicine runs out (fn_log_assigned_rrr_call
  // insists on exactly that date for this outcome). Without it, somebody who
  // told us on 17 Sep that their medicine runs to mid-October was back on this
  // list on the 19th, and got rung again about the same course.
  //
  // Read from followups rather than rrr_work_items because followups is where
  // every RRR call lands whatever screen logged it — the customer in the
  // report above had no work item at all, only the call and its follow-up.
  //
  // Keyed by customer: the call may have been logged against another of their
  // orders, and it still describes the medicine in their hands today.
  const saidOn = new Map<string, string>();
  for (const call of medicineCalls.data ?? []) {
    if (!call.customer_id || !call.completed_at) continue;
    const day = istDateFromTimestamp(call.completed_at);
    const known = saidOn.get(call.customer_id);
    if (!known || day > known) saidOn.set(call.customer_id, day);
  }
  // The booked follow-up carries the date itself. Only one dated on or after
  // the call counts, so an older promise left open on the same customer cannot
  // be mistaken for the medicine running out.
  const statedEndsOn = new Map<string, string>();
  for (const followup of openFollowups.data ?? []) {
    if (!followup.customer_id || !followup.due_at) continue;
    const said = saidOn.get(followup.customer_id);
    if (!said) continue;
    const due = istDateFromTimestamp(followup.due_at);
    if (due < said) continue;
    const known = statedEndsOn.get(followup.customer_id);
    if (!known || due > known) statedEndsOn.set(followup.customer_id, due);
  }

  // Only the newest delivered course of a customer takes the stated date. The
  // medicine they described is the one they are on; pinning their older orders
  // to the same day would drag every one of them back onto the list as a
  // duplicate row for the same phone call.
  const newestOrder = new Set<string>();
  const seenCustomer = new Set<string>();
  for (const o of (orders.data ?? []) as unknown as RawOrder[]) {
    if (seenCustomer.has(o.customer_id)) continue;   // delivered_at desc
    seenCustomer.add(o.customer_id);
    newestOrder.add(o.id);
  }

  const rows = ((orders.data ?? []) as unknown as RawOrder[])
    .filter((o) => {
      const customer = o.customers;
      if (!customer || customer.merged_into_id || !o.delivered_at || !o.course_duration_days)
        return false;
      return !calledSince.has(o.customer_id);
    })
    .map((o): MedicineEndingRow => {
      const customer = o.customers!;
      const deliveredOn = istDateFromTimestamp(o.delivered_at!);
      // addDaysIso, not Date.setDate(): the previous helper stepped the
      // machine's local calendar and then read the result back as a UTC day,
      // which put every single course end one day early — a 15-day course
      // delivered on the 1st ended on the 15th instead of the 16th, and the
      // whole "ends today / 3d left / overdue" banding was shifted with it.
      const estimatedEnd = addDaysIso(deliveredOn, o.course_duration_days!);
      // Later of the two, never earlier: a customer who is running behind on
      // their course has more medicine left than the calendar says, and the
      // call is the only thing that knows it.
      const stated = newestOrder.has(o.id) ? statedEndsOn.get(o.customer_id) : undefined;
      const endsOn = stated && stated > estimatedEnd ? stated : estimatedEnd;
      return {
        order_id: o.id,
        order_no: o.order_no,
        customer_id: o.customer_id,
        full_name: customer.full_name,
        phone_e164: customer.phone_e164,
        is_dnd: customer.is_dnd,
        amount: Number(o.amount),
        course_duration_days: o.course_duration_days!,
        delivered_on: deliveredOn,
        ends_on: endsOn,
        ends_on_stated: endsOn === stated && stated !== estimatedEnd,
        days_left: daysBetween(today, endsOn),
        assigned_to: workByOrder.get(o.id)?.assigned_to ?? null,
        assigned_at: workByOrder.get(o.id)?.assigned_at ?? null,
        due_on: workByOrder.get(o.id)?.due_on ?? null,
        last_outcome: workByOrder.get(o.id)?.last_outcome ?? null,
        medicine_days_left: workByOrder.get(o.id)?.medicine_days_left ?? null,
        completed_at: workByOrder.get(o.id)?.completed_at ?? null,
      };
    })
    .sort((a, b) => a.days_left - b.days_left || b.amount - a.amount);

  return <MedicineEndingTable rows={rows} numbers={(numbers.data ?? []) as ContactNumber[]}
    preferredNumberId={(usualNumber.data as string | null) ?? null}
    reps={reps.data ?? []} canAssign={CAN_ASSIGN.includes(me?.role ?? '')}
    canLog={me?.role !== 'auditor'} today={today} />;
}
