'use client';

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useToast, useViewer } from '@/components/CrmProvider';
import { TableSkeleton } from '@/components/LoadingSkeleton';
import {
  assignPcrLeads,
  getPcrLeads,
  type PcrAssignee,
  type PcrLead,
  type PcrLeadResult,
  type PcrStatusFilter,
} from './actions';
import '../../razorpay/razorpay.css';
import './pcr.css';

const PAGE_SIZE = 50;
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);

function formatDate(value: string | null) {
  if (!value) return 'Not recorded';
  return new Date(`${value}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not recorded';
}

function priority(lead: PcrLead) {
  if (lead.converted) return { label: 'Converted', tone: 'good' };
  if (lead.priorityRank === 0) return { label: `Missed F${lead.nextFollowupAttempt ?? ''}`, tone: 'bad' };
  if (lead.priorityRank === 1) return { label: `Upcoming F${lead.nextFollowupAttempt ?? ''}`, tone: 'warn' };
  if (lead.priorityRank === 2) return { label: 'Date missing', tone: '' };
  return { label: 'Cycle complete', tone: 'good' };
}

export function PcrScreen({ initialData, assignees }: { initialData: PcrLeadResult | null; assignees: PcrAssignee[] }) {
  const viewer = useViewer();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<PcrStatusFilter>('all');
  const [owner, setOwner] = useState('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [selected, setSelected] = useState<PcrLead | null>(null);
  const loadMore = useRef<HTMLDivElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const canAssign = ASSIGN_ROLES.has(viewer.role);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery<PcrLeadResult>({
    queryKey: ['pcr-leads', viewer.id, debounced, status, owner],
    initialPageParam: 0,
    initialData: !debounced && status === 'all' && owner === 'all' && initialData
      ? { pages: [initialData], pageParams: [0] }
      : undefined,
    getNextPageParam: page => page.nextOffset ?? undefined,
    queryFn: ({ pageParam }) => getPcrLeads({
      search: debounced,
      status,
      owner,
      offset: typeof pageParam === 'number' ? pageParam : 0,
      pageSize: PAGE_SIZE,
    }),
    refetchInterval: 60000,
  });

  const rows = query.data?.pages.flatMap(page => page.rows) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const syncWarning = query.data?.pages[0]?.syncWarning ?? false;
  const selectableRows = rows.slice(0, 100);
  const allLoadedChecked = !!selectableRows.length && selectableRows.every(row => checked.has(row.id));

  const assignment = useMutation({
    mutationFn: () => assignPcrLeads({ leadIds: [...checked], ownerId: assignTo }),
    onSuccess: async result => {
      const assignee = assignees.find(item => item.id === assignTo)?.name ?? 'salesperson';
      setChecked(new Set());
      setAssignTo('');
      notify('PCR leads assigned', `${result.assigned} lead${result.assigned === 1 ? '' : 's'} assigned to ${assignee}.`);
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

  useEffect(() => setChecked(new Set()), [debounced, status, owner]);

  useEffect(() => {
    const dialog = detailDialog.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
  }, [selected]);

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
      if (allLoadedChecked) selectableRows.forEach(row => next.delete(row.id));
      else selectableRows.forEach(row => next.add(row.id));
      return next;
    });
  }

  return <>
    <div className="rz-page pcr-page">
      <header className="rz-header">
        <div><div className="rz-eyebrow">PCR CALLING</div><h1>Follow-up queue <span className="rz-mode">Sheet live</span></h1></div>
        <button aria-label="Refresh PCR Calling" title="Refresh PCR Calling" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" /></button>
      </header>

      <div className="rz-filters">
        <label>Search<input aria-label="Search PCR leads" placeholder="Name, number or follow-up" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <label>Status<select aria-label="Filter PCR leads by status" value={status} onChange={event => setStatus(event.target.value as PcrStatusFilter)}>
          <option value="all">All PCR leads</option><option value="missed">Missed follow-up</option><option value="upcoming">Upcoming</option><option value="completed">Cycle complete</option><option value="converted">Converted</option>
        </select></label>
        {canAssign ? <label>Owner<select aria-label="Filter PCR leads by owner" value={owner} onChange={event => setOwner(event.target.value)}>
          <option value="all">All owners</option><option value="unassigned">Unassigned</option>{assignees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label> : null}
        <div className="pcr-count"><strong>{total.toLocaleString('en-IN')}</strong><span>records</span></div>
      </div>

      <div className="rz-body">
        {syncWarning ? <p className="pcr-sync-warning" role="status">Showing saved Supabase data. Sheet refresh will retry automatically.</p> : null}
        {query.isPending ? <TableSkeleton rows={10} columns={8} label="Loading PCR Calling" /> : query.isError ? <p className="rz-error" role="alert">Could not load PCR Calling. <button onClick={() => void query.refetch()}>Retry</button></p> : <>
          {canAssign ? <div className="pcr-assignbar">
            <select aria-label="Assign selected PCR leads to" value={assignTo} disabled={assignment.isPending} onChange={event => setAssignTo(event.target.value)}>
              <option value="">Assign selected to...</option>{assignees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            <button type="button" disabled={!checked.size || !assignTo || assignment.isPending} onClick={() => assignment.mutate()}>{assignment.isPending ? 'Assigning...' : `Assign ${checked.size || ''}`.trim()}</button>
            {checked.size ? <button type="button" onClick={() => setChecked(new Set())} disabled={assignment.isPending}>Clear</button> : null}
            <span>{checked.size ? `${checked.size} selected` : 'No leads selected'}</span>
            {assignment.isError ? <span className="rz-error" role="alert">{assignment.error instanceof Error ? assignment.error.message : 'Assignment failed.'}</span> : null}
          </div> : null}

          <div className="rz-table-scroll" aria-busy={query.isFetchingNextPage}>
            <table><thead><tr>
              {canAssign ? <th className="pcr-check"><input type="checkbox" aria-label="Select up to 100 loaded PCR leads" checked={allLoadedChecked} onChange={toggleLoaded} /></th> : null}
              {['Priority', 'Booking', 'Customer', 'Number', 'Owner', 'Follow-ups', 'Last touch', 'Next due', 'Last update', ''].map(header => <th key={header}>{header}</th>)}
            </tr></thead><tbody>
              {rows.map(row => {
                const state = priority(row);
                return <tr key={row.id} className={checked.has(row.id) ? 'pcr-selected' : undefined}>
                  {canAssign ? <td className="pcr-check"><input type="checkbox" aria-label={`Select ${row.customerName}`} checked={checked.has(row.id)} onChange={() => toggle(row.id)} /></td> : null}
                  <td><span className={`rz-status ${state.tone}`}>{state.label}</span></td>
                  <td>{formatDate(row.bookingDate)}</td>
                  <td><strong>{row.customerName}</strong><small>Sheet row {row.sourceRowNumber}</small></td>
                  <td>{row.phoneRaw ?? row.phoneE164 ?? 'Not recorded'}</td>
                  <td>{row.ownerName ?? 'Unassigned'}</td>
                  <td>{row.followupCount}/5</td>
                  <td>{formatDate(row.lastFollowupOn)}</td>
                  <td>{formatDate(row.nextFollowupOn)}</td>
                  <td className="pcr-summary">{row.lastFollowupSummary ?? 'No follow-up recorded'}</td>
                  <td><button className="rz-link" type="button" onClick={() => setSelected(row)}>Open details</button></td>
                </tr>;
              })}
              {!rows.length ? <tr><td colSpan={canAssign ? 11 : 10} className="rz-empty">No PCR records match these filters.</td></tr> : null}
            </tbody></table>
          </div>
          <div ref={loadMore} />
          {query.isFetchingNextPage ? <p className="rz-muted pcr-loading" role="status">Loading more PCR records...</p> : null}
        </>}
      </div>
    </div>

    {selected ? <dialog ref={detailDialog} className="rz-detail pcr-detail" aria-labelledby="pcr-detail-title" onClose={() => setSelected(null)} onClick={event => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    }}>
      <header className="rz-detail-header"><div><div className="rz-eyebrow">PCR CALLING · ROW {selected.sourceRowNumber}</div><h2 id="pcr-detail-title">{selected.customerName}</h2></div><button className="pcr-close" aria-label="Close PCR details" title="Close" onClick={() => detailDialog.current?.close()}><Icon name="close" /></button></header>
      <section className="rz-detail-section"><h3>Lead details</h3><dl>
        <div><dt>Booking date</dt><dd>{formatDate(selected.bookingDate)}</dd></div>
        <div><dt>Number</dt><dd>{selected.phoneRaw ?? selected.phoneE164 ?? 'Not recorded'}</dd></div>
        <div><dt>Assigned to</dt><dd>{selected.ownerName ?? 'Unassigned'}</dd></div>
        <div><dt>Queue status</dt><dd>{priority(selected).label}</dd></div>
        <div><dt>Next follow-up</dt><dd>{selected.nextFollowupAttempt ? `Follow-up ${selected.nextFollowupAttempt} · ${formatDate(selected.nextFollowupOn)}` : 'No pending slot'}</dd></div>
        <div><dt>Text message date</dt><dd>{selected.textMessageDate ?? 'Not recorded'}</dd></div>
        <div><dt>Text message status</dt><dd>{selected.textMessageStatus ?? 'Not recorded'}</dd></div>
        <div><dt>Sheet synced</dt><dd>{formatDateTime(selected.lastSyncedAt)}</dd></div>
      </dl></section>
      <section className="rz-detail-section"><h3>Follow-up history</h3><div className="rz-detail-followups"><table><thead><tr><th>Attempt</th><th>Date</th><th>Handled by</th><th>Sheet entry</th></tr></thead><tbody>
        {selected.followups.map(item => <tr key={item.attempt}><td>Follow-up {item.attempt}</td><td>{formatDate(item.occurredOn)}</td><td>{item.handledBy ?? 'Not recorded'}</td><td className="pcr-followup-raw">{item.raw ?? 'Pending'}</td></tr>)}
      </tbody></table></div></section>
    </dialog> : null}
  </>;
}
