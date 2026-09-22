'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useToast, useViewer } from '@/components/CrmProvider';
import { TableSkeleton } from '@/components/LoadingSkeleton';
import { assignPocLeads, getPocLeads, type PocLead, type PocLeadResult, type PocOwner } from './actions';
import '../../razorpay/razorpay.css';
import './poc.css';

const PAGE_SIZE = 50;
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);

function formatDate(value: string | null) {
  if (!value) return 'Not recorded';
  return new Date(`${value}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  });
}

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not recorded';
}

export function PocScreen({ initialData, owners }: { initialData: PocLeadResult | null; owners: PocOwner[] }) {
  const viewer = useViewer();
  const notify = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [owner, setOwner] = useState('all');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [selected, setSelected] = useState<PocLead | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncWarning, setSyncWarning] = useState(false);
  const loadMore = useRef<HTMLDivElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const canAssign = ASSIGN_ROLES.has(viewer.role) || owners.length > 0;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery<PocLeadResult>({
    queryKey: ['poc-leads', viewer.id, debounced, owner],
    initialPageParam: 0,
    initialData: !debounced && owner === 'all' && initialData
      ? { pages: [initialData], pageParams: [0] }
      : undefined,
    getNextPageParam: page => page.nextOffset ?? undefined,
    queryFn: ({ pageParam }) => getPocLeads({
      search: debounced,
      owner,
      offset: typeof pageParam === 'number' ? pageParam : 0,
      pageSize: PAGE_SIZE,
    }),
  });

  const refreshFromSheet = useCallback(async (showToast: boolean) => {
    setSyncing(true);
    try {
      const response = await fetch('/api/sheets/poc/sync', { method: 'POST' });
      if (!response.ok) throw new Error('sync_failed');
      setSyncWarning(false);
      await query.refetch();
      if (showToast) notify('POC refreshed', 'Latest consultation records are loaded.');
    } catch {
      setSyncWarning(true);
    } finally {
      setSyncing(false);
    }
  }, [notify, query.refetch]);

  useEffect(() => {
    void refreshFromSheet(false);
    const timer = window.setInterval(() => void refreshFromSheet(false), 60000);
    return () => window.clearInterval(timer);
  }, [refreshFromSheet]);

  useEffect(() => {
    const target = loadMore.current;
    if (!target || !query.hasNextPage || query.isFetchingNextPage) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void query.fetchNextPage();
    }, { rootMargin: '300px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [query.fetchNextPage, query.hasNextPage, query.isFetchingNextPage]);

  useEffect(() => {
    const dialog = detailDialog.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
  }, [selected]);

  const rows = query.data?.pages.flatMap(page => page.rows) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const selectableRows = rows.slice(0, 100);
  const allLoadedChecked = !!selectableRows.length && selectableRows.every(row => checked.has(row.id));

  const assignment = useMutation({
    mutationFn: () => assignPocLeads({ leadIds: [...checked], ownerId: assignTo }),
    onSuccess: async result => {
      const assignee = owners.find(item => item.id === assignTo)?.name ?? 'salesperson';
      setChecked(new Set());
      setAssignTo('');
      notify('POC leads assigned', `${result.assigned} lead${result.assigned === 1 ? '' : 's'} assigned to ${assignee}.`);
      await query.refetch();
    },
  });

  useEffect(() => setChecked(new Set()), [debounced, owner, canAssign]);

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
    <div className="rz-page poc-page">
      <header className="rz-header">
        <div><div className="rz-eyebrow">PRESCRIPTION ORDER CONVERSION</div><h1>POC <span className="rz-mode">Sheet live</span></h1></div>
        <button aria-label="Refresh POC leads" title="Refresh POC leads" disabled={syncing || query.isFetching} onClick={() => void refreshFromSheet(true)}><Icon name="refresh" /></button>
      </header>
      <div className="rz-filters">
        <label>Search<input aria-label="Search POC leads" placeholder="Name, number, doctor or remark" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {canAssign ? <label>Owner<select aria-label="Filter POC leads by owner" value={owner} onChange={event => setOwner(event.target.value)}>
          <option value="all">All owners</option><option value="unassigned">Unassigned</option>{owners.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select></label> : null}
        <div className="poc-count"><strong>{total.toLocaleString('en-IN')}</strong><span>POC leads</span></div>
      </div>
      <div className="rz-body">
        {syncWarning ? <p className="poc-sync-warning" role="status">Showing saved Supabase data. Sheet refresh will retry automatically.</p> : null}
        {query.isPending ? <TableSkeleton rows={10} columns={8} label="Loading POC leads" /> : query.isError ? <p className="rz-error" role="alert">Could not load POC leads. <button onClick={() => void query.refetch()}>Retry</button></p> : <>
          {canAssign ? <div className="poc-assignbar">
            <select aria-label="Assign selected POC leads to" value={assignTo} disabled={assignment.isPending} onChange={event => setAssignTo(event.target.value)}>
              <option value="">Assign selected to...</option>{owners.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            <button type="button" disabled={!checked.size || !assignTo || assignment.isPending} onClick={() => assignment.mutate()}>{assignment.isPending ? 'Assigning...' : `Assign ${checked.size || ''}`.trim()}</button>
            {checked.size ? <button type="button" onClick={() => setChecked(new Set())} disabled={assignment.isPending}>Clear</button> : null}
            <span>{checked.size ? `${checked.size} selected` : 'No leads selected'}</span>
            {assignment.isError ? <span className="rz-error" role="alert">{assignment.error instanceof Error ? assignment.error.message : 'Assignment failed.'}</span> : null}
          </div> : null}
          <div className="rz-table-scroll" aria-busy={query.isFetchingNextPage}>
            <table><thead><tr>{canAssign ? <th className="poc-check"><input type="checkbox" aria-label="Select up to 100 loaded POC leads" checked={allLoadedChecked} onChange={toggleLoaded} /></th> : null}{['Status', 'Consultation', 'Customer', 'Number', 'Doctor', 'Owner', 'Source', 'Concern', 'Cart value', 'Follow-ups', 'Medicine remark', ''].map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>
              {rows.map(row => <tr key={row.id} className={checked.has(row.id) ? 'poc-selected' : undefined}>
                {canAssign ? <td className="poc-check"><input type="checkbox" aria-label={`Select ${row.customerName}`} checked={checked.has(row.id)} onChange={() => toggle(row.id)} /></td> : null}
                <td><span className="rz-status warn">Rx yes · Purchase no</span></td>
                <td>{formatDate(row.consultationDate)}</td>
                <td><strong>{row.customerName}</strong><small>{row.recordNo ? `Record ${row.recordNo}` : `Sheet row ${row.sourceRowNumber}`}</small></td>
                <td>{row.phoneRaw ?? row.phoneE164 ?? 'Not recorded'}</td>
                <td>{row.doctorName ?? 'Not recorded'}</td>
                <td>{row.ownerName ?? row.joinedBy ?? row.consultationTakenBy ?? 'Unassigned'}</td>
                <td>{row.leadSource ?? 'Not recorded'}</td>
                <td>{row.concern ?? 'Not recorded'}</td>
                <td>{row.cartValue ?? 'Not recorded'}</td>
                <td>{row.followupCount}/5<small>{formatDate(row.lastFollowupOn)}</small></td>
                <td className="poc-remark">{row.medicineRemark ?? row.lastFollowupSummary ?? 'Not recorded'}</td>
                <td><button className="rz-link" type="button" onClick={() => setSelected(row)}>Open details</button></td>
              </tr>)}
              {!rows.length ? <tr><td colSpan={canAssign ? 13 : 12} className="rz-empty">No prescription-without-purchase records match this search.</td></tr> : null}
            </tbody></table>
          </div>
          <div ref={loadMore} />
          {query.isFetchingNextPage ? <p className="rz-muted poc-loading" role="status">Loading more POC leads...</p> : null}
        </>}
      </div>
    </div>

    {selected ? <dialog ref={detailDialog} className="rz-detail poc-detail" aria-labelledby="poc-detail-title" onClose={() => setSelected(null)} onClick={event => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    }}>
      <header className="rz-detail-header"><div><div className="rz-eyebrow">POC · SHEET ROW {selected.sourceRowNumber}</div><h2 id="poc-detail-title">{selected.customerName}</h2></div><button className="poc-close" aria-label="Close POC details" title="Close" onClick={() => detailDialog.current?.close()}><Icon name="close" /></button></header>
      <section className="rz-detail-section"><h3>POC status</h3><dl>
        <div><dt>Consultation date</dt><dd>{formatDate(selected.consultationDate)}</dd></div>
        <div><dt>Prescription</dt><dd>{selected.prescriptionStatus}</dd></div>
        <div><dt>Medicine purchased</dt><dd>{selected.medicinePurchased}</dd></div>
        <div><dt>Last follow-up</dt><dd>{formatDate(selected.lastFollowupOn)}</dd></div>
        <div><dt>Sheet synced</dt><dd>{formatDateTime(selected.lastSyncedAt)}</dd></div>
      </dl></section>
      <section className="rz-detail-section"><h3>Follow-up history</h3><div className="rz-detail-followups"><table><thead><tr><th>Attempt</th><th>Date</th><th>Sheet entry</th></tr></thead><tbody>
        {selected.followups.map(item => <tr key={item.attempt}><td>Follow-up {item.attempt}</td><td>{formatDate(item.occurredOn)}</td><td className="poc-followup-raw">{item.raw ?? 'Pending'}</td></tr>)}
      </tbody></table></div></section>
      <section className="rz-detail-section"><h3>Complete consultation record</h3><dl className="poc-all-fields">
        {Object.entries(selected.sourceSnapshot).filter(([, value]) => value?.trim()).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === 'Cart Link' && /^https?:\/\//i.test(value) ? <a href={value} target="_blank" rel="noreferrer">Open cart</a> : value}</dd></div>)}
      </dl></section>
    </dialog> : null}
  </>;
}
