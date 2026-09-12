'use client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useViewer } from '@/components/CrmProvider';
import { createClient } from '@/lib/supabase/client';
import { classifyPayments, type ClassificationPayment, type MedicineOrder } from './classification';
import type { Payment } from './analytics';

const ORDER_COLUMNS = 'id,order_no,customer_id,phone,amount,created_at,payment_mode,stage';
const PAYMENT_COLUMNS = 'id,currency,amount,phone_e164,status,paid_at,order_id';
const BATCH_SIZE = 100;

function valuesInBatches(values: string[]) {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += BATCH_SIZE) batches.push(values.slice(index, index + BATCH_SIZE));
  return batches;
}

export function usePaymentClassification(payments: Payment[]) {
  const viewer = useViewer();
  const candidates = useMemo(() => payments.filter(payment =>
    payment.currency === 'INR' && Number(payment.amount) !== 9 && Number(payment.amount) !== 99,
  ), [payments]);
  const paymentKey = useMemo(() => payments.map(payment => `${payment.id}:${payment.order_id ?? ''}`).join('|'), [payments]);

  return useQuery({ queryKey:['razorpay-classification',viewer.id,paymentKey], enabled:payments.length > 0, queryFn:async({signal})=>{
    const db=createClient();
    const orders = new Map<string, MedicineOrder>();
    const addOrders = async (column: 'id' | 'phone', values: string[]) => {
      for (const batch of valuesInBatches(values)) {
        const {data,error}=await db.from('v_orders_list').select(ORDER_COLUMNS).in(column,batch).order('id').abortSignal(signal).returns<MedicineOrder[]>();
        if(error)throw new Error('Could not load relevant medicine orders.');
        for (const order of data??[]) orders.set(order.id,order);
      }
    };
    await Promise.all([
      addOrders('id',[...new Set(candidates.map(payment=>payment.order_id).filter((id):id is string=>!!id))]),
      addOrders('phone',[...new Set(candidates.map(payment=>payment.phone_e164).filter((phone):phone is string=>!!phone))]),
    ]);

    const context = new Map<string, ClassificationPayment>(payments.map(payment=>[payment.id,payment]));
    for (const batch of valuesInBatches([...orders.keys()])) {
      const {data,error}=await db.from('razorpay_payments').select(PAYMENT_COLUMNS).in('order_id',batch).abortSignal(signal).returns<ClassificationPayment[]>();
      if(error)throw new Error('Could not verify related Razorpay payments.');
      for (const payment of data??[]) context.set(payment.id,payment);
    }
    const relevantOrders = [...orders.values()];
    return { classifications: classifyPayments([...context.values()],relevantOrders), orders: relevantOrders };
  }});
}
