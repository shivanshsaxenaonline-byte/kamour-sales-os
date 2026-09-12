'use server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

export type PaidElementorLead = {
  customer_id: string; full_name: string; phone: string; lead_ids: string[];
  zoho_lead_count: number; latest_zoho_lead: string | null;
  payments: { id: string; paid_at: string; amount: number; amount_refunded: number }[];
};

export type PaidElementorResult = {
  rows: PaidElementorLead[];
  total: number;
  totalPayments: number;
  totalZohoLeads: number;
};

export type PaidElementorQuery = {
  search?: string;
  start?: string;
  end?: string;
  page?: number;
  pageSize?: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayStartIst = (day: string) => `${day}T00:00:00+05:30`;
const dayAfterIst = (day: string) => new Date(Date.parse(dayStartIst(day)) + 86400000).toISOString();

export async function getPaidElementorLeads(query: PaidElementorQuery = {}): Promise<PaidElementorResult> {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('Sign in to view paid leads.');
  const { data: profile } = await db.from('users').select('role,is_active').eq('id', user.id).single();
  if (!profile?.is_active || !['admin','ceo','coo','sales_manager','sales_exec','auditor'].includes(profile.role)) throw new Error('Access denied.');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Payment verification is not configured.');
  const paymentsDb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const today = todayIst();
  const start = DAY.test(query.start ?? '') ? query.start! : addDays(today, -6);
  const end = DAY.test(query.end ?? '') ? query.end! : today;
  if (start > end) throw new Error('Start date must be on or before end date.');
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 25), 1), 100);
  const page = Math.max(Math.trunc(query.page ?? 0), 0);
  const search = (query.search ?? '').trim().toLowerCase();

  const payments: { id: string; phone_e164: string; paid_at: string; amount: number; amount_refunded: number }[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const { data, error } = await paymentsDb.from('razorpay_payments').select('id,phone_e164,paid_at,amount,amount_refunded').eq('currency','INR').eq('amount',99).eq('status','captured').lt('amount_refunded',99).not('phone_e164','is',null).gte('paid_at', dayStartIst(start)).lt('paid_at', dayAfterIst(end)).order('paid_at', { ascending: false }).order('id').range(offset, offset + 999);
    if (error) throw new Error('Could not verify paid Elementor payments.');
    for (const p of data ?? []) payments.push({ id:p.id, phone_e164:p.phone_e164!, paid_at:p.paid_at, amount:Number(p.amount), amount_refunded:Number(p.amount_refunded) });
    if (!data || data.length < 1000) break;
  }
  if (!payments.length) return { rows: [], total: 0, totalPayments: 0, totalZohoLeads: 0 };

  const customers = new Map<string, PaidElementorLead>();
  const customerIds = new Set<string>();
  const phones = [...new Set(payments.map(p => p.phone_e164))];
  for (let i = 0; i < phones.length; i += 100) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await paymentsDb.from('customers').select('id,full_name,phone_e164').in('phone_e164', phones.slice(i, i + 100)).is('merged_into_id', null).order('id').range(offset, offset + 999);
      if (error) throw new Error('Could not load Zoho customer phones.');
      for (const row of data ?? []) {
        if (!row.phone_e164) continue;
        customers.set(row.id, { customer_id: row.id, full_name: row.full_name, phone: row.phone_e164, lead_ids: [], zoho_lead_count: 0, latest_zoho_lead: null, payments: [] });
        customerIds.add(row.id);
      }
      if (!data || data.length < 1000) break;
    }
  }
  if (!customerIds.size) return { rows: [], total: 0, totalPayments: 0, totalZohoLeads: 0 };

  const confirmedZohoIds = new Set<string>();
  const ids = [...customerIds];
  for (let i = 0; i < ids.length; i += 100) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await paymentsDb.from('customer_identities').select('customer_id').in('customer_id', ids.slice(i, i + 100)).eq('system','zoho').order('customer_id').range(offset, offset + 999);
      if (error) throw new Error('Could not verify Zoho CRM identities.');
      for (const identity of data ?? []) confirmedZohoIds.add(identity.customer_id);
      if (!data || data.length < 1000) break;
    }
  }
  for (const id of ids) if (!confirmedZohoIds.has(id)) customers.delete(id);
  if (!customers.size) return { rows: [], total: 0, totalPayments: 0, totalZohoLeads: 0 };

  // This RLS read is the final authorization gate. The service-role lookups
  // above find candidates only; rows are returned only for Zoho leads the
  // signed-in viewer can already read.
  const confirmedIds = [...customers.keys()];
  for (let i = 0; i < confirmedIds.length; i += 100) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from('leads').select('id,customer_id,created_at').in('customer_id', confirmedIds.slice(i, i + 100)).eq('channel','zoho_legacy').eq('is_junk', false).order('id').range(offset, offset + 999);
      if (error) throw new Error('Could not load Zoho CRM lead matches.');
      for (const lead of data ?? []) {
        const customer = customers.get(lead.customer_id);
        if (!customer) continue;
        customer.lead_ids.push(lead.id);
        customer.zoho_lead_count++;
        if (lead.created_at && (!customer.latest_zoho_lead || lead.created_at > customer.latest_zoho_lead)) customer.latest_zoho_lead = lead.created_at;
      }
      if (!data || data.length < 1000) break;
    }
  }
  for (const [id, customer] of customers) if (!customer.lead_ids.length) customers.delete(id);
  const byPhone = new Map([...customers.values()].map(c => [c.phone, c]));
  for (const p of payments) byPhone.get(p.phone_e164)?.payments.push({ id:p.id, paid_at:p.paid_at, amount:p.amount, amount_refunded:p.amount_refunded });

  let rows = [...customers.values()].filter(c => c.payments.length);
  if (search) rows = rows.filter(c => `${c.full_name} ${c.phone} ${c.lead_ids.join(' ')} ${c.payments.map(p => p.id).join(' ')}`.toLowerCase().includes(search));
  rows.sort((a,b) => b.payments[0]!.paid_at.localeCompare(a.payments[0]!.paid_at));
  const total = rows.length;
  const paged = rows.slice(page * pageSize, page * pageSize + pageSize);
  return {
    rows: paged,
    total,
    totalPayments: rows.reduce((n,c)=>n+c.payments.length,0),
    totalZohoLeads: rows.reduce((n,c)=>n+c.lead_ids.length,0),
  };
}
