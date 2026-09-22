import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { ContactNumber } from '../log-call-dialog';
import { addDaysIso, courseDays, daysBetween, istDateFromTimestamp, istToday } from '../lib/format';
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
  created_at,
  order_items(products(default_course_days)),
  customers!inner(full_name, phone_e164, is_dnd, merged_into_id)
`;

type RawOrder = {
  id: string;
  order_no: string;
  customer_id: string;
  amount: number;
  course_duration_days: number | null;
  delivered_at: string | null;
  created_at: string;
  order_items: { products: { default_course_days: number | null } | null }[];
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
  const [orders, reorders, numbers, usualNumber, reps, work, calls, watiCalls,
    medicineCalls, openFollowups] = await Promise.all([
    supabase
      .from('orders')
      .select(COLUMNS)
      .eq('stage', 'delivered')
      .not('delivered_at', 'is', null)
      // No course filter here any more. It used to read
      // .in('course_duration_days', [15, 30]), which threw away every order
      // whose duration the sheet never carried — and of those that do carry
      // one, 232 carry a 15 against a 60N box, so the column could not be
      // trusted to band the list either. The length is decided from the
      // tablets below; the whole delivered set is 131 rows, so nothing here
      // needs narrowing.
      .order('delivered_at', { ascending: false })
      .limit(750),
    // Every order of any stage from the last four months, to answer one
    // question: has this customer already bought again? Only 148 of the 2,037
    // orders on record are ever marked `delivered` — the rest sit at
    // `confirmed` — so "their newest delivered course" is not the same thing
    // as "their newest order", and this screen was only ever seeing the first.
    // Four months covers it: a course that is still near its ending date was
    // delivered within the last six weeks, and anything newer came after that.
    supabase.from('orders')
      .select('id, customer_id, created_at')
      .gte('created_at', `${addDaysIso(today, -120)}T00:00:00+05:30`)
      // A parcel that came back or never arrived is not a course in the
      // customer's hands, so it must not read as "they have bought again" —
      // they are owed a call more than anyone. Ops write the courier's answer
      // into the sheet's Delivered Date cell and the sync now lands it on the
      // stage (see src/lib/sheets/order-sync.ts).
      .not('stage', 'in', '(rto,cancelled)')
      .order('created_at', { ascending: false })
      .limit(3000),
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

  // The longest course among the tablets in the parcel: 60N a month, 30N a
  // fortnight. Accessories (Power Drive, Boost Up Oil, Shilajit) carry no
  // course of their own and so cannot shorten one.
  const tabletDays = (o: RawOrder) =>
    Math.max(0, ...(o.order_items ?? []).map((i) => i.products?.default_course_days ?? 0)) || null;

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

  // A call already booked for a later day.
  //
  // `calledSince` covers two days, which is right for "we spoke, let them be"
  // but wrong for a promise with a date on it. A customer who said on the 16th
  // that he has nine days of medicine left has a call booked for the 25th; on
  // the 18th this list raised him again, Alka assigned him, and the assignment
  // reset the task to due-today and wiped the outcome off it — so the rep saw
  // "Not called yet" on a customer he had marked two days earlier, about a
  // course still in the man's hands. That is the complaint this fixes at
  // source; fn_assign_rrr_work no longer erases the date either.
  //
  // Only dates in the future count. A task due today is today's work and
  // belongs on this screen, assignment state and all.
  const bookedAhead = new Set<string>();
  for (const item of work.data ?? [])
    if (item.customer_id && !item.completed_at && item.due_on > today)
      bookedAhead.add(item.customer_id);
  for (const followup of openFollowups.data ?? [])
    if (followup.customer_id && followup.due_at
      && istDateFromTimestamp(followup.due_at) > today)
      bookedAhead.add(followup.customer_id);

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

  // One row per customer: the course they are actually on.
  //
  // A customer who has reordered has two, three, six delivered courses behind
  // them, and every one of those older courses ran out on its own date. The
  // list was showing them — which is how a customer whose current medicine
  // lasts to mid-October read as "8d overdue" from a course that was replaced
  // by a delivery a week ago, and how one phone call turned into several rows.
  // The medicine in their hands is the newest one; the rest are history.
  const currentCourse = new Set<string>();
  const seenCustomer = new Set<string>();
  for (const o of (orders.data ?? []) as unknown as RawOrder[]) {
    if (seenCustomer.has(o.customer_id)) continue;   // delivered_at desc
    seenCustomer.add(o.customer_id);
    currentCourse.add(o.id);
  }

  // Already bought the next course. The whole point of this list is to catch a
  // customer before their medicine runs out and they drift; one who has placed
  // a fresh order has done the thing the call was going to ask for, and ringing
  // them is ringing about a bottle they finished weeks ago.
  //
  // This is why a customer whose last order was on 9 Sep sat in a rep's list
  // over a course delivered on 30 Aug: the new order is `confirmed`, not
  // `delivered`, so the delivered-orders query above could not see it.
  //
  // Strictly newer, so the two halves of an order split across two rows on the
  // same day cannot cancel each other out.
  //
  // What counts as "newer" depends on what dated the course. Normally it is
  // the order itself. But when the customer has told a rep how much medicine
  // they have, that call is the later word: one customer reordered in July,
  // said in September that his medicine runs to the 19th, and an order two
  // months older than that call must not be read as him having moved on.
  const reorderedAfter = new Map<string, string>();
  for (const o of reorders.data ?? []) {
    if (!o.customer_id || !o.created_at) continue;
    const known = reorderedAfter.get(o.customer_id);
    if (!known || o.created_at > known) reorderedAfter.set(o.customer_id, o.created_at);
  }

  const hasReordered = (customerId: string, orderedAt: string) => {
    const newest = reorderedAfter.get(customerId);
    if (!newest) return false;
    const said = saidOn.get(customerId);
    // Bought on or after the day they described what was left: whatever they
    // had then, they have topped it up since.
    if (said) return istDateFromTimestamp(newest) >= said;
    return newest > orderedAt;
  };

  const rows = ((orders.data ?? []) as unknown as RawOrder[])
    .filter((o) => {
      const customer = o.customers;
      if (!customer || customer.merged_into_id || !o.delivered_at) return false;
      if (!currentCourse.has(o.id)) return false;
      if (hasReordered(o.customer_id, o.created_at)) return false;
      if (bookedAhead.has(o.customer_id)) return false;
      return !calledSince.has(o.customer_id);
    })
    .map((o): MedicineEndingRow => {
      const customer = o.customers!;
      const deliveredOn = istDateFromTimestamp(o.delivered_at!);
      // The tablets decide the course, not the sheet's own column — see
      // courseDays(). This screen and the AI list now read the same number off
      // the same order.
      const course = courseDays({
        course_duration_days: o.course_duration_days,
        tablet_course_days: tabletDays(o),
      });
      // addDaysIso, not Date.setDate(): the previous helper stepped the
      // machine's local calendar and then read the result back as a UTC day,
      // which put every single course end one day early — a 15-day course
      // delivered on the 1st ended on the 15th instead of the 16th, and the
      // whole "ends today / 3d left / overdue" banding was shifted with it.
      const estimatedEnd = addDaysIso(deliveredOn, course);
      // Later of the two, never earlier: a customer who is running behind on
      // their course has more medicine left than the calendar says, and the
      // call is the only thing that knows it.
      const stated = statedEndsOn.get(o.customer_id);
      const endsOn = stated && stated > estimatedEnd ? stated : estimatedEnd;
      return {
        order_id: o.id,
        order_no: o.order_no,
        customer_id: o.customer_id,
        full_name: customer.full_name,
        phone_e164: customer.phone_e164,
        is_dnd: customer.is_dnd,
        amount: Number(o.amount),
        course_duration_days: course,
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
