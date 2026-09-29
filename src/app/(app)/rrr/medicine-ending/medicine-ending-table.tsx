'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { LogCallDialog, type CallTarget, type ContactNumber } from '../log-call-dialog';
import { CustomerPanel } from '../customer-panel';
import { assignRrrWork } from '../actions';
import { dayLong as day, digitsOf, istDateFromTimestamp, money } from '../lib/format';
import { outcomeLabel } from '../lib/outcomes';
import { daysSinceOrder, priorityOf, PRIORITY_SORT, sortByPriority } from '../lib/priority';
import { sortByValue, VALUE_SORTS } from '../lib/sort';
import { PriorityPill } from '../priority-pill';
import { SortSelect } from '../sort-select';

export type MedicineEndingRow = {
  order_id: string;
  order_no: string;
  customer_id: string;
  full_name: string;
  phone_e164: string;
  is_dnd: boolean;
  amount: number;
  /** The customer's lifetime value and order count, across every order. */
  ltv: number;
  lifetime_orders: number;
  last_order_at: string | null;
  course_duration_days: number;
  delivered_on: string;
  ends_on: string;
  /** True when this date came from what the customer told a rep on a call,
   *  rather than from delivery date + course length. */
  ends_on_stated: boolean;
  days_left: number;
  assigned_to: string | null;
  assigned_at: string | null;
  due_on: string | null;
  last_outcome: string | null;
  medicine_days_left: number | null;
  completed_at: string | null;
};

function endState(days: number) {
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: 'critical' };
  if (days === 0) return { text: 'Ends today', tone: 'critical' };
  if (days <= ACTION_LEAD_DAYS) return { text: `${days}d left`, tone: 'attention' };
  if (days <= 7) return { text: `${days}d left`, tone: 'positive-outline' };
  return { text: `${days}d left`, tone: 'neutral' };
}

// How many days before the medicine runs out a customer joins the calling
// list. Seven days was too early: on a 30-day course that is a call a full
// week before there is anything to reorder, and the customer says so — which
// is the call that teaches them to stop picking up. Three days is the floor's
// own answer to "when should I ring them". Due and overdue work is shown on
// its separate queue rather than extending this list.
const ACTION_LEAD_DAYS = 3;

/** An open task another rep holds. It cannot be assigned again until the task
 * is called, completed, or removed. */
function waitingForCall(row: MedicineEndingRow) {
  return !!row.assigned_to && !row.last_outcome && !row.completed_at;
}

export function MedicineEndingTable({
  rows, numbers, preferredNumberId, reps, canAssign, canLog, today,
}: {
  rows: MedicineEndingRow[];
  numbers: ContactNumber[];
  /** The handset this rep last called from, seeding the Log-call dialog. */
  preferredNumberId: string | null;
  reps: { id: string; full_name: string }[];
  canAssign: boolean;
  canLog: boolean;
  today: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [duration, setDuration] = useState('all');
  const [sort, setSort] = useState(PRIORITY_SORT.value);
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [openRow, setOpenRow] = useState<MedicineEndingRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [assigning, startAssignment] = useTransition();

  // This screen is often opened directly, bypassing the Orders workspace
  // where the sheet sync normally runs. Pull the sheet once so an order joins
  // this list as soon as its Delivered Date is filled in by Ops.
  useEffect(() => {
    void fetch('/api/sheets/orders/sync', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok && response.status !== 202) return null;
        return response.json() as Promise<{ created?: number; updated?: number }>;
      })
      .then((result) => {
        if ((result?.created ?? 0) + (result?.updated ?? 0) > 0) router.refresh();
      })
      // Keep the current calling list usable if the source sheet is briefly
      // unavailable. The next page visit retries the sync.
      .catch(() => undefined);
  }, [router]);

  // An outstanding assignment is already on a rep's calling list, so it must
  // not appear here at all. This queue contains only rows that can be assigned.
  const actionableRows = useMemo(() => rows.filter((row) => {
    if (row.is_dnd) return false;
    return !waitingForCall(row);
  }), [rows]);

  // A course running out now, on a customer who bought within 75 days, is the
  // order moment itself.
  const priority = useMemo(() => new Map(rows.map((r) => {
    const days = daysSinceOrder(r.last_order_at, today);
    const courseEnding = r.days_left >= 0 && r.days_left <= ACTION_LEAD_DAYS;
    return [r.order_id, { days, tier: priorityOf({ daysSinceOrder: days, orders: r.lifetime_orders, ltv: r.ltv, courseEnding }) }];
  })), [rows, today]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = digitsOf(q);
    const kept = actionableRows.filter((r) => {
      if (duration !== 'all' && r.course_duration_days !== Number(duration)) return false;
      if (q) {
        const byName = r.full_name.toLowerCase().includes(q);
        const byPhone = digits.length > 0 && digitsOf(r.phone_e164).includes(digits);
        const byOrder = r.order_no.toLowerCase().includes(q);
        if (!byName && !byPhone && !byOrder) return false;
      }
      return true;
    });
    // The rows arrive ending-soonest first; "amount" is this order's value.
    if (sort === 'amount') return [...kept].sort((a, b) => b.amount - a.amount);
    if (sort === PRIORITY_SORT.value) return sortByPriority(kept, (r) => priority.get(r.order_id)!.tier);
    return sortByValue(kept, sort, (r) => ({
      ltv: r.ltv, orders: r.lifetime_orders, last_order_at: r.last_order_at, name: r.full_name,
    }));
  }, [actionableRows, search, duration, sort, priority]);

  const actionCount = actionableRows.length;
  const selectable = visible.filter((row) => !row.is_dnd && !waitingForCall(row)).map((row) => row.order_id);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));

  function assignSelected() {
    if (!selected.size || !target) return;
    startAssignment(async () => {
      const result = await assignRrrWork('medicine_ending', [...selected],
        target === 'unassign' ? null : target);
      if (!result.ok) { setMessage(result.error); return; }
      setMessage(`${result.moved} medicine follow-up tasks assigned.`);
      setSelected(new Set());
      router.refresh();
    });
  }

  const callTargetFor = (r: MedicineEndingRow): CallTarget => ({
    customerId: r.customer_id,
    name: r.full_name,
    phone: r.phone_e164,
    followupId: null,
    orderId: r.order_id,
  });

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>Medicine Ending</h1>
        <div className="module-tabs">
          <Link href="/rrr">All customers</Link>
          <Link href="/rrr/ai">AI Leads · today</Link>
          <Link href="/rrr/medicine-ending" className="active" aria-current="page">Medicine Ending<span>{actionCount}</span></Link>
        </div>
        <span className="muted">
          Showing {visible.length.toLocaleString('en-IN')} of {actionableRows.length.toLocaleString('en-IN')} assignable customers on a delivered course · today {day(today)}
        </span>
        {message ? <span className="muted" role="status">{message}</span> : null}
      </div>

      {canAssign ? (
        <div className="grid-toolbar rrr-assignbar">
          <strong>{selected.size} selected</strong>
          <button type="button" onClick={() => setSelected(new Set(allSelected ? [] : selectable))}
            disabled={selectable.length === 0 || assigning}>
            {allSelected ? 'Clear visible selection' : `Select ${selectable.length} visible`}
          </button>
          <label className="sr-only" htmlFor="medicine-assign-target">Assign calling tasks to</label>
          <select id="medicine-assign-target" value={target} onChange={(event) => setTarget(event.target.value)}
            disabled={assigning}>
            <option value="">Assign selected calls to…</option>
            {reps.map((rep) => <option key={rep.id} value={rep.id}>{rep.full_name}</option>)}
            <option value="unassign">— Remove calling assignment —</option>
          </select>
          <button type="button" onClick={assignSelected} disabled={!selected.size || !target || assigning}>
            {assigning ? 'Assigning…' : 'Assign tasks'}
          </button>
        </div>
      ) : null}

      <div className="rrr-filters" id="medicine-ending-filters">
        <div className="rrr-filter-grid">
          <label className="rrr-field wide">
            <span>Search customer</span>
            <input
              type="search"
              value={search}
              placeholder="Name, mobile number or order..."
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="rrr-field">
            <span>Course duration</span>
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option value="all">15d and 30d</option>
              <option value="15">15 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <SortSelect id="medicine-ending-sort" value={sort} onChange={setSort}
            first={PRIORITY_SORT}
            options={[{ value: 'ending', label: 'Ending soonest' }, ...VALUE_SORTS.slice(0, 2), { value: 'amount', label: 'Highest order amount first' },
              ...VALUE_SORTS.slice(2)]} />
        </div>
      </div>

      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead>
            <tr>
              {canAssign ? <th style={{ width: 32 }}>Select</th> : null}
              <th>Customer</th>
              <th>Order</th>
              <th className="num">Amount</th>
              <th className="num">LTV</th>
              <th>Delivered</th>
              <th>Course</th>
              <th>Expected ending</th>
              <th>Status</th>
              <th>Assigned to</th>
              <th>Last call outcome</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const state = endState(r.days_left);
              const assignee = r.assigned_to ? reps.find((rep) => rep.id === r.assigned_to)?.full_name ?? 'Assigned' : null;
              const waiting = waitingForCall(r);
              return (
                <tr key={r.order_id} className={`record-row ${waiting ? 'assigned-waiting' : ''}`}>
                  {canAssign ? (
                    <td className="no-strike"><input type="checkbox" checked={selected.has(r.order_id)} disabled={r.is_dnd || waiting}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(r.order_id)) next.delete(r.order_id); else next.add(r.order_id);
                        return next;
                      })} aria-label={`Select ${r.full_name}`} /></td>
                  ) : null}
                  <td>
                    <button type="button" className="rrr-customer" onClick={() => setOpenRow(r)}>
                      <span className="rrr-customer-copy">
                        <strong>{r.full_name}</strong>
                        <span className="muted">{r.phone_e164}{r.is_dnd ? ' · DND' : ''}</span>
                      </span>
                    </button>
                    <PriorityPill priority={priority.get(r.order_id)!.tier} days={priority.get(r.order_id)!.days} />
                  </td>
                  <td>{r.order_no}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td className="num">{money(r.ltv)}
                    <br /><span className="muted">{r.lifetime_orders} {r.lifetime_orders === 1 ? 'order' : 'orders'}</span></td>
                  <td>{day(r.delivered_on)}</td>
                  <td>{r.course_duration_days} days</td>
                  <td>{day(r.ends_on)}
                    {r.ends_on_stated ? <><br /><span className="muted">per last call</span></> : null}</td>
                  <td><span className={`status-pill ${state.tone}`}>{state.text}</span></td>
                  <td className="no-strike">{waiting
                    ? <span className="status-pill attention">
                        Assigned {r.assigned_at && istDateFromTimestamp(r.assigned_at) !== today ? day(r.assigned_at) : 'today'} · {assignee}
                      </span>
                    : assignee ? `${r.completed_at ? 'Completed by ' : 'Called by '}${assignee}` : 'Not assigned'}</td>
                  <td>{outcomeLabel(r.last_outcome) ?? 'Not called yet'}
                    {r.medicine_days_left ? <><br /><span className="muted">
                      {r.medicine_days_left} medicine days left</span></> : null}</td>
                  <td className="no-strike">{canLog ? <button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="grid-empty">
            <p>No current 15/30 day medicine courses match this filter.</p>
          </div>
        ) : null}
      </div>

      {openRow ? (
        <CustomerPanel
          customerId={openRow.customer_id}
          name={openRow.full_name}
          phone={openRow.phone_e164}
          onClose={() => setOpenRow(null)}
          onLogCall={canLog ? () => { setCalling(callTargetFor(openRow)); setOpenRow(null); } : undefined}
        />
      ) : null}

      {calling ? (
        <LogCallDialog
          target={calling}
          numbers={numbers}
          preferredNumberId={preferredNumberId}
          onClose={() => setCalling(null)}
          onSaved={(msg) => { setCalling(null); setMessage(msg); }}
        />
      ) : null}
    </section>
  );
}
