'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js';

export type WatiInterestedLead = {
  id: string;
  displayName: string;
  phone: string;
  assignedTo: string | null;
  markedBy: string;
  potentialAt: string;
  source: string;
  intentScore: number | null;
  primaryConcern: string | null;
  summary: string | null;
  nextAction: string | null;
  lastInboundAt: string | null;
  replyWindowExpiredAt: string | null;
  /** The dashboard-side hand-over, when this lead has one. Present means the
   *  lead is tagged WATI Interested on the rep's own call list. */
  work: {
    rep: string;
    assignedAt: string;
    lastOutcome: string | null;
    lastCalledAt: string | null;
    completed: boolean;
  } | null;
  /** What our own order book knows about this number. Null means the number
   *  has never bought — the ordinary case for an interested chat. */
  orders: WatiLeadOrders | null;
};

/**
 * A WhatsApp lead seen from the order book's side.
 *
 * The two systems only ever agreed through the phone number, and nothing on
 * this page read the order side of it: a lead who had already bought looked
 * exactly like a lead who never had. Three of the fourteen handed out so far
 * were customers who had ordered days before somebody dealt them as a fresh
 * prospect, and nobody could see it from here.
 */
export type WatiLeadOrders = {
  customerId: string;
  /** The golden record's name, which is often not the WhatsApp profile name. */
  fullName: string;
  lifetimeOrders: number;
  lifetimeValue: number;
  /** Orders placed since the chat was marked Interested. Above zero is the
   *  conversion this page exists to produce. */
  ordersSinceInterest: number;
  lastOrder: {
    orderNo: string;
    stage: string;
    paymentState: string;
    amount: number;
    courseDays: number | null;
    placedAt: string;
    owner: string | null;
    /** Placed after the chat was marked Interested. */
    afterInterest: boolean;
  } | null;
};

export type WatiInterestedResult = {
  rows: WatiInterestedLead[];
  total: number;
  nextOffset: number | null;
};

export type WatiInterestedQuery = {
  search?: string;
  offset?: number;
  pageSize?: number;
};

/** The three salespeople who work WhatsApp leads. One login id, two addresses:
 *  WATI runs its own directory on its own domain, this dashboard signs people
 *  in as <id>@kamour.local. */
const ASSIGNEES = { ashutosh: 'Ashutosh', shreyansh: 'Shreyansh', tejasv: 'Tejasv' } as const;
export type WatiAssignee = keyof typeof ASSIGNEES;
const watiEmail = (id: WatiAssignee) => `${id}@kamour.internal`;
const dashboardEmail = (id: WatiAssignee) => `${id}@kamour.local`;

type WatiLeadRow = {
  id: string;
  display_name: string | null;
  phone_e164: string;
  source: string | null;
  owner_id: string | null;
  manual_by: string | null;
  manual_at: string | null;
  ai_intent_score: number | null;
  ai_primary_concern: string | null;
  ai_summary: string | null;
  ai_next_action: string | null;
  last_inbound_at: string | null;
  session_expires_at: string | null;
};

const VIEW_ROLES = new Set(['admin', 'ceo', 'coo', 'sales_manager', 'sales_exec', 'auditor']);
// The same four roles fn_assign_wati_work accepts, and the same four
// fn_assign_rrr_work accepts. Offering the control to a role the database will
// refuse is worse than not offering it.
const ASSIGN_ROLES = new Set(['admin', 'ceo', 'coo', 'auditor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(step: string, message: string, error?: unknown): never {
  console.error('[wati-interested] query failed', { step, error });
  throw new Error(message);
}

function externalClient() {
  const url = process.env.WATI_SUPABASE_URL;
  const key = process.env.WATI_SUPABASE_SECRET_KEY;
  if (!url || !key) fail('configuration', 'WATI lead connection is not configured.');
  return createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function authorize() {
  const sessionDb = await createClient();
  const { data: { user }, error: authError } = await sessionDb.auth.getUser();
  if (authError || !user) fail('auth', 'Sign in to view WATI leads.', authError);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('primary-configuration', 'Dashboard access verification is not configured.');
  const primaryDb = createServiceClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await primaryDb
    .from('users')
    .select('role,is_active')
    .eq('id', user.id)
    .single();
  if (profileError) fail('profile', 'Could not verify access to WATI leads.', profileError);
  if (!profile?.is_active || !VIEW_ROLES.has(profile.role)) fail('role', 'Access denied.');
  return { role: profile.role as string, sessionDb, primaryDb };
}

function safeSearch(value: string) {
  return value.trim().replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * The hand-over records this dashboard holds for a page of WATI leads.
 *
 * Read with the service client because the tag has to be visible to everyone
 * who can see the list — an auditor handing leads out needs to see that a lead
 * is already with a rep just as much as an admin does.
 */
async function workByLead(primaryDb: SupabaseClient, leadIds: string[]) {
  if (!leadIds.length) return new Map<string, WatiInterestedLead['work']>();
  const { data, error } = await primaryDb
    .from('wati_work_items')
    .select('wa_lead_id,assigned_to,assigned_at,last_outcome,last_called_at,completed_at')
    .in('wa_lead_id', leadIds)
    .order('assigned_at', { ascending: false });
  // A missing tag is worth a log line, never a blank screen: the leads
  // themselves are what this page is for.
  if (error) {
    console.error('[wati-interested] assignment tags unavailable', { error });
    return new Map<string, WatiInterestedLead['work']>();
  }
  const repIds = [...new Set((data ?? []).map((row) => row.assigned_to as string))];
  const { data: reps } = repIds.length
    ? await primaryDb.from('users').select('id,full_name').in('id', repIds)
    : { data: [] };
  const repName = new Map((reps ?? []).map((rep) => [rep.id as string, rep.full_name as string]));

  const byLead = new Map<string, WatiInterestedLead['work']>();
  // Newest first from the query, so the first row per lead is the live one.
  for (const row of data ?? []) {
    if (byLead.has(row.wa_lead_id as string)) continue;
    byLead.set(row.wa_lead_id as string, {
      rep: repName.get(row.assigned_to as string) ?? 'Salesperson',
      assignedAt: row.assigned_at as string,
      lastOutcome: (row.last_outcome as string | null) ?? null,
      lastCalledAt: (row.last_called_at as string | null) ?? null,
      completed: row.completed_at !== null,
    });
  }
  return byLead;
}

/**
 * WATI's number, in the golden record's own form.
 *
 * Exactly what fn_assign_wati_work does when it looks a lead up, and for the
 * same reason: WATI stores whatever the WhatsApp profile gave it — `919950…`,
 * `+91 99503…`, sometimes with a stray dash — while customers.phone_e164 is
 * always `+91` and ten digits. Matching without this normalisation finds
 * nothing, which reads on screen as "never ordered".
 */
const normalisePhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : null;
};

/**
 * What our order book holds for a page of WhatsApp numbers.
 *
 * Read through the service client for the same reason the hand-over tags are:
 * whoever may see this list needs to see that the person on it has already
 * bought, whatever their own row-level access to the order book happens to be.
 *
 * Keyed by normalised phone rather than by customer id, because the lead side
 * has no customer id to key on — the number is the only thing the two systems
 * share.
 */
async function ordersByPhone(
  primaryDb: SupabaseClient,
  leads: { phone: string; potentialAt: string | null }[],
): Promise<Map<string, WatiLeadOrders>> {
  const found = new Map<string, WatiLeadOrders>();
  const phones = [...new Set(leads.map((lead) => normalisePhone(lead.phone)).filter((p): p is string => !!p))];
  if (!phones.length) return found;

  const { data: customers, error: customerError } = await primaryDb
    .from('customers')
    .select('id,full_name,phone_e164,lifetime_orders,lifetime_value')
    .in('phone_e164', phones)
    .is('merged_into_id', null);
  // An order book we cannot reach is a missing column, not a broken page: the
  // interested leads are what this screen is for, and they come from WATI.
  if (customerError) {
    console.error('[wati-interested] order history unavailable', { error: customerError });
    return found;
  }
  if (!customers?.length) return found;

  const { data: orders, error: orderError } = await primaryDb
    .from('v_orders_list')
    .select('customer_id,order_no,stage,payment_state,amount,course_duration_days,created_at,owner_name')
    .in('customer_id', customers.map((row) => row.id as string))
    .order('created_at', { ascending: false });
  if (orderError) {
    console.error('[wati-interested] orders unavailable', { error: orderError });
  }

  // When the chat was marked Interested, per number — an order counts as this
  // page's own conversion only if it came after that moment.
  const markedAt = new Map<string, string | null>();
  for (const lead of leads) {
    const phone = normalisePhone(lead.phone);
    if (phone && !markedAt.has(phone)) markedAt.set(phone, lead.potentialAt);
  }

  for (const customer of customers) {
    const phone = customer.phone_e164 as string;
    const mine = (orders ?? []).filter((order) => order.customer_id === customer.id);
    const marked = markedAt.get(phone) ?? null;
    const since = marked
      ? mine.filter((order) => (order.created_at as string) >= marked).length
      : 0;
    const latest = mine[0];
    found.set(phone, {
      customerId: customer.id as string,
      fullName: (customer.full_name as string | null) ?? 'Unnamed customer',
      lifetimeOrders: Number(customer.lifetime_orders ?? 0),
      lifetimeValue: Number(customer.lifetime_value ?? 0),
      ordersSinceInterest: since,
      lastOrder: latest
        ? {
          orderNo: latest.order_no as string,
          stage: latest.stage as string,
          paymentState: latest.payment_state as string,
          amount: Number(latest.amount ?? 0),
          courseDays: latest.course_duration_days as number | null,
          placedAt: latest.created_at as string,
          owner: (latest.owner_name as string | null) ?? null,
          afterInterest: !!marked && (latest.created_at as string) >= marked,
        }
        : null,
    });
  }
  return found;
}

export async function getWatiInterestedLeads(query: WatiInterestedQuery = {}): Promise<WatiInterestedResult> {
  const { primaryDb } = await authorize();
  const db = externalClient();
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 50), 1), 100);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const search = safeSearch(query.search ?? '');

  let request = db
    .from('wa_leads')
    .select('id,display_name,phone_e164,source,owner_id,manual_by,manual_at,ai_intent_score,ai_primary_concern,ai_summary,ai_next_action,last_inbound_at,session_expires_at', { count: 'exact' })
    .eq('final_status', 'Potential')
    .eq('is_archived', false)
    .not('session_expires_at', 'is', null)
    .lte('session_expires_at', new Date().toISOString())
    .order('manual_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + pageSize);

  if (search) {
    request = request.or(`display_name.ilike.%${search}%,phone_e164.ilike.%${search}%,source.ilike.%${search}%`);
  }

  const { data, count, error } = await request;
  if (error) fail('leads', 'Could not load WATI Interested leads.', error);
  const page = (data ?? []) as WatiLeadRow[];
  const hasMore = page.length > pageSize;
  const visible = hasMore ? page.slice(0, pageSize) : page;
  const profileIds = [...new Set(visible.flatMap(row => [row.owner_id, row.manual_by]).filter((id): id is string => !!id))];
  const [{ data: profiles, error: profileError }, work, orders] = await Promise.all([
    profileIds.length
      ? db.from('wa_profiles').select('id,full_name,email').in('id', profileIds)
      : Promise.resolve({ data: [], error: null }),
    workByLead(primaryDb, visible.map(row => row.id)),
    ordersByPhone(primaryDb, visible.map(row => ({ phone: row.phone_e164, potentialAt: row.manual_at }))),
  ]);
  if (profileError) fail('profiles', 'Could not load WATI lead owners.', profileError);
  const names = new Map((profiles ?? []).map(profile => [profile.id, profile.full_name || profile.email || 'Unknown user']));

  return {
    rows: visible.map(row => ({
      id: row.id,
      displayName: row.display_name?.trim() || 'Unknown customer',
      phone: row.phone_e164,
      assignedTo: row.owner_id ? names.get(row.owner_id) ?? 'Unknown user' : null,
      markedBy: row.manual_by ? names.get(row.manual_by) ?? 'Unknown user' : 'Unknown user',
      potentialAt: row.manual_at!,
      source: row.source?.trim() || 'Unknown source',
      intentScore: row.ai_intent_score,
      primaryConcern: row.ai_primary_concern,
      summary: row.ai_summary,
      nextAction: row.ai_next_action,
      lastInboundAt: row.last_inbound_at,
      replyWindowExpiredAt: row.session_expires_at,
      work: work.get(row.id) ?? null,
      orders: orders.get(normalisePhone(row.phone_e164) ?? '') ?? null,
    })),
    total: count ?? visible.length,
    nextOffset: hasMore ? offset + pageSize : null,
  };
}

/**
 * Hand interested leads to a salesperson.
 *
 * Two databases have to agree, so the order matters. WATI is updated first
 * because it is the one holding the eligibility rules — it reports back which
 * leads were still in the Interested list, and only those become work here. If
 * the dashboard record then fails, the message says exactly what happened
 * rather than "assignment failed": the leads really are assigned in WATI.
 */
export async function assignWatiInterestedLeads(input: { leadIds: string[]; assignee: WatiAssignee }) {
  const { role, sessionDb } = await authorize();
  if (!ASSIGN_ROLES.has(role)) fail('assign-role', 'You do not have permission to assign WATI leads.');
  if (!(input.assignee in ASSIGNEES)) fail('assignee', 'Choose a valid salesperson.');
  const leadIds = [...new Set(input.leadIds)].filter(id => UUID.test(id));
  if (!leadIds.length || leadIds.length !== input.leadIds.length || leadIds.length > 100) {
    fail('selection', 'Choose between 1 and 100 valid WATI leads.');
  }

  const db = externalClient();
  const { data: assignee, error: assigneeError } = await db
    .from('wa_profiles')
    .select('id,full_name')
    .eq('email', watiEmail(input.assignee))
    .eq('is_active', true)
    .single();
  if (assigneeError || !assignee) fail('assignee-profile', 'Could not find that active WATI salesperson.', assigneeError);

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from('wa_leads')
    .update({ owner_id: assignee.id, updated_at: now })
    .in('id', leadIds)
    .eq('final_status', 'Potential')
    .eq('is_archived', false)
    .not('session_expires_at', 'is', null)
    .lte('session_expires_at', now)
    .select('id,display_name,phone_e164,source,ai_intent_score,ai_primary_concern');
  if (updateError) fail('assign', 'Could not assign the selected WATI leads.', updateError);
  if (!updated?.length) fail('assign-empty', 'Those leads are no longer in the Interested list.');

  // Written through the session client, not the service one: fn_assign_wati_work
  // checks the caller's own role in the database, the same way RRR assignment
  // does. Hiding the control in the UI is not a permission.
  const { error: workError } = await sessionDb.rpc('fn_assign_wati_work', {
    p_assignee_email: dashboardEmail(input.assignee),
    p_leads: updated.map((lead) => ({
      id: lead.id,
      phone: lead.phone_e164,
      name: lead.display_name,
      source: lead.source,
      intent: lead.ai_intent_score,
      concern: lead.ai_primary_concern,
    })),
  });
  if (workError) {
    console.error('[wati-interested] assigned in WATI but not recorded here', { error: workError });
    throw new Error(
      `${updated.length} lead(s) were assigned in WATI, but did not reach ${ASSIGNEES[input.assignee]}'s call list: ${workError.message}`,
    );
  }

  revalidatePath('/leads/wati-interested');
  revalidatePath('/rrr/analytics');
  revalidatePath('/rrr/my');
  revalidatePath('/rrr/work');
  return { assigned: updated.length, assignee: assignee.full_name || ASSIGNEES[input.assignee] };
}
