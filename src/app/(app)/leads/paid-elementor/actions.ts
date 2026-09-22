'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

export type PaidElementorLead = {
  payment_id: string;
  paid_at: string;
  customer_id: string;
  full_name: string;
  phone: string;
  lead_id: string;
  lead_status: string;
  salesperson: string | null;
  connection_status: string;
  lead_insight: string | null;
};

export type PaidElementorAssignee = { id: string; name: string };

export type PaidElementorResult = {
  rows: PaidElementorLead[];
  nextOffset: number | null;
};

export type PaidElementorQuery = {
  search?: string;
  start?: string;
  end?: string;
  offset?: number;
  pageSize?: number;
};

export type PaidElementorLeadDetail = {
  payment: { id: string; paid_at: string; amount: number };
  customer: { full_name: string; phone: string; alternate_phone: string | null; email: string | null; age: number | null; gender: string | null; state: string | null; address: string | null };
  lead: { created_at: string; source: string | null; status: string | null; concern: string | null; salesperson: string | null; connection_status: string; connection_at: string | null; insight: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null };
  followups: { due_at: string; completed_at: string | null; salesperson: string | null; outcome: string | null; remark: string | null; attempt_no: number }[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VIEW_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'sales_exec', 'auditor']);
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'auditor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTION_LABELS: Record<string, string> = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  wrong_number: 'Wrong number',
  not_interested: 'Not interested',
  will_buy: 'Will buy',
  order_placed: 'Order placed',
  medicine_not_finished: 'Medicine not finished',
  will_update_later: 'Will update later',
};
function queryFailure(step: string, message: string, error: unknown): never {
  console.error('[paid-elementor] query failed', { step, error });
  throw new Error(message);
}

async function getAuthenticatedClients(signInMessage: string) {
  const db = await createClient();
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError) queryFailure('auth', signInMessage, authError);
  if (!user) throw new Error(signInMessage);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Payment verification is not configured.');
  const paymentsDb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { db, paymentsDb, userId: user.id };
}

async function getAuthorizedClients(signInMessage: string) {
  const clients = await getAuthenticatedClients(signInMessage);
  const { paymentsDb, userId } = clients;
  const { data: profile, error: profileError } = await paymentsDb
    .from('users')
    .select('role,is_active')
    .eq('id', userId)
    .single();
  if (profileError) queryFailure('profile', 'Could not verify access to paid leads.', profileError);
  if (!profile?.is_active || !VIEW_ROLES.has(profile.role)) throw new Error('Access denied.');

  return clients;
}

export async function getPaidElementorLeads(query: PaidElementorQuery = {}): Promise<PaidElementorResult> {
  const { paymentsDb, userId } = await getAuthenticatedClients('Sign in to view paid leads.');
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 100), 1), 100);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = (query.search ?? '').trim().toLowerCase();
  const start = DAY.test(query.start ?? '') ? query.start! : null;
  const end = DAY.test(query.end ?? '') ? query.end! : null;
  if (start && end && start > end) throw new Error('Start date must be on or before end date.');

  const { data, error } = await paymentsDb.rpc('list_paid_elementor_leads', {
    p_viewer_id: userId,
    p_start: start,
    p_end: end,
    p_search: search || null,
    p_offset: offset,
    p_limit: pageSize + 1,
  });
  if (error) queryFailure('list', 'Could not load paid Elementor leads.', error);

  const page = (data ?? []) as PaidElementorLead[];
  const hasMore = page.length > pageSize;
  return {
    rows: hasMore ? page.slice(0, pageSize) : page,
    nextOffset: hasMore ? offset + pageSize : null,
  };
}

export async function getPaidElementorAssignees(): Promise<PaidElementorAssignee[]> {
  const { paymentsDb, userId } = await getAuthenticatedClients('Sign in to view paid leads.');
  const { data: profile, error: profileError } = await paymentsDb
    .from('users')
    .select('role,is_active')
    .eq('id', userId)
    .single();
  if (profileError) queryFailure('assignee-profile', 'Could not verify paid lead assignment access.', profileError);
  if (!profile?.is_active || !ASSIGN_ROLES.has(profile.role)) return [];

  const { data, error } = await paymentsDb
    .from('users')
    .select('id,full_name')
    .eq('is_active', true)
    .in('role', ['sales_exec', 'sales_manager'])
    .order('full_name');
  if (error) queryFailure('assignees', 'Could not load the sales team.', error);
  return (data ?? []).map(row => ({ id: row.id, name: row.full_name }));
}

export async function assignPaidElementorLeads(input: { leadIds: string[]; ownerId: string }) {
  const { db, paymentsDb, userId } = await getAuthenticatedClients('Sign in to assign paid leads.');
  const { data: profile, error: profileError } = await paymentsDb
    .from('users')
    .select('role,is_active')
    .eq('id', userId)
    .single();
  if (profileError) queryFailure('assign-profile', 'Could not verify paid lead assignment access.', profileError);
  if (!profile?.is_active || !ASSIGN_ROLES.has(profile.role)) throw new Error('You do not have permission to assign paid leads.');

  const leadIds = [...new Set(input.leadIds)].filter(id => UUID.test(id));
  if (!UUID.test(input.ownerId) || !leadIds.length || leadIds.length !== input.leadIds.length || leadIds.length > 100) {
    throw new Error('Choose a salesperson and 1 to 100 valid paid leads.');
  }

  const { data, error } = await db.rpc('fn_assign_paid_elementor_leads', {
    p_lead_ids: leadIds,
    p_owner_id: input.ownerId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/leads/paid-elementor');
  return { assigned: Number(data ?? 0) };
}

export async function getPaidElementorLeadDetail(input: { leadId: string; paymentId: string }): Promise<PaidElementorLeadDetail> {
  const { db, paymentsDb } = await getAuthorizedClients('Sign in to view paid lead details.');

  const { data: lead, error: leadError } = await db.from('leads').select('id,customer_id,source_id,status_id,concern_id,owner_id,created_at,first_contacted_at,utm_source,utm_medium,utm_campaign,zoho_connection_status,zoho_lead_insight,zoho_contacted_person').eq('id', input.leadId).eq('channel','zoho_legacy').eq('is_junk', false).single();
  if (leadError || !lead) queryFailure('lead-detail', 'This Zoho CRM lead is not available to you.', leadError);
  const { data: customer, error: customerError } = await paymentsDb.from('customers').select('id,full_name,phone_e164,alt_phone_e164,email,age,gender,state,address').eq('id', lead.customer_id).single();
  if (customerError || !customer) queryFailure('customer-detail', 'Could not load customer details.', customerError);
  const { data: payment, error: paymentError } = await paymentsDb.from('razorpay_payments').select('id,phone_e164,paid_at,amount').eq('id', input.paymentId).eq('phone_e164', customer.phone_e164).eq('currency','INR').eq('amount',99).eq('status','captured').lt('amount_refunded',99).single();
  if (paymentError || !payment) queryFailure('payment-detail', 'This payment no longer matches the lead.', paymentError);
  const [lookups, followupResult] = await Promise.all([
    Promise.all([
      db.from('lead_sources').select('label_en').eq('id', lead.source_id).single(),
      db.from('lead_statuses').select('label_en').eq('id', lead.status_id).single(),
      lead.concern_id ? db.from('concerns').select('label_en').eq('id', lead.concern_id).single() : Promise.resolve({ data: null }),
    ]),
    db.from('followups').select('due_at,completed_at,owner_id,outcome,remark,attempt_no').eq('lead_id', lead.id).eq('kind','lead').order('attempt_no').range(0, 99),
  ]);
  if (followupResult.error) queryFailure('followup-detail', 'Could not load lead follow-ups.', followupResult.error);
  const ownerIds = [...new Set([lead.owner_id, ...(followupResult.data ?? []).map(followup => followup.owner_id)].filter((id): id is string => !!id))];
  const { data: owners, error: ownersError } = ownerIds.length ? await paymentsDb.from('users').select('id,full_name').in('id', ownerIds) : { data: [], error: null };
  if (ownersError) queryFailure('salespeople', 'Could not load salespeople.', ownersError);
  const ownerById = new Map((owners ?? []).map(owner => [owner.id, owner.full_name]));
  const latestFollowup = [...(followupResult.data ?? [])].sort((a,b) => (b.completed_at ?? b.due_at).localeCompare(a.completed_at ?? a.due_at))[0];
  const connection = lead.zoho_connection_status ?? (latestFollowup?.outcome ? CONNECTION_LABELS[latestFollowup.outcome] ?? latestFollowup.outcome : lead.first_contacted_at ? 'Connected' : 'Needs follow-up');

  return {
    payment: { id: payment.id, paid_at: payment.paid_at, amount: Number(payment.amount) },
    customer: { full_name: customer.full_name, phone: customer.phone_e164, alternate_phone: customer.alt_phone_e164, email: customer.email, age: customer.age, gender: customer.gender, state: customer.state, address: customer.address },
    lead: {
      created_at: lead.created_at,
      source: lookups[0].data?.label_en ?? null,
      status: lookups[1].data?.label_en ?? null,
      concern: lookups[2].data?.label_en ?? null,
      salesperson: lead.zoho_contacted_person ?? (lead.owner_id ? ownerById.get(lead.owner_id) ?? null : null),
      connection_status: connection,
      connection_at: lead.first_contacted_at,
      insight: lead.zoho_lead_insight ?? latestFollowup?.remark ?? null,
      utm_source: lead.utm_source,
      utm_medium: lead.utm_medium,
      utm_campaign: lead.utm_campaign,
    },
    followups: (followupResult.data ?? []).map(followup => ({ ...followup, salesperson: followup.owner_id ? ownerById.get(followup.owner_id) ?? null : null })),
  };
}
