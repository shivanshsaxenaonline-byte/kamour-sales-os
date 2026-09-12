import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyPayments} from '../src/lib/razorpay/classification.ts';
const p=(id,amount=500,changes={})=>({id,amount,currency:'INR',phone_e164:'+919999999999',paid_at:'2026-09-10T10:00:00Z',status:'captured',order_id:null,...changes});
const o=(id,changes={})=>({id,amount:500,phone:'+919999999999',created_at:'2026-09-10T00:00:00Z',payment_mode:'Razorpay',stage:'delivered',...changes});
test('user source rules take precedence over medicine amount matches',()=>{
  const r=classifyPayments([p('9',9),p('99',99),p('usd',9,{currency:'USD'})],[o('o',{amount:9})]);
  assert.equal(r.get('9').category,'Wati');assert.equal(r.get('99').category,'Elementor');assert.equal(r.get('usd').category,'Unclassified');
});
test('medicine requires phone amount date and gateway evidence',()=>{
  assert.equal(classifyPayments([p('a')],[o('o')]).get('a').category,'Kamour Medicine');
  for(const change of [{amount:501},{phone:'+918888888888'},{payment_mode:'COD'},{stage:'cancelled'},{created_at:'2025-09-10T00:00:00Z'}]) assert.equal(classifyPayments([p('a')],[o('o',change)]).get('a').category,'Unclassified');
});
test('multiple orders or competing captures remain unclassified',()=>{
  assert.equal(classifyPayments([p('a')],[o('o'),o('o2')]).get('a').category,'Unclassified');
  assert.equal(classifyPayments([p('a'),p('b')],[o('o')]).get('a').category,'Unclassified');
  assert.equal(classifyPayments([p('a'),p('b',500,{status:'failed'})],[o('o')]).get('a').category,'Kamour Medicine');
});
test('existing explicit links work without phone',()=>{
  assert.equal(classifyPayments([p('a',500,{phone_e164:null,order_id:'o'})],[o('o')]).get('a').category,'Kamour Medicine');
});
