'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CustomerPanel } from '../customer-panel';
import { LogCallDialog, type CallTarget, type ContactNumber } from '../log-call-dialog';
import { dayLong } from '../lib/format';
import { outcomeLabel } from '../lib/outcomes';
import { workSourceLabel, workSourceTone, type WorkSource } from '@/lib/work-tags';

export type MyWorkRow = {
  id: string;
  source: WorkSource;
  /** Set on a WATI Interested hand-over; its calls are logged against the WATI
   *  task rather than an order follow-up. */
  watiWorkId: string | null;
  /** Null for a WATI lead whose number is not in the customer base yet. */
  customer_id: string | null;
  order_id: string | null;
  due_on: string;
  called_today: boolean;
  last_outcome: string | null;
  medicine_days_left: number | null;
  full_name: string;
  phone_e164: string;
  is_dnd: boolean;
  order_no: string | null;
  /** What the lead came in about, for a WATI row that has no order to show. */
  note: string | null;
  medicine_ends_on: string | null;
};

export function MyWorkList({ rows, numbers, preferredNumberId, today }: {
  rows: MyWorkRow[];
  numbers: ContactNumber[];
  /** The handset this rep last called from, seeding the Log-call dialog. */
  preferredNumberId: string | null;
  today: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [viewing, setViewing] = useState<MyWorkRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const callTarget = (row: MyWorkRow): CallTarget => ({
    customerId: row.customer_id, name: row.full_name, phone: row.phone_e164,
    followupId: null, orderId: row.order_id,
    ...(row.watiWorkId ? { watiWorkId: row.watiWorkId } : { workId: row.id }),
  });
  // Saved just now — gone from the list before the server refresh lands. Only
  // ever a bridge: once the refreshed rows arrive they carry the saved outcome
  // and the new date themselves, so the set is dropped. Keeping it would hide
  // a customer who rang back an hour later from the rep searching for them.
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => { setDone(new Set()); }, [rows]);
  // The list is today's calls only. A lead leaves it once its update is saved
  // and comes back on the next follow-up date the rep chose.
  const pending = useMemo(() => rows.filter((row) =>
    row.due_on <= today && !row.called_today && !done.has(row.id)), [rows, today, done]);
  // Everything else, soonest first — defined as the rest of the list rather
  // than as `due_on > today`, which is not the same thing. A call dated today
  // (the rep picks the date, and "customer will ring back this evening" used to
  // be allowed) left the row called-today and still due today: out of Aaj ke
  // calls for having been called, out of Upcoming for not being later, and so
  // off the rep's screen altogether until tomorrow. The two tabs are now a
  // partition, so no task can fall between them whatever date it carries.
  const upcoming = useMemo(() => {
    const open = new Set(pending.map((row) => row.id));
    return rows.filter((row) => !open.has(row.id))
      .sort((a, b) => a.due_on.localeCompare(b.due_on));
  }, [rows, pending]);
  const [tab, setTab] = useState<'today' | 'upcoming'>('today');
  // A search looks through every open task, whichever tab it sits on. A
  // customer who missed the call and rang back an hour later has already moved
  // to Upcoming (or out of Today), and the rep searching for them from Today
  // must still find them to save what they said.
  const searching = search.trim() !== '';
  // `done` applies to the search too. Without it a rep who found a customer by
  // name, saved the call and stayed in the search box watched the row sit there
  // unchanged — the one thing that reads as "I marked it and nothing happened".
  const list = searching
    ? rows.filter((row) => !done.has(row.id))
    : tab === 'today' ? pending : upcoming;
  const visible = useMemo(() => list.filter((row) => {
    const query = search.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    return !query || row.full_name.toLowerCase().includes(query)
      || (digits.length > 0 && row.phone_e164.includes(digits));
  }), [list, search]);

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>My assigned follow-ups</h1>
        <div className="module-tabs" role="tablist" aria-label="Follow-up views">
          <button type="button" role="tab" aria-selected={tab === 'today'}
            className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
            Aaj ke calls<span>{pending.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'upcoming'}
            className={tab === 'upcoming' ? 'active' : ''} onClick={() => setTab('upcoming')}>
            Upcoming<span>{upcoming.length}</span>
          </button>
        </div>
        {message ? <span className="muted" role="status">{message}</span> : null}
      </div>
      <div className="rrr-filters">
        <label className="rrr-field wide">
          <span>Search assigned customer</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or phone — searches Today and Upcoming" />
        </label>
      </div>
      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead><tr><th>Customer</th><th>Source</th><th>Order</th><th>{searching ? 'Due / next follow-up' : tab === 'today' ? 'Due' : 'Next follow-up'}</th>
            <th>Last outcome</th><th /></tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} className="record-row" onClick={() => setViewing(row)}
                style={{ cursor: 'pointer' }}>
                <td><strong>{row.full_name}</strong><br /><span className="muted">{row.phone_e164}</span></td>
                <td><span className={`status-pill ${workSourceTone(row.source)}`}>
                  {workSourceLabel(row.source)}
                </span></td>
                <td>{row.order_no ?? <span className="muted">{row.note ?? 'WhatsApp lead'}</span>}
                  {row.medicine_ends_on ? <><br />
                  <span className="muted">Medicine ends {dayLong(row.medicine_ends_on)}</span></> : null}</td>
                {/* A row that has been called today but still carries today's
                    date is neither due nor later — it says what it is. */}
                <td><span className={`status-pill ${row.due_on <= today && !row.called_today ? 'attention' : 'neutral'}`}>
                  {row.due_on > today ? dayLong(row.due_on)
                    : row.called_today ? 'Called today' : 'Due now'}
                </span></td>
                <td>{outcomeLabel(row.last_outcome) ?? 'Not called yet'}
                  {row.medicine_days_left ? <><br /><span className="muted">
                    {row.medicine_days_left} medicine days left</span></> : null}</td>
                <td onClick={(event) => event.stopPropagation()}>
                  {/* A WATI lead whose number is new to the customer base has
                      no history to open — the call itself is the first one. */}
                  <button type="button" disabled={!row.customer_id}
                    onClick={() => setViewing(row)}>Details</button>{' '}
                  <button type="button" disabled={row.is_dnd} onClick={() => setCalling(callTarget(row))}>
                    {row.is_dnd ? 'DND' : 'Mark call outcome'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 ? <div className="grid-empty"><p>{searching
          ? 'Is naam ya number ka koi open assigned follow-up nahi mila.'
          : tab === 'upcoming'
            ? 'Koi upcoming follow-up nahi hai. Call save karte waqt agli date chunne par lead yahan aayegi.'
            : rows.length
              ? 'Aaj ke saare assigned calls ho gaye. Upcoming tab mein agli follow-ups dekhein.'
              : 'Alka ma’am ke assigned AI Lead, Medicine Ending aur WATI Interested calls yahan dikhenge.'}</p></div> : null}
      </div>
      {viewing?.customer_id && !calling ? <CustomerPanel customerId={viewing.customer_id}
        name={viewing.full_name} phone={viewing.phone_e164}
        onClose={() => setViewing(null)}
        onLogCall={viewing.is_dnd ? undefined : () => setCalling(callTarget(viewing))} /> : null}
      {calling ? <LogCallDialog target={calling} numbers={numbers}
        preferredNumberId={preferredNumberId}
        onClose={() => setCalling(null)} onSaved={(result) => {
          const saved = calling.workId ?? calling.watiWorkId;
          if (saved) setDone((current) => new Set(current).add(saved));
          setViewing(null);
          setCalling(null);
          setMessage(result);
          router.refresh();
        }} /> : null}
    </section>
  );
}
