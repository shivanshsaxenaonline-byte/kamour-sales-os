import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { addDaysIso, daysBetween, istDateFromTimestamp, istToday } from '../lib/format';
import { repNote } from '../lib/notes';
import { DueTodayView, type DueRow } from './due-view';

export const dynamic = 'force-dynamic';

const CAN_VIEW = ['admin', 'ceo', 'coo', 'auditor'];

/**
 * Every repeat-order customer whose follow-up date has come: the day they said
 * their medicine runs out, the day they said they would decide, the retry
 * after a call nobody picked up.
 *
 * The date comes from two places, because the data holds both. Calls logged
 * through the app open a follow-up row for the next date; calls imported from
 * the sheet only wrote next_due_at on the call itself and opened nothing —
 * reading open rows alone missed every one of those. So a customer is due when
 * their open follow-up is due, or, with none open, when their latest call's
 * next date is. A customer who ordered after that call is not due.
 */
export default async function DueTodayPage() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await db.from('users').select('role').eq('id', user.id).single();
  if (!CAN_VIEW.includes(me?.role ?? '')) redirect('/');

  const today = istToday();
  const tomorrowStart = `${addDaysIso(today, 1)}T00:00:00+05:30`;
  // Timestamps come back in UTC, so compare instants, never the strings.
  const tomorrowMs = new Date(tomorrowStart).getTime();
  const beforeTomorrow = (ts: string) => new Date(ts).getTime() < tomorrowMs;

  // Paged: PostgREST stops at 1,000 rows a response.
  async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
    const out: T[] = [];
    for (let from = 0; from < 20_000; from += 1000) {
      const { data, error } = await page(from, from + 999);
      if (error) return { data: out, error };
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return { data: out, error: null };
  }

  const [openRows, datedCalls, reps] = await Promise.all([
    allRows((from, to) => db.from('followups')
      .select('id, customer_id, owner_id, due_at, attempt_no')
      .eq('kind', 'order').is('completed_at', null)
      .order('due_at', { ascending: true }).range(from, to)),
    // Calls that set a date which has now arrived — candidates only; whether
    // each is still the customer's latest call is checked below.
    allRows((from, to) => db.from('followups')
      .select('customer_id')
      .eq('kind', 'order').not('completed_at', 'is', null)
      .lt('next_due_at', tomorrowStart).range(from, to)),
    db.from('users').select('id, full_name').in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
  ]);
  const due = openRows.error ? openRows : datedCalls;

  if (due.error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>Due today</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load follow-ups due today.</p>
          <p className="muted">{due.error.message}</p>
        </div>
      </section>
    );
  }

  // One open follow-up per customer at most (checked against live data), so
  // the earliest-due one is the customer's current task.
  const openByCustomer = new Map<string, { id: string; owner_id: string | null; due_at: string; attempt_no: number }>();
  for (const f of openRows.data) if (!openByCustomer.has(f.customer_id)) openByCustomer.set(f.customer_id, f);
  const ids = [...new Set([
    ...[...openByCustomer].filter(([, f]) => beforeTomorrow(f.due_at)).map(([id]) => id),
    ...datedCalls.data.map((c) => c.customer_id),
  ])].filter((id) => {
    // An open follow-up still in the future means the customer is not due,
    // whatever an older call said.
    const o = openByCustomer.get(id);
    return !o || beforeTomorrow(o.due_at);
  });
  const chunks = <T,>(list: T[], size: number) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  // The customer, their latest call, their latest order, and who holds the task.
  type Call = { id: string; outcome: string | null; remark: string | null; completed_at: string; owner_id: string | null; next_due_at: string | null; attempt_no: number };
  const customers = new Map<string, { full_name: string; phone_e164: string; is_dnd: boolean; merged_into_id: string | null }>();
  const lastCall = new Map<string, Call>();
  const lastOrder = new Map<string, string>();
  const work = new Map<string, { assigned_to: string | null; assigned_at: string; last_outcome: string | null }>();
  for (const part of chunks(ids, 100)) {
    const [c, calls, orders, tasks] = await Promise.all([
      db.from('customers').select('id, full_name, phone_e164, is_dnd, merged_into_id').in('id', part),
      db.from('followups').select('id, customer_id, outcome, remark, completed_at, owner_id, next_due_at, attempt_no')
        .eq('kind', 'order').in('customer_id', part).not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(5000),
      db.from('orders').select('customer_id, created_at').in('customer_id', part)
        .order('created_at', { ascending: false }).limit(5000),
      db.from('rrr_work_items').select('customer_id, assigned_to, assigned_at, last_outcome')
        .in('customer_id', part).is('completed_at', null),
    ]);
    for (const row of c.data ?? []) customers.set(row.id, row);
    for (const row of calls.data ?? [])
      if (!lastCall.has(row.customer_id)) lastCall.set(row.customer_id, { ...row, completed_at: row.completed_at! });
    for (const row of orders.data ?? [])
      if (!lastOrder.has(row.customer_id)) lastOrder.set(row.customer_id, row.created_at);
    for (const row of tasks.data ?? []) work.set(row.customer_id, row);
  }
  const repName = new Map((reps.data ?? []).map((r) => [r.id, r.full_name as string]));

  const rows: DueRow[] = ids.flatMap((customerId) => {
    const customer = customers.get(customerId);
    // DND and merged customers are not calls anyone should make.
    if (!customer || customer.is_dnd || customer.merged_into_id) return [];
    const open = openByCustomer.get(customerId);
    const prev = lastCall.get(customerId);
    let dueAt: string | null;
    if (open) dueAt = open.due_at;
    else {
      if (!prev?.next_due_at || !beforeTomorrow(prev.next_due_at)) return [];
      // Bought again since that call: the follow-up it asked for is answered.
      const ordered = lastOrder.get(customerId);
      if (ordered && new Date(ordered).getTime() > new Date(prev.completed_at).getTime()) return [];
      dueAt = prev.next_due_at;
    }
    const dueOn = istDateFromTimestamp(dueAt);
    const task = work.get(customerId);
    const assignedTo = task?.assigned_to ?? null;
    return [{
      id: open?.id ?? `call-${prev!.id}`,
      customer_id: customerId,
      full_name: customer.full_name,
      phone_e164: customer.phone_e164,
      due_on: dueOn,
      overdue_days: Math.max(0, daysBetween(dueOn, today)),
      attempt_no: open?.attempt_no ?? (prev ? prev.attempt_no + 1 : 1),
      reason: prev?.outcome ?? null,
      set_on: prev ? istDateFromTimestamp(prev.completed_at) : null,
      set_by: prev?.owner_id ? repName.get(prev.owner_id) ?? null : null,
      note: prev ? repNote(prev.remark) : null,
      assigned_to: assignedTo ? repName.get(assignedTo) ?? 'Assigned' : null,
      assigned_on: task?.assigned_at ? istDateFromTimestamp(task.assigned_at) : null,
      task_called: !!task?.last_outcome,
      owner: (open?.owner_id ?? prev?.owner_id) ? repName.get((open?.owner_id ?? prev?.owner_id)!) ?? null : null,
    }];
  });

  return <DueTodayView rows={rows} today={today}
    reps={(reps.data ?? []).map((r) => ({ id: r.id as string, full_name: r.full_name as string }))}
    canAssign={CAN_VIEW.includes(me?.role ?? '')} />;
}
