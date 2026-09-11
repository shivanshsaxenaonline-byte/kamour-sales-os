'use client';

import Link from 'next/link';
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

/** Every condition the All-customers filter panel can hold. All of them are
 *  strings — including the two numeric boxes — because that is what an
 *  <input> and a <select> hand back, and parsing once at filter time beats
 *  carrying a half-typed "12" around as NaN. */
type Filters = {
  search: string;
  type: string;
  payment: string;
  activity: string;
  stage: string;
  outcome: string;
  owner: string;
  dnd: string;
  minOrders: string;
  minValue: string;
  sort: string;
};

const NO_FILTERS: Filters = {
  search: '', type: 'all', payment: 'all', activity: 'all', stage: 'all',
  outcome: 'all', owner: 'all', dnd: 'all', minOrders: '', minValue: '',
  // Not "highest value first": the list arrives unassigned-first from the
  // server, which is the order the work is handed out in, and a default sort
  // here would silently throw that away.
  sort: 'queue',
};

const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'repeat', label: 'Repeat' },
];

// The three profiles v_rrr_queue computes (027). Matched by label, because
// that is what the view returns and what the Payment column already shows.
const PAYMENTS = [
  { value: 'all', label: 'All payment types' },
  { value: 'Prepaid only', label: 'Prepaid only' },
  { value: 'COD only', label: 'COD only' },
  { value: 'Mixed', label: 'Mixed' },
];

// The same bands the Activity pill paints, so a filter and the column it
// filters on can never disagree.
const ACTIVITIES = [
  { value: 'all', label: 'All activity stages' },
  { value: 'active', label: 'Active · ordered within 90d' },
  // Both halves of "gone quiet" as one option, because that is the line the
  // screen drew before this panel existed and the floor still asks for it.
  { value: 'inactive', label: 'Inactive · 90d+' },
  { value: 'cooling', label: 'Cooling · 91–180d' },
  { value: 'dormant', label: 'Inactive · 180d+' },
  { value: 'never', label: 'No orders on record' },
];

const STAGES = [
  { value: 'all', label: 'All follow-up stages' },
  { value: 'untouched', label: 'Untouched — never called' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'upcoming', label: 'Scheduled later' },
  { value: 'closed', label: 'Called, nothing scheduled' },
];

const DND_OPTIONS = [
  { value: 'all', label: 'Include DND' },
  { value: 'exclude', label: 'Hide DND' },
  { value: 'only', label: 'DND only' },
];

const SORTS = [
  { value: 'queue', label: 'Unassigned first (default)' },
  { value: 'value', label: 'Highest amount first' },
  { value: 'orders', label: 'Most orders first' },
  { value: 'aov', label: 'Highest AOV first' },
  { value: 'recent', label: 'Most recent order first' },
  { value: 'stale', label: 'Longest inactive first' },
  { value: 'due', label: 'Follow-up due soonest' },
  { value: 'name', label: 'Name A–Z' },
];

const COMPARE: Record<string, (a: RrrRow, b: RrrRow) => number> = {
  value: (a, b) => b.lifetime_value - a.lifetime_value,
  orders: (a, b) => b.lifetime_orders - a.lifetime_orders,
  aov: (a, b) => (b.aov ?? 0) - (a.aov ?? 0),
  // Never-ordered sorts last either way, rather than pretending to be day 0.
  recent: (a, b) => (a.days_since_order ?? Infinity) - (b.days_since_order ?? Infinity),
  stale: (a, b) => (b.days_since_order ?? -1) - (a.days_since_order ?? -1),
  due: (a, b) => (a.next_due_on ?? '9999-12-31').localeCompare(b.next_due_on ?? '9999-12-31'),
  name: (a, b) => a.full_name.localeCompare(b.full_name),
};

/** The questions the floor actually opens this screen with, one click each.
 *  Anything a preset does not set goes back to its default, so a chip is a
 *  whole answer and not a layer on top of whatever was left over. */
const PRESETS: { id: string; label: string; patch: Partial<Filters> }[] = [
  { id: 'spenders', label: 'Highest spenders', patch: { sort: 'value' } },
  { id: 'orders', label: 'Most orders', patch: { sort: 'orders' } },
  { id: 'prepaid', label: 'Prepaid repeat', patch: { type: 'repeat', payment: 'Prepaid only', sort: 'value' } },
  { id: 'cold', label: 'Inactive high-value', patch: { activity: 'dormant', minValue: '20000', sort: 'value' } },
  { id: 'untouched', label: 'Never called', patch: { stage: 'untouched', sort: 'value' } },
  { id: 'overdue', label: 'Overdue follow-ups', patch: { stage: 'overdue', sort: 'due' } },
];

/** Today on the sales floor. Read per filter pass rather than once at import,
 *  so a screen left open overnight does not keep yesterday's idea of
 *  "overdue" — the same reason RrrScreen has its own istToday(). */
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function activityBand(days: number | null) {
  if (days == null) return 'never';
  if (days <= 90) return 'active';
  if (days <= 180) return 'cooling';
  return 'dormant';
}

/** Where this customer sits in the follow-up cycle — the state the Follow-up
 *  column already reads, reduced to the one word a filter can match. */
function followUpStage(r: RrrRow, today: string) {
  if (r.next_due_on) {
    if (r.next_due_on < today) return 'overdue';
    if (r.next_due_on === today) return 'today';
    return 'upcoming';
  }
  return (r.attempts ?? 0) > 0 ? 'closed' : 'untouched';
}

/** Two filter sets ask the same question when everything except who you are
 *  searching for and whose book you are in matches. Used to light up the
 *  preset chip you are currently standing on. */
const shapeOf = (f: Filters) => JSON.stringify(
  [f.type, f.payment, f.activity, f.stage, f.outcome, f.dnd, f.minOrders, f.minValue, f.sort]);

export function RrrTable({
  mode, rows, aiLeads, counts, aiRun, reps, canAssign, numbers,
}: {
  mode: 'all' | 'ai';
  rows: RrrRow[];
  aiLeads: AiLeadRow[];
  counts: { all: number; ai: number };
  aiRun: AiRun | null;
  reps: Rep[];
  canAssign: boolean;
  numbers: ContactNumber[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One object, not eleven useStates: a preset sets six of them at once, and
  // "clear" has to put every one of them back without listing them again.
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [panelOpen, setPanelOpen] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [bucket, setBucket] = useState('all');
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [openRow, setOpenRow] = useState<RrrRow | null>(null);
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [page, setPage] = useState(1);

  // Which list you are on is now the URL, not component state, so the sidebar
  // can link straight to it and the browser's own back button works.
  const isAi = mode === 'ai';

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
    const { search, owner } = filters;
    const q = search.trim().toLowerCase();
    // Digits only, so "+91 99458" and "99458" find the same customer.
    const digits = q.replace(/\D/g, '');
    const minOrders = filters.minOrders === '' ? null : Number(filters.minOrders);
    const minValue = filters.minValue === '' ? null : Number(filters.minValue);
    const today = istToday();

    const kept = source.filter((r) => {
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
        if (filters.type === 'new' && r.is_repeat_buyer) return false;
        if (filters.type === 'repeat' && !r.is_repeat_buyer) return false;
        if (filters.payment !== 'all' && r.payment_profile !== filters.payment) return false;
        if (filters.activity !== 'all') {
          const band = activityBand(r.days_since_order);
          if (filters.activity === 'inactive') {
            if (band === 'active' || band === 'never') return false;
          } else if (band !== filters.activity) return false;
        }
        if (filters.stage !== 'all' && followUpStage(r, today) !== filters.stage) return false;
        if (filters.outcome !== 'all' && r.last_outcome !== filters.outcome) return false;
        if (filters.dnd === 'exclude' && r.is_dnd) return false;
        if (filters.dnd === 'only' && !r.is_dnd) return false;
        if (minOrders != null && r.lifetime_orders < minOrders) return false;
        if (minValue != null && r.lifetime_value < minValue) return false;
      }
      if (q) {
        const byName = r.full_name.toLowerCase().includes(q);
        const byPhone = digits.length > 0 && r.phone_e164.replace(/\D/g, '').includes(digits);
        if (!byName && !byPhone) return false;
      }
      return true;
    });

    // The AI list is already in the order the generator ranked it, and that
    // ranking is the product — it does not get re-sorted here.
    const compare = isAi ? null : COMPARE[filters.sort];
    return compare ? [...kept].sort(compare) : kept;
  }, [isAi, rows, aiLeads, filters, bucket]);

  /** How many conditions are narrowing the list right now. Sort is not one of
   *  them — it changes the order, never the count — so it is deliberately not
   *  counted, or the badge would read "1 active" on an unfiltered screen. */
  const activeCount = useMemo(() => {
    let n = filters.search.trim() ? 1 : 0;
    for (const k of ['type', 'payment', 'activity', 'stage', 'outcome', 'owner', 'dnd'] as const) {
      if (filters[k] !== NO_FILTERS[k]) n++;
    }
    if (filters.minOrders !== '') n++;
    if (filters.minValue !== '') n++;
    return n;
  }, [filters]);

  const shape = shapeOf(filters);

  function setFilter(key: keyof Filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    // Page 3 of a list that just became 40 rows long is a blank screen.
    setPage(1);
  }

  function applyPreset(patch: Partial<Filters>) {
    const wanted = { ...NO_FILTERS, ...patch };
    setFilters((f) => ({
      // Clicking the chip you are already standing on takes it off again.
      ...(shapeOf(f) === shapeOf(wanted) ? NO_FILTERS : wanted),
      // Who you are searching for and whose book you are in survive a preset:
      // a rep filtered to their own customers stays in their own customers.
      search: f.search,
      owner: f.owner,
    }));
    setPage(1);
  }

  function clearFilters() {
    setFilters(NO_FILTERS);
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // A filter change can leave you past the end; clamp rather than showing a
  // blank page that looks like "no results".
  const current = Math.min(page, pageCount);
  const shown = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // "Select all" means every row the filter matched, not just this page —
  // otherwise assigning 300 customers would take six clicks through pages.
  const allShown = visible.length > 0 && visible.every((r) => selected.has(r.customer_id));

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

        {/* Tabs, not a dropdown. This is WHICH LIST you are looking at, which
            is the same choice Leads, Consultation and Orders all make with
            tabs — and as a select it sat two controls away from the stage
            filter whose first option also read "All customers", so the two
            were indistinguishable and the AI list looked like it was missing.
            The counts are the other half of the fix: a tab reading 0 says the
            list has not been generated, where an unopened dropdown said
            nothing at all. */}
        {/* Links, not buttons: each list is its own URL, so these are the same
            navigation the sidebar performs and behave like it — bookmarkable,
            back-button-able, and highlighted by the route rather than by
            state the sidebar cannot see. */}
        <div className="module-tabs">
          <Link href="/rrr" className={isAi ? '' : 'active'} aria-current={isAi ? undefined : 'page'}>
            All customers<span>{counts.all.toLocaleString('en-IN')}</span>
          </Link>
          <Link href="/rrr/ai" className={isAi ? 'active' : ''} aria-current={isAi ? 'page' : undefined}>
            AI Leads · today<span>{counts.ai.toLocaleString('en-IN')}</span>
          </Link>
        </div>

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

        {/* On the AI list the controls stay in the toolbar: 45 rows need a
            search box and two dropdowns, not a panel. The All-customers list
            is 1,336 rows and gets the panel below. */}
        {isAi ? (
          <>
            <label className="grid-search">
              <span className="sr-only">Search customer</span>
              <input
                type="search"
                value={filters.search}
                placeholder="Name or mobile number…"
                onChange={(e) => setFilter('search', e.target.value)}
              />
            </label>

            <label className="sr-only" htmlFor="rrr-bucket">Why it was picked</label>
            <select id="rrr-bucket" value={bucket} onChange={(e) => { setBucket(e.target.value); setPage(1); }}>
              <option value="all">All reasons</option>
              {buckets.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
            </select>

            <label className="sr-only" htmlFor="rrr-owner">Calling today</label>
            <select id="rrr-owner" value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)}>
              <option value="all">Everyone’s leads</option>
              <option value="unassigned">Unassigned only</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          </>
        ) : (
          <button
            type="button"
            className={`rrr-filters-btn ${activeCount ? 'on' : ''}`}
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            aria-controls="rrr-filters"
          >
            {panelOpen ? 'Hide filters' : 'Filters'}
            {activeCount ? <span>{activeCount}</span> : null}
          </button>
        )}
      </div>

      {/* Filters get a panel of their own rather than three dropdowns crammed
          into the toolbar. The floor's question is never "show me everyone" —
          it is "prepaid repeat buyers worth ₹20k nobody has called yet", which
          is four conditions at once. Labelled fields in a grid, the six
          questions that get asked daily as one-click chips above them, the
          rare ones folded behind "More filters", and a count of what is on, so
          a surprising row total is never a mystery. */}
      {!isAi && panelOpen ? (
        <div className="rrr-filters" id="rrr-filters">
          <div className="rrr-filters-head">
            <strong>Customer filters</strong>
            <span className="muted">Every condition you pick applies together.</span>
            <div className="toolbar-spacer" />
            <span className={`status-pill ${activeCount ? 'positive' : 'dashed'}`}>
              {activeCount} active
            </span>
          </div>

          <div className="rrr-chips-row">
            {PRESETS.map((p) => {
              const on = shapeOf({ ...NO_FILTERS, ...p.patch }) === shape;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`rrr-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => applyPreset(p.patch)}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="rrr-filter-grid">
            <label className="rrr-field wide">
              <span>Search customer</span>
              <input
                type="search"
                value={filters.search}
                placeholder="Name or mobile number…"
                onChange={(e) => setFilter('search', e.target.value)}
              />
            </label>

            <div className="rrr-field">
              <span id="rrr-type-label">Customer type</span>
              {/* Three buttons, not a select: it is the one filter that is
                  always three options and always worth seeing at a glance. */}
              <div className="rrr-segmented" role="group" aria-labelledby="rrr-type-label">
                {TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    className={filters.type === t.value ? 'on' : ''}
                    aria-pressed={filters.type === t.value}
                    onClick={() => setFilter('type', t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="rrr-field">
              <span>Payment</span>
              <select value={filters.payment} onChange={(e) => setFilter('payment', e.target.value)}>
                {PAYMENTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>

            <label className="rrr-field">
              <span>Activity</span>
              <select value={filters.activity} onChange={(e) => setFilter('activity', e.target.value)}>
                {ACTIVITIES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>

            <label className="rrr-field">
              <span>Follow-up stage</span>
              <select value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}>
                {STAGES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>

            <label className="rrr-field">
              <span>Owner</span>
              <select value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)}>
                <option value="all">Everyone</option>
                <option value="unassigned">Unassigned only</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </select>
            </label>

            <label className="rrr-field">
              <span>Sort results</span>
              <select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)}>
                {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {showMore ? (
            <div className="rrr-filter-grid">
              <label className="rrr-field">
                <span>Last call outcome</span>
                <select value={filters.outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
                  <option value="all">Any outcome</option>
                  {/* Straight from the outcome vocabulary the Log-call dialog
                      writes, so the filter can never list one the floor
                      cannot record. */}
                  {Object.entries(OUTCOME_LABEL).map(([code, label]) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              </label>

              <label className="rrr-field">
                <span>Minimum orders</span>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={filters.minOrders}
                  placeholder="Any"
                  onChange={(e) => setFilter('minOrders', e.target.value)}
                />
              </label>

              <label className="rrr-field">
                <span>Minimum lifetime value (₹)</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  inputMode="numeric"
                  value={filters.minValue}
                  placeholder="Any"
                  onChange={(e) => setFilter('minValue', e.target.value)}
                />
              </label>

              <label className="rrr-field">
                <span>Do-not-disturb</span>
                <select value={filters.dnd} onChange={(e) => setFilter('dnd', e.target.value)}>
                  {DND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
          ) : null}

          <div className="rrr-filters-foot">
            <button type="button" onClick={() => setShowMore((m) => !m)} aria-expanded={showMore}>
              {showMore ? 'Fewer filters' : 'More filters'}
            </button>
            <button type="button" onClick={clearFilters} disabled={!activeCount}>
              Clear filters
            </button>
            <span className="muted">
              {visible.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} customers match
            </span>
          </div>
        </div>
      ) : null}

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
