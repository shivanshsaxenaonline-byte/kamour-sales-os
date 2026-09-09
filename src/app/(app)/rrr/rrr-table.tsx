'use client';

import { useMemo, useState, useTransition } from 'react';
import { assignRrr } from './actions';
import { LogCallDialog, type CallTarget, type ContactNumber } from './log-call-dialog';
import { CustomerPanel } from './customer-panel';

export type RrrRow = {
  customer_id: string;
  full_name: string;
  phone_e164: string;
  lifetime_orders: number;
  lifetime_value: number;
  aov: number | null;
  is_repeat_buyer: boolean;
  last_order_on: string | null;
  days_since_order: number | null;
  payment_profile: string | null;
  current_owner_id: string | null;
  owner_name: string | null;
  is_dnd: boolean;
  attempts: number | null;
  last_contacted_on: string | null;
  last_outcome: string | null;
  next_due_on: string | null;
  open_followup_id: string | null;
  last_order_id: string | null;
  last_order_source: string | null;
};

export type Rep = { id: string; full_name: string; role: string };

const OUTCOME_LABEL: Record<string, string> = {
  order_placed: 'Order placed',
  will_buy: 'Interested',
  not_interested: 'Not interested',
  no_answer: 'Call not picked',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  connected: 'Baat hui',
  medicine_not_finished: 'Medicine not finished',
  will_update_later: 'Will update later',
};
const OUTCOME_TONE: Record<string, string> = {
  order_placed: 'positive', will_buy: 'positive', connected: 'positive',
  medicine_not_finished: 'attention', will_update_later: 'attention',
  no_answer: 'attention', busy: 'attention',
  not_interested: 'critical', wrong_number: 'critical',
};

const money = (n: number | null) =>
  n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Active if they bought within 90 days — the same line the team's own
 *  dashboard draws between a live customer and one going cold. */
function activity(days: number | null) {
  if (days == null) return { text: 'No orders', tone: 'dashed' };
  if (days <= 90) return { text: 'Active', tone: 'positive' };
  return { text: `${days}d inactive`, tone: days > 180 ? 'critical' : 'attention' };
}

/** What the follow-up state means today, not what it meant when it was set. */
function followUpState(r: RrrRow) {
  if (r.next_due_on) {
    const days = Math.round(
      (Date.now() - new Date(`${r.next_due_on}T00:00:00+05:30`).getTime()) / 86_400_000);
    const last = r.last_outcome ? OUTCOME_LABEL[r.last_outcome] ?? r.last_outcome : '';
    if (days > 0) return { text: last ? `${last} · ${days}d overdue` : `${days}d overdue`, tone: 'critical' };
    if (days === 0) return { text: 'Due today', tone: 'attention' };
    return { text: `Call in ${Math.abs(days)}d`, tone: 'neutral' };
  }
  if (r.last_outcome)
    return {
      text: OUTCOME_LABEL[r.last_outcome] ?? r.last_outcome,
      tone: OUTCOME_TONE[r.last_outcome] ?? 'neutral',
    };
  return { text: 'Untouched', tone: 'dashed' };
}

export function RrrTable({
  rows, reps, canAssign, numbers,
}: { rows: RrrRow[]; reps: Rep[]; canAssign: boolean; numbers: ContactNumber[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState('all');
  const [stage, setStage] = useState('all');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [openRow, setOpenRow] = useState<RrrRow | null>(null);
  const [calling, setCalling] = useState<CallTarget | null>(null);

  const visible = useMemo(() => rows.filter((r) => {
    if (owner === 'unassigned' && r.current_owner_id) return false;
    if (owner !== 'all' && owner !== 'unassigned' && r.current_owner_id !== owner) return false;
    if (stage === 'untouched' && (r.attempts ?? 0) > 0) return false;
    if (stage === 'overdue' && !(r.next_due_on && new Date(r.next_due_on) < new Date())) return false;
    if (stage === 'inactive' && (r.days_since_order ?? 0) <= 90) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!r.full_name.toLowerCase().includes(q) && !r.phone_e164.includes(q)) return false;
    }
    return true;
  }), [rows, owner, stage, search]);

  const allShown = visible.length > 0 && visible.every((r) => selected.has(r.customer_id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShown) for (const r of visible) next.delete(r.customer_id);
      else for (const r of visible) next.add(r.customer_id);
      return next;
    });
  }

  function submit() {
    if (!selected.size || !target) return;
    const ids = [...selected];
    const toName = target === 'unassign'
      ? 'the unassigned pool'
      : reps.find((r) => r.id === target)?.full_name ?? 'that rep';
    setMessage(null);
    startTransition(async () => {
      const result = await assignRrr(ids, target === 'unassign' ? null : target);
      if (!result.ok) { setMessage(result.error); return; }
      setSelected(new Set());
      setMessage(result.moved === 0
        ? `Nothing changed — those ${ids.length} were already on ${toName}.`
        : `${result.moved} of ${ids.length} moved to ${toName}.`);
    });
  }

  const callTargetFor = (r: RrrRow): CallTarget => ({
    customerId: r.customer_id,
    name: r.full_name,
    phone: r.phone_e164,
    followupId: r.open_followup_id,
    orderId: r.last_order_id,
  });

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>RRR</h1>
        <span className="muted">
          {visible.length.toLocaleString('en-IN')} customers
          {selected.size ? ` · ${selected.size} selected` : ''}
        </span>

        <div className="toolbar-spacer" />

        <label className="grid-search">
          <span className="sr-only">Search customer</span>
          <input
            type="search"
            value={search}
            placeholder="Name or mobile number…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>

        <label className="sr-only" htmlFor="rrr-stage">Stage</label>
        <select id="rrr-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="all">All customers</option>
          <option value="untouched">Untouched — never called</option>
          <option value="overdue">Overdue follow-up</option>
          <option value="inactive">Inactive 90+ days</option>
        </select>

        <label className="sr-only" htmlFor="rrr-owner">Owner</label>
        <select id="rrr-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Everyone</option>
          <option value="unassigned">Unassigned only</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>
      </div>

      {canAssign ? (
        <div className="grid-toolbar rrr-assignbar">
          <label className="sr-only" htmlFor="rrr-target">Assign to</label>
          <select id="rrr-target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending}>
            <option value="">Assign selected to…</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            <option value="unassign">— Put back in unassigned pool —</option>
          </select>
          <button type="button" onClick={submit} disabled={pending || !selected.size || !target}>
            {pending ? 'Assigning…' : `Assign ${selected.size || ''}`.trim()}
          </button>
          {message ? <span className="muted" role="status">{message}</span> : null}
        </div>
      ) : null}

      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead>
            <tr>
              {canAssign ? (
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={allShown} onChange={toggleAllShown} aria-label="Select all shown" />
                </th>
              ) : null}
              <th>Customer</th>
              <th>Payment</th>
              <th className="num">Orders</th>
              <th className="num">Amount / LTV</th>
              <th className="num">AOV</th>
              <th>Last activity</th>
              <th>Activity</th>
              <th>Follow-up</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const act = activity(r.days_since_order);
              const fu = followUpState(r);
              return (
                <tr
                  key={r.customer_id}
                  className={`record-row ${selected.has(r.customer_id) ? 'selected' : ''}`}
                >
                  {canAssign ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.customer_id)}
                        onChange={() => toggle(r.customer_id)}
                        aria-label={`Select ${r.full_name}`}
                      />
                    </td>
                  ) : null}

                  <td>
                    <button type="button" className="rrr-customer" onClick={() => setOpenRow(r)}>
                      <span className="rrr-avatar">{initials(r.full_name)}</span>
                      <span className="rrr-customer-copy">
                        <strong>{r.full_name}</strong>
                        <span className="muted">{r.phone_e164}</span>
                        <span className="muted">
                          {r.is_repeat_buyer ? 'Repeat buyer' : 'New buyer'}
                          {r.is_dnd ? ' · DND' : ''}
                        </span>
                      </span>
                    </button>
                  </td>

                  <td>{r.payment_profile ? <span className="status-pill neutral">{r.payment_profile}</span> : '—'}</td>
                  <td className="num">{r.lifetime_orders}</td>
                  <td className="num">{money(r.lifetime_value)}</td>
                  <td className="num">{money(r.aov)}</td>
                  <td>
                    {r.last_order_on ?? '—'}
                    <br />
                    <span className="muted">{r.last_order_source ?? 'Order placed'}</span>
                  </td>
                  <td><span className={`status-pill ${act.tone}`}>{act.text}</span></td>
                  <td>
                    <span className={`status-pill ${fu.tone}`}>{fu.text}</span>
                    <br />
                    <span className="muted">{r.owner_name ?? 'Unassigned'}</span>
                  </td>
                  <td>
                    <button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {visible.length === 0 ? (
          <div className="grid-empty"><p>No customers match this filter.</p></div>
        ) : null}
      </div>

      {openRow ? (
        <CustomerPanel
          customerId={openRow.customer_id}
          name={openRow.full_name}
          phone={openRow.phone_e164}
          onClose={() => setOpenRow(null)}
          onLogCall={() => { setCalling(callTargetFor(openRow)); setOpenRow(null); }}
        />
      ) : null}

      {calling ? (
        <LogCallDialog
          target={calling}
          numbers={numbers}
          onClose={() => setCalling(null)}
          onSaved={(msg) => { setCalling(null); setMessage(msg); }}
        />
      ) : null}
    </section>
  );
}
