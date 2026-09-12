export type Payment = {
  id: string; razorpay_order_id: string | null; status: string; method: string | null;
  captured: boolean; amount: number; amount_refunded: number; fee: number | null;
  tax: number | null; currency: string; email: string | null; contact_raw: string | null;
  paid_at: string; received_at: string; order_id: string | null; source: string;
  phone_e164?: string | null;
};
export const PAYMENT_COLUMNS = 'id,razorpay_order_id,status,method,captured,amount,amount_refunded,fee,tax,currency,email,contact_raw,phone_e164,paid_at,received_at,order_id,source';
export type ConsultationMatch = { id: string; customer_id: string; full_name: string; phone: string | null; scheduled_at: string | null; state: string; fee_state: string; fee_amount: number | null; doctor_name: string | null };
export const isConsultationPayment = (p: Payment) => p.currency === 'INR' && Number(p.amount) === 99;
export function consultationIndex(rows: ConsultationMatch[]) {
  const index = new Map<string, ConsultationMatch[]>();
  for (const row of rows) {
    if (!row.phone) continue;
    const matches = index.get(row.phone);
    if (matches) matches.push(row); else index.set(row.phone, [row]);
  }
  return index;
}
export function consultationMatches(p: Payment, index: Map<string, ConsultationMatch[]>) {
  return isConsultationPayment(p) && p.phone_e164 ? index.get(p.phone_e164) ?? [] : [];
}
export const ROLES = ['admin', 'ceo', 'coo', 'sales_manager', 'auditor'];
export const money = (n: number, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
export const istDate = (date = new Date()) => new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10);
export function addDays(day: string, count: number) {
  return new Date(Date.parse(day + 'T00:00:00Z') + count * 86400000).toISOString().slice(0, 10);
}
export function dateRange(preset: string, today: string, month: string) {
  if (preset === 'all') return { start: '', end: '' };
  if (preset === 'today') return { start: today, end: today };
  if (preset === 'yesterday') return { start: addDays(today, -1), end: addDays(today, -1) };
  if (preset === '7' || preset === '30') return { start: addDays(today, 1 - Number(preset)), end: today };
  const base = preset === 'month' ? month : today.slice(0, 7);
  const first = base + '-01';
  const next = new Date(first + 'T00:00:00Z');
  if (preset === 'lastMonth') {
    next.setUTCMonth(next.getUTCMonth() - 1);
    return { start: next.toISOString().slice(0, 10), end: addDays(first, -1) };
  }
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: first, end: preset === 'thisMonth' ? today : addDays(next.toISOString().slice(0, 10), -1) };
}
export function validRange(start: string, end: string) {
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  return valid(start) && valid(end) && start <= end;
}
export const isCollected = (p: Payment) => p.captured || p.status === 'captured' || p.status === 'refunded';
// Integer minor units keep financial totals independent of floating-point addition.
const minor = (n: number | null) => Math.round(Number(n ?? 0) * 100);
export function summarize(rows: Payment[]) {
  let gross = 0, refunds = 0, fees = 0, tax = 0, successful = 0, failed = 0, pending = 0, unmatched = 0, missingFees = 0;
  for (const p of rows) {
    if (isCollected(p)) {
      successful++; gross += minor(p.amount); refunds += minor(p.amount_refunded);
      fees += minor(p.fee); tax += minor(p.tax);
      if (p.fee === null) missingFees++;
      if (!p.order_id) unmatched++;
    } else if (p.status === 'failed') failed++;
    else pending++;
  }
  return { gross: gross / 100, refunds: refunds / 100, fees: fees / 100, tax: tax / 100,
    net: (gross - refunds - fees) / 100, successful, failed, pending, unmatched, missingFees,
    total: rows.length, successRate: rows.length ? successful / rows.length * 100 : 0,
    average: successful ? gross / 100 / successful : 0 };
}
export function trend(rows: Payment[], grouping: 'day' | 'month', start: string, end: string) {
  const groups = new Map<string, Payment[]>();
  const first = start || rows.at(-1)?.paid_at && istDate(new Date(rows.at(-1)!.paid_at));
  const last = end || rows[0]?.paid_at && istDate(new Date(rows[0].paid_at));
  if (first && last) {
    let cursor = grouping === 'month' ? first.slice(0, 7) + '-01' : first;
    while (cursor <= last) {
      groups.set(grouping === 'month' ? cursor.slice(0, 7) : cursor, []);
      if (grouping === 'day') cursor = addDays(cursor, 1);
      else { const d = new Date(cursor + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); cursor = d.toISOString().slice(0, 10); }
    }
  }
  for (const p of rows) {
    const day = istDate(new Date(p.paid_at)), key = grouping === 'month' ? day.slice(0, 7) : day;
    const items = groups.get(key);
    if (items) items.push(p);
    else groups.set(key, [p]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, ...summarize(items) }));
}
export function csv(rows: Payment[], classification?: (p: Payment) => string[]) {
  const keys: (keyof Payment)[] = ['id', 'razorpay_order_id', 'paid_at', 'status', 'method', 'currency', 'amount', 'amount_refunded', 'fee', 'tax', 'contact_raw', 'email', 'order_id', 'source'];
  const escape = (v: unknown) => {
    let value = String(v ?? '');
    if (/^[\s]*[=+@-]/.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  };
  const headings = [...keys, ...(classification ? ['source_category','match_reason','medicine_order_ids'] : [])];
  return [headings.join(','), ...rows.map(p => [...keys.map(k => escape(p[k])), ...(classification ? classification(p).map(escape) : [])].join(','))].join('\r\n');
}
