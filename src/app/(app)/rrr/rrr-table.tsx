'use client';

import { useMemo, useState, useTransition } from 'react';
import { assignRrr } from './actions';
import { LogCallDialog, type CallTarget, type ContactNumber } from './log-call-dialog';

export type RrrRow = {
  customer_id: string;
  full_name: string;
  phone_e164: string;
  rfm_segment: string | null;
  lifetime_orders: number;
  lifetime_value: number;
  last_order_on: string | null;
  days_since_order: number | null;
  current_owner_id: string | null;
  owner_name: string | null;
  attempts: number | null;
  last_contacted_on: string | null;
  last_outcome: string | null;
  next_due_on: string | null;
  last_order_source: string | null;
  is_dnd: boolean;
  open_followup_id: string | null;
  last_order_id: string | null;
};

export type Rep = { id: string; full_name: string; role: string };

const SEGMENT_LABEL: Record<string, string> = {
  A1: 'Loyal repeater',
  A2: 'Warm repeater',
  B1: 'One-time recent',
  B2: 'One-time old',
  C1: 'Dormant',
  C2: 'Lapsed / cold',
};

// Positive, neutral and negative read at a glance; anything unmapped falls
// through to the neutral pill rather than being invented a colour.
const OUTCOME_TONE: Record<string, string> = {
  order_placed: 'positive',
  will_buy: 'positive',
  connected: 'positive',
  medicine_not_finished: 'attention',
  will_update_later: 'attention',
  no_answer: 'attention',
  busy: 'attention',
  not_interested: 'critical',
  wrong_number: 'critical',
};

const money = (n: number) =>
  '₹' + Math.round(n).toLocaleString('en-IN');

const label = (s: string | null) =>
  s ? s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) : '—';

export function RrrTable({
  rows, reps, canAssign, numbers,
}: { rows: RrrRow[]; reps: Rep[]; canAssign: boolean; numbers: ContactNumber[] }) {
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [segment, setSegment] = useState('all');
  const [owner, setOwner] = useState('all');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const visible = useMemo(() => rows.filter((r) => {
    if (segment !== 'all' && r.rfm_segment !== segment) return false;
    if (owner === 'unassigned' && r.current_owner_id) return false;
    if (owner !== 'all' && owner !== 'unassigned' && r.current_owner_id !== owner) return false;
    return true;
  }), [rows, segment, owner]);

  // Selection survives filtering on purpose — tick a few A1s, switch to C2,
  // tick a few more, assign the lot. But "select all" only ever means the
  // rows actually on screen.
  const allShown = visible.length > 0 && visible.every((r) => selected.has(r.customer_id));
  const selectedCount = selected.size;

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
    if (!selectedCount || !target) return;
    const ids = [...selected];
    const toName = target === 'unassign'
      ? 'the unassigned pool'
      : reps.find((r) => r.id === target)?.full_name ?? 'that rep';

    setMessage(null);
    startTransition(async () => {
      const result = await assignRrr(ids, target === 'unassign' ? null : target);
      if (!result.ok) { setMessage(result.error); return; }
      setSelected(new Set());
      setMessage(
        result.moved === 0
          ? `Nothing changed — those ${ids.length} were already on ${toName}.`
          : `${result.moved} of ${ids.length} moved to ${toName}.`,
      );
    });
  }

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>RRR</h1>
        <span className="muted">
          {visible.length.toLocaleString('en-IN')} customers
          {selectedCount ? ` · ${selectedCount} selected` : ''}
        </span>

        <div className="toolbar-spacer" />

        <label className="sr-only" htmlFor="rrr-segment">Segment</label>
        <select id="rrr-segment" value={segment} onChange={(e) => setSegment(e.target.value)}>
          <option value="all">All segments</option>
          {Object.entries(SEGMENT_LABEL).map(([code, text]) => (
            <option key={code} value={code}>{code} · {text}</option>
          ))}
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
          <select
            id="rrr-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={pending}
          >
            <option value="">Assign selected to…</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            <option value="unassign">— Put back in unassigned pool —</option>
          </select>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !selectedCount || !target}
          >
            {pending ? 'Assigning…' : `Assign ${selectedCount || ''}`.trim()}
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
                  <input
                    type="checkbox"
                    checked={allShown}
                    onChange={toggleAllShown}
                    aria-label="Select all shown"
                  />
                </th>
              ) : null}
              <th>Customer</th>
              <th>Segment</th>
              <th className="num">Orders</th>
              <th className="num">Lifetime</th>
              <th className="num">Days since order</th>
              <th>Last call</th>
              <th className="num">Tries</th>
              <th>Owner</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.customer_id}
                className={selected.has(r.customer_id) ? 'record-row selected' : 'record-row'}
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
                  <strong>{r.full_name}</strong>
                  <br />
                  <span className="muted">{r.phone_e164}</span>
                  {r.is_dnd ? <span className="status-pill critical"> DND</span> : null}
                </td>
                <td>
                  {r.rfm_segment ? (
                    <span className="status-pill neutral">
                      {r.rfm_segment} · {SEGMENT_LABEL[r.rfm_segment]}
                    </span>
                  ) : '—'}
                </td>
                <td className="num">{r.lifetime_orders}</td>
                <td className="num">{money(r.lifetime_value)}</td>
                <td className="num">{r.days_since_order ?? '—'}</td>
                <td>
                  {r.last_outcome ? (
                    <span className={`status-pill ${OUTCOME_TONE[r.last_outcome] ?? 'neutral'}`}>
                      {label(r.last_outcome)}
                    </span>
                  ) : <span className="muted">Never called</span>}
                  {r.last_contacted_on ? (
                    <>
                      <br />
                      <span className="muted">{r.last_contacted_on}</span>
                    </>
                  ) : null}
                </td>
                <td className="num">{r.attempts ?? 0}</td>
                <td>
                  {r.owner_name ?? <span className="status-pill dashed">Unassigned</span>}
                </td>
                <td className="muted">{r.last_order_source ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => setCalling({
                      customerId: r.customer_id,
                      name: r.full_name,
                      phone: r.phone_e164,
                      followupId: r.open_followup_id,
                      orderId: r.last_order_id,
                    })}
                  >
                    Log call
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {visible.length === 0 ? (
          <div className="grid-empty">
            <p>No customers match this filter.</p>
          </div>
        ) : null}
      </div>

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
