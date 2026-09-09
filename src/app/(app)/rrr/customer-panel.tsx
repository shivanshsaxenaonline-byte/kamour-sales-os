'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { loadCustomerHistory, type OrderRow, type CallRow } from './customer-actions';

const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

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

/** The date a row actually sits at on the timeline: when the call happened,
 *  or when it is due if it has not happened yet. Ordering and the gaps between
 *  entries both hang off this, so it is one function, not two rules. */
const eventAt = (c: CallRow) => c.completed_at ?? c.due_at;

/** What an entry IS, which is not the same question as what its outcome was.
 *
 *  21,387 of the 22,847 follow-ups in this database are closed with no outcome
 *  — the legacy import and the queue rows whose sheet status carried no signal
 *  ("Others", "Not Contacted"), which import-ai-queue deliberately leaves NULL
 *  with the original text kept in the remark. Reading a missing outcome as
 *  "Pending" told the rep the call had not happened yet when it had, years
 *  ago. A closed follow-up says the call was made; a missing outcome says
 *  nobody wrote down what came of it. Those are two different facts. */
function entryState(c: CallRow) {
  if (!c.completed_at) return { label: 'Pending', tone: 'dashed', done: false };
  if (!c.outcome) return { label: 'No outcome recorded', tone: 'neutral', done: true };
  return {
    label: OUTCOME_LABEL[c.outcome] ?? c.outcome,
    tone: OUTCOME_TONE[c.outcome] ?? 'neutral',
    done: true,
  };
}

/** The silence between two neighbouring entries, in the words the floor uses.
 *  Three attempts in one afternoon and a three-month gap are the two things
 *  worth seeing instantly, and both are invisible in a list of bare dates. */
function gapLabel(newer: string, older: string) {
  const days = Math.round(
    (new Date(newer).getTime() - new Date(older).getTime()) / 86_400_000);
  if (days <= 0) return null;                       // same day: no rail break
  if (days === 1) return { text: '1 day', long: false };
  // Three weeks is roughly when a course runs down and a customer starts
  // drifting, so that is where the gap stops being routine and gets coloured.
  return { text: `${days} days`, long: days > 21 };
}

/** "Gold Plus 30N×1, Power Drive×3" -> one chip per product, counted. */
function productTotals(orders: OrderRow[]) {
  const total = new Map<string, number>();
  for (const o of orders) {
    if (!o.products) continue;
    for (const part of o.products.split(', ')) {
      const m = part.match(/^(.*)×(\d+)$/);
      if (!m?.[1] || !m[2]) continue;
      total.set(m[1], (total.get(m[1]) ?? 0) + Number(m[2]));
    }
  }
  return [...total.entries()].sort((a, b) => b[1] - a[1]);
}

export function CustomerPanel({
  customerId, name, phone, onClose, onLogCall,
}: {
  customerId: string;
  name: string;
  phone: string;
  onClose: () => void;
  onLogCall: () => void;
}) {
  const [data, setData] = useState<{ orders: OrderRow[]; calls: CallRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    loadCustomerHistory(customerId).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      setData({ orders: r.orders, calls: r.calls });
    });
    return () => { live = false; };
  }, [customerId]);

  const orders = data?.orders ?? [];
  const ltv = orders.reduce((sum, o) => sum + Number(o.amount), 0);
  const chips = productTotals(orders);
  // Orders with no product breakdown exist by the thousand (the source sheet
  // did not track products before ~Oct 2025), so the chips are labelled as
  // covering only part of the history rather than silently undercounting.
  const withoutProducts = orders.filter((o) => !o.products).length;
  // Newest first by when the call actually HAPPENED, not by when it was due:
  // the queue's dates and the floor's dates drift apart whenever a rep gets to
  // a call late, and a timeline sorted by intention rather than by event puts
  // entries out of order and makes the gaps between them meaningless.
  const calls = useMemo(
    () => [...(data?.calls ?? [])].sort(
      (a, b) => new Date(eventAt(b)).getTime() - new Date(eventAt(a)).getTime()),
    [data]);
  const done = calls.filter((c) => c.completed_at).length;
  const pending = calls.length - done;

  return (
    <div className="rrr-dialog" role="dialog" aria-modal="true" aria-label={`${name} details`}>
      <div className="rrr-panel">
        <header className="rrr-panel-head">
          <div>
            <h2 className="record-name">{name}</h2>
            <p className="muted">{phone}</p>
          </div>
          <div className="rrr-panel-head-actions">
            <button type="button" onClick={onLogCall}>Log call</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </header>

        {error ? <p className="edit-error" role="alert">{error}</p> : null}
        {!data ? <p className="muted">Loading…</p> : null}

        {data ? (
          <>
            <section className="rrr-panel-section">
              <h3>
                Order history · {orders.length} orders · {money(ltv)} LTV
              </h3>
              {chips.length ? (
                <p className="rrr-chips">
                  {chips.map(([label, n]) => (
                    <span key={label} className="status-pill neutral">{label} {n}</span>
                  ))}
                  {withoutProducts ? (
                    <span className="muted">
                      · {withoutProducts} older order{withoutProducts > 1 ? 's' : ''} without a product breakdown
                    </span>
                  ) : null}
                </p>
              ) : null}

              {orders.length ? (
                <div className="rrr-panel-scroll">
                  <table className="records-table rrr-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Products</th>
                        <th className="num">Amount</th>
                        <th>Payment</th>
                        <th>State</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr key={o.order_id}>
                          <td>{day(o.ordered_on)}</td>
                          <td>{o.products ?? <span className="muted">Not recorded</span>}</td>
                          <td className="num">{money(Number(o.amount))}</td>
                          <td>
                            {o.payment_mode ?? <span className="muted">—</span>}
                            <br />
                            <span className="muted">{o.payment_state}</span>
                          </td>
                          <td>{o.ship_state ?? '—'}</td>
                          <td className="muted">{o.source ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="muted">No orders.</p>}
            </section>

            <section className="rrr-panel-section">
              <h3>
                Follow-up history · {done} call{done === 1 ? '' : 's'}
                {/* A scheduled call is not a call that happened. Counting the
                    two together made the history claim more than it knew. */}
                {pending ? ` · ${pending} scheduled` : ''}
              </h3>
              {calls.length ? (
                <ol className="rrr-timeline">
                  {calls.map((c, i) => {
                    const prev = calls[i - 1];
                    // The gap belongs above this entry: the list runs newest
                    // first, so it is the wait between the call above and this
                    // one. The newest entry has nothing above it.
                    const gap = prev ? gapLabel(eventAt(prev), eventAt(c)) : null;
                    const state = entryState(c);
                    return (
                      <Fragment key={c.followup_id}>
                        {gap ? (
                          <li className="rrr-tl-gap" data-long={gap.long}>
                            <span>{gap.text}</span>
                          </li>
                        ) : null}
                        <li
                          className="rrr-tl-item"
                          data-tone={state.tone}
                          data-state={state.done ? 'done' : 'pending'}
                        >
                          <div className="rrr-timeline-head">
                            <span className={`status-pill ${state.tone}`}>{state.label}</span>
                            <span className="muted">
                              {c.completed_at ? day(c.completed_at) : `Due ${day(c.due_at)}`}
                              {c.by_name ? ` · ${c.by_name}` : ''}
                              {c.called_from ? ` · from ${c.called_from}` : ''}
                              {c.attempt_no > 1 ? ` · attempt ${c.attempt_no}` : ''}
                            </span>
                          </div>
                          {c.remark ? <p className="rrr-timeline-note">{c.remark}</p> : null}
                        </li>
                      </Fragment>
                    );
                  })}
                </ol>
              ) : <p className="muted">No calls logged yet.</p>}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
