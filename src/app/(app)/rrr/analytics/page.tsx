import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { addDaysIso, istDateFromTimestamp, istToday } from '../lib/format';
import { AUTOMATIC_REMARK, repNote } from '../lib/notes';
import { AnalyticsView, type CallLine, type PotentialLine, type RepDay, type TaskLine } from './analytics-view';

export const dynamic = 'force-dynamic';

const CAN_AUDIT = ['admin', 'ceo', 'coo', 'auditor'];

/** Outcomes where the customer actually spoke to the rep. `other` counts:
 *  the dialog only accepts it with a note describing the conversation. */
const CONNECTED = new Set(['order_placed', 'will_buy', 'medicine_not_finished', 'will_update_later', 'connected', 'not_interested', 'other']);
const NOT_PICKED = new Set(['no_answer', 'busy']);

const TASK_COLUMNS = `id, assigned_to, source, due_on, assigned_at, completed_at, last_outcome,
  last_called_at, customer_id, customers(full_name, phone_e164)`;

type RawTask = {
  id: string; assigned_to: string | null; source: TaskLine['source']; due_on: string;
  assigned_at: string; completed_at: string | null; last_outcome: string | null;
  last_called_at: string | null; customer_id: string;
  customers: { full_name: string; phone_e164: string } | null;
};

// WATI Interested carries its own tables — its leads have no order to hang a
// follow-up on, so a call lands in wati_work_calls rather than followups. The
// shapes are otherwise parallel, which is what makes one screen possible.
const WATI_TASK_COLUMNS = `id, assigned_to, due_on, assigned_at, completed_at, last_outcome,
  last_called_at, customer_id, display_name, phone_e164`;

// Pending work is read the way the rep's own list reads it — customer and order
// inner-joined — so a task the rep cannot see is not counted against them.
const PENDING_COLUMNS = `id, assigned_to, source, due_on, assigned_at, completed_at, last_outcome,
  last_called_at, customer_id, customers!inner(full_name, phone_e164), orders!inner(id)`;

type RawWatiTask = {
  id: string; assigned_to: string | null; due_on: string; assigned_at: string;
  completed_at: string | null; last_outcome: string | null; last_called_at: string | null;
  customer_id: string | null; display_name: string; phone_e164: string;
};

type RawWatiCall = {
  id: string; work_id: string; owner_id: string; outcome: string | null; note: string | null;
  next_due_on: string | null; attempt_no: number; called_at: string; contact_number_id: string | null;
  wati_work_items: { display_name: string; phone_e164: string; customer_id: string | null } | null;
};


/**
 * One day of RRR calling, rep by rep, for auditing the assigned work: who was
 * called, what the customer said, and what is still waiting.
 *
 * Both calling streams, on one screen. RRR work (AI Leads, Due today, Medicine
 * Ending) lives in rrr_work_items and logs its calls to followups; WATI
 * Interested lives in wati_work_items and logs to wati_work_calls. They used to
 * have an analytics page each, which meant the manager auditing the day had to
 * add two screens together in their head — and the rep's own list had merged
 * them all along, so neither page matched what the rep was looking at.
 *
 * A "call" is a completed order follow-up, or a WATI call, timestamped on the
 * chosen IST day. Assigned and open counts come from the two work tables,
 * which hold each task's current state — a reassigned task counts for its new
 * rep.
 */
export default async function RrrAnalyticsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await db.from('users').select('role').eq('id', user.id).single();
  if (me?.role === 'sales_exec' || me?.role === 'sales_manager') redirect('/rrr/my');
  if (!CAN_AUDIT.includes(me?.role ?? '')) redirect('/');

  const today = istToday();
  const asked = (await searchParams).date ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const start = `${date}T00:00:00+05:30`;
  const end = `${addDaysIso(date, 1)}T00:00:00+05:30`;

  const [calls, reps, assigned, open, numbers, watiCalls, watiAssigned, watiOpen, potential] = await Promise.all([
    db.from('followups')
      .select('id, customer_id, order_id, owner_id, outcome, remark, completed_at, next_due_at, attempt_no, contact_number_id')
      .eq('kind', 'order').gte('completed_at', start).lt('completed_at', end)
      .order('completed_at', { ascending: true }).limit(2000),
    db.from('users').select('id, full_name').in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
    // Full rows, not just owners: the Assigned and Open tiles open these lists.
    db.from('rrr_work_items').select(TASK_COLUMNS)
      .gte('assigned_at', start).lt('assigned_at', end).limit(3000),
    // Pending work: what sits in each rep's "Aaj ke calls" tab right now —
    // open, due today or earlier, and not already called today. Always live,
    // whatever day is being audited: yesterday's backlog cannot be rebuilt
    // from current task state, and the number that matters is what is waiting
    // on the rep now. Forward-dated follow-ups (their Upcoming tab) are not
    // pending.
    db.from('rrr_work_items').select(PENDING_COLUMNS)
      .is('completed_at', null).lte('due_on', today).limit(5000),
    db.from('contact_numbers').select('id, label_en'),
    db.from('wati_work_calls')
      .select(`id, work_id, owner_id, outcome, note, next_due_on, attempt_no, called_at,
        contact_number_id, wati_work_items!inner(display_name, phone_e164, customer_id)`)
      .gte('called_at', start).lt('called_at', end)
      .order('called_at', { ascending: true }).limit(2000),
    db.from('wati_work_items').select(WATI_TASK_COLUMNS)
      .gte('assigned_at', start).lt('assigned_at', end).limit(3000),
    // Same rule as the RRR half above.
    db.from('wati_work_items').select(WATI_TASK_COLUMNS)
      .is('completed_at', null).lte('due_on', today).limit(5000),
    // Every lead a rep has pinned as potential and nobody has removed. Like
    // pending work, a standing count rather than one day's.
    db.from('potential_leads')
      .select('id, marked_by, source, customer_id, display_name, phone_e164, order_no, note, marked_at')
      .is('removed_at', null).order('marked_at', { ascending: false }).limit(5000),
  ]);

  if (calls.error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>RRR Analytics</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load the day’s calls.</p>
          <p className="muted">{calls.error.message}</p>
        </div>
      </section>
    );
  }

  // A WATI read that fails must not take the RRR half of the day down with it.
  if (watiCalls.error) console.error('[rrr/analytics] WATI calls unavailable', { error: watiCalls.error });

  const callRows = calls.data ?? [];
  const customerIds = [...new Set(callRows.map((c) => c.customer_id))];
  const { data: customers } = customerIds.length
    ? await db.from('customers').select('id, full_name, phone_e164').in('id', customerIds)
    : { data: [] };
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]));
  const numberById = new Map((numbers.data ?? []).map((n) => [n.id, n.label_en as string]));
  const repName = new Map((reps.data ?? []).map((r) => [r.id, r.full_name as string]));

  // The system also closes follow-ups on its own when an order converts or a
  // delivery schedules the next course call. Those are not a rep's calls.
  const isAutomatic = (remark: string | null) => AUTOMATIC_REMARK.test(remark ?? '');
  const automatic = callRows.filter((c) => isAutomatic(c.remark)).length;

  const rrrLines: CallLine[] = callRows.filter((c) => !isAutomatic(c.remark)).map((c) => ({
    id: c.id,
    customer_id: c.customer_id,
    full_name: customerById.get(c.customer_id)?.full_name ?? 'Customer',
    phone_e164: customerById.get(c.customer_id)?.phone_e164 ?? '',
    rep_id: c.owner_id,
    rep_name: c.owner_id ? repName.get(c.owner_id) ?? 'Other user' : 'Not recorded',
    outcome: c.outcome,
    note: repNote(c.remark),
    completed_at: c.completed_at!,
    next_due_at: c.next_due_at,
    attempt_no: c.attempt_no,
    called_from: c.contact_number_id ? numberById.get(c.contact_number_id) ?? null : null,
    subject_key: c.customer_id,
    channel: 'rrr',
  }));

  const watiLines: CallLine[] = ((watiCalls.data ?? []) as unknown as RawWatiCall[]).map((c) => ({
    id: c.id,
    customer_id: c.wati_work_items?.customer_id ?? null,
    // A prospect with no customer row is still one person across their calls.
    subject_key: c.wati_work_items?.customer_id ?? `wati:${c.work_id}`,
    channel: 'wati_interested',
    full_name: c.wati_work_items?.display_name ?? 'WATI lead',
    phone_e164: c.wati_work_items?.phone_e164 ?? '',
    rep_id: c.owner_id,
    rep_name: repName.get(c.owner_id) ?? 'Other user',
    outcome: c.outcome,
    note: c.note,
    completed_at: c.called_at,
    next_due_at: c.next_due_on,
    attempt_no: c.attempt_no,
    called_from: c.contact_number_id ? numberById.get(c.contact_number_id) ?? null : null,
  }));

  // One log, in the order the calls happened, whichever list they came off.
  const lines = [...rrrLines, ...watiLines]
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at));

  const count = <T,>(rows: T[], pick: (r: T) => string | null) => {
    const m = new Map<string | null, number>();
    for (const r of rows) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
    return m;
  };
  const toTask = (w: RawTask): TaskLine => ({
    id: w.id,
    customer_id: w.customer_id,
    full_name: w.customers?.full_name ?? 'Customer',
    phone_e164: w.customers?.phone_e164 ?? '',
    rep_id: w.assigned_to,
    rep_name: w.assigned_to ? repName.get(w.assigned_to) ?? 'Other user' : 'Not assigned',
    source: w.source,
    due_on: w.due_on,
    assigned_at: w.assigned_at,
    completed_at: w.completed_at,
    last_outcome: w.last_outcome,
    last_called_at: w.last_called_at,
  });
  const toWatiTask = (w: RawWatiTask): TaskLine => ({
    id: w.id,
    customer_id: w.customer_id,
    full_name: w.display_name,
    phone_e164: w.phone_e164,
    rep_id: w.assigned_to,
    rep_name: w.assigned_to ? repName.get(w.assigned_to) ?? 'Other user' : 'Not assigned',
    source: 'wati_interested',
    due_on: w.due_on,
    assigned_at: w.assigned_at,
    completed_at: w.completed_at,
    last_outcome: w.last_outcome,
    last_called_at: w.last_called_at,
  });
  const assignedTasks = [
    ...((assigned.data ?? []) as unknown as RawTask[]).map(toTask),
    ...((watiAssigned.data ?? []) as unknown as RawWatiTask[]).map(toWatiTask),
  ];
  if (open.error) console.error('[rrr/analytics] pending RRR work unavailable', { error: open.error });
  if (watiOpen.error) console.error('[rrr/analytics] pending WATI work unavailable', { error: watiOpen.error });
  const calledToday = (t: TaskLine) => !!t.last_called_at && istDateFromTimestamp(t.last_called_at) === today;
  const openTasks = [
    ...((open.data ?? []) as unknown as RawTask[]).map(toTask),
    ...((watiOpen.data ?? []) as unknown as RawWatiTask[]).map(toWatiTask),
  ].filter((t) => !calledToday(t));

  if (potential.error) console.error('[rrr/analytics] potential leads unavailable', { error: potential.error });
  const potentialLeads: PotentialLine[] = (potential.data ?? []).map((p) => ({
    id: p.id,
    customer_id: p.customer_id,
    full_name: p.display_name,
    phone_e164: p.phone_e164,
    rep_id: p.marked_by,
    rep_name: repName.get(p.marked_by) ?? 'Other user',
    source: p.source as PotentialLine['source'],
    order_no: p.order_no,
    note: p.note,
    marked_at: p.marked_at,
  }));
  const potentialBy = count(potentialLeads, (p) => p.rep_id);
  const assignedBy = count(assignedTasks, (w) => w.rep_id);
  const openBy = count(openTasks, (w) => w.rep_id);

  const dayFor = (id: string | null, name: string): RepDay => {
    const mine = lines.filter((l) => l.rep_id === id);
    return {
      id, name,
      assigned: assignedBy.get(id) ?? 0,
      open: openBy.get(id) ?? 0,
      potential: potentialBy.get(id) ?? 0,
      calls: mine.length,
      customers: new Set(mine.map((l) => l.subject_key)).size,
      connected: mine.filter((l) => l.outcome && CONNECTED.has(l.outcome)).length,
      notPicked: mine.filter((l) => l.outcome && NOT_PICKED.has(l.outcome)).length,
      orders: mine.filter((l) => l.outcome === 'order_placed').length,
      scheduled: mine.filter((l) => l.next_due_at).length,
    };
  };

  const repDays = (reps.data ?? []).map((r) => dayFor(r.id, r.full_name));
  // Calls by someone who is not an active rep (or with no owner at all) still
  // happened; they get a card rather than silently dropping out of the totals.
  const others = [...new Set(lines.map((l) => l.rep_id))].filter((id) => !id || !repName.has(id));
  for (const id of others) repDays.push(dayFor(id, lines.find((l) => l.rep_id === id)!.rep_name));

  return <AnalyticsView date={date} today={today} reps={repDays} lines={lines}
    assignedTasks={assignedTasks} openTasks={openTasks} potentialLeads={potentialLeads}
    automatic={automatic} />;
}
