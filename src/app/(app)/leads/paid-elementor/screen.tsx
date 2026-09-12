'use client';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useViewer } from '@/components/CrmProvider';
import { Icon } from '@/components/Icon';
import { addDays, istDate, money } from '@/lib/razorpay/analytics';
import { getPaidElementorLeads, type PaidElementorResult } from './actions';
import '../../razorpay/razorpay.css';

const PAGE_SIZE = 100;

export function PaidElementorScreen() {
  const viewer = useViewer();
  const today = istDate();
  const defaultStart = addDays(today, -6);
  const [search,setSearch] = useState(''), [debounced,setDebounced] = useState(''), [start,setStart] = useState(defaultStart), [end,setEnd] = useState(today), [expanded,setExpanded] = useState<string|null>(null);
  const loadMore = useRef<HTMLDivElement>(null);
  useEffect(()=>{const t=setTimeout(()=>setDebounced(search),300);return()=>clearTimeout(t);},[search]);
  const invalid = !!start && !!end && start > end;
  const query = useInfiniteQuery<PaidElementorResult>({
    queryKey:['paid-elementor',viewer.id,debounced,start,end],
    enabled:!invalid,
    initialPageParam:0,
    getNextPageParam:(lastPage,pages)=>pages.reduce((total,item)=>total+item.rows.length,0)<lastPage.total ? pages.length : undefined,
    queryFn:({pageParam})=>getPaidElementorLeads({ search:debounced, start, end, page:Number(pageParam), pageSize:PAGE_SIZE }),
    refetchInterval:60000,
  });
  const rows = query.data?.pages.flatMap(item=>item.rows) ?? [];
  const summary = query.data?.pages[0];
  useEffect(()=>{
    const target = loadMore.current;
    if (!target || !query.hasNextPage || query.isFetchingNextPage) return;
    const observer = new IntersectionObserver(entries=>{
      if (entries[0]?.isIntersecting) void query.fetchNextPage();
    },{rootMargin:'300px'});
    observer.observe(target);
    return ()=>observer.disconnect();
  },[query.fetchNextPage,query.hasNextPage,query.isFetchingNextPage]);
  return <div className="rz-page"><header className="rz-header"><div><div className="rz-eyebrow">LEADS</div><h1>Paid Elementor</h1></div><button aria-label="Refresh paid leads" title="Refresh paid leads" disabled={query.isFetching} onClick={()=>void query.refetch()}><Icon name="refresh" /></button></header>
    <div className="rz-filters"><label>Search<input aria-label="Search paid leads" placeholder="Name, phone, lead or payment ID" value={search} onChange={e=>setSearch(e.target.value)} /></label><label>Payment from (IST)<input aria-label="Payment from" type="date" value={start} onChange={e=>setStart(e.target.value)} /></label><label>Payment to (IST)<input aria-label="Payment to" type="date" value={end} onChange={e=>setEnd(e.target.value)} /></label><button onClick={()=>{setStart(defaultStart);setEnd(today);setSearch('');setDebounced('');}}>Reset to 7 days</button></div>
    <div className="rz-body">{invalid ? <p role="alert">Start date must be on or before end date.</p> : query.isPending ? <p role="status">Matching captured INR 99 payments with Zoho CRM lead phones...</p> : query.isError ? <p role="alert">{query.error.message} <button onClick={()=>void query.refetch()}>Retry</button></p> : <>
      <div className="rz-section-heading"><h2>{(summary?.total ?? 0).toLocaleString('en-IN')} customers</h2><span className="rz-muted">{summary?.totalZohoLeads ?? 0} Zoho CRM leads / {summary?.totalPayments ?? 0} paid payments</span></div>
      <div className="rz-table-scroll" aria-busy={query.isFetchingNextPage}><table><thead><tr>{['Customer','Phone','Latest payment (IST)','Paid amount','Refunded','Zoho CRM leads','Latest Zoho lead','Details'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(c=><tr key={c.customer_id}><td>{c.full_name}</td><td>{c.phone}</td><td>{new Date(c.payments[0]!.paid_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</td><td>{money(c.payments.reduce((n,p)=>n+p.amount,0))}</td><td>{money(c.payments.reduce((n,p)=>n+p.amount_refunded,0))}</td><td>{c.zoho_lead_count}</td><td>{c.latest_zoho_lead ? new Date(c.latest_zoho_lead).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'}) : <>&mdash;</>}</td><td><button onClick={()=>setExpanded(expanded===c.customer_id?null:c.customer_id)} aria-expanded={expanded===c.customer_id}>View matches</button>{expanded===c.customer_id && <div style={{whiteSpace:'normal',minWidth:240,maxWidth:340,overflowWrap:'anywhere'}}><strong>Zoho CRM lead IDs</strong>{c.lead_ids.map(id=><p key={id}>{id}</p>)}<strong>Captured INR 99 payments</strong>{c.payments.map(p=><p key={p.id}>{p.id}<br />{money(p.amount)} / {istDate(new Date(p.paid_at))}</p>)}</div>}</td></tr>)}{!rows.length && <tr><td colSpan={8} className="rz-empty">No Razorpay INR 99 payments matched with Zoho CRM leads.</td></tr>}</tbody></table></div>
      <div ref={loadMore} />{query.isFetchingNextPage ? <p className="rz-muted" role="status">Loading more paid customers...</p> : null}
    </>}</div></div>;
}
