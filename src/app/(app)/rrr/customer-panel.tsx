'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { loadCustomerHistory, type OrderRow, type CallRow } from './customer-actions';
import { dayInYear as dayShort, istDateFromTimestamp, istToday, money } from './lib/format';
import { outcomeLabel, outcomeTone } from './lib/outcomes';
import { useModal } from './lib/use-modal';

/**
 * One customer's story in as few words as a rep can read between two calls:
 * a summary line to decide on, then one line per real event.
 *
 * Most of what the history used to print was the sheet talking to itself.
 * Imported remarks read "Status | Note | Reminder | Segment | Origin | Called
 * from" — Status repeats the pill, Called from repeats the header, and the
 * other three are sheet bookkeeping. Only Note is something a rep wrote, so
 * that is the only text kept, and only when it adds to the outcome.
 */

/** When the call happened, or when it is due if it has not. */
const eventAt = (c: CallRow) => c.completed_at ?? c.due_at;

/** Rows the sheet import made that are not calls: the note left when an order
 *  synced (the order itself is on the timeline), the course reminder raised
 *  from its delivery date, and the scheduler's own placeholder. */
function isNotACall(c: CallRow) {
  const r = c.remark ?? '';
  return (c.outcome === 'order_placed' && r.includes('Automatically marked converted'))
    || r.includes('Course follow-up scheduled')
    || r.startsWith('Scheduled from latest');
}

const NOT_PICKED = /^(call\s*)?(not\s*(pick(ed)?(\s*up)?|connected|recei?ve)|no\.?\s*is\s*busy|busy|cx call disconnected|call (cut|disconnected) by customer|customer disconnected the call|not connected the call|not recei?ve the call|number switched\s?off|number out of service)/i;

/** The rep's own words, or null when there are none worth reading. */
function noteOf(c: CallRow): string | null {
  if (!c.remark) return null;
  const parts = c.remark.split(' | ').map((p) => p.trim()).filter(Boolean);
  const sheet = parts[0]?.startsWith('Status:');
  const kept = sheet
    ? parts.filter((p) => p.startsWith('Note:') || p.startsWith('Medicine remaining:'))
        .map((p) => p.replace(/^Note:\s*/, ''))
    : parts.filter((p) => !p.startsWith('Completed on selection date'));
  const text = kept
    .map((p) => p.replace(/\s*\((Shreyansh|Tejasv|Ashutosh|Nisha|Harshal Deep)\)\s*$/i, '').trim())
    .filter((p) => p
      && !/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(p)            // a bare date
      && !/^(tejasv|shreyansh|ashutosh|nisha)$/i.test(p))       // a bare name
    .join(' · ');
  if (!text) return null;
  // "Call Not Pick" under a "Call not picked" pill says nothing new.
  if (NOT_PICKED.test(text) && (!c.outcome || c.outcome === 'no_answer' || c.outcome === 'busy')
      && text.length < 45) return null;
  return text;
}

/** What the line says the call came to. Legacy rows have no outcome but often
 *  a note that plainly is one ("Call Not Pick"), which is the better label. */
function resultOf(c: CallRow): { label: string; tone: string } {
  if (c.outcome === 'order_placed') return { label: 'Rep noted: ordered', tone: 'neutral' };
  if (c.outcome) return { label: outcomeLabel(c.outcome) ?? c.outcome, tone: outcomeTone(c.outcome) };
  const raw = (c.remark ?? '').replace(/^Status:\s*[^|]*\|\s*Note:\s*/, '');
  if (NOT_PICKED.test(raw.trim())) return { label: 'Call not picked', tone: 'attention' };
  return { label: 'Called', tone: 'neutral' };
}

type Line =
  | { key: string; at: string; kind: 'order'; order: OrderRow }
  | { key: string; at: string; kind: 'call'; label: string; tone: string;
      who: string | null; note: string | null; count: number; from: string };

function gapText(days: number) {
  if (days >= 60) return `${Math.round(days / 30)} months gap`;
  return `${Math.round(days / 7)} weeks gap`;
}

export function CustomerPanel({
  customerId, name, phone, onClose, onLogCall,
}: {
  customerId: string;
  name: string;
  phone: string;
  onClose: () => void;
  onLogCall?: () => void;
}) {
  const [data, setData] = useState<{ orders: OrderRow[]; calls: CallRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const { ref, onBackdropClick } = useModal(onClose);

  useEffect(() => {
    let live = true;
    setData(null); setError(null); setShowOld(false);
    loadCustomerHistory(customerId).then((r) => {
      if (!live) return;
      if (r.error) setError(r.error);
      setData({ orders: r.orders, calls: r.calls });
    });
    return () => { live = false; };
  }, [customerId]);

  const view = useMemo(() => {
    const orders = data?.orders ?? [];
    const calls = (data?.calls ?? []).filter((c) => !isNotACall(c));
    const done = calls.filter((c) => c.completed_at);
    const latestDone = done.reduce((max, c) => (c.completed_at! > max ? c.completed_at! : max), '');
    // A reminder due before the last call that actually happened was simply
    // never closed ("Not Contacted" from the sheet); it is not the next call.
    const pending = calls.filter((c) => !c.completed_at && c.due_at > latestDone)
      .sort((a, b) => a.due_at.localeCompare(b.due_at));
    const oldCalls = done.filter((c) => c.kind !== 'order');
    const shownCalls = showOld ? done : done.filter((c) => c.kind === 'order');

    const events = [
      ...orders.map((o) => ({ at: o.ordered_on, order: o, call: null as CallRow | null })),
      ...shownCalls.map((c) => ({ at: eventAt(c), order: null as OrderRow | null, call: c })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // Back-to-back calls with the same result and nothing written fold into
    // one line: "Call not picked ×3 (02 Aug – 09 Aug)".
    const lines: Line[] = [];
    for (const e of events) {
      if (e.order) {
        lines.push({ key: `o-${e.order.order_id}`, at: e.at, kind: 'order', order: e.order });
        continue;
      }
      const c = e.call!;
      const { label, tone } = resultOf(c);
      const note = noteOf(c);
      const prev = lines[lines.length - 1];
      if (prev?.kind === 'call' && prev.label === label && !prev.note && !note) {
        prev.count += 1;
        prev.from = e.at;
        if (prev.who !== c.by_name) prev.who = null;
        continue;
      }
      lines.push({ key: `f-${c.followup_id}`, at: e.at, kind: 'call', label, tone,
        who: c.by_name, note, count: 1, from: e.at });
    }

    const lastOrder = orders[0] ?? null;
    const medicineEnds = lastOrder?.medicine_ends_on
      ? { on: lastOrder.medicine_ends_on, estimated: !!lastOrder.medicine_ends_estimated }
      : null;
    const lastCall = done.filter((c) => c.kind === 'order')
      .sort((a, b) => eventAt(b).localeCompare(eventAt(a)))[0] ?? null;

    return {
      orders, lines, oldCount: oldCalls.length, lastOrder, medicineEnds, lastCall,
      nextCall: pending[0] ?? null,
      ltv: orders.reduce((sum, o) => sum + Number(o.amount), 0),
    };
  }, [data, showOld]);

  return (
    <div className="rrr-dialog" onMouseDown={onBackdropClick}>
      <div className="rrr-panel" ref={ref} role="dialog" aria-modal="true" aria-label={`${name} details`} tabIndex={-1}>
        <header className="rrr-panel-head">
          <div>
            <h2 className="record-name">{name}</h2>
            <p className="muted">{phone}</p>
          </div>
          <div className="rrr-panel-head-actions">
            {onLogCall ? <button type="button" onClick={onLogCall}>Log call</button> : null}
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </header>

        {error ? <p className="edit-error" role="alert">{error}</p> : null}
        {!data ? <p className="muted">Loading…</p> : null}

        {data ? (
          <>
            <dl className="rrr-summary">
              <div>
                <dt>Last order</dt>
                <dd>{view.lastOrder
                  ? <>{dayShort(view.lastOrder.ordered_on)} · {money(Number(view.lastOrder.amount))}</>
                  : '—'}</dd>
              </div>
              <div>
                <dt>Medicine ends</dt>
                <dd>{!view.medicineEnds ? '—'
                  : <>
                    {view.medicineEnds.on < istToday()
                      ? <>Ended {dayShort(view.medicineEnds.on)}</>
                      : dayShort(view.medicineEnds.on)}
                    {view.medicineEnds.estimated ? ' · est.' : ''}
                  </>}</dd>
              </div>
              <div>
                <dt>Last call</dt>
                <dd>{view.lastCall
                  ? <>{dayShort(eventAt(view.lastCall))} · {resultOf(view.lastCall).label}</>
                  : 'Not called yet'}</dd>
              </div>
              <div>
                <dt>Next call</dt>
                <dd>{!view.nextCall ? 'Not scheduled'
                  : istDateFromTimestamp(view.nextCall.due_at) < istToday()
                    ? <>Overdue · {dayShort(view.nextCall.due_at)}</>
                    : dayShort(view.nextCall.due_at)}</dd>
              </div>
              <div>
                <dt>Orders</dt>
                <dd>{view.orders.length} · {money(view.ltv)}</dd>
              </div>
            </dl>

            <section className="rrr-panel-section">
              {view.lines.length ? (
                <ol className="rrr-feed">
                  {view.lines.map((line, i) => {
                    const prev = view.lines[i - 1];
                    const days = prev
                      ? Math.round((new Date(prev.kind === 'call' ? prev.from : prev.at).getTime()
                          - new Date(line.at).getTime()) / 86_400_000)
                      : 0;
                    return (
                      <Fragment key={line.key}>
                        {days > 21 ? <li className="rrr-feed-gap">{gapText(days)}</li> : null}
                        {line.kind === 'order' ? (
                          <li className="rrr-feed-line" data-tone="positive">
                            <span className="rrr-feed-date">{dayShort(line.order.ordered_on)}</span>
                            <span>
                              <strong>Order {line.order.order_no}</strong> · {money(Number(line.order.amount))}
                              {line.order.products ? <span className="muted"> · {line.order.products}</span> : null}
                            </span>
                          </li>
                        ) : (
                          <li className="rrr-feed-line" data-tone={line.tone}>
                            <span className="rrr-feed-date">{dayShort(line.at)}</span>
                            <span>
                              {line.label}
                              {line.count > 1 ? <> ×{line.count} <span className="muted">
                                ({dayShort(line.from)} – {dayShort(line.at)})</span></> : null}
                              {line.who ? <span className="muted"> · {line.who}</span> : null}
                              {line.note ? <span className="rrr-feed-note"> “{line.note}”</span> : null}
                            </span>
                          </li>
                        )}
                      </Fragment>
                    );
                  })}
                </ol>
              ) : <p className="muted">No orders or calls yet.</p>}
              {view.oldCount ? (
                <button type="button" className="rrr-feed-more" onClick={() => setShowOld((v) => !v)}>
                  {showOld ? 'Hide old lead calls' : `Show old lead calls (${view.oldCount})`}
                </button>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
