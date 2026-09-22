'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { syncPcrCallingSheet } from '@/lib/sheets/pcr-sync';

export type PcrFollowup = {
  attempt: number;
  raw: string | null;
  occurredOn: string | null;
  handledBy: string | null;
};

export type PcrLead = {
  id: string;
  sourceRowNumber: number;
  bookingDate: string | null;
  customerName: string;
  phoneRaw: string | null;
  phoneE164: string | null;
  ownerId: string | null;
  ownerName: string | null;
  followups: PcrFollowup[];
  followupCount: number;
  lastFollowupOn: string | null;
  lastFollowupSummary: string | null;
  nextFollowupOn: string | null;
  nextFollowupAttempt: number | null;
  priorityRank: number;
  textMessageDate: string | null;
  textMessageStatus: string | null;
  converted: boolean;
  lastSyncedAt: string;
};

export type PcrStatusFilter = 'all' | 'missed' | 'upcoming' | 'completed' | 'converted';

export type PcrLeadResult = {
  rows: PcrLead[];
  total: number;
  nextOffset: number | null;
  syncWarning: boolean;
};

export type PcrAssignee = { id: string; name: string };

type PcrDbRow = {
  id: string;
  source_row_number: number;
  booking_date: string | null;
  customer_name: string;
  phone_raw: string | null;
  phone_e164: string | null;
  owner_id: string | null;
  followups: PcrFollowup[];
  followup_count: number;
  last_followup_on: string | null;
  last_followup_summary: string | null;
  next_followup_on: string | null;
  next_followup_attempt: number | null;
  priority_rank: number;
  text_message_date: string | null;
  text_message_status: string | null;
  converted: boolean;
  last_synced_at: string;
  owner: { full_name: string } | { full_name: string }[] | null;
};

const VIEW_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'sales_exec', 'auditor']);
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function authorize() {
  const db = await createClient();
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) throw new Error('Sign in to view PCR Calling.');
  const { data: profile, error: profileError } = await db
    .from('users')
    .select('role,is_active')
    .eq('id', user.id)
    .single();
  if (profileError || !profile?.is_active || !VIEW_ROLES.has(profile.role)) throw new Error('Access denied.');
  return { db, role: profile.role as string };
}

function safeSearch(value: string) {
  return value.trim().replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
}

function ownerName(owner: PcrDbRow['owner']) {
  if (Array.isArray(owner)) return owner[0]?.full_name ?? null;
  return owner?.full_name ?? null;
}

export async function getPcrLeads(query: {
  search?: string;
  status?: PcrStatusFilter;
  owner?: string;
  offset?: number;
  pageSize?: number;
} = {}): Promise<PcrLeadResult> {
  const { db } = await authorize();
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 50), 1), 100);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = safeSearch(query.search ?? '');
  const status = query.status ?? 'all';
  let syncWarning = false;

  if (offset === 0) {
    try {
      await syncPcrCallingSheet();
    } catch (error) {
      syncWarning = true;
      console.error('[pcr] sheet sync failed', { error });
    }
  }

  let request = db
    .from('pcr_leads')
    .select('id,source_row_number,booking_date,customer_name,phone_raw,phone_e164,owner_id,followups,followup_count,last_followup_on,last_followup_summary,next_followup_on,next_followup_attempt,priority_rank,text_message_date,text_message_status,converted,last_synced_at,owner:users!pcr_leads_owner_id_fkey(full_name)', { count: 'exact' })
    .eq('is_active', true)
    .order('priority_rank', { ascending: true })
    .order('booking_date', { ascending: false, nullsFirst: false })
    .order('source_row_number', { ascending: false })
    .range(offset, offset + pageSize);

  if (status === 'missed') request = request.eq('priority_rank', 0);
  else if (status === 'upcoming') request = request.eq('priority_rank', 1);
  else if (status === 'completed') request = request.eq('priority_rank', 3);
  else if (status === 'converted') request = request.eq('converted', true);
  if (query.owner === 'unassigned') request = request.is('owner_id', null);
  else if (query.owner && UUID.test(query.owner)) request = request.eq('owner_id', query.owner);
  if (search) request = request.or(`customer_name.ilike.%${search}%,phone_raw.ilike.%${search}%,phone_e164.ilike.%${search}%,last_followup_summary.ilike.%${search}%`);

  const { data, count, error } = await request;
  if (error) throw new Error('Could not load PCR Calling leads.');
  const page = (data ?? []) as unknown as PcrDbRow[];
  const hasMore = page.length > pageSize;
  const visible = hasMore ? page.slice(0, pageSize) : page;

  return {
    rows: visible.map(row => ({
      id: row.id,
      sourceRowNumber: row.source_row_number,
      bookingDate: row.booking_date,
      customerName: row.customer_name,
      phoneRaw: row.phone_raw,
      phoneE164: row.phone_e164,
      ownerId: row.owner_id,
      ownerName: ownerName(row.owner),
      followups: row.followups ?? [],
      followupCount: row.followup_count,
      lastFollowupOn: row.last_followup_on,
      lastFollowupSummary: row.last_followup_summary,
      nextFollowupOn: row.next_followup_on,
      nextFollowupAttempt: row.next_followup_attempt,
      priorityRank: row.priority_rank,
      textMessageDate: row.text_message_date,
      textMessageStatus: row.text_message_status,
      converted: row.converted,
      lastSyncedAt: row.last_synced_at,
    })),
    total: count ?? visible.length,
    nextOffset: hasMore ? offset + pageSize : null,
    syncWarning,
  };
}

export async function getPcrAssignees(): Promise<PcrAssignee[]> {
  const { db, role } = await authorize();
  if (!ASSIGN_ROLES.has(role)) return [];
  const { data, error } = await db
    .from('users')
    .select('id,full_name')
    .eq('is_active', true)
    .in('role', ['sales_exec', 'sales_manager'])
    .order('full_name');
  if (error) throw new Error('Could not load the sales team.');
  return (data ?? []).map(row => ({ id: row.id, name: row.full_name }));
}

export async function assignPcrLeads(input: { leadIds: string[]; ownerId: string }) {
  const { db, role } = await authorize();
  if (!ASSIGN_ROLES.has(role)) throw new Error('You do not have permission to assign PCR leads.');
  const leadIds = [...new Set(input.leadIds)].filter(id => UUID.test(id));
  if (!UUID.test(input.ownerId) || !leadIds.length || leadIds.length !== input.leadIds.length || leadIds.length > 100) {
    throw new Error('Choose a salesperson and 1 to 100 valid PCR leads.');
  }
  const { data, error } = await db.rpc('fn_assign_pcr_leads', {
    p_lead_ids: leadIds,
    p_owner_id: input.ownerId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/leads/pcr');
  return { assigned: Number(data ?? 0) };
}
