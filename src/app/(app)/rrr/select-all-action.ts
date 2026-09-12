'use server';

import { createClient } from '@/lib/supabase/server';
import { istToday } from './lib/format';
import { parseFilters, type QueryParams } from './lib/filters';
import { fetchRrrIds } from './lib/query';

/** Assigning is a batch operation, not a bulk-import. A number this size means
 *  a filter went wrong, and sending it on would be a very slow surprise. */
const MAX_SELECTION = 5000;

/**
 * Every customer id the current filter matches.
 *
 * The screen only ever holds the fifty rows it is showing, so "select all 558"
 * cannot be answered from what is already in the browser. Rather than go back
 * to shipping the whole base on every page load just so this one button works,
 * the question is asked when the button is pressed, and only the id column
 * comes back — 58 KB for the unfiltered 1,336, against the 726 KB of full rows
 * the screen used to load every single time.
 *
 * The filter arrives as raw URL params and is re-parsed here rather than
 * trusted: parseFilters() validates every value against the fixed set of
 * options that produced it, so a hand-edited request cannot reach the query
 * builder with something the UI could not have generated. RLS still decides
 * which customers are in scope, so a sales exec's "all matching" is their own
 * book — the same rows the list itself would have shown them.
 */
export async function resolveMatchingIds(
  params: QueryParams,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { ok: false, error: 'Your session expired. Sign in again.' };

  const { ids, error } = await fetchRrrIds(db, parseFilters(params), istToday());
  if (error) return { ok: false, error: error.message };

  if (ids.length > MAX_SELECTION)
    return {
      ok: false,
      error: `That filter matches ${ids.length.toLocaleString('en-IN')} customers — narrow it below ${MAX_SELECTION.toLocaleString('en-IN')} before selecting them all.`,
    };

  return { ok: true, ids };
}
