import fs from 'node:fs';
import pg from 'pg';
import { classifyPayments } from '../src/lib/razorpay/classification.ts';
import { PAYMENT_COLUMNS, csv } from '../src/lib/razorpay/analytics.ts';

const db=new pg.Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
try {
  const {rows:payments}=await db.query(`select ${PAYMENT_COLUMNS} from razorpay_payments order by paid_at desc,id`);
  const {rows:orders}=await db.query('select id,order_no,customer_id,phone,amount,created_at,payment_mode,stage from v_orders_list');
  const classes=classifyPayments(payments,orders);
  const paid=payments.filter(p=>p.status==='captured'&&Number(p.amount_refunded)<Number(p.amount));
  const remaining=paid.filter(p=>classes.get(p.id).category==='Unclassified');
  fs.mkdirSync('exports',{recursive:true});
  fs.writeFileSync('exports/razorpay-unclassified-payments.csv','\uFEFF'+csv(remaining,p=>{const c=classes.get(p.id);return [c.category,c.reason,c.orderIds.join(' | ')];}));
  const categories=Object.fromEntries(['Elementor','Wati','Kamour Medicine','Unclassified'].map(category=>[category,{attempts:payments.filter(p=>classes.get(p.id).category===category).length,paid:paid.filter(p=>classes.get(p.id).category===category).length}]));
  const amounts=new Map();for(const p of remaining){const key=`${p.currency} ${p.amount}`;amounts.set(key,(amounts.get(key)??0)+1);}
  console.log(JSON.stringify({categories,remaining:remaining.length,commonRemainingAmounts:[...amounts].sort((a,b)=>b[1]-a[1]).slice(0,12),report:'exports/razorpay-unclassified-payments.csv'},null,2));
} finally { await db.end(); }
