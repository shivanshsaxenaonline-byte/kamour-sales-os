'use server';

import { createClient } from '@/lib/supabase/server';

export type OrderRow = {
  order_id: string;
  order_no: string;
  ordered_on: string;
  amount: number;
  stage: string;
  payment_state: string;
  payment_mode: string | null;
  ship_state: string | null;
  source: string | null;
  products: string | null;
  delivered_on: string | null;
};

export type CallRow = {
  followup_id: string;
  due_at: string;
  completed_at: string | null;
  outcome: string | null;
  remark: string | null;
  attempt_no: number;
  by_name: string | null;
  called_from: string | null;
};

/**
 * Everything behind one customer, loaded when their row is opened rather than
 * with the list — 1,300 customers' full order and call history is not
 * something to ship on every page load.
 *
 * RLS decides visibility: a rep opening someone else's customer gets nothing
 * back, which the caller shows as an empty history rather than an error.
 */
export async function loadCustomerHistory(customerId: string): Promise<{
  orders: OrderRow[];
  calls: CallRow[];
  error?: string;
}> {
  if (!/^[0-9a-f-]{36}$/i.test(customerId))
    return { orders: [], calls: [], error: 'Invalid customer.' };

  const db = await createClient();

  const [orders, calls] = await Promise.all([
    db.from('v_rrr_customer_orders')
      .select('order_id, order_no, ordered_on, amount, stage, payment_state, payment_mode, ship_state, source, products, delivered_on')
      .eq('customer_id', customerId)
      .order('ordered_on', { ascending: false }),
    db.from('v_rrr_customer_followups')
      .select('followup_id, due_at, completed_at, outcome, remark, attempt_no, by_name, called_from')
      .eq('customer_id', customerId)
      .order('due_at', { ascending: false })
      .limit(100),
  ]);

  if (orders.error) return { orders: [], calls: [], error: orders.error.message };

  return {
    orders: (orders.data ?? []) as OrderRow[],
    // A failure here must not hide the order history, which is the more
    // important half; the panel simply shows no calls.
    calls: (calls.data ?? []) as CallRow[],
  };
}
