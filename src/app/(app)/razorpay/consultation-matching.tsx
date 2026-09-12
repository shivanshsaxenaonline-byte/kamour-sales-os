'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useViewer } from '@/components/CrmProvider';
import { isConsultationPayment, money, type ConsultationMatch, type Payment } from '@/lib/razorpay/analytics';

const BATCH_SIZE = 100;

export function useConsultationMatches(payments: Payment[]) {
  const viewer = useViewer();
  const phones = useMemo(() => [...new Set(payments
    .filter(payment => isConsultationPayment(payment) && !!payment.phone_e164)
    .map(payment => payment.phone_e164!))].sort(), [payments]);
  const phoneKey = phones.join('|');
  return useQuery({
    queryKey: ['razorpay-consultation-matches', viewer.id, phoneKey], enabled: phones.length > 0,
    queryFn: async ({ signal }) => {
      const rows: ConsultationMatch[] = [];
      for (let start = 0; start < phones.length; start += BATCH_SIZE) {
        const { data, error } = await createClient().from('v_consultations_list')
          .select('id,customer_id,full_name,phone,scheduled_at,state,fee_state,fee_amount,doctor_name')
          .in('phone', phones.slice(start, start + BATCH_SIZE)).order('id').abortSignal(signal).returns<ConsultationMatch[]>();
        if (error) throw new Error(error.message);
        rows.push(...(data ?? []));
      }
      return rows;
    },
  });
}

export function ConsultationCandidates({ matches }: { matches: ConsultationMatch[] }) {
  return <section className="rz-consultation-matches"><h3>Elementor consultation / INR 99</h3>
    <p className="rz-muted">Same phone number. A phone match does not confirm which consultation this payment paid for.</p>
    {!matches.length ? <p>No consultation found for this payment's phone number.</p> : matches.map(c => <article key={c.id}>
      <strong>{c.full_name}</strong>
      <dl><div><dt>Consultation ID</dt><dd>{c.id}</dd></div><div><dt>Phone</dt><dd>{c.phone}</dd></div>
        <div><dt>Consultation date</dt><dd>{c.scheduled_at ? new Date(c.scheduled_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }) : 'Not scheduled'}</dd></div>
        <div><dt>Doctor</dt><dd>{c.doctor_name || 'Unassigned'}</dd></div><div><dt>Consultation status</dt><dd>{c.state}</dd></div>
        <div><dt>Recorded fee status</dt><dd>{c.fee_state}</dd></div><div><dt>Recorded fee</dt><dd>{c.fee_amount === null ? 'Not recorded' : money(Number(c.fee_amount))}</dd></div></dl>
    </article>)}
  </section>;
}
