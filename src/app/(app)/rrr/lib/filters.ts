// The All-customers filter: its shape, its URL form, and its translation into
// a database query.
//
// This used to run entirely in the browser over every customer in the base.
// That meant /rrr shipped all 1,336 rows — 726 KB and 1.6 s measured — to
// render fifty of them, which broke PROJECT.md's first hard constraint ("every
// list paginated, default 50, range queries only") on the module's own busiest
// screen. The conditions below are now SQL, so a page costs one bounded range
// query (~27 KB, 100–370 ms measured across every filter combination).
//
// The filter state lives in the URL, which makes it shareable, bookmarkable
// and survivable across a refresh — and is what lets the server know what to
// fetch in the first place.

import { OUTCOME_CODES, outcomeLabel } from './outcomes';

export type Filters = {
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
  bucket: string;   // AI list only: why the generator picked them
};

export const NO_FILTERS: Filters = {
  search: '', type: 'all', payment: 'all', activity: 'all', stage: 'all',
  outcome: 'all', owner: 'all', dnd: 'all', minOrders: '', minValue: '',
  // Not "highest value first": the list arrives unassigned-first, which is the
  // order the work is handed out in, and a default sort would throw that away.
  sort: 'queue',
  bucket: 'all',
};

export const PAGE_SIZE = 50;

export const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'repeat', label: 'Repeat' },
];

// The three profiles v_rrr_queue computes (027), matched by label because that
// is what the view returns and what the Payment column already shows.
export const PAYMENTS = [
  { value: 'all', label: 'All payment types' },
  { value: 'Prepaid only', label: 'Prepaid only' },
  { value: 'COD only', label: 'COD only' },
  { value: 'Mixed', label: 'Mixed' },
];

// The same bands the Activity pill paints, so a filter and the column it
// filters on can never disagree.
export const ACTIVITIES = [
  { value: 'all', label: 'All activity stages' },
  { value: 'active', label: 'Active · ordered within 90d' },
  // Both halves of "gone quiet" as one option, because that is the line the
  // screen drew before this panel existed and the floor still asks for it.
  { value: 'inactive', label: 'Inactive · 90d+' },
  { value: 'cooling', label: 'Cooling · 91–180d' },
  { value: 'dormant', label: 'Inactive · 180d+' },
  { value: 'never', label: 'No orders on record' },
];

export const STAGES = [
  { value: 'all', label: 'All follow-up stages' },
  { value: 'untouched', label: 'Untouched — never called' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'upcoming', label: 'Scheduled later' },
  { value: 'closed', label: 'Called, nothing scheduled' },
];

export const DND_OPTIONS = [
  { value: 'all', label: 'Include DND' },
  { value: 'exclude', label: 'Hide DND' },
  { value: 'only', label: 'DND only' },
];

export const OUTCOME_OPTIONS = [
  { value: 'all', label: 'Any outcome' },
  ...OUTCOME_CODES.map((code) => ({ value: code as string, label: outcomeLabel(code) ?? code })),
];

export const SORTS = [
  { value: 'queue', label: 'Unassigned first (default)' },
  { value: 'value', label: 'Highest amount first' },
  { value: 'orders', label: 'Most orders first' },
  { value: 'aov', label: 'Highest AOV first' },
  { value: 'recent', label: 'Most recent order first' },
  { value: 'stale', label: 'Longest inactive first' },
  { value: 'due', label: 'Follow-up due soonest' },
  { value: 'name', label: 'Name A–Z' },
];

/** The questions the floor actually opens this screen with, one click each.
 *  Anything a preset does not set goes back to its default, so a chip is a
 *  whole answer and not a layer on top of whatever was left over. */
export const PRESETS: { id: string; label: string; patch: Partial<Filters> }[] = [
  { id: 'spenders', label: 'Highest spenders', patch: { sort: 'value' } },
  { id: 'orders', label: 'Most orders', patch: { sort: 'orders' } },
  { id: 'prepaid', label: 'Prepaid repeat', patch: { type: 'repeat', payment: 'Prepaid only', sort: 'value' } },
  { id: 'cold', label: 'Inactive high-value', patch: { activity: 'dormant', minValue: '20000', sort: 'value' } },
  { id: 'untouched', label: 'Never called', patch: { stage: 'untouched', sort: 'value' } },
  { id: 'overdue', label: 'Overdue follow-ups', patch: { stage: 'overdue', sort: 'due' } },
];

const ALLOWED: Record<keyof Filters, readonly string[] | null> = {
  search: null,
  type: TYPES.map((o) => o.value),
  payment: PAYMENTS.map((o) => o.value),
  activity: ACTIVITIES.map((o) => o.value),
  stage: STAGES.map((o) => o.value),
  outcome: OUTCOME_OPTIONS.map((o) => o.value),
  owner: null,            // 'all' | 'unassigned' | a user uuid
  dnd: DND_OPTIONS.map((o) => o.value),
  minOrders: null,
  minValue: null,
  sort: SORTS.map((o) => o.value),
  bucket: null,           // whatever codes the generator wrote today
};

const KEYS = Object.keys(NO_FILTERS) as (keyof Filters)[];

const uuidish = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const wholeNumber = (v: string) => /^\d{1,9}$/.test(v);

export type QueryParams = Record<string, string | string[] | undefined>;

const one = (raw: string | string[] | undefined) =>
  (Array.isArray(raw) ? raw[0] : raw) ?? '';

/**
 * Read the filter out of the URL.
 *
 * Every value is validated against the options that produced it, because a URL
 * is user input: an unknown value falls back to its default rather than
 * reaching the query builder. That is what keeps `sort` and the enum filters
 * from ever becoming a PostgREST injection surface — they are only ever one of
 * a fixed set of strings this file wrote.
 */
export function parseFilters(params: QueryParams): Filters {
  const out = { ...NO_FILTERS };
  for (const key of KEYS) {
    const value = one(params[key]);
    if (!value) continue;
    const allowed = ALLOWED[key];
    if (allowed) {
      if (allowed.includes(value)) out[key] = value;
      continue;
    }
    if (key === 'owner') {
      if (value === 'all' || value === 'unassigned' || uuidish(value)) out.owner = value;
    } else if (key === 'minOrders' || key === 'minValue') {
      if (wholeNumber(value)) out[key] = value;
    } else if (key === 'search') {
      out.search = value.slice(0, 80);
    } else if (key === 'bucket') {
      out.bucket = value.slice(0, 40);
    }
  }
  return out;
}

/** 1-based, clamped. Page 0 and page -3 are the same page as page 1. */
export function parsePage(params: QueryParams): number {
  const n = Number(one(params.page));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** The URL form of a filter. Defaults are omitted, so an unfiltered screen has
 *  a clean `/rrr` and a shared link carries only what was actually chosen. */
export function toQueryString(filters: Filters, page = 1): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    if (filters[key] !== NO_FILTERS[key]) params.set(key, filters[key]);
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** How many conditions are narrowing the list right now. Sort is not one of
 *  them — it changes the order, never the count — so it is deliberately not
 *  counted, or the badge would read "1 active" on an unfiltered screen. */
export function activeCount(filters: Filters): number {
  let n = 0;
  for (const key of KEYS) {
    if (key === 'sort') continue;
    if (key === 'search' ? filters.search.trim() !== '' : filters[key] !== NO_FILTERS[key]) n++;
  }
  return n;
}

/** Two filter sets ask the same question when everything except who you are
 *  searching for and whose book you are in matches. Used to light up the
 *  preset chip you are currently standing on. */
export const shapeOf = (f: Filters) => JSON.stringify(
  [f.type, f.payment, f.activity, f.stage, f.outcome, f.dnd, f.minOrders, f.minValue, f.sort]);

// ---------------------------------------------------------------------------
// Translation to a query.
//
// Emitted as plain data rather than by mutating a Supabase builder here, so
// this file stays free of client/server and PostgREST typing concerns and the
// caller applies the ops against its own fully-typed builder.
// ---------------------------------------------------------------------------

export type FilterOp =
  | { kind: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; col: string; val: string | number | boolean }
  | { kind: 'is-null'; col: string }
  | { kind: 'or'; expr: string };

export type OrderOp = { col: string; ascending: boolean; nullsFirst: boolean };

/** Every sort the UI offers, as database order. `customer_id` always breaks
 *  the tie: without it two rows with equal value can swap between pages, so
 *  one gets fetched twice and another never at all. */
const ORDERS: Record<string, OrderOp[]> = {
  queue: [
    { col: 'current_owner_id', ascending: true, nullsFirst: true },
    { col: 'lifetime_value', ascending: false, nullsFirst: false },
  ],
  value: [{ col: 'lifetime_value', ascending: false, nullsFirst: false }],
  orders: [{ col: 'lifetime_orders', ascending: false, nullsFirst: false }],
  aov: [{ col: 'aov', ascending: false, nullsFirst: false }],
  // Never-ordered sorts last either way, rather than pretending to be day 0.
  recent: [{ col: 'days_since_order', ascending: true, nullsFirst: false }],
  stale: [{ col: 'days_since_order', ascending: false, nullsFirst: false }],
  due: [{ col: 'next_due_on', ascending: true, nullsFirst: false }],
  name: [{ col: 'full_name', ascending: true, nullsFirst: false }],
};

const QUEUE_ORDER = ORDERS.queue as OrderOp[];

export function orderFor(filters: Filters): OrderOp[] {
  return [
    ...(ORDERS[filters.sort] ?? QUEUE_ORDER),
    { col: 'customer_id', ascending: true, nullsFirst: false },
  ];
}

/**
 * Strip PostgREST's filter grammar out of a search term.
 *
 * The term is interpolated into an `or=(...)` expression, where `,` separates
 * conditions, `.` separates column/operator/value and `()"` delimit. Removing
 * those characters — rather than escaping them — means a search box can never
 * add a condition of its own. Same approach as src/lib/crm/queries.ts.
 */
export function safeSearch(raw: string): string {
  return raw.trim().replace(/[^\p{L}\p{N}\s+@-]/gu, '').slice(0, 80);
}

/** Every condition, as database filters. `today` is passed in rather than read
 *  here so one request cannot straddle midnight IST between its count query
 *  and its rows query. */
export function filterOps(filters: Filters, today: string): FilterOp[] {
  const ops: FilterOp[] = [];

  if (filters.type === 'new') ops.push({ kind: 'eq', col: 'is_repeat_buyer', val: false });
  if (filters.type === 'repeat') ops.push({ kind: 'eq', col: 'is_repeat_buyer', val: true });

  if (filters.payment !== 'all')
    ops.push({ kind: 'eq', col: 'payment_profile', val: filters.payment });

  switch (filters.activity) {
    case 'active': ops.push({ kind: 'lte', col: 'days_since_order', val: 90 }); break;
    // NULL compares as unknown, so "no orders on record" is excluded from every
    // band except its own — the same behaviour the client-side version had.
    case 'inactive': ops.push({ kind: 'gt', col: 'days_since_order', val: 90 }); break;
    case 'cooling': ops.push(
      { kind: 'gt', col: 'days_since_order', val: 90 },
      { kind: 'lte', col: 'days_since_order', val: 180 }); break;
    case 'dormant': ops.push({ kind: 'gt', col: 'days_since_order', val: 180 }); break;
    case 'never': ops.push({ kind: 'is-null', col: 'days_since_order' }); break;
  }

  switch (filters.stage) {
    case 'overdue': ops.push({ kind: 'lt', col: 'next_due_on', val: today }); break;
    case 'today': ops.push({ kind: 'eq', col: 'next_due_on', val: today }); break;
    case 'upcoming': ops.push({ kind: 'gt', col: 'next_due_on', val: today }); break;
    // `attempts` is a count(*) over followups, so it is 0 — never NULL — for a
    // customer nobody has ever called.
    case 'untouched': ops.push(
      { kind: 'is-null', col: 'next_due_on' },
      { kind: 'eq', col: 'attempts', val: 0 }); break;
    case 'closed': ops.push(
      { kind: 'is-null', col: 'next_due_on' },
      { kind: 'gt', col: 'attempts', val: 0 }); break;
  }

  if (filters.outcome !== 'all')
    ops.push({ kind: 'eq', col: 'last_outcome', val: filters.outcome });

  if (filters.owner === 'unassigned') ops.push({ kind: 'is-null', col: 'current_owner_id' });
  else if (filters.owner !== 'all') ops.push({ kind: 'eq', col: 'current_owner_id', val: filters.owner });

  if (filters.dnd === 'exclude') ops.push({ kind: 'eq', col: 'is_dnd', val: false });
  if (filters.dnd === 'only') ops.push({ kind: 'eq', col: 'is_dnd', val: true });

  if (filters.minOrders !== '')
    ops.push({ kind: 'gte', col: 'lifetime_orders', val: Number(filters.minOrders) });
  if (filters.minValue !== '')
    ops.push({ kind: 'gte', col: 'lifetime_value', val: Number(filters.minValue) });

  const q = safeSearch(filters.search);
  if (q) {
    // Digits only for the phone half, so "+91 99458" and "99458" find the same
    // customer — the column is E.164 and holds no spaces or punctuation.
    const digits = q.replace(/\D/g, '');
    const clauses = [`full_name.ilike.%${q}%`];
    if (digits) clauses.push(`phone_e164.ilike.%${digits}%`);
    ops.push({ kind: 'or', expr: clauses.join(',') });
  }

  return ops;
}
