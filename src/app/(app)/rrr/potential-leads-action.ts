'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function markPotentialLead(input: {
  workId?: string | null;
  watiWorkId?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const workId = input.workId ?? null;
  const watiWorkId = input.watiWorkId ?? null;
  if (!!workId === !!watiWorkId) return { ok: false, error: 'Choose one lead to mark.' };
  if (workId && !UUID.test(workId)) return { ok: false, error: 'Invalid lead.' };
  if (watiWorkId && !UUID.test(watiWorkId)) return { ok: false, error: 'Invalid lead.' };

  const db = await createClient();
  const { data, error } = await db.rpc('fn_mark_potential_lead', {
    p_rrr_work_id: workId,
    p_wati_work_id: watiWorkId,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/rrr/my');
  return { ok: true, id: String(data) };
}

export async function removePotentialLead(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID.test(id)) return { ok: false, error: 'Invalid potential lead.' };

  const db = await createClient();
  const { error } = await db.rpc('fn_remove_potential_lead', {
    p_potential_id: id,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/rrr/my');
  return { ok: true };
}
