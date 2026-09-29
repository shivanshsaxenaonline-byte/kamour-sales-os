// Who to ring first, in one vocabulary for every RRR calling list.
//
// Measured on the calls of 1–21 Sep 2026 (423 customers, their orders read off
// the Medicine Order sheet as well as the app): a customer whose last order was
// within 75 days ordered again 18% of the time after an RRR call; one whose
// last order was older ordered 0.9% of the time, and past 180 days one order of
// Rs 500 came out of about 650 calls. So the lists are ranked by how recently
// the customer bought, and past 180 days they are not a call at all.

import { daysBetween, istDateFromTimestamp } from './format';

/** Past this many days since the last order a customer is not on any RRR
 *  calling list. Must agree with v_max_age in fn_generate_ai_daily_leads. */
export const MAX_DAYS_SINCE_ORDER = 180;

export type Priority = 'p1' | 'p2' | 'p3' | 'cold';

export const PRIORITY_META: Record<Priority, { label: string; tone: string; rank: number }> = {
  p1: { label: 'P1', tone: 'positive', rank: 0 },
  p2: { label: 'P2', tone: 'attention', rank: 1 },
  p3: { label: 'P3', tone: 'neutral', rank: 2 },
  cold: { label: 'Cold', tone: 'dashed', rank: 3 },
};

/** The outcomes where the customer gave us a date to ring back on. 3 of the 7
 *  who said "will buy" in September ordered. */
const PROMISES = new Set(['will_buy', 'medicine_not_finished']);

export const isPromise = (outcome: string | null | undefined) => PROMISES.has(outcome ?? '');

/** Whole IST days since the last order, or null for a customer with none. */
export const daysSinceOrder = (lastOrderAt: string | null, today: string) =>
  lastOrderAt ? daysBetween(istDateFromTimestamp(lastOrderAt), today) : null;

/** A customer who bought, but longer ago than any list should reach. Nobody
 *  who never ordered is "too old": those are WATI and consultation leads, and
 *  they are judged on their own lists. */
export const isPastRrrWindow = (lastOrderAt: string | null, today: string) => {
  const days = daysSinceOrder(lastOrderAt, today);
  return days != null && days > MAX_DAYS_SINCE_ORDER;
};

/** The earliest last-order instant still inside the window, for filtering in
 *  the database: `last_order_at >= rrrWindowStart(today)`. */
export const rrrWindowStart = (today: string) => {
  const from = new Date(`${today}T00:00:00+05:30`).getTime() - MAX_DAYS_SINCE_ORDER * 86_400_000;
  return new Date(from).toISOString();
};

/**
 * P1: the order moment — 10 to 20 days after the last order (a 15-day course
 *     running out; 23% ordered), or a customer who gave us a date to call back.
 * P2: bought within 75 days (13–23%).
 * P3: 76 to 180 days, but a customer worth one more try: 4+ orders or
 *     Rs 8,000+ lifetime.
 * Cold: everyone else.
 */
export function priorityOf(c: {
  daysSinceOrder: number | null;
  orders: number;
  ltv: number;
  /** They said "will buy", or told us when their medicine runs out. */
  promise?: boolean;
  /** Their course runs out about now (Medicine Ending's action window). */
  courseEnding?: boolean;
}): Priority {
  const d = c.daysSinceOrder;
  if (c.promise) return 'p1';
  if (d == null) return 'cold';
  if (d > MAX_DAYS_SINCE_ORDER) return 'cold';
  if (d <= 75 && c.courseEnding) return 'p1';
  if (d >= 10 && d <= 20) return 'p1';
  if (d <= 75) return 'p2';
  if (c.orders >= 4 || c.ltv >= 8000) return 'p3';
  return 'cold';
}

/** `rows` with P1 first, then P2, P3, Cold. Stable, so each list's own order
 *  (most overdue, ending soonest, due date…) still decides within a tier. */
export function sortByPriority<T>(rows: T[], pick: (row: T) => Priority): T[] {
  return [...rows].sort((a, b) => PRIORITY_META[pick(a)].rank - PRIORITY_META[pick(b)].rank);
}

/** The Sort dropdown's entry for this order. */
export const PRIORITY_SORT = { value: 'priority', label: 'P1 → P2 → P3 (default)' };
