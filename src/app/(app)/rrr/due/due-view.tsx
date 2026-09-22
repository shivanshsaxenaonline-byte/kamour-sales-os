'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { assignRrrWork } from '../actions';
import { CustomerPanel } from '../customer-panel';
import { dayInYear, digitsOf } from '../lib/format';
import { outcomeLabel, outcomeTone } from '../lib/outcomes';

export type DueRow = {
  id: string;
  customer_id: string;
  full_name: string;
  phone_e164: string;
  due_on: string;
  overdue_days: number;
  attempt_no: number;
  /** Outcome of the call that set this date. */
  reason: string | null;
  set_on: string | null;
  set_by: string | null;
  note: string | null;
  assigned_to: string | null;
  assigned_on: string | null;
  /** The assigned rep has logged a call on the task. */
  task_called: boolean;
  owner: string | null;
};

/** Why the lead is back today, in the floor's words. */
const WHY: Record<string, string> = {
  medicine_not_finished: 'Customer ne kaha tha is din dawai khatam hogi',
  will_update_later: 'Customer ne kaha tha is din batayenge',
  connected: 'Baat hui thi — is din dobara call',
  will_buy: 'Interested tha — follow-up',
  no_answer: 'Call not picked — dobara try',
  busy: 'Busy tha — dobara try',
  not_interested: 'Not interested — freeze khatam',
  order_placed: 'Order ke baad course follow-up',
  other: 'Kuch aur baat hui — note padhein',
};

export function DueTodayView({ rows, today, reps, canAssign }: {
  rows: DueRow[];
  today: string;
  reps: { id: string; full_name: string }[];
  canAssign: boolean;
}) {
  const router = useRouter();
  const [when, setWhen] = useState<'today' | 'overdue' | 'all'>('today');
  const [reason, setReason] = useState('all');
  const [rep, setRep] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<DueRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [assigning, startAssign] = useTransition();

  const todayCount = rows.filter((r) => r.overdue_days === 0).length;
  const overdueCount = rows.length - todayCount;
  const reasons = useMemo(() => [...new Set(rows.map((r) => r.reason ?? 'none'))], [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = digitsOf(q);
    return rows.filter((r) => {
      if (when === 'today' && r.overdue_days > 0) return false;
      if (when === 'overdue' && r.overdue_days === 0) return false;
      if (reason !== 'all' && (r.reason ?? 'none') !== reason) return false;
      if (rep === 'unassigned' && r.assigned_to) return false;
      if (rep !== 'all' && rep !== 'unassigned' && (r.assigned_to ?? r.owner) !== rep) return false;
      if (q && !r.full_name.toLowerCase().includes(q) && !(digits && digitsOf(r.phone_e164).includes(digits))) return false;
      return true;
    }).sort((a, b) => b.overdue_days - a.overdue_days || a.full_name.localeCompare(b.full_name));
  }, [rows, when, reason, rep, search]);

  // The header box covers what the filters show; selection outside it stays.
  const shownIds = useMemo(() => shown.map((r) => r.customer_id), [shown]);
  const selectedShown = shownIds.filter((id) => selected.has(id)).length;
  const allShown = shownIds.length > 0 && selectedShown === shownIds.length;
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = selectedShown > 0 && !allShown;
  }, [selectedShown, allShown]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of shownIds) if (allShown) next.delete(id); else next.add(id);
      return next;
    });
  }

  function assign() {
    if (!selected.size || !target) return;
    const ids = [...selected];
    const toName = target === 'unassign' ? null : reps.find((r) => r.id === target)?.full_name ?? 'that rep';
    setMessage(null);
    startAssign(async () => {
      // The database takes at most 250 a call.
      let moved = 0;
      for (let i = 0; i < ids.length; i += 250) {
        const result = await assignRrrWork('due', ids.slice(i, i + 250), target === 'unassign' ? null : target);
        if (!result.ok) { setMessage(moved ? `${moved} done, then: ${result.error}` : result.error); router.refresh(); return; }
        moved += result.moved;
      }
      setSelected(new Set());
      setMessage(toName ? `${moved} leads assigned to ${toName}.` : `${moved} calling assignments removed.`);
      router.refresh();
    });
  }

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>Due today</h1>
        <div className="module-tabs" role="tablist" aria-label="Due views">
          <button type="button" role="tab" aria-selected={when === 'today'} className={when === 'today' ? 'active' : ''} onClick={() => setWhen('today')}>
            Aaj ki date<span>{todayCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={when === 'overdue'} className={when === 'overdue' ? 'active' : ''} onClick={() => setWhen('overdue')}>
            Overdue<span>{overdueCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={when === 'all'} className={when === 'all' ? 'active' : ''} onClick={() => setWhen('all')}>
            Sab<span>{rows.length}</span>
          </button>
        </div>
        <span className="muted">{dayInYear(today)} tak jin leads ki follow-up date aa gayi hai</span>
        {message ? <span className="muted" role="status">{message}</span> : null}
        <div className="toolbar-spacer" />
        <label className="grid-search">
          <span className="sr-only">Search customer</span>
          <input type="search" value={search} placeholder="Name or mobile…" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="sr-only" htmlFor="due-reason">Reason</label>
        <select id="due-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="all">All reasons</option>
          {reasons.map((code) => (
            <option key={code} value={code}>{code === 'none' ? 'Scheduled follow-up' : outcomeLabel(code)}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="due-rep">Salesperson</label>
        <select id="due-rep" value={rep} onChange={(e) => setRep(e.target.value)}>
          <option value="all">All salespeople</option>
          <option value="unassigned">Not assigned</option>
          {reps.map((r) => <option key={r.id} value={r.full_name}>{r.full_name}</option>)}
        </select>
      </div>

      {canAssign ? (
        <div className="grid-toolbar rrr-assignbar">
          <strong>{selected.size} selected</strong>
          <label className="sr-only" htmlFor="due-target">Assign calling task to</label>
          <select id="due-target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={assigning}>
            <option value="">Assign selected calls to…</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            <option value="unassign">— Remove calling assignment —</option>
          </select>
          <button type="button" onClick={assign} disabled={!selected.size || !target || assigning}>
            {assigning ? 'Assigning…' : `Assign ${selected.size || ''}`.trim()}
          </button>
          {selected.size ? <button type="button" onClick={() => setSelected(new Set())} disabled={assigning}>Clear selection</button> : null}
          <span className="muted">Rep call log karte hi lead yahan se hat jayegi.</span>
        </div>
      ) : null}

      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead>
            <tr>
              {canAssign ? (
                <th style={{ width: 32 }}>
                  <input ref={headBox} type="checkbox" checked={allShown} onChange={toggleShown}
                    aria-label="Select every lead shown" />
                </th>
              ) : null}
              <th>Customer</th>
              <th>Due</th>
              <th>Kyun aaj?</th>
              <th>Pichhli call</th>
              <th>Note</th>
              <th>Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              // Handed to a rep who has not called yet: struck through until they do.
              const waiting = !!r.assigned_to && !r.task_called;
              return (
                <tr key={r.id} className={`record-row ${waiting ? 'assigned-waiting' : ''} ${selected.has(r.customer_id) ? 'selected' : ''}`}>
                  {canAssign ? (
                    <td className="no-strike">
                      <input type="checkbox" checked={selected.has(r.customer_id)} onChange={() => toggle(r.customer_id)}
                        aria-label={`Select ${r.full_name}`} />
                    </td>
                  ) : null}
                  <td>
                    <button type="button" className="rrr-customer" onClick={() => setOpen(r)}>
                      <span className="rrr-customer-copy">
                        <strong>{r.full_name}</strong>
                        <span className="muted">{r.phone_e164}</span>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className={`status-pill ${r.overdue_days === 0 ? 'attention' : 'critical'}`}>
                      {r.overdue_days === 0 ? 'Aaj' : `${r.overdue_days}d overdue`}
                    </span>
                    <br />
                    <span className="muted">{dayInYear(r.due_on)}{r.attempt_no > 1 ? ` · attempt ${r.attempt_no}` : ''}</span>
                  </td>
                  <td className="analytics-note">
                    {r.reason
                      ? <span className={`status-pill ${outcomeTone(r.reason)}`}>{outcomeLabel(r.reason)}</span>
                      : <span className="status-pill neutral">Scheduled follow-up</span>}
                    <br />
                    <span className="muted">{r.reason ? WHY[r.reason] ?? 'Follow-up date aa gayi' : 'Follow-up date aa gayi'}</span>
                  </td>
                  <td>
                    {r.set_on ? dayInYear(r.set_on) : <span className="muted">—</span>}
                    {r.set_by ? <><br /><span className="muted">{r.set_by}</span></> : null}
                  </td>
                  <td className="analytics-note">{r.note ?? <span className="muted">—</span>}</td>
                  <td className="no-strike">
                    {waiting ? (
                      <span className="status-pill attention">
                        Assigned {r.assigned_on && r.assigned_on !== today ? dayInYear(r.assigned_on) : 'today'} · {r.assigned_to}
                      </span>
                    ) : r.assigned_to
                      ? <strong>{r.assigned_to}</strong>
                      : <span className="muted">Not assigned{r.owner ? ` · last with ${r.owner}` : ''}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <div className="grid-empty">
            <p>{rows.length ? 'Is filter mein koi lead nahi hai.' : 'Aaj koi follow-up due nahi hai.'}</p>
          </div>
        ) : null}
      </div>

      {open ? (
        <CustomerPanel customerId={open.customer_id} name={open.full_name} phone={open.phone_e164} onClose={() => setOpen(null)} />
      ) : null}
    </section>
  );
}
