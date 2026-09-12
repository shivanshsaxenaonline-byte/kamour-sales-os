import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { ContactNumber } from '../log-call-dialog';
import { addDaysIso, daysBetween, istToday } from '../lib/format';
import { MedicineEndingTable, type MedicineEndingRow } from './medicine-ending-table';

export const dynamic = 'force-dynamic';

const COLUMNS = `
  id,
  order_no,
  customer_id,
  amount,
  course_duration_days,
  delivered_at,
  customers!inner(full_name, phone_e164, is_dnd, merged_into_id)
`;

type RawOrder = {
  id: string;
  order_no: string;
  customer_id: string;
  amount: number;
  course_duration_days: number | null;
  delivered_at: string | null;
  customers: {
    full_name: string;
    phone_e164: string;
    is_dnd: boolean;
    merged_into_id: string | null;
  }[] | null;
};

export default async function MedicineEndingPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const today = istToday();

  // The two reads do not feed each other, so they go together rather than one
  // after the other.
  //
  // The 750 cap stays: the window filter runs in the browser because the "all"
  // option genuinely means all, and measuring says the whole set is 130 rows
  // (41.6 KB) — the cap is nowhere near binding, so bounding this by date
  // would narrow a user-facing filter to buy back nothing.
  const [orders, numbers] = await Promise.all([
    supabase
      .from('orders')
      .select(COLUMNS)
      .eq('stage', 'delivered')
      .not('delivered_at', 'is', null)
      .in('course_duration_days', [15, 30])
      .order('delivered_at', { ascending: false })
      .limit(750),
    supabase.from('contact_numbers').select('id, label_en')
      .eq('is_active', true).order('sort_order'),
  ]);

  if (orders.error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>Medicine Ending</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load delivered medicine orders.</p>
          <p className="muted">{orders.error.message}</p>
        </div>
      </section>
    );
  }

  const rows = ((orders.data ?? []) as unknown as RawOrder[])
    .filter((o) => {
      const customer = o.customers?.[0];
      return customer && !customer.merged_into_id && o.delivered_at && o.course_duration_days;
    })
    .map((o): MedicineEndingRow => {
      const customer = o.customers![0]!;
      const deliveredOn = o.delivered_at!.slice(0, 10);
      // addDaysIso, not Date.setDate(): the previous helper stepped the
      // machine's local calendar and then read the result back as a UTC day,
      // which put every single course end one day early — a 15-day course
      // delivered on the 1st ended on the 15th instead of the 16th, and the
      // whole "ends today / 3d left / overdue" banding was shifted with it.
      const endsOn = addDaysIso(deliveredOn, o.course_duration_days!);
      return {
        order_id: o.id,
        order_no: o.order_no,
        customer_id: o.customer_id,
        full_name: customer.full_name,
        phone_e164: customer.phone_e164,
        is_dnd: customer.is_dnd,
        amount: Number(o.amount),
        course_duration_days: o.course_duration_days!,
        delivered_on: deliveredOn,
        ends_on: endsOn,
        days_left: daysBetween(today, endsOn),
      };
    })
    .sort((a, b) => a.days_left - b.days_left || b.amount - a.amount);

  return <MedicineEndingTable rows={rows} numbers={(numbers.data ?? []) as ContactNumber[]} today={today} />;
}
