'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useToast, useViewer } from '@/components/CrmProvider';
import { Icon } from '@/components/Icon';
import { TableSkeleton } from '@/components/LoadingSkeleton';
import { outcomeLabel } from '@/app/(app)/rrr/lib/outcomes';
import { workSourceLabel, workSourceTone } from '@/lib/work-tags';
import { assignWatiInterestedLeads, getWatiInterestedLeads, type WatiAssignee, type WatiInterestedLead, type WatiInterestedResult } from './actions';
import '../../razorpay/razorpay.css';
import './wati-interested.css';

const PAGE_SIZE = 50;
// Mirrors the gate in actions.ts, which mirrors the one in the database.
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'auditor']);
const formatDateTime = (value: string | null) => value
  ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  : 'Not recorded';

/** The hand-over, as the person who made it needs to read it back: the tag the
 *  rep now sees on their own list, who has it, and what came of the call. */
function CallingStatus({ work }: { work: WatiInterestedLead['work'] }) {
  if (!work) return <span className="muted">Not handed over</span>;
  return <span className="wati-tagcell">
    <span className={`status-pill ${workSourceTone('wati_interested')}`}>
      {workSourceLabel('wati_interested')}
    </span>
    <span>{work.rep}</span>
    <span className="muted">{work.completed
      ? `Closed · ${outcomeLabel(work.lastOutcome) ?? 'no response recorded'}`
      : work.lastOutcome
        ? `${outcomeLabel(work.lastOutcome)} · calling again`
        : 'Not called yet'}</span>
  </span>;
}

/** Rupees the way every other money column on this dashboard shows them. */
const money = (value: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
}).format(value);
const formatDate = (value: string) => new Date(value).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
});

/**
 * What our own order book says about the number, in the three states that
 * change what a person should do with the row.
 *
 * "Converted" is the win this page is for: an order placed after the chat was
 * marked Interested. "Already a customer" is the one that was invisible until
 * now — they bought before anybody marked them, so handing them out as a fresh
 * prospect wastes a call and confuses the customer. Everyone else is the
 * ordinary case, and says so plainly rather than sitting blank.
 */
function OrderStatus({ orders }: { orders: WatiInterestedLead['orders'] }) {
  // A customer row with no orders says nothing: every WhatsApp lead on this
  // page has one already. Only an actual order is worth a word here.
  if (!orders?.lastOrder) return <span className="muted">No order</span>;
  const { lastOrder } = orders;
  const converted = orders.ordersSinceInterest > 0;
  return <span className="wati-ordercell">
    <span className={`status-pill ${converted ? 'positive' : 'attention'}`}>
      {converted
        ? `Converted${orders.ordersSinceInterest > 1 ? ` ×${orders.ordersSinceInterest}` : ''}`
        : 'Already a customer'}
    </span>
    <span>{lastOrder.orderNo} · {money(lastOrder.amount)}</span>
    <span className="muted">{formatDate(lastOrder.placedAt)} · {lastOrder.stage} · {lastOrder.paymentState}</span>
  </span>;
}

export function WatiInterestedScreen({ initialData }: { initialData: WatiInterestedResult | null }) {
  const viewer = useViewer();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<WatiInterestedLead | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState<WatiAssignee | ''>('');
  const loadMore = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery<WatiInterestedResult>({
    queryKey: ['wati-interested', viewer.id, debounced],
    initialPageParam: 0,
    initialData: !debounced && initialData ? { pages: [initialData], pageParams: [0] } : undefined,
    getNextPageParam: lastPage => lastPage.nextOffset ?? undefined,
    queryFn: ({ pageParam }) => getWatiInterestedLeads({
      search: debounced,
      offset: typeof pageParam === 'number' ? pageParam : 0,
      pageSize: PAGE_SIZE,
    }),
    refetchInterval: 60000,
  });
  const rows = query.data?.pages.flatMap(page => page.rows) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const canAssign = ASSIGN_ROLES.has(viewer.role);
  const allLoadedChecked = !!rows.length && rows.every(row => checked.has(row.id));
  const assignment = useMutation({
    mutationFn: () => assignWatiInterestedLeads({ leadIds: [...checked], assignee: assignee as WatiAssignee }),
    onSuccess: async result => {
      setChecked(new Set());
      setAssignee('');
      notify('WATI leads assigned', `${result.assigned} lead${result.assigned === 1 ? '' : 's'} assigned to ${result.assignee}.`);
      await query.refetch();
    },
  });

  useEffect(() => {
    const target = loadMore.current;
    if (!target || !query.hasNextPage || query.isFetchingNextPage) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void query.fetchNextPage();
    }, { rootMargin: '300px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);

  useEffect(() => setChecked(new Set()), [debounced]);

  function toggle(id: string) {
    setChecked(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleLoaded() {
    setChecked(previous => {
      const next = new Set(previous);
      if (allLoadedChecked) rows.forEach(row => next.delete(row.id));
      else rows.forEach(row => next.add(row.id));
      return next;
    });
  }

  return <>
    <div className="rz-page wati-page">
      <header className="rz-header">
        <div><div className="rz-eyebrow">WATI LEADS</div><h1>Interested <span className="rz-mode">Live</span></h1></div>
        <div className="module-tabs">
          <Link href="/leads/wati-interested" className="active" aria-current="page">Interested leads</Link>
          <Link href="/rrr/analytics">Analytics</Link>
        </div>
        <button aria-label="Refresh WATI Interested leads" title="Refresh WATI Interested leads" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" /></button>
      </header>
      <div className="rz-filters">
        <label>Search<input aria-label="Search WATI Interested leads" placeholder="Name, number or source" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="wati-count"><strong>{total.toLocaleString('en-IN')}</strong><span>Interested leads</span></div>
      </div>
      <div className="rz-body">
        {query.isPending ? <TableSkeleton rows={10} columns={8} label="Loading WATI Interested leads" /> : query.isError ? <p className="rz-error" role="alert">Could not load WATI Interested leads. <button onClick={() => void query.refetch()}>Retry</button></p> : <>
          {canAssign ? <div className="wati-assignbar">
            <select aria-label="Assign selected WATI leads to" value={assignee} disabled={assignment.isPending} onChange={event => setAssignee(event.target.value as WatiAssignee | '')}>
              <option value="">Assign selected to...</option><option value="ashutosh">Ashutosh</option><option value="shreyansh">Shreyansh</option><option value="tejasv">Tejasv</option>
            </select>
            <button type="button" disabled={!checked.size || !assignee || assignment.isPending} onClick={() => assignment.mutate()}>{assignment.isPending ? 'Assigning...' : `Assign ${checked.size || ''}`.trim()}</button>
            {checked.size ? <button type="button" onClick={() => setChecked(new Set())} disabled={assignment.isPending}>Clear selection</button> : null}
            <span>{checked.size ? `${checked.size} selected` : 'Select leads using the checkboxes'}</span>
            {assignment.isError ? <span className="rz-error" role="alert">Assignment failed. Please retry.</span> : null}
          </div> : null}
          <div className="rz-table-scroll" aria-busy={query.isFetchingNextPage}>
            <table><thead><tr>{canAssign ? <th className="wati-check"><input type="checkbox" aria-label="Select all loaded WATI leads" checked={allLoadedChecked} onChange={toggleLoaded} /></th> : null}{['Potential since (IST)', 'Customer', 'Number', 'Order', 'Assigned to', 'Calling status', 'Marked potential by', 'Source', 'Intent', 'Concern', ''].map(header => <th key={header}>{header}</th>)}</tr></thead>
              <tbody>{rows.map(row => {
                // Handed over and not yet called: struck through until the rep
                // logs one, the same as every RRR list.
                const waiting = !!row.work && !row.work.completed && !row.work.lastOutcome;
                return <tr key={row.id} className={`${checked.has(row.id) ? 'wati-selected' : ''} ${waiting ? 'wati-waiting' : ''}`.trim() || undefined}>
                {canAssign ? <td className="wati-check no-strike"><input type="checkbox" aria-label={`Select ${row.displayName}`} checked={checked.has(row.id)} onChange={() => toggle(row.id)} /></td> : null}<td>{formatDateTime(row.potentialAt)}</td><td><button type="button" className="wati-name" onClick={() => setSelected(row)}>{row.displayName}</button></td><td>{row.phone}</td><td className="wati-wrap no-strike"><OrderStatus orders={row.orders} /></td><td>{row.assignedTo ?? 'Unassigned'}</td><td className="wati-wrap no-strike"><CallingStatus work={row.work} /></td><td>{row.markedBy}</td><td>{row.source}</td><td>{row.intentScore ?? 'Not scored'}</td><td className="wati-wrap">{row.primaryConcern ?? 'Not recorded'}</td><td className="no-strike"><button onClick={() => setSelected(row)}>Open details</button></td>
              </tr>;
              })}{!rows.length && <tr><td colSpan={canAssign ? 12 : 11} className="rz-empty">No WATI Interested leads match this search.</td></tr>}</tbody></table>
          </div>
          <div ref={loadMore} />
          {query.isFetchingNextPage ? <p className="rz-muted" role="status">Loading more Interested leads...</p> : null}
        </>}
      </div>
    </div>
    {selected ? <dialog open className="rz-detail" aria-labelledby="wati-lead-detail-title">
      <header className="rz-detail-header"><div><div className="rz-eyebrow">WATI INTERESTED LEAD</div><h2 id="wati-lead-detail-title">{selected.displayName}</h2></div><button onClick={() => setSelected(null)}>Close</button></header>
      <section className="rz-detail-section"><h3>Lead ownership</h3><dl>
        <div><dt>Number</dt><dd>{selected.phone}</dd></div><div><dt>Assigned to</dt><dd>{selected.assignedTo ?? 'Unassigned'}</dd></div><div><dt>Marked potential by</dt><dd>{selected.markedBy}</dd></div><div><dt>Potential since (IST)</dt><dd>{formatDateTime(selected.potentialAt)}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div>
      </dl></section>
      <section className="rz-detail-section"><h3>Calling status</h3><dl>
        <div><dt>On the rep&apos;s call list</dt><dd><CallingStatus work={selected.work} /></dd></div><div><dt>Handed over (IST)</dt><dd>{formatDateTime(selected.work?.assignedAt ?? null)}</dd></div><div><dt>Last called (IST)</dt><dd>{formatDateTime(selected.work?.lastCalledAt ?? null)}</dd></div>
      </dl></section>
      <section className="rz-detail-section"><h3>Order book</h3>{selected.orders ? <dl>
        <div><dt>Status</dt><dd><OrderStatus orders={selected.orders} /></dd></div>
        <div><dt>Customer record</dt><dd>{selected.orders.fullName}</dd></div>
        <div><dt>Lifetime orders</dt><dd>{selected.orders.lifetimeOrders}</dd></div>
        <div><dt>Lifetime value</dt><dd>{money(selected.orders.lifetimeValue)}</dd></div>
        <div><dt>Orders since marked Interested</dt><dd>{selected.orders.ordersSinceInterest}</dd></div>
        {selected.orders.lastOrder ? <>
          <div><dt>Last order</dt><dd>{selected.orders.lastOrder.orderNo}</dd></div>
          <div><dt>Amount</dt><dd>{money(selected.orders.lastOrder.amount)}</dd></div>
          <div><dt>Placed (IST)</dt><dd>{formatDateTime(selected.orders.lastOrder.placedAt)}</dd></div>
          <div><dt>Stage</dt><dd>{selected.orders.lastOrder.stage}</dd></div>
          <div><dt>Payment</dt><dd>{selected.orders.lastOrder.paymentState}</dd></div>
          <div><dt>Course length</dt><dd>{selected.orders.lastOrder.courseDays ? `${selected.orders.lastOrder.courseDays} days` : 'Not recorded'}</dd></div>
          <div><dt>Booked by</dt><dd>{selected.orders.lastOrder.owner ?? 'Not recorded'}</dd></div>
        </> : null}
      </dl> : <p className="muted">This number has never ordered. Nothing in the order book matches it.</p>}</section>
      <section className="rz-detail-section"><h3>Lead intelligence</h3><dl>
        <div><dt>Intent score</dt><dd>{selected.intentScore ?? 'Not scored'}</dd></div><div><dt>Primary concern</dt><dd>{selected.primaryConcern ?? 'Not recorded'}</dd></div><div><dt>AI summary</dt><dd>{selected.summary ?? 'Not recorded'}</dd></div><div><dt>Next action</dt><dd>{selected.nextAction ?? 'Not recorded'}</dd></div>
      </dl></section>
      <section className="rz-detail-section"><h3>Conversation timing</h3><dl>
        <div><dt>Last inbound (IST)</dt><dd>{formatDateTime(selected.lastInboundAt)}</dd></div><div><dt>Reply window expired (IST)</dt><dd>{formatDateTime(selected.replyWindowExpiredAt)}</dd></div>
      </dl></section>
    </dialog> : null}
  </>;
}
