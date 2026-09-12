'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LogCallDialog, type CallTarget, type ContactNumber } from '../log-call-dialog';
import { dayLong as day, digitsOf, money } from '../lib/format';

export type MedicineEndingRow = {
  order_id: string;
  order_no: string;
  customer_id: string;
  full_name: string;
  phone_e164: string;
  is_dnd: boolean;
  amount: number;
  course_duration_days: number;
  delivered_on: string;
  ends_on: string;
  days_left: number;
};

function endState(days: number) {
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: 'critical' };
  if (days === 0) return { text: 'Ends today', tone: 'critical' };
  if (days <= 3) return { text: `${days}d left`, tone: 'attention' };
  if (days <= 7) return { text: `${days}d left`, tone: 'positive-outline' };
  return { text: `${days}d left`, tone: 'neutral' };
}

export function MedicineEndingTable({
  rows, numbers, today,
}: {
  rows: MedicineEndingRow[];
  numbers: ContactNumber[];
  today: string;
}) {
  const [search, setSearch] = useState('');
  const [duration, setDuration] = useState('all');
  const [window, setWindow] = useState('action');
  const [calling, setCalling] = useState<CallTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = digitsOf(q);
    return rows.filter((r) => {
      if (duration !== 'all' && r.course_duration_days !== Number(duration)) return false;
      if (window === 'action' && (r.days_left < -10 || r.days_left > 7)) return false;
      if (window === 'ending' && (r.days_left < 0 || r.days_left > 7)) return false;
      if (window === 'overdue' && r.days_left >= 0) return false;
      if (q) {
        const byName = r.full_name.toLowerCase().includes(q);
        const byPhone = digits.length > 0 && digitsOf(r.phone_e164).includes(digits);
        const byOrder = r.order_no.toLowerCase().includes(q);
        if (!byName && !byPhone && !byOrder) return false;
      }
      return true;
    });
  }, [rows, search, duration, window]);

  const actionCount = rows.filter((r) => r.days_left >= -10 && r.days_left <= 7).length;
  const endingCount = rows.filter((r) => r.days_left >= 0 && r.days_left <= 7).length;
  const overdueCount = rows.filter((r) => r.days_left < 0).length;

  const callTargetFor = (r: MedicineEndingRow): CallTarget => ({
    customerId: r.customer_id,
    name: r.full_name,
    phone: r.phone_e164,
    followupId: null,
    orderId: r.order_id,
  });

  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        <h1>Medicine Ending</h1>
        <div className="module-tabs">
          <Link href="/rrr">All customers</Link>
          <Link href="/rrr/ai">AI Leads · today</Link>
          <Link href="/rrr/medicine-ending" className="active" aria-current="page">Medicine Ending<span>{actionCount}</span></Link>
        </div>
        <span className="muted">
          Showing {visible.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} delivered orders · today {day(today)}
        </span>
        {message ? <span className="muted" role="status">{message}</span> : null}
      </div>

      <div className="rrr-filters" id="medicine-ending-filters">
        <div className="rrr-filter-grid">
          <label className="rrr-field wide">
            <span>Search customer</span>
            <input
              type="search"
              value={search}
              placeholder="Name, mobile number or order..."
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="rrr-field">
            <span>Window</span>
            <select value={window} onChange={(e) => setWindow(e.target.value)}>
              <option value="action">Action list ({actionCount})</option>
              <option value="ending">Ending in 7 days ({endingCount})</option>
              <option value="overdue">Already ended ({overdueCount})</option>
              <option value="all">All delivered 15/30 day courses</option>
            </select>
          </label>
          <label className="rrr-field">
            <span>Course duration</span>
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option value="all">15d and 30d</option>
              <option value="15">15 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
        </div>
      </div>

      <div className="grid-scroll">
        <table className="records-table rrr-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Order</th>
              <th className="num">Amount</th>
              <th>Delivered</th>
              <th>Course</th>
              <th>Expected ending</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const state = endState(r.days_left);
              return (
                <tr key={r.order_id} className="record-row">
                  <td>
                    <strong>{r.full_name}</strong>
                    <br />
                    <span className="muted">{r.phone_e164}{r.is_dnd ? ' · DND' : ''}</span>
                  </td>
                  <td>{r.order_no}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td>{day(r.delivered_on)}</td>
                  <td>{r.course_duration_days} days</td>
                  <td>{day(r.ends_on)}</td>
                  <td><span className={`status-pill ${state.tone}`}>{state.text}</span></td>
                  <td><button type="button" onClick={() => setCalling(callTargetFor(r))}>Log call</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <div className="grid-empty">
            <p>No delivered 15/30 day medicine orders match this filter.</p>
          </div>
        ) : null}
      </div>

      {calling ? (
        <LogCallDialog
          target={calling}
          numbers={numbers}
          onClose={() => setCalling(null)}
          onSaved={(msg) => { setCalling(null); setMessage(msg); }}
        />
      ) : null}
    </section>
  );
}
