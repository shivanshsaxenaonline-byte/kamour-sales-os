import type { Payment } from './analytics';

const isConsultationPayment = (p: Pick<Payment, 'currency' | 'amount'>) => p.currency === 'INR' && Number(p.amount) === 99;

export type MedicineOrder = { id: string; order_no: string; customer_id: string; phone: string | null; amount: number; created_at: string; payment_mode: string | null; stage: string; razorpay_payment_id?: string | null };
export type Classification = { category: 'Elementor' | 'Wati' | 'Kamour Medicine' | 'Unclassified'; orderIds: string[]; reason: string };
export type ClassificationPayment = Pick<Payment, 'id' | 'currency' | 'amount' | 'phone_e164' | 'paid_at' | 'status' | 'order_id'>;

export function classifyPayments(payments: ClassificationPayment[], orders: MedicineOrder[]) {
  const byPhone = new Map<string, MedicineOrder[]>();
  for (const order of orders) {
    if (order.phone) byPhone.set(order.phone, [...(byPhone.get(order.phone) ?? []), order]);
  }
  const candidates = new Map<string, MedicineOrder[]>();
  const useCounts = new Map<string, number>();
  for (const p of payments) {
    if (p.currency !== 'INR' || Number(p.amount) === 9 || isConsultationPayment(p)) continue;
    const exact = orders.filter(o => o.id === p.order_id || o.razorpay_payment_id === p.id);
    const matches = exact.length ? exact : (byPhone.get(p.phone_e164 || '') ?? []).filter(o =>
      o.stage !== 'cancelled' && o.payment_mode === 'Razorpay' &&
      Math.round(Number(o.amount) * 100) === Math.round(Number(p.amount) * 100) &&
      Math.abs(Date.parse(o.created_at) - Date.parse(p.paid_at)) <= 14 * 86400000
    );
    candidates.set(p.id, matches);
    // Failed attempts do not compete with captured payments for the same order.
    if (p.status === 'captured' || p.status === 'refunded') for (const o of matches) useCounts.set(o.id, (useCounts.get(o.id) ?? 0) + 1);
  }
  const result = new Map<string, Classification>();
  for (const p of payments) {
    if (isConsultationPayment(p)) { result.set(p.id, { category: 'Elementor', orderIds: [], reason: 'INR 99 consultation' }); continue; }
    if (p.currency === 'INR' && Number(p.amount) === 9) { result.set(p.id, { category: 'Wati', orderIds: [], reason: 'INR 9 Wati payment' }); continue; }
    const matches = candidates.get(p.id) ?? [];
    const exact = matches.find(o => o.id === p.order_id || o.razorpay_payment_id === p.id);
    const unique = matches.length === 1 && (useCounts.get(matches[0]!.id) ?? 0) <= 1;
    result.set(p.id, exact || unique
      ? { category: 'Kamour Medicine', orderIds: [exact?.id ?? matches[0]!.id], reason: exact ? 'Existing payment/order link' : 'Same phone and amount; Razorpay order within 14 days' }
      : { category: 'Unclassified', orderIds: matches.map(o => o.id), reason: matches.length ? 'Multiple possible payments or orders: review required' : !p.phone_e164 ? 'No valid phone or existing order link' : 'No matching Razorpay medicine order' });
  }
  return result;
}
