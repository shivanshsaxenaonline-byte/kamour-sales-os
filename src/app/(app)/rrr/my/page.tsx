import { redirect } from 'next/navigation';
import { getServerViewer } from '@/lib/supabase/viewer';
import { medicineEnds, istDateFromTimestamp, istToday } from '../lib/format';
import type { ContactNumber } from '../log-call-dialog';
import { MyWorkList, type MyWorkRow } from './my-work-list';

export const dynamic = 'force-dynamic';

type RawWork = {
  id: string;
  source: 'ai' | 'medicine_ending' | 'due';
  customer_id: string;
  order_id: string;
  due_on: string;
  last_called_at: string | null;
  last_outcome: string | null;
  medicine_days_left: number | null;
  customers: { full_name: string; phone_e164: string; is_dnd: boolean } | null;
  orders: { order_no: string; course_duration_days: number | null;
    delivered_at: string | null; created_at: string;
    /** The tablets in the parcel, for the course length the sheet may not
     *  carry — see courseDays() in ../lib/format. */
    order_items: { products: { default_course_days: number | null } | null }[] } | null;
};

type RawWatiWork = {
  id: string;
  customer_id: string | null;
  display_name: string;
  phone_e164: string;
  due_on: string;
  last_called_at: string | null;
  last_outcome: string | null;
  medicine_days_left: number | null;
  primary_concern: string | null;
  customers: { full_name: string; phone_e164: string; is_dnd: boolean } | null;
};

export default async function MyRrrWorkPage() {
  const { supabase: db, user, profile: me } = await getServerViewer();
  if (!user) redirect('/login');
  if (me?.role !== 'sales_exec' && me?.role !== 'sales_manager') redirect('/rrr/ai');

  const today = istToday();
  const [work, wati, numbers, usualNumber] = await Promise.all([
    db.from('rrr_work_items').select(`id, source, customer_id, order_id, due_on, last_called_at,
      last_outcome, medicine_days_left, customers!inner(full_name, phone_e164, is_dnd),
      orders!inner(order_no, course_duration_days, delivered_at, created_at,
        order_items(products(default_course_days)))`)
      .eq('assigned_to', user.id).is('completed_at', null)
      .order('due_on', { ascending: true }).limit(500),
    // Leads Alka handed over from WATI Interested. Left-joined to customers,
    // not inner: an interested chat from a number nobody has ordered from is
    // exactly the lead worth calling, and it must not drop out of the list.
    db.from('wati_work_items').select(`id, customer_id, display_name, phone_e164, due_on,
      last_called_at, last_outcome, medicine_days_left, primary_concern,
      customers(full_name, phone_e164, is_dnd)`)
      .eq('assigned_to', user.id).is('completed_at', null)
      .order('due_on', { ascending: true }).limit(500),
    db.from('contact_numbers').select('id, label_en').eq('is_active', true).order('sort_order'),
    // The handset this rep last called from, so the Log-call dialog opens on
    // it instead of whatever sorts first. Their own history is behind a
    // restrictive policy, so this is asked of the database, not read here.
    db.rpc('fn_my_calling_number'),
  ]);
  if (work.error) return <div className="grid-empty" role="alert">Could not load assigned follow-ups: {work.error.message}</div>;
  const rows = ((work.data ?? []) as unknown as RawWork[])
    .filter((item) => item.customers && item.orders)
    .map((item): MyWorkRow => {
      // One definition of when the course runs out, shared with the AI list
      // and with the generator's own window — see medicineEnds().
      const ends = medicineEnds({
        ordered_on: item.orders!.created_at,
        delivered_on: item.orders!.delivered_at
          ? istDateFromTimestamp(item.orders!.delivered_at) : null,
        course_duration_days: item.orders!.course_duration_days,
        tablet_course_days: Math.max(0, ...(item.orders!.order_items ?? [])
          .map((oi) => oi.products?.default_course_days ?? 0)) || null,
      });
      return {
        id: item.id,
        source: item.source,
        watiWorkId: null,
        customer_id: item.customer_id,
        order_id: item.order_id,
        due_on: item.due_on,
        called_today: !!item.last_called_at && istDateFromTimestamp(item.last_called_at) === today,
        last_outcome: item.last_outcome,
        medicine_days_left: item.medicine_days_left,
        full_name: item.customers!.full_name,
        phone_e164: item.customers!.phone_e164,
        is_dnd: item.customers!.is_dnd,
        order_no: item.orders!.order_no,
        note: null,
        medicine_ends_on: ends?.on ?? null,
      };
    });

  // A WATI hand-over that fails to load is worth saying out loud, but it must
  // not take the RRR calls down with it — those are the bulk of the day.
  if (wati.error) console.error('[rrr/my] WATI Interested tasks unavailable', { error: wati.error });
  for (const item of (wati.data ?? []) as unknown as RawWatiWork[]) {
    rows.push({
      id: item.id,
      source: 'wati_interested',
      watiWorkId: item.id,
      customer_id: item.customer_id,
      order_id: null,
      due_on: item.due_on,
      called_today: !!item.last_called_at && istDateFromTimestamp(item.last_called_at) === today,
      last_outcome: item.last_outcome,
      medicine_days_left: item.medicine_days_left,
      // The golden record's name wins when the number is already a customer;
      // otherwise the WhatsApp profile name is all anyone has.
      full_name: item.customers?.full_name ?? item.display_name,
      phone_e164: item.customers?.phone_e164 ?? item.phone_e164,
      is_dnd: item.customers?.is_dnd ?? false,
      order_no: null,
      note: item.primary_concern,
      medicine_ends_on: null,
    });
  }
  rows.sort((a, b) => a.due_on.localeCompare(b.due_on));

  return <MyWorkList rows={rows} numbers={(numbers.data ?? []) as ContactNumber[]}
    preferredNumberId={(usualNumber.data as string | null) ?? null}
    today={today} />;
}
