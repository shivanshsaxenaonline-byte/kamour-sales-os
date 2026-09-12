'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useViewer } from '@/components/CrmProvider';
import { Icon } from '@/components/Icon';
import { createClient } from '@/lib/supabase/client';
import { consultationIndex, consultationMatches, isConsultationPayment } from '@/lib/razorpay/analytics';
import { ConsultationCandidates, useConsultationMatches } from './consultation-matching';
import { usePaymentClassification } from '@/lib/razorpay/use-classification';
import { addDays, csv, dateRange, isCollected, istDate, money, PAYMENT_COLUMNS, summarize, trend, validRange, type Payment } from '@/lib/razorpay/analytics';
import './razorpay.css';

const timestamp = (s: string) => new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const count = (n: number) => n.toLocaleString('en-IN');
type Detail = Payment & { vpa: string | null; bank: string | null; wallet: string | null; card_last4: string | null; description: string | null; error_code: string | null; error_description: string | null; invoice_id: string | null; notes: unknown; acquirer_data: unknown; };

export function RazorpayScreen() {
  const viewer = useViewer();
  const [purpose, setPurpose] = useState('all');
  const [today, setToday] = useState(() => istDate());
  const [preset, setPreset] = useState('thisMonth'), [month, setMonth] = useState(today.slice(0, 7));
  const [custom, setCustom] = useState({ start: today, end: today });
  const [range, setRange] = useState(() => dateRange('thisMonth', today, month));
  const [validation, setValidation] = useState('');
  const [tab, setTab] = useState('overview'), [grouping, setGrouping] = useState<'day' | 'month'>('day');
  const [currency, setCurrency] = useState('INR'), [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [method, setMethod] = useState('all'), [match, setMatch] = useState('all');
  const [page, setPage] = useState(0), [ascending, setAscending] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const timer = setInterval(() => setToday(istDate()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (preset !== 'custom') setRange(dateRange(preset, today, month));
  }, [preset, today, month]);

  const payments = useQuery({
    queryKey: ['razorpay', viewer.id, range], refetchInterval: 60000,
    queryFn: async ({ signal }) => {
      const db = createClient(), rows: Payment[] = [];
      // Fetch every page: Supabase's default row cap must never truncate totals.
      for (let offset = 0; ; offset += 1000) {
        let query = db.from('razorpay_payments').select(PAYMENT_COLUMNS).order('paid_at', { ascending: false }).order('id').range(offset, offset + 999);
        if (range.start) query = query.gte('paid_at', range.start + 'T00:00:00+05:30');
        if (range.end) query = query.lt('paid_at', addDays(range.end, 1) + 'T00:00:00+05:30');
        const { data, error } = await query.abortSignal(signal).returns<Payment[]>();
        if (error) throw new Error(error.message);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      return rows;
    },
  });
  const consultations = useConsultationMatches(payments.data ?? []);
  const sources = usePaymentClassification(payments.data ?? []);
  const matchIndex = useMemo(() => consultationIndex(consultations.data ?? []), [consultations.data]);
  const health = useQuery({ queryKey: ['razorpay-health', viewer.id], refetchInterval: 60000, queryFn: async ({ signal }) => {
    const { data, error } = await createClient().from('razorpay_events').select('received_at,event,handled,error').eq('signature_ok', true).not('payment_id', 'is', null).order('received_at', { ascending: false }).limit(1).abortSignal(signal);
    if (error) throw new Error(error.message);
    return data?.[0] ?? null;
  } });
  const detail = useQuery({ queryKey: ['razorpay-detail', viewer.id, selected], enabled: !!selected, queryFn: async ({ signal }) => {
    const { data, error } = await createClient().from('razorpay_payments').select(PAYMENT_COLUMNS + ',vpa,bank,wallet,card_last4,description,error_code,error_description,invoice_id,notes,acquirer_data').eq('id', selected!).abortSignal(signal).single<Detail>();
    if (error) throw new Error(error.message);
    return data;
  } });
  useEffect(() => { if (selected) dialog.current?.showModal(); else dialog.current?.close(); }, [selected]);
  const currencies = [...new Set(['INR', ...(payments.data ?? []).map(p => p.currency)])].sort();
  const rows = useMemo(() => (payments.data ?? []).filter(p => p.currency === currency), [payments.data, currency]);
  const totals = useMemo(() => summarize(rows), [rows]);
  const buckets = useMemo(() => trend(rows, grouping, range.start, range.end), [rows, grouping, range]);
  const methods = useMemo(() => [...new Set(rows.map(p => p.method || 'unknown'))].map(name => ({ name, ...summarize(rows.filter(p => (p.method || 'unknown') === name)) })).sort((a, b) => b.gross - a.gross), [rows]);
  const filtered = useMemo(() => rows.filter(p =>
    (status === 'all' || (status === 'refunded' ? Number(p.amount_refunded) > 0 : p.status === status)) &&
    (method === 'all' || (p.method || 'unknown') === method) &&
    (purpose === 'all' || sources.data?.classifications.get(p.id)?.category === purpose) &&
    (match === 'all' || (match === 'matched' ? !!p.order_id && !isConsultationPayment(p) : match === 'phone' ? consultationMatches(p, matchIndex).length === 1 : match === 'multiple' ? consultationMatches(p, matchIndex).length > 1 : isConsultationPayment(p) ? consultations.isSuccess && consultationMatches(p, matchIndex).length === 0 : !p.order_id)) &&
    [p.id, p.razorpay_order_id, p.email, p.contact_raw].some(v => (v ?? '').toLowerCase().includes(search.trim().toLowerCase()))
  ).sort((a, b) => (ascending ? 1 : -1) * (a.paid_at.localeCompare(b.paid_at) || a.id.localeCompare(b.id))), [rows, status, method, match, search, ascending, purpose, matchIndex, consultations.isSuccess, sources.data]);
  useEffect(() => { setPage(0); }, [range, currency, status, method, match, search, ascending, purpose]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), currentPage = Math.min(page, pages - 1);
  const max = Math.max(1, ...buckets.map(b => b.gross));
  const format = (n: number) => money(n, currency);
  function exportPayments() {
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv(filtered,p=>{const c=sources.data?.classifications.get(p.id);return [c?.category??'Unknown',c?.reason??'Source check unavailable',c?.orderIds.join(' | ')??''];})], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `razorpay-${range.start || 'all'}-${range.end || today}-${currency}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const metrics = [
    ['Gross collections', format(totals.gross), `${count(totals.successful)} captured payments`, 'good'],
    ['Success rate', `${totals.successRate.toFixed(1)}%`, `${count(totals.total)} payment attempts`, ''],
    ['Refunded amount', format(totals.refunds), `${count(rows.filter(p => Number(p.amount_refunded) > 0).length)} payments with refunds`, 'warn'],
    ['Net collections', format(totals.net), 'Collections less refunds and reported fees', 'good'],
    ['Gateway fees', format(totals.fees), `${format(totals.tax)} tax included${totals.missingFees ? `; ${count(totals.missingFees)} fees pending` : ''}`, ''],
    ['Average payment', format(totals.average), 'Per captured payment', ''],
    ['Failed payments', count(totals.failed), `${count(totals.pending)} created / authorized`, 'bad'],
    ['Elementor consultations', count(rows.filter(p => isConsultationPayment(p) && isCollected(p)).length), 'Captured INR 99 payments', 'good'],
  ];
  function matchLabel(p: Payment) {
    if (!isConsultationPayment(p)) {
      const source=sources.data?.classifications.get(p.id);
      return source?.category==='Wati' ? 'Wati / INR 9' : source?.category==='Kamour Medicine' ? 'Medicine order matched' : sources.isError ? 'Source check unavailable' : sources.isPending ? 'Checking source...' : source?.reason ?? 'Unclassified';
    }
    if (consultations.isError) return 'Matching unavailable';
    if (!consultations.isSuccess) return 'Checking consultations...';
    if (!p.phone_e164) return 'No valid phone';
    const candidates = consultationMatches(p, matchIndex);
    return candidates.length === 1 ? `Phone matched: ${candidates[0]!.full_name}` : candidates.length > 1 ? `${candidates.length} consultations: review` : 'No consultation found';
  }
  return <div className="rz-page">
    <header className="rz-header"><div><div className="rz-eyebrow">PAYMENTS</div><h1>Razorpay <span className="rz-mode">Live data</span></h1></div><div className="rz-actions"><span className="rz-muted">{payments.dataUpdatedAt ? `Updated ${timestamp(new Date(payments.dataUpdatedAt).toISOString())}` : 'Connecting...'}</span><button title="Refresh payments" aria-label="Refresh payments" disabled={payments.isFetching} onClick={() => { void payments.refetch(); void consultations.refetch(); void sources.refetch(); void health.refetch(); }}><Icon name="refresh" /></button></div></header>
    <form className="rz-filters" onSubmit={e => { e.preventDefault(); if (!validRange(custom.start, custom.end)) { setValidation('Choose valid dates, with the start on or before the end.'); return; } setValidation(''); setRange(custom); }}>
      <label>Period<select aria-label="Period" value={preset} onChange={e => { setPreset(e.target.value); setValidation(''); }}><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="thisMonth">This month</option><option value="lastMonth">Last month</option><option value="month">Choose month</option><option value="custom">Custom date range</option><option value="all">All time</option></select></label>
      {preset === 'month' && <label>Month<input aria-label="Month" type="month" required value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} /></label>}
      {preset === 'custom' && <><label>From<input aria-label="From date" type="date" required value={custom.start} onChange={e => setCustom({ ...custom, start: e.target.value })} /></label><label>To<input aria-label="To date" type="date" required min={custom.start} value={custom.end} onChange={e => setCustom({ ...custom, end: e.target.value })} /></label><button className="rz-primary" type="submit">Apply</button></>}
      <label>Currency<select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)}>{currencies.map(c => <option key={c}>{c}</option>)}</select></label>
      <span className="rz-range">{range.start ? `${range.start} to ${range.end}` : 'All payment dates'} <strong>IST</strong></span>
      {validation && <span role="alert" className="rz-error">{validation}</span>}
    </form>
    <nav className="rz-tabs" aria-label="Razorpay views">{['overview', 'payments', 'monthly'].map(t => <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{t === 'monthly' ? 'Monthly report' : t === 'payments' ? 'Payments' : 'Overview'}</button>)}</nav>
    <div className="rz-body" aria-busy={payments.isFetching}>
      {payments.isError ? <div className="rz-error" role="alert">Unable to load payments: {payments.error.message} <button onClick={() => void payments.refetch()}>Retry</button></div> : payments.isPending ? <div className="rz-loading" role="status">Loading Razorpay payments...</div> : <>
      {tab === 'overview' && <>
        <section className="rz-metrics" aria-label="Payment metrics">{metrics.map(([label, value, note, tone]) => <article className={'rz-metric ' + tone} key={label}><h2>{label}</h2><strong>{value}</strong><p>{note}</p></article>)}</section>
        <section className="rz-analysis">
          <div className="rz-trend"><div className="rz-section-heading"><h2>Collection trend</h2><div className="rz-segment"><button aria-pressed={grouping === 'day'} onClick={() => setGrouping('day')}>Daily</button><button aria-pressed={grouping === 'month'} onClick={() => setGrouping('month')}>Monthly</button></div></div>
            {!rows.length ? <div className="rz-empty">No payments in this period.</div> : <div className="rz-chart-scroll"><div className="rz-chart" style={{ minWidth: Math.max(300, buckets.length * 28) }}>{buckets.map((b, i) => <div className="rz-chart-column" key={b.date}><div className="rz-bar-track"><div tabIndex={0} className="rz-bar" style={{ height: `${b.gross / max * 100}%`, minHeight: b.gross ? 2 : 0 }} aria-label={`${b.date}: ${format(b.gross)}, ${b.successful} captured payments`}><span className="rz-chart-tip">{b.date}<br />{format(b.gross)}<br />{count(b.successful)} captured</span></div></div><span className="rz-axis">{buckets.length < 15 || i % Math.ceil(buckets.length / 12) === 0 ? b.date.slice(grouping === 'month' ? 0 : 5) : ''}</span></div>)}</div></div>}
            <p className="rz-muted">Gross captured amount ({currency})</p>
          </div>
          <div className="rz-methods"><h2>Payment methods</h2>{!methods.length && <div className="rz-empty">No payment methods recorded.</div>}{methods.map(m => <div className="rz-method" key={m.name}><div><strong>{m.name.toUpperCase()}</strong><span>{format(m.gross)}</span></div><progress max={totals.gross || 1} value={m.gross} aria-label={`${m.name} collections`} /><div className="rz-muted"><span>{count(m.total)} attempts</span><span>{m.successRate.toFixed(1)}% success</span></div></div>)}</div>
        </section>
        <div className="rz-sync"><span>{health.isError ? 'Delivery status unavailable' : health.data ? `Last payment webhook: ${timestamp(health.data.received_at)}${health.data.handled ? '' : ' (processing error)'}` : 'Awaiting first verified payment webhook'}</span><span>Net collections are not bank settlements.</span></div>
      </>}
      {tab === 'monthly' ? <section><div className="rz-section-heading"><h2>Month-wise summary</h2><span className="rz-muted">{currency} / IST</span></div><div className="rz-table-scroll"><table><thead><tr>{['Month', 'Attempts', 'Captured', 'Gross collections', 'Refunds', 'Fees incl. tax', 'Net collections', 'Success rate'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{trend(rows, 'month', range.start, range.end).map(b => <tr key={b.date}><th>{b.date}</th><td>{count(b.total)}</td><td>{count(b.successful)}</td><td>{format(b.gross)}</td><td>{format(b.refunds)}</td><td>{format(b.fees)}</td><td>{format(b.net)}</td><td>{b.successRate.toFixed(1)}%</td></tr>)}{!rows.length && <tr><td colSpan={8} className="rz-empty">No payments in this period.</td></tr>}</tbody></table></div><p className="rz-muted">Refunds are attributed to the original payment month. {totals.missingFees ? `${totals.missingFees} captured payments have no reported fee yet.` : 'Fees include reported tax.'}</p></section> : <section>
        <div className="rz-section-heading"><h2>{tab === 'overview' ? 'Recent payments' : 'All payments'} <span className="rz-count">{count(filtered.length)}</span></h2><button disabled={!filtered.length} onClick={exportPayments}>Export CSV</button></div>
        <div className="rz-transaction-filters">
          <label className="rz-search"><Icon name="search" /><input aria-label="Search payments" placeholder="Payment ID, order ID, phone or email" value={search} onChange={e => setSearch(e.target.value)} /></label>
          <select aria-label="Payment category" value={purpose} disabled={!sources.isSuccess} onChange={e => setPurpose(e.target.value)}><option value="all">All payment categories</option><option value="Elementor">Paid Elementor / INR 99</option><option value="Wati">Wati / INR 9</option><option value="Kamour Medicine">Kamour Medicine</option><option value="Unclassified">Unclassified / needs review</option></select>
          <select aria-label="Payment status" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>{['captured', 'authorized', 'failed', 'refunded', 'created'].map(s => <option key={s}>{s}</option>)}</select>
          <select aria-label="Payment method" value={method} onChange={e => setMethod(e.target.value)}><option value="all">All methods</option>{methods.map(m => <option key={m.name}>{m.name}</option>)}</select>
          <select aria-label="CRM matching" value={match} onChange={e => setMatch(e.target.value)}><option value="all">All CRM matches</option><option value="phone">Consultation phone matched</option><option value="multiple">Multiple consultations</option><option value="matched">Order matched</option><option value="unmatched">No match found</option></select>
        </div>
        {consultations.isError && <p className="rz-error" role="alert">Consultation matching unavailable. <button onClick={() => void consultations.refetch()}>Retry matching</button></p>}
        {sources.isError && <p role="alert" className="rz-error">{sources.error.message} <button onClick={()=>void sources.refetch()}>Retry sources</button></p>}
        <div className="rz-table-scroll"><table><thead><tr><th>Payment ID</th><th aria-sort={ascending ? 'ascending' : 'descending'}><button onClick={() => setAscending(!ascending)}>Payment date {ascending ? '\u2191' : '\u2193'}</button></th><th>Customer</th><th>Amount</th><th>Status</th><th>Method</th><th>Refunded</th><th>Category</th><th>Consultation / order match</th></tr></thead><tbody>{filtered.slice(currentPage * 25, currentPage * 25 + 25).map(p => <tr key={p.id}><td><button className="rz-link" onClick={() => setSelected(p.id)}>{p.id}</button></td><td>{timestamp(p.paid_at)}</td><td><span>{p.contact_raw || '-'}</span><small>{p.email || '-'}</small></td><td className="rz-amount">{format(Number(p.amount))}</td><td><span className={`rz-status ${isCollected(p) ? 'good' : p.status === 'failed' ? 'bad' : 'warn'}`}>{p.status}</span></td><td>{p.method?.toUpperCase() || '-'}</td><td>{format(Number(p.amount_refunded))}</td><td>{sources.data?.classifications.get(p.id)?.category ?? (sources.isError ? 'Source unavailable' : 'Checking source...')}</td><td><button className="rz-link" onClick={() => setSelected(p.id)}>{matchLabel(p)}</button></td></tr>)}{!filtered.length && <tr><td colSpan={9} className="rz-empty">No payments match these filters.</td></tr>}</tbody></table></div>
        <footer className="rz-pagination"><span>{filtered.length ? `${currentPage * 25 + 1}-${Math.min((currentPage + 1) * 25, filtered.length)} of ${count(filtered.length)}` : '0 payments'}</span><div><button aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>&larr;</button><span>Page {currentPage + 1} of {pages}</span><button aria-label="Next page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>&rarr;</button></div></footer>
      </section>}
      </>}
    </div>
    <dialog className="rz-detail" ref={dialog} onClose={() => setSelected(null)} onClick={e => { if (e.target === dialog.current) setSelected(null); }}><div className="rz-section-heading"><h2>Payment details</h2><button aria-label="Close payment details" onClick={() => setSelected(null)}>&times;</button></div>{detail.isPending ? <p role="status">Loading payment...</p> : detail.isError ? <p role="alert">{detail.error.message}</p> : detail.data && <><p className="rz-detail-amount">{money(Number(detail.data.amount), detail.data.currency)}</p><span className="rz-status">{detail.data.status}</span><dl>{[
      ['Payment ID', detail.data.id], ['Payment date (IST)', timestamp(detail.data.paid_at)], ['Razorpay order', detail.data.razorpay_order_id], ['Invoice', detail.data.invoice_id], ['Phone', detail.data.contact_raw], ['Email', detail.data.email], ['Method', detail.data.method], ['UPI ID', detail.data.vpa], ['Bank / wallet', detail.data.bank || detail.data.wallet], ['Card ending', detail.data.card_last4], ['Refunded', money(Number(detail.data.amount_refunded), detail.data.currency)], ['Fee (tax included)', detail.data.fee === null ? 'Not reported' : money(Number(detail.data.fee), detail.data.currency)], ['Tax', detail.data.tax === null ? 'Not reported' : money(Number(detail.data.tax), detail.data.currency)], ['CRM order', detail.data.order_id || 'Unmatched'], ['Source', detail.data.source], ['Last received', timestamp(detail.data.received_at)], ['Description', detail.data.description], ['Failure code', detail.data.error_code], ['Failure reason', detail.data.error_description],
    ].filter(([label]) => label !== 'CRM order').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '-'}</dd></div>)}</dl>
    {isConsultationPayment(detail.data) && (consultations.isSuccess ? <ConsultationCandidates matches={consultationMatches(detail.data, matchIndex)} /> : <p>{consultations.isError ? 'Consultation matching unavailable.' : 'Checking consultations...'}</p>)}
    {!isConsultationPayment(detail.data) && <section><h3>{sources.data?.classifications.get(detail.data.id)?.category ?? 'Source check pending'}</h3><p>{sources.data?.classifications.get(detail.data.id)?.reason}</p>{sources.data?.classifications.get(detail.data.id)?.orderIds.map(id=>{const o=sources.data.orders.find(o=>o.id===id);return <p key={id}>{o?.order_no ?? id} / {o?.created_at ? timestamp(o.created_at) : ''} / {o ? format(Number(o.amount)) : ''}</p>;})}</section>}
    {detail.data.notes && <><h3>Notes</h3><pre>{JSON.stringify(detail.data.notes, null, 2)}</pre></>}{detail.data.acquirer_data && <><h3>Bank references</h3><pre>{JSON.stringify(detail.data.acquirer_data, null, 2)}</pre></>}</>}</dialog>
  </div>;
}
