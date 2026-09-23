import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { workSourceLabel, workSourceTone, type WorkSource } from '@/lib/work-tags';
import { dayLong } from '../lib/format';
import { money } from '../lib/format';
import { outcomeLabel } from '../lib/outcomes';
import { sortByValue, VALUE_SORTS } from '../lib/sort';
import { WorkSort } from './work-sort';

export const dynamic = 'force-dynamic';

type Item = {
  id: string;
  source: 'ai' | 'medicine_ending' | 'due';
  assigned_to: string | null;
  due_on: string;
  last_outcome: string | null;
  medicine_days_left: number | null;
  completed_at: string | null;
  customers: { full_name: string; phone_e164: string } & CustomerValue | null;
  orders: { order_no: string } | null;
};

type WatiItem = {
  id: string;
  assigned_to: string;
  due_on: string;
  last_outcome: string | null;
  medicine_days_left: number | null;
  completed_at: string | null;
  display_name: string;
  phone_e164: string;
  primary_concern: string | null;
  customers: CustomerValue | null;
};

type CustomerValue = { lifetime_value: number; lifetime_orders: number; last_order_at: string | null };

/** One row of the table, whichever table it came from. */
type Row = {
  id: string;
  source: WorkSource;
  name: string;
  phone: string;
  /** The order number, or what a WATI lead has instead of one. */
  about: string;
  assigned_to: string | null;
  due_on: string;
  completed_at: string | null;
  last_outcome: string | null;
  medicine_days_left: number | null;
  ltv: number;
  lifetime_orders: number;
  last_order_at: string | null;
};

export default async function RrrAssignedWorkPage(
  { searchParams }: { searchParams: Promise<{ sort?: string }> },
) {
  const asked = (await searchParams).sort ?? '';
  const sort = VALUE_SORTS.some((o) => o.value === asked) ? asked : 'due';
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) redirect('/login');
  const { data: me } = await db.from('users').select('role').eq('id', user.id).single();
  if (me?.role === 'sales_exec' || me?.role === 'sales_manager') redirect('/rrr/my');
  if (!['admin', 'ceo', 'coo', 'auditor'].includes(me?.role ?? ''))
    redirect('/');

  const select = `id,source,assigned_to,due_on,last_outcome,medicine_days_left,completed_at,
    customers!inner(full_name,phone_e164,lifetime_value,lifetime_orders,last_order_at),orders!inner(order_no)`;
  const watiSelect = `id,assigned_to,due_on,last_outcome,medicine_days_left,completed_at,
    display_name,phone_e164,primary_concern,customers(lifetime_value,lifetime_orders,last_order_at)`;
  const [active, completed, watiActive, watiCompleted, reps] = await Promise.all([
    db.from('rrr_work_items').select(select).is('completed_at', null)
      .order('due_on', { ascending: true }).limit(500),
    db.from('rrr_work_items').select(select).not('completed_at', 'is', null)
      .order('completed_at', { ascending: false }).limit(100),
    db.from('wati_work_items').select(watiSelect).is('completed_at', null)
      .order('due_on', { ascending: true }).limit(500),
    db.from('wati_work_items').select(watiSelect).not('completed_at', 'is', null)
      .order('completed_at', { ascending: false }).limit(100),
    db.from('users').select('id,full_name').in('role', ['sales_exec', 'sales_manager']),
  ]);
  if (active.error || completed.error) return <section className="data-grid">
    <div className="grid-toolbar"><h1>Assigned RRR work</h1></div>
    <div className="grid-empty" role="alert">Could not load assignments: {active.error?.message ?? completed.error?.message}</div>
  </section>;
  // The WATI hand-overs are one source among four here. Losing them should
  // narrow this table, not empty it.
  const watiError = watiActive.error ?? watiCompleted.error;
  if (watiError) console.error('[rrr/work] WATI Interested assignments unavailable', { error: watiError });

  const names = new Map((reps.data ?? []).map((rep) => [rep.id, rep.full_name]));
  const rrrRows = ([...(active.data ?? []), ...(completed.data ?? [])] as unknown as Item[])
    .map((item): Row => ({
      id: item.id,
      source: item.source,
      name: item.customers?.full_name ?? 'Customer',
      phone: item.customers?.phone_e164 ?? '',
      about: item.orders?.order_no ?? '—',
      assigned_to: item.assigned_to,
      due_on: item.due_on,
      completed_at: item.completed_at,
      last_outcome: item.last_outcome,
      medicine_days_left: item.medicine_days_left,
      ltv: Number(item.customers?.lifetime_value ?? 0),
      lifetime_orders: item.customers?.lifetime_orders ?? 0,
      last_order_at: item.customers?.last_order_at ?? null,
    }));
  const watiRows = ([...(watiActive.data ?? []), ...(watiCompleted.data ?? [])] as unknown as WatiItem[])
    .map((item): Row => ({
      id: item.id,
      source: 'wati_interested',
      name: item.display_name,
      phone: item.phone_e164,
      about: item.primary_concern ?? 'WhatsApp lead',
      assigned_to: item.assigned_to,
      due_on: item.due_on,
      completed_at: item.completed_at,
      last_outcome: item.last_outcome,
      medicine_days_left: item.medicine_days_left,
      ltv: Number(item.customers?.lifetime_value ?? 0),
      lifetime_orders: item.customers?.lifetime_orders ?? 0,
      last_order_at: item.customers?.last_order_at ?? null,
    }));
  const items = sortByValue([...rrrRows, ...watiRows], sort, (item) => ({
    ltv: item.ltv, orders: item.lifetime_orders, last_order_at: item.last_order_at, name: item.name,
  }));
  const openCount = (active.data?.length ?? 0) + (watiActive.data?.length ?? 0);
  const doneCount = (completed.data?.length ?? 0) + (watiCompleted.data?.length ?? 0);

  return <section className="data-grid">
    <div className="grid-toolbar"><h1>Assigned RRR work</h1>
      <div className="module-tabs"><Link href="/rrr/ai">AI Leads</Link>
        <Link href="/rrr/medicine-ending">Medicine Ending</Link>
        <Link href="/rrr/work" className="active" aria-current="page">Assigned work</Link>
        <Link href="/rrr/analytics">Analytics</Link></div>
      <span className="muted">{openCount} active · {doneCount} recently completed</span>
      <div className="toolbar-spacer" />
      <WorkSort value={sort} />
    </div>
    <div className="grid-scroll"><table className="records-table rrr-table">
      <thead><tr><th>Customer</th><th>Source</th><th>Order / lead</th><th>Assigned to</th>
        <th>Due / status</th><th>Last outcome</th></tr></thead>
      <tbody>{items.map((item) => <tr key={`${item.source}-${item.id}`} className="record-row">
        <td><strong>{item.name}</strong><br />
          <span className="muted">{item.phone}</span>
          {item.lifetime_orders ? <><br /><span className="muted">
            LTV {money(item.ltv)} · {item.lifetime_orders} {item.lifetime_orders === 1 ? 'order' : 'orders'}</span></> : null}</td>
        <td><span className={`status-pill ${workSourceTone(item.source)}`}>
          {workSourceLabel(item.source)}</span></td>
        <td>{item.about}</td>
        <td>{item.assigned_to ? names.get(item.assigned_to) ?? 'Assigned rep' : 'Unassigned'}</td>
        <td>{item.completed_at ? 'Completed' : dayLong(item.due_on)}</td>
        <td>{outcomeLabel(item.last_outcome) ?? 'Not called yet'}
          {item.medicine_days_left ? <><br /><span className="muted">
            {item.medicine_days_left} medicine days left</span></> : null}</td>
      </tr>)}</tbody>
    </table>{items.length === 0 ? <div className="grid-empty">No assignments yet. Select leads from AI Leads, Medicine Ending or WATI Interested.</div> : null}</div>
  </section>;
}
