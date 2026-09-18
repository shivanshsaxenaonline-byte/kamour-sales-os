'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { CustomerPanel } from '@/app/(app)/rrr/customer-panel';
import { addDaysIso, dayLong, dayShort, timeLabel } from '@/app/(app)/rrr/lib/format';
import { OUTCOME_CODES, outcomeLabel, outcomeTone } from '@/app/(app)/rrr/lib/outcomes';
import { workSourceLabel, workSourceTone } from '@/lib/work-tags';

export type RepDay = {
  id: string | null;
  name: string;
  assigned: number;
  open: number;
  calls: number;
  /** Distinct leads reached, as against total attempts. */
  leads: number;
  connected: number;
  notPicked: number;
  interested: number;
  scheduled: number;
};

export type CallLine = {
  id: string;
  work_id: string;
  /** The golden customer behind this number, when the lead has one. */
  customer_id: string | null;
  full_name: string;
  phone_e164: string;
  lead_source: string | null;
  rep_id: string | null;
  rep_name: string;
  outcome: string | null;
  note: string | null;
  called_at: string;
  next_due_on: string | null;
  attempt_no: number;
  called_from: string | null;
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

export function AnalyticsView({ date, today, reps, lines }: {
  date: string;
  today: string;
  reps: RepDay[];
  lines: CallLine[];
}) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const [rep, setRep] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [open, setOpen] = useState<CallLine | null>(null);

  const goTo = (d: string) =>
    startNav(() => router.push(`/leads/wati-interested/analytics?date=${d}`, { scroll: false }));

  const shown = useMemo(() => lines.filter((l) =>
    (rep === 'all' || (l.rep_id ?? 'none') === rep)
    && (outcome === 'all' || l.outcome === outcome)), [lines, rep, outcome]);

  const total = reps.reduce((t, r) => ({
    ...t,
    assigned: t.assigned + r.assigned, open: t.open + r.open, calls: t.calls + r.calls,
    leads: t.leads + r.leads, connected: t.connected + r.connected,
    notPicked: t.notPicked + r.notPicked, interested: t.interested + r.interested,
    scheduled: t.scheduled + r.scheduled,
  }), { id: 'total', name: 'Whole team', assigned: 0, open: 0, calls: 0, leads: 0, connected: 0, notPicked: 0, interested: 0, scheduled: 0 } as RepDay);

  return (
    <section className="data-grid" aria-busy={navigating}>
      <div className="grid-toolbar">
        <h1>WATI Interested Analytics</h1>
        <div className="module-tabs">
          <Link href="/leads/wati-interested">Interested leads</Link>
          <Link href="/leads/wati-interested/analytics" className="active" aria-current="page">Analytics</Link>
        </div>
        <div className="toolbar-spacer" />
        <button type="button" onClick={() => goTo(addDaysIso(date, -1))} disabled={navigating}>← Previous day</button>
        <label className="sr-only" htmlFor="analytics-date">Date</label>
        <input id="analytics-date" type="date" value={date} max={today}
          onChange={(e) => e.target.value && goTo(e.target.value)} />
        <button type="button" onClick={() => goTo(addDaysIso(date, 1))} disabled={navigating || date >= today}>Next day →</button>
        {date !== today ? <button type="button" onClick={() => goTo(today)} disabled={navigating}>Today</button> : null}
      </div>

      <div className="grid-scroll analytics-body">
        <p className="muted analytics-caption">
          {dayLong(date)} · calls logged that day on leads handed over from WATI Interested, by salesperson.
          “Open tasks” is handed-over work due by this date that is still not closed, as of right now.
        </p>

        <div className="analytics-cards">
          {[...reps, total].map((r) => (
            <button
              key={r.id ?? 'none'}
              type="button"
              className={`analytics-card ${r.id === 'total' ? 'total' : ''} ${rep === (r.id ?? 'none') ? 'on' : ''}`}
              onClick={() => r.id !== 'total' && setRep((cur) => (cur === (r.id ?? 'none') ? 'all' : r.id ?? 'none'))}
              aria-pressed={r.id !== 'total' ? rep === (r.id ?? 'none') : undefined}
            >
              <strong>{r.name}</strong>
              <dl className="rrr-summary">
                <div><dt>Connected</dt><dd>{r.connected} <span className="muted">{pct(r.connected, r.calls)}</span></dd></div>
                <div><dt>Not picked</dt><dd>{r.notPicked}</dd></div>
                <div><dt>Interested</dt><dd>{r.interested}</dd></div>
                <div><dt>Next call set</dt><dd>{r.scheduled}</dd></div>
                <div><dt>Assigned that day</dt><dd>{r.assigned}</dd></div>
                <div><dt>Open tasks</dt><dd className={r.open ? 'analytics-warn' : ''}>{r.open}</dd></div>
              </dl>
            </button>
          ))}
        </div>

        <div className="grid-toolbar analytics-filters">
          <strong>Call log</strong>
          <span className="muted">{shown.length} of {lines.length}</span>
          <div className="toolbar-spacer" />
          <label className="sr-only" htmlFor="analytics-rep">Salesperson</label>
          <select id="analytics-rep" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="all">All salespeople</option>
            {reps.map((r) => <option key={r.id ?? 'none'} value={r.id ?? 'none'}>{r.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="analytics-outcome">Response</label>
          <select id="analytics-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="all">All responses</option>
            {OUTCOME_CODES.map((c) => <option key={c} value={c}>{outcomeLabel(c)}</option>)}
          </select>
        </div>

        <table className="records-table rrr-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Salesperson</th>
              <th>Lead</th>
              <th>Tag</th>
              <th>Response</th>
              <th>Note</th>
              <th>Next follow-up</th>
              <th>Called from</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className="record-row">
                <td>{timeLabel(l.called_at)}</td>
                <td>{l.rep_name}</td>
                <td>
                  {/* The history panel only opens on a lead the customer base
                      already knows; a brand-new number has nothing to show. */}
                  {l.customer_id ? (
                    <button type="button" className="rrr-customer" onClick={() => setOpen(l)}>
                      <span className="rrr-customer-copy">
                        <strong>{l.full_name}</strong>
                        <span className="muted">{l.phone_e164}{l.attempt_no > 1 ? ` · attempt ${l.attempt_no}` : ''}</span>
                      </span>
                    </button>
                  ) : (
                    <span className="rrr-customer-copy">
                      <strong>{l.full_name}</strong>
                      <span className="muted">{l.phone_e164}{l.attempt_no > 1 ? ` · attempt ${l.attempt_no}` : ''}</span>
                    </span>
                  )}
                </td>
                <td>
                  <span className={`status-pill ${workSourceTone('wati_interested')}`}>
                    {workSourceLabel('wati_interested')}
                  </span>
                  {l.lead_source ? <><br /><span className="muted">{l.lead_source}</span></> : null}
                </td>
                <td>
                  {l.outcome
                    ? <span className={`status-pill ${outcomeTone(l.outcome)}`}>{outcomeLabel(l.outcome)}</span>
                    : <span className="muted">No response recorded</span>}
                </td>
                <td className="analytics-note">{l.note ?? <span className="muted">—</span>}</td>
                <td>{l.next_due_on ? dayShort(l.next_due_on) : <span className="muted">None</span>}</td>
                <td>{l.called_from ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <div className="grid-empty">
            <p>{lines.length ? 'No calls match this filter.' : `No WATI Interested calls were logged on ${dayLong(date)}.`}</p>
          </div>
        ) : null}
      </div>

      {open?.customer_id ? (
        <CustomerPanel
          customerId={open.customer_id}
          name={open.full_name}
          phone={open.phone_e164}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}
