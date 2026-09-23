'use client';

import { DashboardLink as Link } from '@/components/DashboardLink';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { assignRrr, assignRrrWork } from './actions';
import { refreshAiLeads } from './ai-leads-actions';
import { resolveMatchingIds } from './select-all-action';
import { LogCallDialog, type CallTarget, type ContactNumber } from './log-call-dialog';
import { CustomerPanel } from './customer-panel';
import { SortSelect } from './sort-select';
import { dayInYear, dayMaybeYear, dayShort, daysBetween, digitsOf, istDateFromTimestamp, initials, isOtherYear, money, timeLabel } from './lib/format';
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
  /** Filled in by the screen after the list loads, not by the view. */
  last_order_products?: string | null;
  medicine_ends_on?: string | null;
  /** Delivery date or course length was missing, so a stand-in was used. */
  medicine_ends_estimated?: boolean;
};

export type AiRun = { run_on: string; generated_at: string; total: number };

export type Rep = { id: string; full_name: string; role: string };
export type WorkAssignment = {
  customer_id: string;
  source: 'ai' | 'medicine_ending' | 'due';
  assigned_to: string | null;
  assigned_at: string | null;
  due_on: string;
  last_outcome: string | null;
  medicine_days_left: number | null;
  completed_at: string | null;
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

/** The AI list's sorts, in the same vocabulary (and URL values) as the
 *  All-customers list, so `?sort=value` means the same thing on both. `queue`
 *  is the generator's own rank here and is left as the rows arrive. */
const AI_SORT_FIRST = { value: 'queue', label: 'AI priority (default)' };
const AI_SORTS = SORTS.filter((o) => o.value !== 'queue')
  .map((o) => (o.value === 'value' ? { ...o, label: 'Highest LTV first' } : o));
// A customer with no value on record sorts last whichever way the list runs.
const nullsLast = <T,>(a: T | null, b: T | null, cmp: (x: T, y: T) => number) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : cmp(a, b);
const AI_ORDER: Record<string, (a: AiLeadRow, b: AiLeadRow) => number> = {
  value: (a, b) => b.lifetime_value - a.lifetime_value || a.rank - b.rank,
  orders: (a, b) => b.lifetime_orders - a.lifetime_orders || b.lifetime_value - a.lifetime_value,
  aov: (a, b) => nullsLast(a.aov, b.aov, (x, y) => y - x),
  recent: (a, b) => nullsLast(a.days_since_order, b.days_since_order, (x, y) => x - y),
  stale: (a, b) => nullsLast(a.days_since_order, b.days_since_order, (x, y) => y - x),
  due: (a, b) => nullsLast(a.next_due_on, b.next_due_on, (x, y) => x.localeCompare(y)),
  name: (a, b) => a.full_name.localeCompare(b.full_name),
};

export function RrrTable({
  mode, rows, aiLeads, filters, page, pageSize, matched, counts, aiRun, reps,
  workAssignments, canAssign, canLog, numbers, preferredNumberId, today,
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
  workAssignments: WorkAssignment[];
  canAssign: boolean;
  canLog: boolean;
  numbers: ContactNumber[];
  /** The handset this rep last called from, seeding the Log-call dialog. */
  preferredNumberId: string | null;
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
  const workByCustomer = useMemo(
    () => {
      const byCustomer = new Map<string, WorkAssignment>();
      for (const work of workAssignments)
        if (!byCustomer.has(work.customer_id)) byCustomer.set(work.customer_id, work);
      return byCustomer;
    },
    [workAssignments]);

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
  // cap). The generator's ranking is the default order; the Sort dropdown can
  // re-order the day by value (LTV first, most orders…) for whoever is
  // choosing who to hand out first.
  const filtered = useMemo(() => {
    if (!isAi) return rows;
    const q = filters.search.trim().toLowerCase();
    const digits = digitsOf(q);
    const kept = aiLeads.filter((a) => {
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
    const compare = AI_ORDER[filters.sort];
    return compare ? [...kept].sort(compare) : kept;
  }, [isAi, rows, aiLeads, filters.search, filters.owner, filters.bucket, filters.sort]);

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
  /** Above this, a handover is more calls than the floor can make in a day and
   *  is far likelier to be "select all matching" pressed by reflex. The whole
   *  team's daily AI list is 45. */
  const CONFIRM_ABOVE = 100;

  function submit() {
    if (!selected.size || !target) return;
    const ids = [...selected];
    const unassigning = target === 'unassign';
    const toName = unassigning
      ? isAi ? 'unassigned calling tasks' : 'the unassigned pool'
      : reps.find((r) => r.id === target)?.full_name ?? 'that rep';
    // On the All list this now hands over calls, not just ownership, so a
    // batch this size is worth one question before a rep's day fills up.
    if (!isAi && !unassigning && ids.length > CONFIRM_ABOVE
      && !window.confirm(`Assign ${ids.length.toLocaleString('en-IN')} customers to ${toName}? Each one becomes a call on their list.`))
      return;
    setMessage(null);
    startTransition(async () => {
      const owner = unassigning ? null : target;
      if (isAi) {
        const result = await assignRrrWork('ai', ids, owner);
        if (!result.ok) { setMessage(result.error); return; }
        setSelected(new Set());
        setMessage(result.moved === 0
          ? `Nothing changed — those ${ids.length} were already on ${toName}.`
          : `${result.moved} of ${ids.length} moved to ${toName}.`);
      } else {
        const result = await assignRrr(ids, owner);
        if (!result.ok) { setMessage(result.error); return; }
        setSelected(new Set());
        // Ownership and the call are two different numbers: a customer can
        // already be owned by the rep and still be getting their first call.
        const { tasks, skipped } = result;
        setMessage(unassigning
          ? `${ids.length} back in the unassigned pool${tasks ? `, ${tasks} calling task${tasks === 1 ? '' : 's'} withdrawn` : ''}.`
          : `${tasks} of ${ids.length} now on ${toName}'s calling list.`
            + (result.moved ? ` Ownership moved for ${result.moved}.` : ' Ownership was already theirs.')
            + (skipped ? ` ${skipped} skipped — DND, merged, or no order on record.` : ''));
      }
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

            <label className="sr-only" htmlFor="rrr-owner">AI suggested caller</label>
            <select id="rrr-owner" value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)}>
              <option value="all">All AI suggestions</option>
              <option value="unassigned">Unassigned only</option>
              {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>

            <SortSelect id="rrr-ai-sort" inToolbar value={filters.sort}
              onChange={(v) => setFilter('sort', v)} first={AI_SORT_FIRST} options={AI_SORTS} />
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
          <label className="sr-only" htmlFor="rrr-target">{isAi ? 'Assign calling task to' : 'Assign customer to'}</label>
          <select id="rrr-target" value={target} onChange={(e) => setTarget(e.target.value)} disabled={pending}>
            <option value="">{isAi ? 'Assign selected calls to…' : 'Assign selected to…'}</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            <option value="unassign">{isAi ? '— Remove calling assignment —' : '— Put back in unassigned pool —'}</option>
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

          <span className="muted">
            {isAi
              ? 'This assigns a calling task. Permanent customer ownership stays unchanged.'
              : "Moves ownership and puts the lead on that rep's calling list."}
          </span>
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
              <th>Customer</th>
              {isAi ? (
                <>
                  <th className="num">Lifetime value</th>
                  <th>Last order</th>
                  <th>Medicine ends</th>
                  <th>Activity</th>
                  <th>Last follow-up</th>
                  <th>Task assignment</th>
                </>
              ) : (
                <>
                  <th>Payment</th>
                  <th className="num">Orders</th>
                  <th className="num">Amount / LTV</th>
                  <th className="num">AOV</th>
                  <th>Last activity</th>
                  <th>Activity</th>
                  <th>Follow-up</th>
                </>
              )}
              <th />
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {shown.map((r, i) => {
              const act = activity(r.days_since_order);
              const fu = followUpState(r, today);
              if (isAi) {
                const ai = r as AiLeadRow;
                // One decision for the row's two dates — see dayMaybeYear.
                const rowYear = isOtherYear(r.last_order_on) || isOtherYear(ai.medicine_ends_on ?? null);
                const work = workByCustomer.get(r.customer_id);
                const assignee = work?.assigned_to ? reps.find((rep) => rep.id === work.assigned_to)?.full_name ?? 'Assigned' : null;
                // A call logged against today's task is newer than the queue's
                // last contact, so it wins.
                const outcome = work?.last_outcome ?? r.last_outcome;
                // Handed to a rep who has not logged a call on it yet: struck
                // through until they do.
                const waiting = !!assignee && !work?.last_outcome && !work?.completed_at;
                return (
                  <tr
                    key={r.customer_id}
                    className={`record-row ${waiting ? 'assigned-waiting' : ''} ${selected.has(r.customer_id) ? 'selected' : ''} ${i === cursor ? 'keyboard-focused' : ''}`}
                    onMouseDown={() => setCursor(i)}
                  >
                    {canAssign ? (
                      <td className="no-strike">
                        <input
                          type="checkbox"
                          checked={selected.has(r.customer_id)}
                          onChange={() => toggle(r.customer_id)}
                          aria-label={`Select ${r.full_name}`}
                        />
                      </td>
                    ) : null}
                    <td>
                      <button type="button" className="rrr-customer" onClick={() => setOpenRow(r)}>
                        <span className="rrr-customer-copy">
                          <strong>{r.full_name}</strong>
                          <span className="muted">{r.phone_e164}</span>
                        </span>
                      </button>
                    </td>
                    <td className="num">{money(r.lifetime_value)}</td>
                    <td>
                      {/* Both dates carry the year, or neither does. A row
                          reading "30 Dec 2025 → ends 5 Feb" makes the reader
                          guess which February, and the missing year suggests
                          the wrong one. */}
                      {r.last_order_on ? dayMaybeYear(r.last_order_on, rowYear) : '—'}
                      {ai.last_order_products ? <><br /><span className="muted">{ai.last_order_products}</span></> : null}
                    </td>
                    <td>
                      {ai.medicine_ends_on ? (() => {
                        const left = daysBetween(today, ai.medicine_ends_on);
                        return <>
                          {dayMaybeYear(ai.medicine_ends_on, rowYear)}
                          <br />
                          <span className="muted" title={ai.medicine_ends_estimated ? 'Estimated: delivery taken as 7 days after the order, and/or the course length read off the tablets rather than recorded' : undefined}>
                            {left < 0 ? `Ended ${-left}d ago` : left === 0 ? 'Ends today' : `${left}d left`}
                            {ai.medicine_ends_estimated ? ' · est.' : ''}
                          </span>
                        </>;
                      })() : <span className="muted">—</span>}
                    </td>
                    <td>
                      <span className={`status-pill ${act.tone}`}>
                        {r.days_since_order == null
                          ? act.text
                          : `${r.days_since_order <= 90 ? 'Active' : 'Inactive'} · ${r.days_since_order} ${r.days_since_order === 1 ? 'day' : 'days'} ago`}
                      </span>
                    </td>
                    <td>
                      {outcome
                        ? <span className={`status-pill ${outcomeTone(outcome)}`}>{outcomeLabel(outcome) ?? outcome}</span>
                        : <span className="muted">No follow-up yet</span>}
                      {outcome && r.last_contacted_on && !work?.last_outcome
                        ? <><br /><span className="muted">{dayInYear(r.last_contacted_on)}</span></> : null}
                      {work?.last_outcome ? <><br /><span className="muted">Today</span></> : null}
                    </td>
                    <td className="no-strike">
                      {waiting ? (
                        <span className="status-pill attention">
                          Assigned {work?.assigned_at && istDateFromTimestamp(work.assigned_at) !== today ? dayShort(work.assigned_at) : 'today'} · {assignee}
                        </span>
                      ) : (
                        <strong>{assignee ? `${work?.completed_at ? 'Completed by ' : 'Called by '}${assignee}` : 'Not assigned yet'}</strong>
                      )}
                      <br />
                      <span className="muted">AI suggested: {ai.ai_owner_name ?? 'Unassigned'}</span>
                    </td>
                    <td className="no-strike">
                      {canLog ? <button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button> : null}
                    </td>
                  </tr>
                );
              }
              // Assigning here hands over the call as well as the customer,
              // so the row says so and greys out until the rep has called —
              // the same signal the AI, Due and Medicine Ending lists give.
              const work = workByCustomer.get(r.customer_id);
              const assignee = work?.assigned_to
                ? reps.find((rep) => rep.id === work.assigned_to)?.full_name ?? 'Assigned'
                : null;
              const waiting = !!assignee && !work?.last_outcome && !work?.completed_at;
              return (
                <tr
                  key={r.customer_id}
                  className={`record-row ${waiting ? 'assigned-waiting' : ''} ${selected.has(r.customer_id) ? 'selected' : ''} ${i === cursor ? 'keyboard-focused' : ''}`}
                  onMouseDown={() => setCursor(i)}
                >
                  {canAssign ? (
                    <td className="no-strike">
                      <input
                        type="checkbox"
                        checked={selected.has(r.customer_id)}
                        onChange={() => toggle(r.customer_id)}
                        aria-label={`Select ${r.full_name}`}
                      />
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

                  <td>{r.payment_profile ? <span className="status-pill neutral">{r.payment_profile}</span> : '—'}</td>

                  <td className="num">{r.lifetime_orders}</td>
                  <td className="num">{money(r.lifetime_value)}</td>
                  <td className="num">{money(r.aov)}</td>
                  <td>
                    {r.last_order_on ?? '—'}
                    <br />
                    <span className="muted">{r.last_order_source ?? 'Order placed'}</span>
                  </td>
                  <td><span className={`status-pill ${act.tone}`}>{act.text}</span></td>
                  <td className="no-strike">
                    {waiting ? (
                      <span className="status-pill attention">
                        Assigned {work?.assigned_at && istDateFromTimestamp(work.assigned_at) !== today ? dayShort(work.assigned_at) : 'today'} · {assignee}
                      </span>
                    ) : (
                      <span className={`status-pill ${fu.tone}`}>{fu.text}</span>
                    )}
                    <br />
                    <span className="muted">
                      {assignee && !waiting ? `Called by ${assignee}` : r.owner_name ?? 'Unassigned'}
                    </span>
                  </td>
                  <td className="no-strike">
                    {canLog ? <button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button> : null}
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
          onLogCall={canLog ? () => { setCalling(callTargetFor(openRow)); setOpenRow(null); } : undefined}
        />
      ) : null}

      {calling ? (
        <LogCallDialog
          target={calling}
          numbers={numbers}
          preferredNumberId={preferredNumberId}
          onClose={() => setCalling(null)}
          onSaved={(msg) => { setCalling(null); setMessage(msg); router.refresh(); }}
        />
      ) : null}
    </section>
  );
}
