'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type PocFollowup = { attempt: number; raw: string | null; occurredOn: string | null };

export type PocLead = {
  id: string;
  sourceRowNumber: number;
  recordNo: string | null;
  paymentDate: string | null;
  consultationDate: string | null;
  customerName: string;
  phoneRaw: string | null;
  phoneE164: string | null;
  consultationStatus: string | null;
  doctorName: string | null;
  consultationTakenBy: string | null;
  prescriptionStatus: string;
  customerType: string | null;
  age: number | null;
  profession: string | null;
  state: string | null;
  concern: string | null;
  medicineRemark: string | null;
  conversionType: string | null;
  amount: string | null;
  paymentMethod: string | null;
  leadSource: string | null;
  joinedBy: string | null;
  consultationMode: string | null;
  cartLink: string | null;
  cartValue: string | null;
  medicinePurchased: string;
  savedInCrmBy: string | null;
  medicineNatureStatus: string | null;
  followups: PocFollowup[];
  followupCount: number;
  lastFollowupOn: string | null;
  lastFollowupSummary: string | null;
  ownerId: string | null;
  ownerName: string | null;
  sourceSnapshot: Record<string, string>;
  lastSyncedAt: string;
};

export type PocLeadResult = { rows: PocLead[]; total: number; nextOffset: number | null };
export type PocOwner = { id: string; name: string };

type DbRow = {
  id: string; source_row_number: number; record_no: string | null; payment_date: string | null;
  consultation_date: string | null; customer_name: string; phone_raw: string | null; phone_e164: string | null;
  consultation_status: string | null; doctor_name: string | null; consultation_taken_by: string | null;
  prescription_status: string; customer_type: string | null; age: number | null; profession: string | null;
  state: string | null; concern: string | null; medicine_remark: string | null; conversion_type: string | null;
  amount: string | null; payment_method: string | null; lead_source: string | null; joined_by: string | null;
  consultation_mode: string | null; cart_link: string | null; cart_value: string | null; medicine_purchased: string;
  saved_in_crm_by: string | null; medicine_nature_status: string | null; followups: PocFollowup[];
  followup_count: number; last_followup_on: string | null; last_followup_summary: string | null;
  owner_id: string | null; source_snapshot: Record<string, string>; last_synced_at: string;
  owner: { full_name: string } | { full_name: string }[] | null;
};

const VIEW_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'sales_exec', 'auditor']);
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function authorize() {
  const db = await createClient();
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) throw new Error('Sign in to view POC leads.');
  const { data: profile, error } = await db.from('users').select('role,is_active').eq('id', user.id).single();
  if (error || !profile?.is_active || !VIEW_ROLES.has(profile.role)) throw new Error('Access denied.');
  return { db, role: profile.role as string };
}

function safeSearch(value: string) {
  return value.trim().replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
}

function ownerName(owner: DbRow['owner']) {
  if (Array.isArray(owner)) return owner[0]?.full_name ?? null;
  return owner?.full_name ?? null;
}

export async function getPocLeads(query: { search?: string; owner?: string; offset?: number; pageSize?: number } = {}): Promise<PocLeadResult> {
  const { db } = await authorize();
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 50), 1), 100);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = safeSearch(query.search ?? '');
  let request = db
    .from('poc_leads')
    .select('id,source_row_number,record_no,payment_date,consultation_date,customer_name,phone_raw,phone_e164,consultation_status,doctor_name,consultation_taken_by,prescription_status,customer_type,age,profession,state,concern,medicine_remark,conversion_type,amount,payment_method,lead_source,joined_by,consultation_mode,cart_link,cart_value,medicine_purchased,saved_in_crm_by,medicine_nature_status,followups,followup_count,last_followup_on,last_followup_summary,owner_id,source_snapshot,last_synced_at,owner:users!poc_leads_owner_id_fkey(full_name)', { count: 'exact' })
    .eq('is_active', true)
    .order('consultation_date', { ascending: false, nullsFirst: false })
    .order('payment_date', { ascending: false, nullsFirst: false })
    .order('source_row_number', { ascending: false })
    .range(offset, offset + pageSize);
  if (query.owner === 'unassigned') request = request.is('owner_id', null);
  else if (query.owner && UUID.test(query.owner)) request = request.eq('owner_id', query.owner);
  if (search) request = request.or(`customer_name.ilike.%${search}%,phone_raw.ilike.%${search}%,phone_e164.ilike.%${search}%,doctor_name.ilike.%${search}%,medicine_remark.ilike.%${search}%`);

  const { data, count, error } = await request;
  if (error) throw new Error('Could not load POC leads.');
  const page = (data ?? []) as unknown as DbRow[];
  const hasMore = page.length > pageSize;
  const visible = hasMore ? page.slice(0, pageSize) : page;
  return {
    rows: visible.map(row => ({
      id: row.id, sourceRowNumber: row.source_row_number, recordNo: row.record_no,
      paymentDate: row.payment_date, consultationDate: row.consultation_date,
      customerName: row.customer_name, phoneRaw: row.phone_raw, phoneE164: row.phone_e164,
      consultationStatus: row.consultation_status, doctorName: row.doctor_name,
      consultationTakenBy: row.consultation_taken_by, prescriptionStatus: row.prescription_status,
      customerType: row.customer_type, age: row.age, profession: row.profession, state: row.state,
      concern: row.concern, medicineRemark: row.medicine_remark, conversionType: row.conversion_type,
      amount: row.amount, paymentMethod: row.payment_method, leadSource: row.lead_source,
      joinedBy: row.joined_by, consultationMode: row.consultation_mode, cartLink: row.cart_link,
      cartValue: row.cart_value, medicinePurchased: row.medicine_purchased,
      savedInCrmBy: row.saved_in_crm_by, medicineNatureStatus: row.medicine_nature_status,
      followups: row.followups ?? [], followupCount: row.followup_count,
      lastFollowupOn: row.last_followup_on, lastFollowupSummary: row.last_followup_summary,
      ownerId: row.owner_id, ownerName: ownerName(row.owner), sourceSnapshot: row.source_snapshot ?? {},
      lastSyncedAt: row.last_synced_at,
    })),
    total: count ?? visible.length,
    nextOffset: hasMore ? offset + pageSize : null,
  };
}

export async function getPocOwners(): Promise<PocOwner[]> {
  const { db, role } = await authorize();
  if (!ASSIGN_ROLES.has(role)) return [];
  const { data, error } = await db.from('users').select('id,full_name').eq('is_active', true).in('role', ['sales_exec', 'sales_manager']).order('full_name');
  if (error) throw new Error('Could not load POC owners.');
  return (data ?? []).map(row => ({ id: row.id, name: row.full_name }));
}

export async function assignPocLeads(input: { leadIds: string[]; ownerId: string }) {
  const { db, role } = await authorize();
  if (!ASSIGN_ROLES.has(role)) throw new Error('You do not have permission to assign POC leads.');
  const leadIds = [...new Set(input.leadIds)].filter(id => UUID.test(id));
  if (!UUID.test(input.ownerId) || !leadIds.length || leadIds.length !== input.leadIds.length || leadIds.length > 100) {
    throw new Error('Choose a salesperson and 1 to 100 valid POC leads.');
  }
  const { data, error } = await db.rpc('fn_assign_poc_leads', {
    p_lead_ids: leadIds,
    p_owner_id: input.ownerId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/leads/poc');
  return { assigned: Number(data ?? 0) };
}
