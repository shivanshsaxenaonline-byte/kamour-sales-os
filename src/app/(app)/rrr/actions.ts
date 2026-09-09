'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

/**
 * Assign a batch of RRR customers to a salesperson, or back to the unassigned
 * pool when `ownerId` is null.
 *
 * Permission is NOT decided here. This calls `fn_assign_rrr_customers`, which
 * checks the caller's role in the database, so a crafted PostgREST call cannot
 * route around this file. The UI hides the controls from roles that cannot
 * assign; the database is what actually enforces it.
 */
export async function assignRrr(
  customerIds: string[],
  ownerId: string | null,
): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  if (!customerIds.length) return { ok: false, error: 'Select at least one customer.' };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_assign_rrr_customers', {
    p_customer_ids: customerIds,
    p_owner_id: ownerId,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath('/rrr');
  return { ok: true, moved: data ?? 0 };
}
