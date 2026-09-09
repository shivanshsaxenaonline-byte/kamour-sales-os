'use client';

import { useMemo, useState, useTransition } from 'react';
import { assignRrr } from './actions';
import { refreshAiLeads } from './ai-leads-actions';
import { LogCallDialog, type CallTarget, type ContactNumber } from './log-call-dialog';
import { CustomerPanel } from './customer-panel';

export type RrrRow = {
  customer_id: string;
  full_name: string;
  phone_e164: string;
  lifetime_orders: number;
  lifetime_value: number;
  aov: number | null;
  is_repeat_buyer: boolean;
  last_order_on: string | null;
  days_since_order: number | null;
  payment_profile: string | null;
  current_owner_id: string | null;
  owner_name: string | null;
  is_dnd: boolean;
  attempts: number | null;
  last_contacted_on: string | null;
  last_outcome: string | null;
  next_due_on: string | null;
  open_followup_id: string | null;
  last_order_id: string | null;
  last_order_source: string | null;
};

/** A customer the generator picked for today, and why. Same shape as an RRR
 *  row plus the four things only a picked lead has, so one table renders both. */
export type AiLeadRow = RrrRow & {
  run_on: string;
  rank: number;
  bucket: string;
  bucket_label: string | null;
  priority_score: number;
  reason: string | null;
  ai_owner_id: string | null;
  ai_owner_name: string | null;
};

export type AiRun = { run_on: string; generated_at: string; total: number };

export type Rep = { id: string; full_name: string; role: string };

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

// The five buckets migration 028 seeds into ai_lead_rules. The label comes
// from the database (bucket_label) so a renamed rule needs no deploy; only the
// colour lives here, because a colour is a UI decision.
const BUCKET_TONE: Record<string, string> = {
  overdue: 'critical',
  kamour: 'positive-outline',
  active: 'positive',
  cooling: 'attention',
  dormant: 'neutral',
};

// 1,300 rows in one <table> is a slow, unscrollable page. Fifty at a time,
// the same size the team's existing workspace uses. The AI list is 45, so it
// lands on one page and the pager hides itself.
const PAGE_SIZE = 50;

const money = (n: number | null) =>
  n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/** Active if they bought within 90 days — the same line the team's own
 *  dashboard draws between a live customer and one going cold, and the same
 *  line the lead generator's `active` bucket uses. */
function activity(days: number | null) {
  if (days == null) return { text: 'No orders', tone: 'dashed' };
  if (days <= 90) return { text: 'Active', tone: 'positive' };
  return { text: `${days}d inactive`, tone: days > 180 ? 'critical' : 'attention' };
}

/** What the follow-up state means today, not what it meant when it was set. */
function followUpState(r: RrrRow) {
  if (r.next_due_on) {
    const days = Math.round(
      (Date.now() - new Date(`${r.next_due_on}T00:00:00+05:30`).getTime()) / 86_400_000);
    const last = r.last_outcome ? OUTCOME_LABEL[r.last_outcome] ?? r.last_outcome : '';
    if (days > 0) return { text: last ? `${last} · ${days}d overdue` : `${days}d overdue`, tone: 'critical' };
    if (days === 0) return { text: 'Due today', tone: 'attention' };
    return { text: `Call in ${Math.abs(days)}d`, tone: 'neutral' };
  }
  if (r.last_outcome)
    return {
      text: OUTCOME_LABEL[r.last_outcome] ?? r.last_outcome,
      tone: OUTCOME_TONE[r.last_outcome] ?? 'neutral',
    };
  return { text: 'Untouched', tone: 'dashed' };
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00+05:30`).toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-IN',
    { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export function RrrTable({
  rows, aiLeads, aiRun, reps, canAssign, numbers,
}: {
  rows: RrrRow[];
  aiLeads: AiLeadRow[];
  aiRun: AiRun | null;
  reps: Rep[];
  canAssign: boolean;
  numbers: ContactNumber[];
}) {
  const [list, setList] = useState<'all' | 'ai'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [owner, setOwner] = useState('all');
  const [stage, setStage] = useState('all');
  const [bucket, setBucket] = useState('all');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [openRow, setOpenRow] = useState<RrrRow | null>(null);
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [page, setPage] = useState(1);

  const isAi = list === 'ai';

  // The buckets actually present in today's list, labelled by the database.
  // Built from the rows rather than hard-coded so a new rule shows up on its
  // own the first time the generator uses it.
  const buckets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of aiLeads) seen.set(r.bucket, r.bucket_label ?? r.bucket);
    return [...seen].map(([code, label]) => ({ code, label }));
  }, [aiLeads]);

  const visible = useMemo(() => {
    const source: RrrRow[] = isAi ? aiLeads : rows;
    return source.filter((r) => {
      if (isAi) {
        const a = r as AiLeadRow;
        // In this list "owner" means who is calling them TODAY, not who owns
        // the customer — that is the whole point of the daily deal.
        if (owner === 'unassigned' && a.ai_owner_id) return false;
        if (owner !== 'all' && owner !== 'unassigned' && a.ai_owner_id !== owner) return false;
        if (bucket !== 'all' && a.bucket !== bucket) return false;
      } else {
        if (owner === 'unassigned' && r.current_owner_id) return false;
        if (owner !== 'all' && owner !== 'unassigned' && r.current_owner_id !== owner) return false;
        if (stage === 'untouched' && (r.attempts ?? 0) > 0) return false;
        if (stage === 'overdue' && !(r.next_due_on && new Date(r.next_due_on) < new Date())) return false;
        if (stage === 'inactive' && (r.days_since_order ?? 0) <= 90) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!r.full_name.toLowerCase().includes(q) && !r.phone_e164.includes(q)) return false;
      }
      return true;
    });
  }, [isAi, rows, aiLeads, owner, stage, bucket, search]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // A filter change can leave you past the end; clamp rather than showing a
  // blank page that looks like "no results".
  const current = Math.min(page, pageCount);
  const shown = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // "Select all" means every row the filter matched, not just this page —
  // otherwise assigning 300 customers would take six clicks through pages.
  const allShown = visible.length > 0 && visible.every((r) => selected.has(r.customer_id));

  function switchList(next: 'all' | 'ai') {
    setList(next);
    // The two lists do not share a filter vocabulary, and a selection carried
    // across them would assign rows the user can no longer see.
    setSelected(new Set());
    setOwner('all');
    setStage('all');
    setBucket('all');
    setPage(1);
    setMessage(null);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShown) for (const r of visible) next.delete(r.customer_id);
      else for (const r of visible) next.add(r.customer_id);
      return next;
    });
  }

  function submit() {
    if (!selected.size || !target) return;
    const ids = [...selected];
    const toName = target === 'unassign'
      ? 'the unassigned pool'
      : reps.find((r) => r.id === target)?.full_name ?? 'that rep';
    setMessage(null);
    startTransition(async () => {
      const result = await assignRrr(ids, target === 'unassign' ? null : target);
      if (!result.ok) { setMessage(result.error); return; }
      setSelected(new Set());
      setMessage(result.moved === 0
        ? `Nothing changed — those ${ids.length} were already on ${toName}.`
        : `${result.moved} of ${ids.length} moved to ${toName}.`);
    });
  }

  function regenerate() {
    setMessage(null);
    startRefresh(async () => {
      const result = await refreshAiLeads();
      setMessage(result.ok
        ? `Today's list rebuilt — ${result.total} leads.`
        : result.error);
    });
  }

  const callTargetFor = (r: RrrRow): CallTarget => ({
    customerId: r.customer_id,
    name: r.full_name,
    phone: r.phone_e164,
    followupId: r.open_followup_id,
    orderId: r.last_order_id,
  });

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>RRR</h1>

        <label className="sr-only" htmlFor="rrr-list">List</label>
        <select id="rrr-list" value={list} onChange={(e) => switchList(e.target.value as 'all' | 'ai')}>
          <option value="all">All customers</option>
          <option value="ai">AI Leads — today</option>
        </select>

        <span className="muted">
          {visible.length
            ? `Showing ${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, visible.length)} of ${visible.length.toLocaleString('en-IN')}`
            : '0 customers'}
          {selected.size ? ` · ${selected.size} selected` : ''}
        </span>

        {/* Up here rather than in the assign bar, which only oversight roles
            see — a rep logging a call was getting no confirmation at all. */}
        {message ? <span className="muted" role="status">{message}</span> : null}

        <div className="toolbar-spacer" />

        <label className="grid-search">
          <span className="sr-only">Search customer</span>
          <input
            type="search"
            value={search}
            placeholder="Name or mobile number…"
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </label>

        {isAi ? (
          <>
            <label className="sr-only" htmlFor="rrr-bucket">Why it was picked</label>
            <select id="rrr-bucket" value={bucket} onChange={(e) => { setBucket(e.target.value); setPage(1); }}>
              <option value="all">All reasons</option>
              {buckets.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
            </select>
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="rrr-stage">Stage</label>
            <select id="rrr-stage" value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }}>
              <option value="all">All customers</option>
              <option value="untouched">Untouched — never called</option>
              <option value="overdue">Overdue follow-up</option>
              <option value="inactive">Inactive 90+ days</option>
            </select>
          </>
        )}

        <label className="sr-only" htmlFor="rrr-owner">Owner</label>
        <select id="rrr-owner" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }}>
          <option value="all">{isAi ? 'Everyone’s leads' : 'Everyone'}</option>
          <option value="unassigned">Unassigned only</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>
      </div>

      {isAi ? (
        <div className="grid-toolbar rrr-aibar">
          <span>
            {aiRun
              ? <><strong>{aiRun.total} leads</strong> for {dayLabel(aiRun.run_on)}, dealt evenly across the floor</>
              : <strong>Today’s list has not been generated yet.</strong>}
          </span>
          {aiRun ? (
            <span className="muted">Built at {timeLabel(aiRun.generated_at)} · refreshes itself every morning at 4:30</span>
          ) : null}
          <div className="toolbar-spacer" />
          {canAssign ? (
            <button type="button" onClick={regenerate} disabled={refreshing}>
              {refreshing ? 'Rebuilding…' : aiRun ? 'Rebuild now' : 'Generate now'}
            </button>
          ) : null}
        </div>
      ) : null}

      {canAssign ? (
        <div className="grid-toolbar rrr-assignbar">
          <label className="sr-only" htmlFor="rrr-target">Assign to</label>
          <select id="rrr-target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending}>
            <option value="">Assign selected to…</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            <option value="unassign">— Put back in unassigned pool —</option>
          </select>
          <button type="button" onClick={submit} disabled={pending || !selected.size || !target}>
            {pending ? 'Assigning…' : `Assign ${selected.size || ''}`.trim()}
          </button>
          {isAi ? (
            <span className="muted">
              This changes who owns the customer for good — today’s AI list is only who calls them today.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead>
            <tr>
              {canAssign ? (
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={allShown} onChange={toggleAllShown} aria-label="Select all shown" />
                </th>
              ) : null}
              {isAi ? <th className="num" style={{ width: 44 }}>#</th> : null}
              <th>Customer</th>
              {isAi ? <th>Why this one</th> : <th>Payment</th>}
              <th className="num">Orders</th>
              <th className="num">Amount / LTV</th>
              {isAi ? null : <th className="num">AOV</th>}
              <th>Last activity</th>
              <th>Activity</th>
              <th>{isAi ? 'Calling today' : 'Follow-up'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const act = activity(r.days_since_order);
              const fu = followUpState(r);
              const ai = isAi ? (r as AiLeadRow) : null;
              return (
                <tr
                  key={r.customer_id}
                  className={`record-row ${selected.has(r.customer_id) ? 'selected' : ''}`}
                >
                  {canAssign ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.customer_id)}
                        onChange={() => toggle(r.customer_id)}
                        aria-label={`Select ${r.full_name}`}
                      />
                    </td>
                  ) : null}

                  {ai ? (
                    <td className="num">
                      {ai.rank}
                      <br />
                      <span className="muted" title="Priority score out of 100">{ai.priority_score}</span>
                    </td>
                  ) : null}

                  <td>
                    <button type="button" className="rrr-customer" onClick={() => setOpenRow(r)}>
                      <span className="rrr-avatar">{initials(r.full_name)}</span>
                      <span className="rrr-customer-copy">
                        <strong>{r.full_name}</strong>
                        <span className="muted">{r.phone_e164}</span>
                        <span className="muted">
                          {r.is_repeat_buyer ? 'Repeat buyer' : 'New buyer'}
                          {r.is_dnd ? ' · DND' : ''}
                        </span>
                      </span>
                    </button>
                  </td>

                  {ai ? (
                    <td className="rrr-why">
                      <span className={`status-pill ${BUCKET_TONE[ai.bucket] ?? 'neutral'}`}>
                        {ai.bucket_label ?? ai.bucket}
                      </span>
                      {ai.reason ? <span className="muted">{ai.reason}</span> : null}
                    </td>
                  ) : (
                    <td>{r.payment_profile ? <span className="status-pill neutral">{r.payment_profile}</span> : '—'}</td>
                  )}

                  <td className="num">{r.lifetime_orders}</td>
                  <td className="num">{money(r.lifetime_value)}</td>
                  {isAi ? null : <td className="num">{money(r.aov)}</td>}
                  <td>
                    {r.last_order_on ?? '—'}
                    <br />
                    <span className="muted">{r.last_order_source ?? 'Order placed'}</span>
                  </td>
                  <td><span className={`status-pill ${act.tone}`}>{act.text}</span></td>
                  {ai ? (
                    <td>
                      <strong>{ai.ai_owner_name ?? 'Unassigned'}</strong>
                      <br />
                      <span className="muted">
                        {/* Who owns the customer the rest of the time, said out
                            loud only when it is somebody else — otherwise it
                            reads as a contradiction. */}
                        {r.owner_name && r.owner_name !== ai.ai_owner_name
                          ? `Owned by ${r.owner_name}`
                          : fu.text}
                      </span>
                    </td>
                  ) : (
                    <td>
                      <span className={`status-pill ${fu.tone}`}>{fu.text}</span>
                      <br />
                      <span className="muted">{r.owner_name ?? 'Unassigned'}</span>
                    </td>
                  )}
                  <td>
                    <button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {visible.length === 0 ? (
          <div className="grid-empty">
            <p>
              {isAi && !aiRun
                ? 'No AI leads for today yet. The list is built every morning at 4:30.'
                : 'No customers match this filter.'}
            </p>
          </div>
        ) : null}
      </div>

      {pageCount > 1 ? (
        <footer className="grid-footer rrr-pager">
          <button type="button" onClick={() => setPage(current - 1)} disabled={current <= 1}>
            Previous
          </button>
          <span className="muted">Page {current} of {pageCount}</span>
          <button type="button" onClick={() => setPage(current + 1)} disabled={current >= pageCount}>
            Next
          </button>
        </footer>
      ) : null}

      {openRow ? (
        <CustomerPanel
          customerId={openRow.customer_id}
          name={openRow.full_name}
          phone={openRow.phone_e164}
          onClose={() => setOpenRow(null)}
          onLogCall={() => { setCalling(callTargetFor(openRow)); setOpenRow(null); }}
        />
      ) : null}

      {calling ? (
        <LogCallDialog
          target={calling}
          numbers={numbers}
          onClose={() => setCalling(null)}
          onSaved={(msg) => { setCalling(null); setMessage(msg); }}
        />
      ) : null}
    </section>
  );
}
