'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { assignRrr } from './actions';
import { refreshAiLeads } from './ai-leads-actions';
import { resolveMatchingIds } from './select-all-action';
import { LogCallDialog, type CallTarget, type ContactNumber } from './log-call-dialog';
import { CustomerPanel } from './customer-panel';
import { dayShort, digitsOf, initials, money, timeLabel } from './lib/format';
import { outcomeLabel, outcomeTone } from './lib/outcomes';
import {
  ACTIVITIES, DND_OPTIONS, NO_FILTERS, OUTCOME_OPTIONS, PAYMENTS, PRESETS, SORTS, STAGES, TYPES,
  activeCount as countActive, shapeOf, toQueryString, type Filters,
} from './lib/filters';

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

// The five buckets migration 028 seeds into ai_lead_rules. The label comes
// from the database (bucket_label) so a renamed rule needs no deploy; only the
// colour lives here, because a colour is a UI decision.
const BUCKET_TONE: Record<string, string> = {
  // 029's mix, in the order the numbers put them.
  refill: 'positive',            // the course is running out — the band that pays
  retry: 'attention-outline',    // did not pick up, second attempt
  overdue: 'critical',           // a date already promised to the customer
  topbook: 'positive-outline',   // top 10% by lifetime value, on a cycle
  slipping: 'attention',
  cooling: 'neutral',
  revival: 'dashed',
  // 028's codes, kept so a list generated before 029 still paints correctly.
  kamour: 'positive-outline',
  active: 'positive',
  dormant: 'neutral',
};

/** Active if they bought within 90 days — the same line the team's own
 *  dashboard draws between a live customer and one going cold, and the same
 *  line the lead generator's `active` bucket uses. */
function activity(days: number | null) {
  if (days == null) return { text: 'No orders', tone: 'dashed' };
  if (days <= 90) return { text: 'Active', tone: 'positive' };
  return { text: `${days}d inactive`, tone: days > 180 ? 'critical' : 'attention' };
}

/** What the follow-up state means today, not what it meant when it was set.
 *  `today` comes from the server so the pill and the Overdue filter can never
 *  disagree about which day it is. */
function followUpState(r: RrrRow, today: string) {
  if (r.next_due_on) {
    const days = Math.round(
      (new Date(`${today}T00:00:00+05:30`).getTime()
        - new Date(`${r.next_due_on}T00:00:00+05:30`).getTime()) / 86_400_000);
    const last = outcomeLabel(r.last_outcome) ?? '';
    if (days > 0) return { text: last ? `${last} · ${days}d overdue` : `${days}d overdue`, tone: 'critical' };
    if (days === 0) return { text: 'Due today', tone: 'attention' };
    return { text: `Call in ${Math.abs(days)}d`, tone: 'neutral' };
  }
  if (r.last_outcome)
    return { text: outcomeLabel(r.last_outcome) ?? r.last_outcome, tone: outcomeTone(r.last_outcome) };
  return { text: 'Untouched', tone: 'dashed' };
}

const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export function RrrTable({
  mode, rows, aiLeads, filters, page, pageSize, matched, counts, aiRun, reps, canAssign, numbers, today,
}: {
  mode: 'all' | 'ai';
  rows: RrrRow[];
  aiLeads: AiLeadRow[];
  filters: Filters;
  page: number;
  pageSize: number;
  matched: number;
  counts: { all: number; ai: number };
  aiRun: AiRun | null;
  reps: Rep[];
  canAssign: boolean;
  numbers: ContactNumber[];
  today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [navigating, startNav] = useTransition();
  const [selectingAll, startSelectAll] = useTransition();
  const [openRow, setOpenRow] = useState<RrrRow | null>(null);
  const [calling, setCalling] = useState<CallTarget | null>(null);
  /** Which row the keyboard is on. -1 = nothing focused yet. */
  const [cursor, setCursor] = useState(-1);

  const searchInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Which list you are on is the URL, not component state, so the sidebar can
  // link straight to it and the browser's own back button works.
  const isAi = mode === 'ai';

  // ---- filter state lives in the URL -------------------------------------
  // The server reads it to decide what to fetch, so a filter change is a
  // navigation. push() for discrete choices, so the back button steps back
  // through them; replace() while typing, so one search does not bury the
  // history under thirty entries.
  const go = useCallback((next: Filters, nextPage: number, replace = false) => {
    const url = pathname + toQueryString(next, nextPage);
    startNav(() => { if (replace) router.replace(url, { scroll: false }); else router.push(url, { scroll: false }); });
  }, [pathname, router]);

  const setFilter = useCallback((key: keyof Filters, value: string) => {
    // Page 3 of a list that just became 40 rows long is a blank screen.
    go({ ...filters, [key]: value }, 1);
  }, [filters, go]);

  // The search box is typed into, so it keeps a local value and pushes to the
  // URL once typing settles. Without the debounce every keystroke would be a
  // round trip; without the local value the input would lag a frame behind the
  // key that was pressed.
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const committed = useRef(filters.search);
  useEffect(() => {
    // The URL changed from somewhere else (back button, preset, Clear) — take
    // its value rather than overwriting it with a stale draft.
    if (filters.search !== committed.current) {
      committed.current = filters.search;
      setSearchDraft(filters.search);
    }
  }, [filters.search]);
  useEffect(() => {
    if (searchDraft === committed.current) return;
    const id = setTimeout(() => {
      committed.current = searchDraft;
      go({ ...filters, search: searchDraft }, 1, true);
    }, 300);
    return () => clearTimeout(id);
  }, [searchDraft, filters, go]);

  function applyPreset(patch: Partial<Filters>) {
    const wanted = { ...NO_FILTERS, ...patch };
    go({
      // Clicking the chip you are already standing on takes it off again.
      ...(shapeOf(filters) === shapeOf(wanted) ? NO_FILTERS : wanted),
      // Who you are searching for and whose book you are in survive a preset:
      // a rep filtered to their own customers stays in their own customers.
      search: filters.search,
      owner: filters.owner,
      bucket: filters.bucket,
    }, 1);
  }

  function clearFilters() {
    go({ ...NO_FILTERS, sort: filters.sort }, 1);
  }

  const activeCount = useMemo(() => countActive(filters), [filters]);
  const shape = useMemo(() => shapeOf(filters), [filters]);

  // ---- what is on screen -------------------------------------------------
  // On the All tab the server already filtered, sorted and paged, so `rows` IS
  // the page. On the AI tab the whole day is in hand (45 rows at the current
  // cap) and the generator's ranking is the product — it is never re-sorted,
  // only narrowed.
  const filtered = useMemo(() => {
    if (!isAi) return rows;
    const q = filters.search.trim().toLowerCase();
    const digits = digitsOf(q);
    return aiLeads.filter((a) => {
      // In this list "owner" means who is calling them TODAY, not who owns the
      // customer — that is the whole point of the daily deal.
      if (filters.owner === 'unassigned' && a.ai_owner_id) return false;
      if (filters.owner !== 'all' && filters.owner !== 'unassigned' && a.ai_owner_id !== filters.owner) return false;
      if (filters.bucket !== 'all' && a.bucket !== filters.bucket) return false;
      if (q) {
        const byName = a.full_name.toLowerCase().includes(q);
        const byPhone = digits.length > 0 && digitsOf(a.phone_e164).includes(digits);
        if (!byName && !byPhone) return false;
      }
      return true;
    });
  }, [isAi, rows, aiLeads, filters.search, filters.owner, filters.bucket]);

  const total = isAi ? filtered.length : matched;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = (page - 1) * pageSize + 1;

  // The rows actually on screen.
  //
  // On the All tab the server already sliced, so `rows` IS the page. On the AI
  // tab the whole day is in hand and the slice happens here — it has to, or a
  // day bigger than one page would render every row while the pager claimed
  // there were two. Today's cap is 45 so it fits, but the day is the sum of
  // users.daily_lead_cap: a fourth rep takes it to 60 and past the page size.
  const shown = useMemo(
    () => (isAi ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered),
    [isAi, filtered, page, pageSize]);

  // A filter can narrow the list while you are on page 6. On the All tab the
  // server has no count until it has run the query, so the correction happens
  // here either way: step to the last page that exists rather than showing a
  // blank one that reads as "no results".
  useEffect(() => {
    if (page > pageCount && total > 0) go(filters, pageCount);
  }, [page, pageCount, total, filters, go]);

  // The buckets actually present in today's list, labelled by the database.
  // Built from the rows rather than hard-coded so a new rule shows up on its
  // own the first time the generator uses it.
  const buckets = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of aiLeads) seen.set(r.bucket, r.bucket_label ?? r.bucket);
    return [...seen].map(([code, label]) => ({ code, label }));
  }, [aiLeads]);

  // ---- selection ---------------------------------------------------------
  // Selection survives paging: the Set is component state and the page is a
  // navigation, so ticking six rows on page 1 and four on page 2 is one batch
  // of ten. The header checkbox covers this page; everything the filter matched
  // is a separate, explicit action, because it is the one that can move 500
  // customers and should never happen by reflex.
  const pageIds = useMemo(() => shown.map((r) => r.customer_id), [shown]);
  const selectedOnPage = useMemo(
    () => pageIds.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0), [pageIds, selected]);
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someOnPage = selectedOnPage > 0 && !allOnPage;

  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headBox.current) headBox.current.indeterminate = someOnPage; }, [someOnPage]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  function selectAllMatching() {
    setMessage(null);
    startSelectAll(async () => {
      // The browser holds fifty rows, so the ids for the other 1,286 have to be
      // asked for. Id column only — see resolveMatchingIds.
      const params = Object.fromEntries(new URLSearchParams(toQueryString(filters, 1)));
      const result = await resolveMatchingIds(params);
      if (!result.ok) { setMessage(result.error); return; }
      setSelected(new Set(result.ids));
      setMessage(`${result.ids.length.toLocaleString('en-IN')} customers selected.`);
    });
  }

  const clearSelection = () => { setSelected(new Set()); setMessage(null); };

  // ---- actions -----------------------------------------------------------
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
      // The rows on screen now say the wrong owner; the server has the new one.
      router.refresh();
    });
  }

  function regenerate() {
    setMessage(null);
    startRefresh(async () => {
      const result = await refreshAiLeads();
      setMessage(result.ok ? `Today's list rebuilt — ${result.total} leads.` : result.error);
      if (result.ok) router.refresh();
    });
  }

  const callTargetFor = useCallback((r: RrrRow): CallTarget => ({
    customerId: r.customer_id,
    name: r.full_name,
    phone: r.phone_e164,
    followupId: r.open_followup_id,
    orderId: r.last_order_id,
  }), []);

  // ---- keyboard ----------------------------------------------------------
  // "Keyboard first: j/k row nav, Enter open, e edit, / search, Esc close" is
  // the design brief, and this grid had none of it. Esc inside the dialogs is
  // handled by useModal, which is why this listener stands down while one is
  // open rather than competing with it.
  const dialogOpen = !!openRow || !!calling;
  useEffect(() => {
    if (dialogOpen) return;

    function onKey(event: KeyboardEvent) {
      const el = event.target as HTMLElement | null;
      const typing = !!el && (TYPING.has(el.tagName) || el.isContentEditable);

      if (event.key === '/' && !typing) {
        event.preventDefault();
        // On the All tab the search box lives in the filter panel, so a
        // collapsed panel has nothing to focus — open it and focus once it is
        // on screen, rather than swallowing the keystroke.
        if (!isAi && !panelOpen) {
          setPanelOpen(true);
          requestAnimationFrame(() => {
            searchInput.current?.focus();
            searchInput.current?.select();
          });
          return;
        }
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (typing) {
        // Escape gives the keyboard back to the grid from any field.
        if (event.key === 'Escape') el?.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Escape unwinds one layer at a time, the same order DataGrid uses:
      // a selection first, then the keyboard cursor.
      if (event.key === 'Escape') {
        if (selected.size) clearSelection();
        else setCursor(-1);
        return;
      }

      const last = shown.length - 1;
      if (last < 0) return;

      // A key pressed with a button or link focused belongs to that control.
      const onControl = !!el?.closest('button,a');
      const row = shown[cursor];

      switch (event.key) {
        case 'j': case 'ArrowDown':
          event.preventDefault();
          setCursor((c) => Math.min(c < 0 ? 0 : c + 1, last));
          break;
        case 'k': case 'ArrowUp':
          event.preventDefault();
          setCursor((c) => Math.max(c < 0 ? 0 : c - 1, 0));
          break;
        case 'Enter':
          if (row && !onControl) { event.preventDefault(); setOpenRow(row); }
          break;
        case 'e': case 'E':
          if (row) { event.preventDefault(); setCalling(callTargetFor(row)); }
          break;
        case ' ':
          if (row && canAssign && !onControl) { event.preventDefault(); toggle(row.customer_id); }
          break;
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialogOpen, shown, cursor, canAssign, callTargetFor, isAi, panelOpen, selected.size]);

  // A cursor past the end of a freshly-filtered page points at nothing.
  useEffect(() => { setCursor((c) => (c > shown.length - 1 ? -1 : c)); }, [shown.length]);

  // Keep the keyboard row in view without yanking the page around.
  useEffect(() => {
    if (cursor < 0) return;
    bodyRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const busy = navigating || pending;

  return (
    <section className="data-grid" aria-busy={busy}>
      <div className="grid-toolbar">
        <h1>RRR</h1>

        {/* Tabs, not a dropdown. This is WHICH LIST you are looking at, which
            is the same choice Leads, Consultation and Orders all make with
            tabs. Links, not buttons: each list is its own URL, so these are the
            same navigation the sidebar performs and behave like it —
            bookmarkable, back-button-able, and highlighted by the route rather
            than by state the sidebar cannot see. */}
        <div className="module-tabs">
          <Link href="/rrr" className={isAi ? '' : 'active'} aria-current={isAi ? undefined : 'page'}>
            All customers<span>{counts.all.toLocaleString('en-IN')}</span>
          </Link>
          <Link href="/rrr/ai" className={isAi ? 'active' : ''} aria-current={isAi ? 'page' : undefined}>
            AI Leads · today<span>{counts.ai.toLocaleString('en-IN')}</span>
          </Link>
        </div>

        <span className="muted" aria-live="polite">
          {total
            ? `Showing ${firstShown}–${Math.min(page * pageSize, total)} of ${total.toLocaleString('en-IN')}`
            : '0 customers'}
          {selected.size ? ` · ${selected.size.toLocaleString('en-IN')} selected` : ''}
        </span>

        {/* Up here rather than in the assign bar, which only oversight roles
            see — a rep logging a call was getting no confirmation at all. */}
        {message ? <span className="muted" role="status">{message}</span> : null}

        <div className="toolbar-spacer" />

        {/* On the AI list the controls stay in the toolbar: 45 rows need a
            search box and two dropdowns, not a panel. The All-customers list is
            1,336 rows and gets the panel below. */}
        {isAi ? (
          <>
            <label className="grid-search">
              <span className="sr-only">Search customer</span>
              <input
                ref={searchInput}
                type="search"
                value={searchDraft}
                placeholder="Name or mobile number…   /"
                onChange={(e) => setSearchDraft(e.target.value)}
              />
            </label>

            <label className="sr-only" htmlFor="rrr-bucket">Why it was picked</label>
            <select id="rrr-bucket" value={filters.bucket} onChange={(e) => setFilter('bucket', e.target.value)}>
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
          questions that get asked daily as one-click chips above them, the rare
          ones folded behind "More filters", and a count of what is on, so a
          surprising row total is never a mystery. */}
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
                ref={searchInput}
                type="search"
                value={searchDraft}
                placeholder="Name or mobile number…   press / to jump here"
                onChange={(e) => setSearchDraft(e.target.value)}
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
                {/* Straight from the outcome vocabulary the Log-call dialog
                    writes, so the filter can never list one the floor cannot
                    record — nor miss one the data holds. */}
                <select value={filters.outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
                  {OUTCOME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
                  onChange={(e) => setFilter('minOrders', e.target.value.replace(/\D/g, ''))}
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
                  onChange={(e) => setFilter('minValue', e.target.value.replace(/\D/g, ''))}
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
              {total.toLocaleString('en-IN')} of {counts.all.toLocaleString('en-IN')} customers match
            </span>
          </div>
        </div>
      ) : null}

      {isAi ? (
        <div className="grid-toolbar rrr-aibar">
          <span>
            {aiRun
              ? <><strong>{aiRun.total} leads</strong> for {dayShort(aiRun.run_on)}, dealt evenly across the floor</>
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

          {/* Selecting beyond this page is deliberate and says its own number.
              The screen holds fifty rows, so this asks the server which ids the
              filter matches rather than pretending it already knows. */}
          {!isAi && total > shown.length ? (
            <button type="button" onClick={selectAllMatching} disabled={selectingAll || busy}>
              {selectingAll ? 'Selecting…' : `Select all ${total.toLocaleString('en-IN')} matching`}
            </button>
          ) : null}
          {selected.size ? (
            <button type="button" onClick={clearSelection}>Clear selection</button>
          ) : null}

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
                  <input
                    ref={headBox}
                    type="checkbox"
                    checked={allOnPage}
                    onChange={togglePage}
                    aria-label="Select every row on this page"
                  />
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
          <tbody ref={bodyRef}>
            {shown.map((r, i) => {
              const act = activity(r.days_since_order);
              const fu = followUpState(r, today);
              const ai = isAi ? (r as AiLeadRow) : null;
              return (
                <tr
                  key={r.customer_id}
                  className={`record-row ${selected.has(r.customer_id) ? 'selected' : ''} ${i === cursor ? 'keyboard-focused' : ''}`}
                  onMouseDown={() => setCursor(i)}
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

        {shown.length === 0 ? (
          <div className="grid-empty">
            <p>
              {isAi && !aiRun
                ? 'No AI leads for today yet. The list is built every morning at 4:30.'
                : 'No customers match this filter.'}
            </p>
            {!isAi && activeCount ? (
              <p><button type="button" onClick={clearFilters}>Clear filters</button></p>
            ) : null}
          </div>
        ) : null}
      </div>

      {pageCount > 1 ? (
        <footer className="grid-footer rrr-pager">
          <button type="button" onClick={() => go(filters, page - 1)} disabled={page <= 1 || busy}>
            Previous
          </button>
          <span className="muted">Page {Math.min(page, pageCount)} of {pageCount}</span>
          <button type="button" onClick={() => go(filters, page + 1)} disabled={page >= pageCount || busy}>
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
          onSaved={(msg) => { setCalling(null); setMessage(msg); router.refresh(); }}
        />
      ) : null}
    </section>
  );
}
