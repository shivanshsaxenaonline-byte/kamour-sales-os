import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, csv, dateRange, istDate, summarize, trend, validRange, consultationIndex, consultationMatches, isConsultationPayment } from '../src/lib/razorpay/analytics.ts';

const payment = (values = {}) => ({ id: 'pay_test', razorpay_order_id: null, status: 'captured', captured: true, method: 'upi', amount: 100, amount_refunded: 0, fee: 2.36, tax: .36, currency: 'INR', email: null, contact_raw: null, paid_at: '2026-09-01T00:00:00Z', received_at: '2026-09-01T00:00:00Z', source: 'backfill', order_id: null, ...values });
test('INR 99 consultation matching uses normalized phones and preserves ambiguity', () => {
  const index = consultationIndex([{ id: 'c1', phone: '+919999999999' }, { id: 'c2', phone: '+919999999999' }, { id: 'c3', phone: null }]);
  const p = payment({ amount: 99, phone_e164: '+919999999999' });
  assert.ok(isConsultationPayment(p));
  assert.deepEqual(consultationMatches(p, index).map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(consultationMatches(payment({ amount: 99, phone_e164: null }), index), []);
  assert.deepEqual(consultationMatches(payment({ amount: 999, phone_e164: p.phone_e164 }), index), []);
  assert.equal(isConsultationPayment(payment({ amount: 99, currency: 'USD' })), false);
  assert.deepEqual(consultationMatches(payment({ ...p, status: 'failed', captured: false }), index).map(c => c.id), ['c1', 'c2']);
});
test('IST midnight and inclusive custom end date', () => {
  assert.equal(istDate(new Date('2026-08-31T18:30:00Z')), '2026-09-01');
  assert.equal(istDate(new Date('2026-08-31T18:29:59Z')), '2026-08-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(Date.parse(addDays('2026-09-30', 1) + 'T00:00:00+05:30'), Date.parse('2026-09-30T18:30:00Z'));
  assert.ok(validRange('2026-09-01', '2026-09-01'));
  assert.ok(!validRange('2026-09-02', '2026-09-01'));
  assert.ok(!validRange('2026-02-30', '2026-03-01'));
});
test('presets cross years and leap months correctly', () => {
  assert.deepEqual(dateRange('lastMonth', '2026-01-10', ''), { start: '2025-12-01', end: '2025-12-31' });
  assert.deepEqual(dateRange('month', '2026-09-11', '2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(dateRange('7', '2026-09-03', ''), { start: '2026-08-28', end: '2026-09-03' });
  assert.deepEqual(dateRange('thisMonth', '2026-09-11', ''), { start: '2026-09-01', end: '2026-09-11' });
  assert.deepEqual(dateRange('all', '2026-09-11', ''), { start: '', end: '' });
});
test('collections retain refunded captures and never count failed or authorized attempts as revenue', () => {
  const result = summarize([payment(), payment({ status: 'refunded', captured: false, amount_refunded: 100 }), payment({ amount_refunded: 20, fee: null, tax: null, order_id: 'crm' }), payment({ status: 'failed', captured: false }), payment({ status: 'authorized', captured: false })]);
  assert.equal(result.gross, 300);
  assert.equal(result.refunds, 120);
  assert.equal(result.fees, 4.72);
  assert.equal(result.tax, .72);
  assert.equal(result.net, 175.28);
  assert.equal(result.successRate, 60);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.unmatched, 2);
  assert.equal(result.missingFees, 1);
  assert.equal(result.average, 100);
});
test('money totals use integer minor units and empty periods stay finite', () => {
  assert.equal(summarize([payment({ amount: .1 }), payment({ amount: .2 })]).gross, .3);
  assert.equal(summarize([]).successRate, 0);
  assert.equal(summarize([]).average, 0);
});
test('monthly and daily reports bucket by IST and include empty intervals', () => {
  const rows = [payment({ paid_at: '2026-08-31T18:30:00Z' }), payment({ paid_at: '2026-08-31T18:29:59Z' })];
  const months = trend(rows, 'month', '2026-08-01', '2026-10-31');
  assert.deepEqual(months.map(m => [m.date, m.gross]), [['2026-08', 100], ['2026-09', 100], ['2026-10', 0]]);
  assert.deepEqual(trend(rows.slice(0, 1), 'day', '2026-09-01', '2026-09-02').map(d => d.gross), [100, 0]);
});
test('CSV escapes quotes and prevents spreadsheet formulas', () => {
  const result = csv([payment({ email: '=HYPERLINK("bad")', contact_raw: '+919999999999' })]);
  assert.ok(result.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(result.includes('"\'+919999999999"'));
});
