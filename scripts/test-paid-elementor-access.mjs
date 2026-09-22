import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const source=ts.transpileModule(fs.readFileSync('src/app/(app)/leads/paid-elementor/actions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup({user={id:'viewer'},profile={role:'sales_exec',is_active:true},leads=[],identities=[],customers=[],payments=[]}={}) {
  const calls=[];let privileged=0;
  function builder(table,service=false){const call={table,service,filters:[]};calls.push(call);const b={
    select(v){call.columns=v;return b;},eq(k,v){call.filters.push(['eq',k,v]);return b;},lt(k,v){call.filters.push(['lt',k,v]);return b;},gte(k,v){call.filters.push(['gte',k,v]);return b;},in(k,v){call.filters.push(['in',k,v]);return b;},is(k,v){call.filters.push(['is',k,v]);return b;},not(k,o,v){call.filters.push(['not',k,o,v]);return b;},order(){return b;},range(a,z){call.range=[a,z];return b;},
    single:async()=>({data:profile}),then(resolve,reject){return Promise.resolve({data:table==='leads'?leads:table==='customer_identities'?identities:table==='customers'?customers:payments}).then(resolve,reject);}
  };return b;}
  const db={auth:{getUser:async()=>({data:{user}})},from:t=>builder(t)};
  const exports={};
  vm.runInNewContext(source,{exports,require:name=>name==='@/lib/supabase/server'?{createClient:async()=>db}:{createClient:()=>{privileged++;return {from:t=>builder(t,true)};}},process:{env:{SUPABASE_SERVICE_ROLE_KEY:'test-only',NEXT_PUBLIC_SUPABASE_URL:'https://example.invalid'}}});
  return {run:exports.getPaidElementorLeads,calls,privileged:()=>privileged};
}
test('unauthenticated, inactive and unauthorized roles never query private payments',async()=>{
  for(const opts of [{user:null},{profile:{role:'admin',is_active:false}},{profile:{role:'ops',is_active:true}}]){const s=setup(opts);await assert.rejects(s.run());assert.equal(s.privileged(),0);}
});
test('no candidate payments returns an empty infinite-scroll result',async()=>{const s=setup();assert.equal(JSON.stringify(await s.run({start:'2026-09-11',end:'2026-09-11'})),JSON.stringify({rows:[],nextOffset:null}));assert.equal(s.privileged(),1);});
test('only RLS-visible Zoho CRM leads determine payment phone scope',async()=>{
  const s=setup({leads:[{id:'lead1',customer_id:'a',created_at:'2026-09-11T00:00:00Z'}],identities:[{customer_id:'a'},{customer_id:'b'}],customers:[{id:'a',full_name:'A',phone_e164:'+919999999999'},{id:'b',full_name:'B',phone_e164:'+918888888888'}],payments:[{id:'pay1',phone_e164:'+919999999999',amount:99,amount_refunded:0,paid_at:'2026-09-11T02:00:00Z'},{id:'pay2',phone_e164:'+918888888888',amount:99,amount_refunded:0,paid_at:'2026-09-11T03:00:00Z'}]});
  const result=await s.run({start:'2026-09-11',end:'2026-09-11'});assert.equal(result.rows.length,1);assert.equal(result.rows[0].customer_id,'a');assert.equal(result.rows[0].lead_id,'lead1');assert.equal(result.rows[0].payment_id,'pay1');
  const lead=s.calls.find(c=>c.table==='leads');assert.ok(lead.filters.some(f=>JSON.stringify(f)===JSON.stringify(['eq','channel','zoho_legacy'])));assert.equal(JSON.stringify(lead.filters.find(f=>f[0]==='in')),JSON.stringify(['in','customer_id',['a','b']]));
  const identity=s.calls.find(c=>c.table==='customer_identities');assert.ok(identity.service);assert.ok(identity.filters.some(f=>JSON.stringify(f)===JSON.stringify(['eq','system','zoho'])));
  const payment=s.calls.find(c=>c.table==='razorpay_payments');
  for(const expected of [['eq','currency','INR'],['eq','amount',99],['eq','status','captured'],['lt','amount_refunded',99]])assert.ok(payment.filters.some(f=>JSON.stringify(f)===JSON.stringify(expected)));
  assert.ok(!payment.columns.includes('raw'));assert.ok(!payment.columns.includes('email'));
});
