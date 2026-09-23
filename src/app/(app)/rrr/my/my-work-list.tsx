'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Icon } from '@/components/Icon';
import { CustomerPanel } from '../customer-panel';
import { LogCallDialog, type CallTarget, type ContactNumber } from '../log-call-dialog';
import { dayLong, money } from '../lib/format';
import { outcomeLabel } from '../lib/outcomes';
import { sortByValue, VALUE_SORTS } from '../lib/sort';
import { SortSelect } from '../sort-select';
import { markPotentialLead, removePotentialLead } from '../potential-leads-action';
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
  /** The customer's lifetime value and order count; 0 for a WATI lead who has
   *  never ordered. */
  ltv: number;
  lifetime_orders: number;
  last_order_at: string | null;
  order_no: string | null;
  /** What the lead came in about, for a WATI row that has no order to show. */
  note: string | null;
  medicine_ends_on: string | null;
};

export type PotentialLeadRow = {
  id: string;
  rrr_work_id: string | null;
  wati_work_id: string | null;
  customer_id: string | null;
  source: WorkSource;
  display_name: string;
  phone_e164: string;
  order_no: string | null;
  note: string | null;
  marked_by_name: string;
  marked_at: string;
};

const formatDateTime = (value: string) => new Date(value).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function MyWorkList({ rows, potentialLeads, numbers, preferredNumberId, today }: {
  rows: MyWorkRow[];
  potentialLeads: PotentialLeadRow[];
  numbers: ContactNumber[];
  /** The handset this rep last called from, seeding the Log-call dialog. */
  preferredNumberId: string | null;
  today: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('due');
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [viewing, setViewing] = useState<MyWorkRow | null>(null);
  const [viewingPotential, setViewingPotential] = useState<PotentialLeadRow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPotential, setPendingPotential] = useState<string | null>(null);
  const [localStarred, setLocalStarred] = useState<Map<string, string>>(new Map());
  const [localRemoved, setLocalRemoved] = useState<Set<string>>(new Set());
  const [, startPotentialTransition] = useTransition();
  const callTarget = (row: MyWorkRow): CallTarget => ({
    customerId: row.customer_id, name: row.full_name, phone: row.phone_e164,
    followupId: null, orderId: row.order_id,
    ...(row.watiWorkId ? { watiWorkId: row.watiWorkId } : { workId: row.id }),
  });
  const potentialKey = (row: MyWorkRow) => row.watiWorkId ? `wati:${row.watiWorkId}` : `rrr:${row.id}`;
  const rowPotentialKeys = (row: MyWorkRow) => [
    potentialKey(row),
    row.customer_id ? `customer:${row.customer_id}` : `phone:${row.phone_e164}`,
  ];
  // Saved just now — gone from the list before the server refresh lands. Only
  // ever a bridge: once the refreshed rows arrive they carry the saved outcome
  // and the new date themselves, so the set is dropped. Keeping it would hide
  // a customer who rang back an hour later from the rep searching for them.
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => { setDone(new Set()); }, [rows]);
  useEffect(() => {
    setLocalStarred(new Map());
    setLocalRemoved(new Set());
  }, [potentialLeads]);
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
  const [tab, setTab] = useState<'today' | 'upcoming' | 'potential'>('today');
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
    : tab === 'today' ? pending : tab === 'upcoming' ? upcoming : [];
  const visible = useMemo(() => sortByValue(list.filter((row) => {
    const query = search.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    return !query || row.full_name.toLowerCase().includes(query)
      || (digits.length > 0 && row.phone_e164.includes(digits));
  }), sort, (row) => ({
    ltv: row.ltv, orders: row.lifetime_orders, last_order_at: row.last_order_at, name: row.full_name,
  })), [list, search, sort]);
  const activePotentialLeads = useMemo(() =>
    potentialLeads.filter((lead) => !localRemoved.has(lead.id)),
    [potentialLeads, localRemoved],
  );
  const potentialKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const lead of activePotentialLeads) {
      if (lead.rrr_work_id) keys.add(`rrr:${lead.rrr_work_id}`);
      if (lead.wati_work_id) keys.add(`wati:${lead.wati_work_id}`);
      keys.add(lead.customer_id ? `customer:${lead.customer_id}` : `phone:${lead.phone_e164}`);
    }
    for (const key of localStarred.keys()) keys.add(key);
    return keys;
  }, [activePotentialLeads, localStarred]);
  const potentialLeadByKey = useMemo(() => {
    const byKey = new Map<string, PotentialLeadRow>();
    for (const lead of activePotentialLeads) {
      if (lead.rrr_work_id) byKey.set(`rrr:${lead.rrr_work_id}`, lead);
      if (lead.wati_work_id) byKey.set(`wati:${lead.wati_work_id}`, lead);
      byKey.set(lead.customer_id ? `customer:${lead.customer_id}` : `phone:${lead.phone_e164}`, lead);
    }
    return byKey;
  }, [activePotentialLeads]);
  const potentialVisible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    return activePotentialLeads.filter((lead) => !query
      || lead.display_name.toLowerCase().includes(query)
      || lead.marked_by_name.toLowerCase().includes(query)
      || (digits.length > 0 && lead.phone_e164.includes(digits)));
  }, [activePotentialLeads, search]);
  const activeWorkByPotentialKey = useMemo(() => {
    const byKey = new Map<string, MyWorkRow>();
    for (const row of rows) {
      for (const key of rowPotentialKeys(row)) {
        if (!byKey.has(key)) byKey.set(key, row);
      }
    }
    return byKey;
  }, [rows]);
  const workForPotential = (lead: PotentialLeadRow) =>
    (lead.wati_work_id ? activeWorkByPotentialKey.get(`wati:${lead.wati_work_id}`) : null)
    ?? (lead.rrr_work_id ? activeWorkByPotentialKey.get(`rrr:${lead.rrr_work_id}`) : null)
    ?? activeWorkByPotentialKey.get(lead.customer_id ? `customer:${lead.customer_id}` : `phone:${lead.phone_e164}`);
  const potentialForRow = (row: MyWorkRow) => {
    for (const key of rowPotentialKeys(row)) {
      const lead = potentialLeadByKey.get(key);
      if (lead) return lead;
    }
    return null;
  };

  function markPotential(row: MyWorkRow) {
    const key = potentialKey(row);
    setPendingPotential(key);
    startPotentialTransition(() => {
      void (async () => {
        const result = await markPotentialLead({
          workId: row.watiWorkId ? null : row.id,
          watiWorkId: row.watiWorkId,
        });
        setPendingPotential(null);
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
        setLocalStarred((current) => new Map(current).set(key, result.id));
        setMessage(`${row.full_name} saved in Potential leads.`);
        router.refresh();
      })();
    });
  }

  function removePotentialById(id: string, name: string) {
    setPendingPotential(`remove:${id}`);
    startPotentialTransition(() => {
      void (async () => {
        const result = await removePotentialLead(id);
        setPendingPotential(null);
        if (!result.ok) {
          setMessage(result.error);
          return;
        }
        setLocalRemoved((current) => new Set(current).add(id));
        setLocalStarred((current) => {
          const next = new Map(current);
          for (const [key, value] of next) {
            if (value === id) next.delete(key);
          }
          return next;
        });
        setMessage(`${name} removed from Potential leads.`);
        router.refresh();
      })();
    });
  }

  function removePotential(lead: PotentialLeadRow) {
    removePotentialById(lead.id, lead.display_name);
  }

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
          <button type="button" role="tab" aria-selected={tab === 'potential'}
            className={tab === 'potential' ? 'active' : ''} onClick={() => setTab('potential')}>
            Potential leads<span>{activePotentialLeads.length}</span>
          </button>
        </div>
        {message ? <span className="muted" role="status">{message}</span> : null}
      </div>
      <div className="rrr-filters">
        <div className="rrr-filter-grid">
        <label className="rrr-field wide">
          <span>{tab === 'potential' ? 'Search potential lead' : 'Search assigned customer'}</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === 'potential'
              ? 'Name, phone or salesperson'
              : 'Name or phone — searches Today and Upcoming'} />
        </label>
        {tab !== 'potential' ? (
          <SortSelect id="my-work-sort" value={sort} onChange={setSort}
            first={{ value: 'due', label: 'Due date (default)' }} options={VALUE_SORTS} />
        ) : null}
        </div>
      </div>
      <div className="grid-scroll">
        <table className="records-table rrr-table">
          {tab === 'potential' ? (
            <thead><tr><th>Customer</th><th>Source</th><th>Order / note</th><th>Marked potential</th>
              <th>Salesperson</th><th /></tr></thead>
          ) : (
            <thead><tr><th>Customer</th><th>Source</th><th>Order</th><th>{searching ? 'Due / next follow-up' : tab === 'today' ? 'Due' : 'Next follow-up'}</th>
              <th>Last outcome</th><th /></tr></thead>
          )}
          <tbody>
            {tab === 'potential' ? potentialVisible.map((lead) => {
              const work = workForPotential(lead);
              return (
              <tr key={lead.id} className="record-row" onClick={() => setViewingPotential(lead)}
                style={{ cursor: lead.customer_id ? 'pointer' : 'default' }}>
                <td><strong>{lead.display_name}</strong><br /><span className="muted">{lead.phone_e164}</span></td>
                <td><span className={`status-pill ${workSourceTone(lead.source)}`}>
                  {workSourceLabel(lead.source)}
                </span></td>
                <td>{lead.order_no ?? <span className="muted">{lead.note ?? 'No order yet'}</span>}</td>
                <td>{formatDateTime(lead.marked_at)}</td>
                <td>{lead.marked_by_name}</td>
                <td className="rrr-actions-cell" onClick={(event) => event.stopPropagation()}>
                  <div className="rrr-row-actions">
                    <button type="button" disabled={!lead.customer_id}
                      onClick={() => setViewingPotential(lead)}>Details</button>
                    {work ? (
                      <button type="button" disabled={work.is_dnd} onClick={() => setCalling(callTarget(work))}>
                        {work.is_dnd ? 'DND' : 'Mark call outcome'}
                      </button>
                    ) : (
                      <button type="button" disabled>No open follow-up</button>
                    )}
                    <button
                      type="button"
                      className="potential-star active"
                      title="Remove from Potential leads"
                      aria-label={`Remove ${lead.display_name} from Potential leads`}
                      aria-pressed={true}
                      disabled={pendingPotential === `remove:${lead.id}`}
                      onClick={() => removePotential(lead)}
                    >
                      <Icon name="star" />
                    </button>
                  </div>
                </td>
              </tr>
            ); }) : visible.map((row) => {
              const existingPotential = potentialForRow(row);
              const key = potentialKey(row);
              const localPotentialId = localStarred.get(key);
              const starred = !!existingPotential || rowPotentialKeys(row).some((k) => potentialKeys.has(k));
              return (
              <tr key={row.id} className="record-row" onClick={() => setViewing(row)}
                style={{ cursor: 'pointer' }}>
                <td><strong>{row.full_name}</strong><br /><span className="muted">{row.phone_e164}</span>
                  {row.lifetime_orders ? <><br /><span className="muted">
                    LTV {money(row.ltv)} · {row.lifetime_orders} {row.lifetime_orders === 1 ? 'order' : 'orders'}</span></> : null}</td>
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
                <td className="rrr-actions-cell" onClick={(event) => event.stopPropagation()}>
                  <div className="rrr-row-actions">
                    {/* A WATI lead whose number is new to the customer base has
                        no history to open — the call itself is the first one. */}
                    <button type="button" disabled={!row.customer_id}
                      onClick={() => setViewing(row)}>Details</button>
                    <button type="button" disabled={row.is_dnd} onClick={() => setCalling(callTarget(row))}>
                      {row.is_dnd ? 'DND' : 'Mark call outcome'}</button>
                    <button
                      type="button"
                      className={`potential-star ${starred ? 'active' : ''}`}
                      title={starred ? 'Remove from Potential leads' : 'Mark as potential lead'}
                      aria-label={starred ? `Remove ${row.full_name} from Potential leads` : `Mark ${row.full_name} as potential lead`}
                      aria-pressed={starred}
                      disabled={pendingPotential === key
                        || (!!existingPotential && pendingPotential === `remove:${existingPotential.id}`)
                        || (!!localPotentialId && pendingPotential === `remove:${localPotentialId}`)}
                      onClick={() => existingPotential
                        ? removePotential(existingPotential)
                        : localPotentialId
                          ? removePotentialById(localPotentialId, row.full_name)
                          : markPotential(row)}
                    >
                      <Icon name="star" />
                    </button>
                  </div>
                </td>
              </tr>
            ); })}
          </tbody>
        </table>
        {tab === 'potential' && potentialVisible.length === 0 ? <div className="grid-empty"><p>{searching
          ? 'Is naam, number ya salesperson ka koi potential lead nahi mila.'
          : 'Abhi koi potential lead mark nahi hai. Star dabate hi lead yahan save hogi.'}</p></div> : null}
        {tab !== 'potential' && visible.length === 0 ? <div className="grid-empty"><p>{searching
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
      {viewingPotential?.customer_id && !calling ? <CustomerPanel customerId={viewingPotential.customer_id}
        name={viewingPotential.display_name} phone={viewingPotential.phone_e164}
        onClose={() => setViewingPotential(null)} /> : null}
      {calling ? <LogCallDialog target={calling} numbers={numbers}
        preferredNumberId={preferredNumberId}
        onClose={() => setCalling(null)} onSaved={(result) => {
          const saved = calling.workId ?? calling.watiWorkId;
          if (saved) setDone((current) => new Set(current).add(saved));
          setViewing(null);
          setViewingPotential(null);
          setCalling(null);
          setMessage(result);
          router.refresh();
        }} /> : null}
    </section>
  );
}
