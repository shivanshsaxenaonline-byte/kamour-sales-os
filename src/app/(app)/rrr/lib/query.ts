// Reading the RRR list from the database.
//
// One place that knows how a Filters object becomes a bounded range query, so
// the screen and the select-all action cannot drift into asking two different
// questions and disagreeing about what "matching" means.

import type { createClient } from '@/lib/supabase/server';
import { PAGE_SIZE, filterOps, orderFor, type FilterOp, type Filters } from './filters';

type Db = Awaited<ReturnType<typeof createClient>>;

// One literal, not a concatenation: supabase-js infers the row type from the
// select string, and a built-up string erases that back to a generic error type.
export const RRR_COLUMNS = 'customer_id, full_name, phone_e164, lifetime_orders, lifetime_value, aov, is_repeat_buyer, last_order_on, days_since_order, payment_profile, current_owner_id, owner_name, is_dnd, attempts, last_contacted_on, last_outcome, next_due_on, open_followup_id, last_order_id, last_order_source';

/** The four things only a lead the generator picked has, in front of the rest. */
export const AI_COLUMNS = `run_on, rank, bucket, bucket_label, priority_score, reason, ai_owner_id, ai_owner_name, ${RRR_COLUMNS}`;

/** PostgREST's filter builder, narrowed to the methods this file uses. Written
 *  structurally rather than imported, because the concrete generic changes with
 *  every `.select()` and pinning it here would fight supabase-js's inference. */
type Buildable<Q> = Q & {
  eq(col: string, val: unknown): Buildable<Q>;
  gt(col: string, val: unknown): Buildable<Q>;
  gte(col: string, val: unknown): Buildable<Q>;
  lt(col: string, val: unknown): Buildable<Q>;
  lte(col: string, val: unknown): Buildable<Q>;
  is(col: string, val: null): Buildable<Q>;
  or(expr: string): Buildable<Q>;
};

/** Apply every condition to a query. Kept separate from filterOps() so the
 *  translation stays testable as plain data. */
export function applyOps<Q>(query: Buildable<Q>, ops: FilterOp[]): Buildable<Q> {
  let q = query;
  for (const op of ops) {
    switch (op.kind) {
      case 'eq': q = q.eq(op.col, op.val); break;
      case 'gt': q = q.gt(op.col, op.val); break;
      case 'gte': q = q.gte(op.col, op.val); break;
      case 'lt': q = q.lt(op.col, op.val); break;
      case 'lte': q = q.lte(op.col, op.val); break;
      case 'is-null': q = q.is(op.col, null); break;
      case 'or': q = q.or(op.expr); break;
    }
  }
  return q;
}

type Ordered = {
  order(col: string, opts: { ascending: boolean; nullsFirst: boolean }): Ordered;
  range(from: number, to: number): PromiseLike<unknown>;
};

export function applyOrder(query: Ordered, filters: Filters): Ordered {
  let q = query;
  for (const o of orderFor(filters)) {
    q = q.order(o.col, { ascending: o.ascending, nullsFirst: o.nullsFirst });
  }
  return q;
}

/**
 * One page of the All-customers list, plus how many rows the filter matched in
 * total.
 *
 * `count: 'exact'` rides along on the same request as the rows, so the footer's
 * "1–50 of 1,336" costs no extra round trip. RLS decides which customers are
 * in scope — a sales exec's count is their own book, not the whole base.
 */
export async function fetchRrrPage(db: Db, filters: Filters, today: string, page: number) {
  const from = (page - 1) * PAGE_SIZE;
  const base = db.from('v_rrr_queue').select(RRR_COLUMNS, { count: 'exact' });
  const filtered = applyOps(
    base as unknown as Buildable<unknown>,
    filterOps(filters, today),
  );
  const result = await applyOrder(filtered as unknown as Ordered, filters)
    .range(from, from + PAGE_SIZE - 1);
  const { data, count, error } = result as {
    data: unknown[] | null;
    count: number | null;
    error: { message: string } | null;
  };
  return { rows: data ?? [], count: count ?? 0, error };
}

/**
 * Every customer id the current filter matches — nothing else.
 *
 * This is what makes "select all 558 matching" possible without the screen
 * having downloaded 558 rows: one id column instead of twenty, fetched only
 * when the button is actually pressed. Measured at 58 KB for the unfiltered
 * 1,336, against 726 KB for the full rows the screen used to load every time.
 *
 * PostgREST caps a response at 1,000 rows, so it is read in pages and stitched.
 * The ceiling degrades instead of hanging if the base ever explodes.
 */
export async function fetchRrrIds(db: Db, filters: Filters, today: string) {
  const PAGE = 1000;
  const MAX_PAGES = 20;
  const ids: string[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const base = db.from('v_rrr_queue').select('customer_id');
    const filtered = applyOps(
      base as unknown as Buildable<unknown>,
      filterOps(filters, today),
    );
    const result = await applyOrder(filtered as unknown as Ordered, filters)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const { data, error } = result as {
      data: { customer_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) return { ids, error };
    ids.push(...(data ?? []).map((r) => r.customer_id));
    if (!data || data.length < PAGE) break;
  }

  return { ids, error: null };
}
