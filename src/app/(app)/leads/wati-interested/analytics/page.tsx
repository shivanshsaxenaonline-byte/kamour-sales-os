import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { addDaysIso, istToday } from '@/app/(app)/rrr/lib/format';
import { AnalyticsView, type CallLine, type RepDay } from './analytics-view';

export const dynamic = 'force-dynamic';

const CAN_AUDIT = ['admin', 'ceo', 'coo', 'auditor'];

/** Outcomes where the lead actually spoke to the rep. */
const CONNECTED = new Set(['will_buy', 'medicine_not_finished', 'will_update_later', 'connected', 'not_interested']);
const NOT_PICKED = new Set(['no_answer', 'busy']);

type RawCall = {
  id: string;
  work_id: string;
  owner_id: string;
  outcome: string | null;
  note: string | null;
  next_due_on: string | null;
  attempt_no: number;
  called_at: string;
  contact_number_id: string | null;
  wati_work_items: {
    display_name: string;
    phone_e164: string;
    lead_source: string | null;
    customer_id: string | null;
  } | null;
};

/**
 * One day of WATI Interested calling, rep by rep — the same day view as RRR
 * Analytics, over the leads Alka handed out from the WhatsApp list instead of
 * the order base.
 *
 * A "call" is a row in wati_work_calls whose called_at falls on the chosen IST
 * day. "Assigned" and "Open" come from wati_work_items, which holds each
 * lead's current state, so a lead handed to a second rep counts for that rep.
 */
export default async function WatiAnalyticsPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
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

  const [calls, reps, assigned, open, numbers] = await Promise.all([
    db.from('wati_work_calls')
      .select(`id, work_id, owner_id, outcome, note, next_due_on, attempt_no, called_at,
        contact_number_id,
        wati_work_items!inner(display_name, phone_e164, lead_source, customer_id)`)
      .gte('called_at', start).lt('called_at', end)
      .order('called_at', { ascending: true }).limit(2000),
    db.from('users').select('id, full_name').in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
    db.from('wati_work_items').select('assigned_to')
      .gte('assigned_at', start).lt('assigned_at', end).limit(3000),
    db.from('wati_work_items').select('assigned_to')
      .is('completed_at', null).lte('due_on', date).limit(3000),
    db.from('contact_numbers').select('id, label_en'),
  ]);

  if (calls.error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>WATI Interested Analytics</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load the day’s calls.</p>
          <p className="muted">{calls.error.message}</p>
        </div>
      </section>
    );
  }

  const numberById = new Map((numbers.data ?? []).map((n) => [n.id, n.label_en as string]));
  const repName = new Map((reps.data ?? []).map((r) => [r.id, r.full_name as string]));

  const lines: CallLine[] = ((calls.data ?? []) as unknown as RawCall[]).map((c) => ({
    id: c.id,
    work_id: c.work_id,
    customer_id: c.wati_work_items?.customer_id ?? null,
    full_name: c.wati_work_items?.display_name ?? 'WATI lead',
    phone_e164: c.wati_work_items?.phone_e164 ?? '',
    lead_source: c.wati_work_items?.lead_source ?? null,
    rep_id: c.owner_id,
    rep_name: repName.get(c.owner_id) ?? 'Other user',
    outcome: c.outcome,
    note: c.note,
    called_at: c.called_at,
    next_due_on: c.next_due_on,
    attempt_no: c.attempt_no,
    called_from: c.contact_number_id ? numberById.get(c.contact_number_id) ?? null : null,
  }));

  const count = <T,>(rows: T[], pick: (r: T) => string | null) => {
    const m = new Map<string | null, number>();
    for (const r of rows) m.set(pick(r), (m.get(pick(r)) ?? 0) + 1);
    return m;
  };
  const assignedBy = count(assigned.data ?? [], (w) => w.assigned_to);
  const openBy = count(open.data ?? [], (w) => w.assigned_to);

  const dayFor = (id: string | null, name: string): RepDay => {
    const mine = lines.filter((l) => l.rep_id === id);
    return {
      id, name,
      assigned: assignedBy.get(id) ?? 0,
      open: openBy.get(id) ?? 0,
      calls: mine.length,
      leads: new Set(mine.map((l) => l.work_id)).size,
      connected: mine.filter((l) => l.outcome && CONNECTED.has(l.outcome)).length,
      notPicked: mine.filter((l) => l.outcome && NOT_PICKED.has(l.outcome)).length,
      interested: mine.filter((l) => l.outcome === 'will_buy').length,
      scheduled: mine.filter((l) => l.next_due_on).length,
    };
  };

  const repDays = (reps.data ?? []).map((r) => dayFor(r.id, r.full_name));
  // Calls by someone who is no longer an active rep still happened; they get a
  // card rather than silently dropping out of the totals.
  const others = [...new Set(lines.map((l) => l.rep_id))].filter((id) => !repName.has(id));
  for (const id of others) repDays.push(dayFor(id, lines.find((l) => l.rep_id === id)!.rep_name));

  return <AnalyticsView date={date} today={today} reps={repDays} lines={lines} />;
}
