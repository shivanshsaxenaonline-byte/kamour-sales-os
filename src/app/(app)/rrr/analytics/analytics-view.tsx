'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { CustomerPanel } from '../customer-panel';
import { addDaysIso, dayLong, dayShort, timeLabel } from '../lib/format';
import { OUTCOME_CODES, outcomeLabel, outcomeTone } from '../lib/outcomes';
import { workSourceLabel, workSourceTone, type WorkSource } from '@/lib/work-tags';

export type RepDay = {
  id: string | null;
  name: string;
  assigned: number;
  open: number;
  calls: number;
  customers: number;
  connected: number;
  notPicked: number;
  orders: number;
  scheduled: number;
};

export type CallLine = {
  id: string;
  /** Null for a WATI Interested lead nobody has ordered from yet: there is no
   *  customer record to open a history panel on. */
  customer_id: string | null;
  /** Who was called, for counting distinct people when customer_id is null. */
  subject_key: string;
  /** Which list the call came off. RRR calls land in `followups`, WATI
   *  Interested calls in `wati_work_calls`; this screen shows both. */
  channel: 'rrr' | 'wati_interested';
  full_name: string;
  phone_e164: string;
  rep_id: string | null;
  rep_name: string;
  outcome: string | null;
  note: string | null;
  completed_at: string;
  next_due_at: string | null;
  attempt_no: number;
  called_from: string | null;
};

export type TaskLine = {
  id: string;
  customer_id: string | null;
  full_name: string;
  phone_e164: string;
  rep_id: string | null;
  rep_name: string;
  source: WorkSource;
  due_on: string;
  assigned_at: string;
  completed_at: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
};

/** What a tile on a card narrows the page to. The first five are calls from
 *  the log; the last two are tasks, which get a list of their own. */
type Metric = 'all' | 'connected' | 'notPicked' | 'orders' | 'scheduled' | 'assigned' | 'open';
type CallMetric = Exclude<Metric, 'assigned' | 'open'>;

// Kept in step with CONNECTED / NOT_PICKED in page.tsx, which count the tiles.
const CONNECTED = new Set(['order_placed', 'will_buy', 'medicine_not_finished', 'will_update_later', 'connected', 'not_interested', 'other']);
const NOT_PICKED = new Set(['no_answer', 'busy']);

const CALL_TEST: Record<CallMetric, (l: CallLine) => boolean> = {
  all: () => true,
  connected: (l) => !!l.outcome && CONNECTED.has(l.outcome),
  notPicked: (l) => !!l.outcome && NOT_PICKED.has(l.outcome),
  orders: (l) => l.outcome === 'order_placed',
  scheduled: (l) => !!l.next_due_at,
};

const METRIC_LABEL: Record<Metric, string> = {
  all: 'All calls', connected: 'Connected', notPicked: 'Not picked', orders: 'Orders placed',
  scheduled: 'Next call set', assigned: 'Assigned that day', open: 'Open tasks',
};

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

/** The two calling streams, as a pill. WATI borrows its tone from work-tags so
 *  a lead wears the same colour here as it does on the rep's own list. */
const CHANNEL: Record<CallLine['channel'], { label: string; tone: string }> = {
  rrr: { label: 'RRR', tone: 'neutral' },
  wati_interested: { label: workSourceLabel('wati_interested'), tone: workSourceTone('wati_interested') },
};

export function AnalyticsView({ date, today, reps, lines, assignedTasks, openTasks, automatic }: {
  date: string;
  today: string;
  reps: RepDay[];
  lines: CallLine[];
  assignedTasks: TaskLine[];
  openTasks: TaskLine[];
  automatic: number;
}) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const [rep, setRep] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [metric, setMetric] = useState<Metric>('all');
  const [open, setOpen] = useState<CallLine | TaskLine | null>(null);

  const goTo = (d: string) => startNav(() => router.push(`/rrr/analytics?date=${d}`, { scroll: false }));

  const isTasks = metric === 'assigned' || metric === 'open';
  const shown = useMemo(() => isTasks ? [] : lines.filter((l) =>
    (rep === 'all' || (l.rep_id ?? 'none') === rep)
    && CALL_TEST[metric as CallMetric](l)
    && (outcome === 'all' || l.outcome === outcome)), [lines, rep, outcome, metric, isTasks]);
  const tasks = useMemo(() => {
    if (!isTasks) return [];
    const pool = metric === 'assigned' ? assignedTasks : openTasks;
    return pool.filter((t) => rep === 'all' || (t.rep_id ?? 'none') === rep)
      .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.full_name.localeCompare(b.full_name));
  }, [isTasks, metric, assignedTasks, openTasks, rep]);

  /** A tile click: that card's person (everyone, on the team card) and that
   *  number. Clicking the tile already selected takes the filter off. */
  function pick(cardRep: string, next: Metric) {
    const same = rep === cardRep && metric === next;
    setRep(same ? 'all' : cardRep);
    setMetric(same ? 'all' : next);
    setOutcome('all');
    if (!same) document.getElementById('analytics-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function clearAll() { setRep('all'); setMetric('all'); setOutcome('all'); }

  /** Name and number, clickable into the history panel only when there is a
   *  customer to open. A WATI Interested prospect who has never ordered has no
   *  customer row, and the panel would have nothing to show. */
  const subject = (row: CallLine | TaskLine, sub2: string) => row.customer_id
    ? (
      <button type="button" className="rrr-customer" onClick={() => setOpen(row)}>
        <span className="rrr-customer-copy">
          <strong>{row.full_name}</strong>
          <span className="muted">{sub2}</span>
        </span>
      </button>
    ) : (
      <span className="rrr-customer-copy">
        <strong>{row.full_name}</strong>
        <span className="muted">{sub2}</span>
      </span>
    );
  const filtering = rep !== 'all' || metric !== 'all' || outcome !== 'all';
  const repLabel = rep === 'all' ? 'Whole team' : reps.find((r) => (r.id ?? 'none') === rep)?.name ?? '';

  const total = reps.reduce((t, r) => ({
    ...t,
    assigned: t.assigned + r.assigned, open: t.open + r.open, calls: t.calls + r.calls,
    customers: t.customers + r.customers, connected: t.connected + r.connected,
    notPicked: t.notPicked + r.notPicked, orders: t.orders + r.orders, scheduled: t.scheduled + r.scheduled,
  }), { id: 'total', name: 'Whole team', assigned: 0, open: 0, calls: 0, customers: 0, connected: 0, notPicked: 0, orders: 0, scheduled: 0 } as RepDay);

  return (
    <section className="data-grid" aria-busy={navigating}>
      <div className="grid-toolbar">
        <h1>Calling Analytics</h1>
        <div className="module-tabs">
          <Link href="/rrr/ai">AI Leads</Link>
          <Link href="/rrr/medicine-ending">Medicine Ending</Link>
          <Link href="/rrr/work">Assigned work</Link>
          <Link href="/rrr/analytics" className="active" aria-current="page">Analytics</Link>
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
          {dayLong(date)} · every call logged that day, by salesperson — RRR and WATI Interested together, tagged by the list each came off. “Assigned that day” counts hand-overs made that day; a lead handed over again counts again. “Open tasks” is assigned work that is due and still not closed — the same count the salesperson sees in their own “Aaj ke calls” tab. Follow-ups they have already made and dated forward sit in their Upcoming tab and are not counted here.
          {automatic ? ` ${automatic} automatic system updates (order converted / course follow-up created) are not counted as calls.` : ''}
        </p>

        <div className="analytics-cards">
          {[...reps, total].map((r) => {
            const cardRep = r.id === 'total' ? 'all' : r.id ?? 'none';
            const tile = (key: Metric, label: string, value: ReactNode, warn = false) => {
              const on = rep === cardRep && metric === key;
              return (
                <button key={key} type="button" className={`analytics-tile ${on ? 'on' : ''}`}
                  aria-pressed={on} onClick={() => pick(cardRep, key)}
                  title={`${r.name} · ${label}: list dekhein`}>
                  <span className="analytics-tile-label">{label}</span>
                  <span className={`analytics-tile-value ${warn ? 'analytics-warn' : ''}`}>{value}</span>
                </button>
              );
            };
            const cardOn = cardRep !== 'all' && rep === cardRep;
            return (
              <div key={r.id ?? 'none'}
                className={`analytics-card ${r.id === 'total' ? 'total' : ''} ${cardOn ? 'on' : ''}`}>
                <button type="button" className="analytics-card-name" onClick={() => pick(cardRep, 'all')}
                  aria-pressed={cardRep === 'all' ? undefined : rep === cardRep && metric === 'all'}>
                  <strong>{r.name}</strong>
                </button>
                <div className="rrr-summary">
                  {tile('connected', 'Connected', <>{r.connected} <span className="muted">{pct(r.connected, r.calls)}</span></>)}
                  {tile('notPicked', 'Not picked', r.notPicked)}
                  {tile('orders', 'Orders placed', r.orders)}
                  {tile('scheduled', 'Next call set', r.scheduled)}
                  {tile('assigned', 'Assigned that day', r.assigned)}
                  {tile('open', 'Open tasks', r.open, r.open > 0)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid-toolbar analytics-filters" id="analytics-log">
          <strong>{isTasks ? METRIC_LABEL[metric] : 'Call log'}</strong>
          <span className="muted">
            {isTasks ? `${tasks.length} tasks` : `${shown.length} of ${lines.length}`}
            {filtering && (rep !== 'all' || metric !== 'all')
              ? ` · ${repLabel}${metric !== 'all' ? ` · ${METRIC_LABEL[metric]}` : ''}` : ''}
          </span>
          {filtering ? <button type="button" onClick={clearAll}>Clear filter</button> : null}
          <div className="toolbar-spacer" />
          <label className="sr-only" htmlFor="analytics-rep">Salesperson</label>
          <select id="analytics-rep" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="all">All salespeople</option>
            {reps.map((r) => <option key={r.id ?? 'none'} value={r.id ?? 'none'}>{r.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="analytics-outcome">Response</label>
          <select id="analytics-outcome" value={outcome} disabled={isTasks}
            onChange={(e) => setOutcome(e.target.value)}>
            <option value="all">All responses</option>
            {OUTCOME_CODES.map((c) => <option key={c} value={c}>{outcomeLabel(c)}</option>)}
          </select>
        </div>

        {isTasks ? (
          <table className="records-table rrr-table">
            <thead>
              <tr>
                <th>Salesperson</th>
                <th>Customer</th>
                <th>Source</th>
                <th>Due</th>
                <th>Status</th>
                <th>Last outcome</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="record-row">
                  <td>{t.rep_name}</td>
                  <td>{subject(t, t.phone_e164)}</td>
                  <td><span className={`status-pill ${workSourceTone(t.source)}`}>{workSourceLabel(t.source)}</span></td>
                  <td><span className={`status-pill ${t.due_on < date ? 'attention' : 'neutral'}`}>{dayLong(t.due_on)}</span></td>
                  <td>{t.completed_at
                    ? 'Closed'
                    : t.last_called_at
                      ? `Called ${dayShort(t.last_called_at)}`
                      : <span className="analytics-warn">Not called yet</span>}</td>
                  <td>{t.last_outcome
                    ? <span className={`status-pill ${outcomeTone(t.last_outcome)}`}>{outcomeLabel(t.last_outcome)}</span>
                    : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
        <table className="records-table rrr-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Salesperson</th>
              <th>Customer</th>
              <th>Source</th>
              <th>Response</th>
              <th>Note</th>
              <th>Next follow-up</th>
              <th>Called from</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className="record-row">
                <td>{timeLabel(l.completed_at)}</td>
                <td>{l.rep_name}</td>
                <td>{subject(l, `${l.phone_e164}${l.attempt_no > 1 ? ` · attempt ${l.attempt_no}` : ''}`)}</td>
                <td><span className={`status-pill ${CHANNEL[l.channel].tone}`}>{CHANNEL[l.channel].label}</span></td>
                <td>
                  {l.outcome
                    ? <span className={`status-pill ${outcomeTone(l.outcome)}`}>{outcomeLabel(l.outcome)}</span>
                    : <span className="muted">No response recorded</span>}
                </td>
                <td className="analytics-note">{l.note ?? <span className="muted">—</span>}</td>
                <td>{l.next_due_at ? dayShort(l.next_due_at) : <span className="muted">None</span>}</td>
                <td>{l.called_from ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        {isTasks && tasks.length === 0 ? (
          <div className="grid-empty"><p>No tasks match this filter.</p></div>
        ) : null}
        {!isTasks && shown.length === 0 ? (
          <div className="grid-empty">
            <p>{lines.length ? 'No calls match this filter.' : `No follow-up calls were logged on ${dayLong(date)}.`}</p>
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
