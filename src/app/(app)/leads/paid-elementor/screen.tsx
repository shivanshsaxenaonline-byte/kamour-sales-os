'use client';

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useToast, useViewer } from '@/components/CrmProvider';
import { Icon } from '@/components/Icon';
import { TableSkeleton } from '@/components/LoadingSkeleton';
import { addDays, istDate } from '@/lib/razorpay/analytics';
import {
  assignPaidElementorLeads,
  getPaidElementorLeadDetail,
  getPaidElementorLeads,
  type PaidElementorAssignee,
  type PaidElementorLead,
  type PaidElementorResult,
} from './actions';
import '../../razorpay/razorpay.css';

const PAGE_SIZE = 50;
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);
type RangePreset = 'all' | 'today' | 'week' | 'month' | 'custom';
const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not recorded';
const formatValue = (value: string | number | null | undefined) => value ?? 'Not recorded';

export function PaidElementorScreen({
  initialData,
  initialStart,
  initialEnd,
  assignees,
}: {
  initialData: PaidElementorResult | null;
  initialStart: string;
  initialEnd: string;
  assignees: PaidElementorAssignee[];
}) {
  const viewer = useViewer();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [range, setRange] = useState<RangePreset>('all');
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [selected, setSelected] = useState<PaidElementorLead | null>(null);
  const loadMore = useRef<HTMLDivElement>(null);
  const canAssign = ASSIGN_ROLES.has(viewer.role) || assignees.length > 0;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const invalid = !!start && !!end && start > end;
  const query = useInfiniteQuery<PaidElementorResult>({
    queryKey: ['paid-elementor', viewer.id, debounced, start, end],
    enabled: !invalid,
    initialPageParam: 0,
    initialData: initialData ? { pages: [initialData], pageParams: [0] } : undefined,
    getNextPageParam: lastPage => lastPage.nextOffset ?? undefined,
    queryFn: ({ pageParam }) => getPaidElementorLeads({
      search: debounced,
      start,
      end,
      offset: typeof pageParam === 'number' ? pageParam : 0,
      pageSize: PAGE_SIZE,
    }),
    refetchInterval: 60000,
  });
  const rows = query.data?.pages.flatMap(page => page.rows) ?? [];
  const selectableRows = rows.slice(0, 100);
  const allLoadedChecked = !!selectableRows.length && selectableRows.every(row => checked.has(row.lead_id));
  const detail = useQuery({
    queryKey: ['paid-elementor-detail', viewer.id, selected?.lead_id, selected?.payment_id],
    enabled: !!selected,
    queryFn: () => getPaidElementorLeadDetail({ leadId: selected!.lead_id, paymentId: selected!.payment_id }),
  });
  const assignment = useMutation({
    mutationFn: () => assignPaidElementorLeads({ leadIds: [...checked], ownerId: assignTo }),
    onSuccess: async result => {
      const assignee = assignees.find(item => item.id === assignTo)?.name ?? 'salesperson';
      setChecked(new Set());
      setAssignTo('');
      notify('Paid leads assigned', `${result.assigned} lead${result.assigned === 1 ? '' : 's'} assigned to ${assignee}.`);
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

  useEffect(() => setChecked(new Set()), [debounced, start, end, canAssign]);

  function setRangePreset(next: RangePreset) {
    const today = istDate();
    setRange(next);
    if (next === 'all') {
      setStart('');
      setEnd('');
    } else if (next === 'today') {
      setStart(today);
      setEnd(today);
    } else if (next === 'week') {
      setStart(addDays(today, -6));
      setEnd(today);
    } else if (next === 'month') {
      setStart(`${today.slice(0, 8)}01`);
      setEnd(today);
    }
  }

  function toggle(id: string) {
    setChecked(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < 100) next.add(id);
      return next;
    });
  }

  function toggleLoaded() {
    setChecked(previous => {
      const next = new Set(previous);
      if (allLoadedChecked) selectableRows.forEach(row => next.delete(row.lead_id));
      else selectableRows.forEach(row => next.add(row.lead_id));
      return next;
    });
  }

  return <><div className="rz-page paid-page"><header className="rz-header"><div><div className="rz-eyebrow">LEADS</div><h1>Paid Elementor</h1></div><button aria-label="Refresh paid leads" title="Refresh paid leads" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" /></button></header>
    <div className="rz-filters">
      <label>Search<input aria-label="Search paid leads" placeholder="Name, phone, payment ID or insight" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Period<select aria-label="Payment period" value={range} onChange={event => setRangePreset(event.target.value as RangePreset)}><option value="all">All time</option><option value="today">Today</option><option value="week">Last 7 days</option><option value="month">This month</option><option value="custom">Custom range</option></select></label>
      <label>Payment from (IST)<input aria-label="Payment from" type="date" value={start} onChange={event => { setRange('custom'); setStart(event.target.value); }} /></label>
      <label>Payment to (IST)<input aria-label="Payment to" type="date" value={end} onChange={event => { setRange('custom'); setEnd(event.target.value); }} /></label>
    </div>
    <div className="rz-body">{invalid ? <p role="alert">Start date must be on or before end date.</p> : query.isPending ? <TableSkeleton rows={10} columns={8} label="Loading verified paid Elementor leads" /> : query.isError ? <p role="alert">Could not load paid Elementor leads. <button onClick={() => void query.refetch()}>Retry</button></p> : <>
      {canAssign ? <div className="paid-assignbar">
        <select aria-label="Assign selected paid leads to" value={assignTo} disabled={assignment.isPending} onChange={event => setAssignTo(event.target.value)}>
          <option value="">Assign selected to...</option>{assignees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
        <button type="button" disabled={!checked.size || !assignTo || assignment.isPending} onClick={() => assignment.mutate()}>{assignment.isPending ? 'Assigning...' : `Assign ${checked.size || ''}`.trim()}</button>
        {checked.size ? <button type="button" onClick={() => setChecked(new Set())} disabled={assignment.isPending}>Clear</button> : null}
        <span>{checked.size ? `${checked.size} selected` : 'No leads selected'}</span>
        {assignment.isError ? <span className="rz-error" role="alert">{assignment.error instanceof Error ? assignment.error.message : 'Assignment failed.'}</span> : null}
      </div> : null}
      <div className="rz-table-scroll" aria-busy={query.isFetchingNextPage}><table><thead><tr>{canAssign ? <th className="paid-check"><input type="checkbox" aria-label="Select up to 100 loaded paid leads" checked={allLoadedChecked} onChange={toggleLoaded} /></th> : null}{['Payment time (IST)', 'Customer', 'Contact number', 'Lead status', 'Salesperson', 'Connection status', 'Lead insight', ''].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.payment_id} className={checked.has(row.lead_id) ? 'paid-selected' : undefined}>{canAssign ? <td className="paid-check"><input type="checkbox" aria-label={`Select ${row.full_name}`} checked={checked.has(row.lead_id)} onChange={() => toggle(row.lead_id)} /></td> : null}<td>{formatDateTime(row.paid_at)}</td><td>{row.full_name}</td><td>{row.phone}</td><td>{row.lead_status}</td><td>{row.salesperson ?? 'Unassigned'}</td><td>{row.connection_status}</td><td style={{ minWidth: 220, whiteSpace: 'normal' }}>{row.lead_insight ?? 'No call note yet'}</td><td><button onClick={() => setSelected(row)}>Open details</button></td></tr>)}{!rows.length && <tr><td colSpan={canAssign ? 9 : 8} className="rz-empty">No verified INR 99 Razorpay payments match a Zoho CRM lead.</td></tr>}</tbody></table></div>
      <div ref={loadMore} />{query.isFetchingNextPage ? <p className="rz-muted" role="status">Loading more paid leads...</p> : null}
    </>}</div></div>
    {selected ? <dialog open className="rz-detail" aria-labelledby="paid-lead-detail-title"><header className="rz-detail-header"><div><div className="rz-eyebrow">PAID ELEMENTOR LEAD</div><h2 id="paid-lead-detail-title">{selected.full_name}</h2></div><button onClick={() => setSelected(null)}>Close</button></header>{detail.isPending ? <p role="status">Loading lead details...</p> : detail.isError ? <p role="alert">Could not load paid lead details.</p> : detail.data ? <div>
      <section className="rz-detail-section"><h3>Payment</h3><dl><div><dt>Razorpay payment</dt><dd>{detail.data.payment.id}</dd></div><div><dt>Payment time (IST)</dt><dd>{formatDateTime(detail.data.payment.paid_at)}</dd></div><div><dt>Amount</dt><dd>Rs. {detail.data.payment.amount.toFixed(2)}</dd></div></dl></section>
      <section className="rz-detail-section"><h3>Customer and Lead</h3><dl>{[['Customer', detail.data.customer.full_name], ['Contact number', detail.data.customer.phone], ['Alternate number', detail.data.customer.alternate_phone], ['Email', detail.data.customer.email], ['Age', detail.data.customer.age], ['Gender', detail.data.customer.gender], ['State', detail.data.customer.state], ['Address', detail.data.customer.address], ['Zoho lead date', formatDateTime(detail.data.lead.created_at)], ['Lead source', detail.data.lead.source], ['Lead status', detail.data.lead.status], ['Concern', detail.data.lead.concern]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatValue(value)}</dd></div>)}</dl></section>
      <section className="rz-detail-section"><h3>Connection</h3><dl>{[['Salesperson', detail.data.lead.salesperson], ['Connection status', detail.data.lead.connection_status], ['Date of connection', formatDateTime(detail.data.lead.connection_at)], ['Lead insight', detail.data.lead.insight]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatValue(value)}</dd></div>)}</dl></section>
      <section className="rz-detail-section"><h3>Follow-up History</h3>{detail.data.followups.length ? <div className="rz-detail-followups"><table><thead><tr><th>Attempt</th><th>Due</th><th>Done</th><th>Salesperson</th><th>Outcome</th><th>Remark</th></tr></thead><tbody>{detail.data.followups.map(followup => <tr key={`${followup.attempt_no}-${followup.due_at}`}><td>{followup.attempt_no}</td><td>{formatDateTime(followup.due_at)}</td><td>{formatDateTime(followup.completed_at)}</td><td>{formatValue(followup.salesperson)}</td><td>{formatValue(followup.outcome)}</td><td>{formatValue(followup.remark)}</td></tr>)}</tbody></table></div> : <p className="rz-muted">No follow-up history recorded.</p>}</section>
      <section className="rz-detail-section"><h3>Attribution</h3><dl>{[['UTM source', detail.data.lead.utm_source], ['UTM medium', detail.data.lead.utm_medium], ['UTM campaign', detail.data.lead.utm_campaign]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatValue(value)}</dd></div>)}</dl></section>
    </div> : null}</dialog> : null}</>;
}
