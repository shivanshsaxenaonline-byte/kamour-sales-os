'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

/**
 * Assign a batch of RRR customers to a salesperson, or back to the unassigned
 * pool when `ownerId` is null.
 *
 * Both halves of a handover, because half of one reaches nobody. Until now
 * this moved `current_owner_id` alone, and since the 14 September cutover a
 * rep's day is `rrr_work_items` — owning a customer shows them nothing. So the
 * same tick-and-assign now also hands over the calling task, the way Due today
 * and AI Leads already do, and putting a customer back in the pool withdraws
 * the task with them.
 *
 * Permission is NOT decided here. This calls `fn_assign_rrr_customers_with_work`,
 * whose two halves each check the caller's role in the database, so a crafted
 * PostgREST call cannot route around this file. The UI hides the controls from
 * roles that cannot assign; the database is what actually enforces it.
 */
export async function assignRrr(
  customerIds: string[],
  ownerId: string | null,
): Promise<
  | { ok: true; moved: number; tasks: number; skipped: number }
  | { ok: false; error: string }
> {
  if (!customerIds.length) return { ok: false, error: 'Select at least one customer.' };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_assign_rrr_customers_with_work', {
    p_customer_ids: customerIds,
    p_owner_id: ownerId,
  });

  if (error) return { ok: false, error: error.message };

  const result = (data ?? {}) as { owned?: number; tasks?: number; skipped?: number };
  revalidatePath('/rrr');
  revalidatePath('/rrr/due');
  revalidatePath('/rrr/my');
  return {
    ok: true,
    moved: result.owned ?? 0,
    tasks: result.tasks ?? 0,
    skipped: result.skipped ?? 0,
  };
}

/** Assign a calling task without changing permanent customer ownership. */
export async function assignRrrWork(
  source: 'ai' | 'medicine_ending' | 'due',
  ids: string[],
  ownerId: string | null,
): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  if (!ids.length) return { ok: false, error: 'Select at least one lead.' };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_assign_rrr_work', {
    p_source: source,
    p_ids: ids,
    p_owner_id: ownerId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/rrr/ai');
  revalidatePath('/rrr/medicine-ending');
  revalidatePath('/rrr/due');
  revalidatePath('/rrr/my');
  return { ok: true, moved: data ?? 0 };
}
