// Import the two authoritative July tabs.
//
//   node scripts/import-sheets.mjs            dry run — reports, writes nothing
//   node scripts/import-sheets.mjs --commit   actually writes
//
// Everything runs in one transaction. Anything that cannot be understood goes
// to import_rejects with a reason rather than being guessed at. An import with
// zero rejects would mean the importer guessed somewhere (D-011).

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// date columns must not come back as JS Date objects — node-postgres parses
// them at local midnight and IST then shifts them a day (D-016)
pg.types.setTypeParser(1082, (v) => v);

const COMMIT = process.argv.includes('--commit');
const DIR = 'data/incoming/sheets';
const F_CONSULT = `${DIR}/NEW SALES TEAM WORKING DOC 2026 - July - Consultation Record - AP+TA+SS.csv`;
const F_ORDER = `${DIR}/NEW SALES TEAM WORKING DOC 2026 - July - Medicine Order Record - AP+TA+S.csv`;

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// ---------------------------------------------------------------------------
// CSV (RFC4180). Fields contain embedded newlines, so line-splitting will not do.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function load(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1).filter((r) => r.some((c) => (c || '').trim()));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return { header, body, idx, get: (r, c) => (r[idx[c]] ?? '').trim() };
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------
const BLANK = new Set(['', '-', '--', 'n/a', 'N/A', 'na', 'NA', 'null', '#N/A']);
const blank = (v) => !v || BLANK.has(v.trim());

// "Follow up" in Amount / Payment / Lead Source is a deliberate literal meaning
// "came off a follow-up, no fresh payment or source" — NOT a shifted column
// and NOT corrupt data. Import as null. (D-021)
const FOLLOWUP_LITERAL = /^follow\s*up$/i;

function toE164(raw) {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

// Returns 'YYYY-MM-DD' or null. Never guesses an ambiguous date.
function parseDate(v) {
  if (blank(v)) return null;
  const s = v.trim();
  let m;
  // "July 4, 2026" / "Jul 1, 2026"
  if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  // "07-07-2026" / "02-07-26" / "7/7/2026"  — always dd-mm, per the sheet's convention
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/))) {
    let [_, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31)
      return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

function money(v) {
  if (blank(v) || FOLLOWUP_LITERAL.test(v)) return null;
  if (/^free$/i.test(v)) return 0;
  const s = v.replace(/[₹,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300_000,
  application_name: 'kamour-import',
});

const rejects = [];
const reject = (source, rowNo, reason, payload) =>
  rejects.push({ source, rowNo, reason, payload });

const stats = {};
const bump = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

async function main() {
  await client.connect();
  await client.query('begin');

  // ---- reference data ----
  const lut = async (t) =>
    Object.fromEntries((await client.query(`select id, code from ${t}`)).rows.map((r) => [r.code, r.id]));
  const sources = await lut('lead_sources');
  const couriers = await lut('couriers');
  const payModes = await lut('payment_modes');
  const cancelReasons = await lut('cancel_reasons');
  const products = Object.fromEntries(
    (await client.query('select id, sku from products')).rows.map((r) => [r.sku, r.id]));
  const users = (await client.query('select id, full_name, role from users')).rows;
  const userByName = {};
  for (const u of users) userByName[norm(u.full_name)] = u.id;

  const salesId = (name) => {
    const n = norm(name);
    for (const key of ['shreyansh', 'tejasv', 'ashutosh'])
      if (n.includes(key)) return userByName[key === 'ashutosh' ? 'ashutosh' : key];
    return null;
  };
  const doctorId = (name) => {
    const n = norm(name);
    if (!n || n.includes('nodoctor') || n === 'salesteam') return null;
    if (n.includes('rupend')) return userByName['drrupendrasingh'];
    if (n.includes('harsh')) return userByName['drharsh'];
    if (n.includes('shubham')) return userByName['drshubhamsaxena'];
    if (n.includes('dinesh')) return userByName['drdineshbiswas'];
    if (n.includes('rajeev')) return userByName['drrajeev'];
    return undefined; // unknown → caller rejects
  };
  const srcId = (v) => {
    if (blank(v) || FOLLOWUP_LITERAL.test(v)) return null;
    const n = norm(v);
    const map = { elementor:'elementor', wati:'wati', watielementor:'wati_elementor',
      reactivation:'reactivation', calling:'calling', justdial:'justdial', facebook:'facebook',
      instagram:'instagram', flipkart:'flipkart', indiamart:'indiamart', kapeefit:'kapeefit' };
    return sources[map[n]] ?? undefined;
  };

  // ---- read both files ----
  const C = load(F_CONSULT);
  const O = load(F_ORDER);

  // =========================================================================
  // Pass 1 — assemble the Golden Customer from both tabs.
  // original_owner_id comes from the EARLIEST event, current from the LATEST.
  // Attribution is frozen at import and incentive follows it forever (D-024).
  // =========================================================================
  const people = new Map(); // phone -> {...}
  const touch = (phone, when, owner, patch) => {
    let p = people.get(phone);
    if (!p) { p = { phone, first: null, last: null, firstOwner: null, lastOwner: null }; people.set(phone, p); }
    for (const [k, v] of Object.entries(patch ?? {}))
      if (p[k] == null && v != null && v !== '') p[k] = v;
    if (when) {
      if (!p.first || when < p.first) { p.first = when; if (owner) p.firstOwner = owner; }
      if (!p.last || when >= p.last) { p.last = when; if (owner) p.lastOwner = owner; }
    }
    if (!p.firstOwner && owner) p.firstOwner = owner;
    if (!p.lastOwner && owner) p.lastOwner = owner;
    return p;
  };

  C.body.forEach((r, n) => {
    const phone = toE164(C.get(r, 'Number'));
    if (!phone) return reject('consultation', n + 2, 'unparseable_phone', { raw: C.get(r, 'Number') });
    touch(phone, parseDate(C.get(r, 'Consultation Date')), salesId(C.get(r, 'Joined By')), {
      full_name: C.get(r, 'Customer Name') || 'Unknown',
      state: blank(C.get(r, 'State')) ? null : C.get(r, 'State'),
      age: /^\d{1,3}$/.test(C.get(r, 'Age')) ? Number(C.get(r, 'Age')) : null,
      source: srcId(C.get(r, 'Lead Source')) || null,
    });
  });

  O.body.forEach((r, n) => {
    const phone = toE164(O.get(r, 'Contact Number'));
    if (!phone) return reject('order', n + 2, 'unparseable_phone', { raw: O.get(r, 'Contact Number') });
    const pin = O.get(r, 'Pincode').replace(/\D/g, '');
    touch(phone, parseDate(O.get(r, 'Date of Order')), salesId(O.get(r, 'Conversion By')), {
      full_name: O.get(r, 'Customer Name') || 'Unknown',
      // never cleaned, never repaired — one wrong character is an RTO
      address: blank(O.get(r, 'Complete Address')) ? null : O.get(r, 'Complete Address'),
      pincode: /^[1-9]\d{5}$/.test(pin) ? pin : null,
      city: blank(O.get(r, 'City')) ? null : O.get(r, 'City'),
      state: blank(O.get(r, 'State')) ? null : O.get(r, 'State'),
      age: /^\d{1,3}$/.test(O.get(r, 'Age')) ? Number(O.get(r, 'Age')) : null,
      source: srcId(O.get(r, 'Source')) || null,
    });
  });

  // ---- upsert customers ----
  const idByPhone = new Map();
  for (const p of people.values()) {
    const { rows } = await client.query(
      `insert into customers
         (phone_e164, phone_raw, full_name, address, pincode, city, state, age,
          first_source_id, original_owner_id, current_owner_id)
       values ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (phone_e164) where merged_into_id is null do update set
         -- enrich only where the target is still empty; never overwrite
         full_name = coalesce(customers.full_name, excluded.full_name),
         address   = coalesce(customers.address,   excluded.address),
         pincode   = coalesce(customers.pincode,   excluded.pincode),
         city      = coalesce(customers.city,      excluded.city),
         state     = coalesce(customers.state,     excluded.state),
         age       = coalesce(customers.age,       excluded.age)
       returning id`,
      [p.phone, p.full_name, p.address ?? null, p.pincode ?? null, p.city ?? null,
       p.state ?? null, p.age ?? null, p.source ?? null, p.firstOwner ?? null, p.lastOwner ?? null]
    );
    idByPhone.set(p.phone, rows[0].id);
  }
  bump('customers', idByPhone.size);

  // =========================================================================
  // Pass 2 — consultations
  // =========================================================================
  const STATE = { 'consultation done': 'done', pending: 'pending', cancelled: 'cancelled' };
  const consultByKey = new Map(); // phone|date -> consultation id

  for (const [n, r] of C.body.entries()) {
    const rowNo = n + 2;
    const phone = toE164(C.get(r, 'Number'));
    if (!phone) continue; // already rejected
    const cust = idByPhone.get(phone);
    const state = STATE[C.get(r, 'Consultation Status').toLowerCase()];
    if (!state) { reject('consultation', rowNo, 'unknown_status', { raw: C.get(r, 'Consultation Status') }); continue; }

    // `Consultation Date` doubles as a status marker: it holds the literal
    // "Pending" or "Cancel" for consultations that never happened. Those rows
    // are not corrupt — they simply have no consultation date. Fall back to the
    // payment date, which is when the customer actually paid.
    const when = parseDate(C.get(r, 'Consultation Date')) ?? parseDate(C.get(r, 'Payment Date'));
    if (state === 'done' && !when) {
      reject('consultation', rowNo, 'done_without_date', { raw: C.get(r, 'Consultation Date') });
      continue;
    }

    const doc = doctorId(C.get(r, 'Doctor Name'));
    if (doc === undefined) { reject('consultation', rowNo, 'unknown_doctor', { raw: C.get(r, 'Doctor Name') }); continue; }

    const amount = money(C.get(r, 'Amount'));
    const pay = C.get(r, 'Payment');
    // A real payment mode implies the fee was taken. "Follow up" means no fresh
    // fee was charged, so it stays unpaid. Verified: the two columns never disagree.
    const feeState = (!blank(pay) && !FOLLOWUP_LITERAL.test(pay)) ? 'paid' : 'unpaid';

    const { rows } = await client.query(
      `insert into consultations
         (customer_id, doctor_id, scheduled_at, state, completed_at,
          cancel_reason_id, fee_amount, fee_state, notes)
       values ($1,$2,$3::date,$4::consultation_state,$5,$6,$7,$8::payment_state,$9)
       returning id`,
      [cust, doc, when, state,
       state === 'done' ? when : null,   // completed_at only when it happened
       state === 'cancelled' ? cancelReasons['legacy_unknown'] : null,
       amount, feeState,
       [C.get(r, 'Notes (Before Consultation)'), C.get(r, 'Medicine Remark (Immediately After Consultation)')]
         .filter((x) => !blank(x)).join('\n---\n') || null]
    );
    if (when) consultByKey.set(`${phone}|${when}`, rows[0].id);
    bump(`consultation_${state}`);

    // ---- follow-ups: "24-07-2026 | Shreyansh Call Not Pick" ----
    for (const [k, col] of ['1st Followup','2nd Followup','3rd Followup','4th Followup','5th Followup'].entries()) {
      const cell = C.get(r, col);
      if (blank(cell)) continue;
      const m = cell.match(/^\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*[|\-–]?\s*(.*)$/s);
      const due = m ? parseDate(m[1]) : null;
      if (!due) { reject('consultation', rowNo, 'followup_without_date', { column: col, raw: cell.slice(0, 200) }); continue; }
      const rest = (m[2] ?? '').trim();
      // outcome deliberately left NULL: the text is free-form and classifying it
      // would fabricate the signal the pool rule depends on. Remark keeps it all.
      await client.query(
        `insert into followups
           (customer_id, kind, consultation_id, due_at, owner_id, remark, completed_at, attempt_no)
         values ($1,'consultation',$2,$3::date,$4,$5,$3::date,$6)`,
        [cust, rows[0].id, due, salesId(rest), rest || cell, k + 1]
      );
      bump('followups');
    }
  }

  // =========================================================================
  // Pass 3 — orders + order_items
  // =========================================================================
  const SKU_COLS = {
    'Gold Plus 60N': 'GP60', 'Gold Plus 30N': 'GP30',
    'Daily Charge 60N': 'DC60', 'Daily Charge 30N': 'DC30',
    'Power Drive': 'PD', 'Boost Up Oil': 'BUO', 'Shilajit Resin': 'SGR',
  };
  const PAY = { 'gpaycod': 'gpay_cod', 'gpay': 'gpay', 'cod': 'cod', 'razorpay': 'razorpay', 'prepaid': 'prepaid' };
  // COD money is not collected yet; gpay+COD is part paid.
  const PAY_STATE = { gpay:'paid', razorpay:'paid', prepaid:'paid', cod:'unpaid', gpay_cod:'partial' };
  const COURIER = { delhivery:'delhivery', shiprocket:'shiprocket', bluedart:'bluedart',
    dtdc:'dtdc', shadowfax:'shadowfax', maruti:'maruti', store:'store' };

  for (const [n, r] of O.body.entries()) {
    const rowNo = n + 2;
    const phone = toE164(O.get(r, 'Contact Number'));
    if (!phone) continue;
    const cust = idByPhone.get(phone);

    const items = Object.entries(SKU_COLS)
      .map(([col, sku]) => [sku, Number(O.get(r, col).replace(/\D/g, ''))])
      .filter(([, q]) => q > 0);
    if (!items.length) { reject('order', rowNo, 'no_product_lines', { customer: O.get(r, 'Customer Name') }); continue; }

    const days = Number((O.get(r, 'Course Duration').match(/\d+/) ?? [])[0]);
    if (!days) { reject('order', rowNo, 'missing_course_duration', { raw: O.get(r, 'Course Duration') }); continue; }

    const amount = money(O.get(r, 'Order Amount'));
    if (amount == null) { reject('order', rowNo, 'unparseable_amount', { raw: O.get(r, 'Order Amount') }); continue; }

    const owner = salesId(O.get(r, 'Conversion By'));
    if (!owner) { reject('order', rowNo, 'unknown_sales_owner', { raw: O.get(r, 'Conversion By') }); continue; }

    const pm = PAY[norm(O.get(r, 'Payment Mode'))];
    const delivered = parseDate(O.get(r, 'Delivered Date'));
    const pendingConfirm = /^true$/i.test(O.get(r, 'Pending Status'));
    // No dispatch date exists in the source (D-022/D-023), so a delivered order
    // is recorded as delivered with dispatch_date null and is_legacy set.
    const stage = pendingConfirm ? 'pending_confirm' : delivered ? 'delivered' : 'confirmed';

    const pin = O.get(r, 'Pincode').replace(/\D/g, '');
    const when = parseDate(O.get(r, 'Date of Order'));
    const consultDate = parseDate(O.get(r, 'Date of Consultation'));

    const { rows } = await client.query(
      `insert into orders
         (customer_id, consultation_id, stage, payment_state, payment_mode_id,
          amount, discount, shipping_amount, course_duration_days,
          ship_name, ship_address, ship_pincode, ship_city, ship_state,
          courier_id, delivered_at, is_repeat, is_legacy,
          original_owner_id, current_owner_id, created_at)
       values ($1,$2,$3::order_stage,$4::payment_state,$5,$6,$7,$8,$9,
               $10,$11,$12,$13,$14,$15,$16::date,$17,true,$18,$18,
               coalesce($19::date, now()))
       returning id`,
      [cust, consultByKey.get(`${phone}|${consultDate}`) ?? null, stage,
       PAY_STATE[pm] ?? 'unpaid', payModes[pm] ?? null,
       amount, money(O.get(r, 'Discount')) ?? 0, money(O.get(r, 'Shipping Charges')) ?? 0, days,
       O.get(r, 'Customer Name') || null,
       blank(O.get(r, 'Complete Address')) ? null : O.get(r, 'Complete Address'),
       /^[1-9]\d{5}$/.test(pin) ? pin : null,
       blank(O.get(r, 'City')) ? null : O.get(r, 'City'),
       blank(O.get(r, 'State')) ? null : O.get(r, 'State'),
       couriers[COURIER[norm(O.get(r, 'Shipped By'))]] ?? null,
       delivered, /repeat/i.test(O.get(r, 'Order Type')), owner, when]
    );

    for (const [sku, qty] of items) {
      // unit_price stays NULL: the sheet holds an order total, and splitting it
      // would invent a price on what is a prescription record (D-009).
      await client.query(
        `insert into order_items (order_id, product_id, quantity) values ($1,$2,$3)`,
        [rows[0].id, products[sku], qty]);
      bump('order_items');
    }
    bump(`order_${stage}`);
  }

  // ---- rejects ----
  for (const r of rejects)
    await client.query(
      `insert into import_rejects (source, source_row_no, reason, payload) values ($1,$2,$3,$4)`,
      [r.source, r.rowNo, r.reason, JSON.stringify(r.payload)]);

  // ---- report ----
  console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN (nothing written)'}\n`);
  console.log('loaded:');
  for (const k of Object.keys(stats).sort()) console.log(`  ${k.padEnd(28)} ${stats[k]}`);
  const byReason = {};
  for (const r of rejects) byReason[`${r.source}: ${r.reason}`] = (byReason[`${r.source}: ${r.reason}`] ?? 0) + 1;
  console.log(`\nrejects (${rejects.length}):`);
  for (const k of Object.keys(byReason).sort()) console.log(`  ${k.padEnd(44)} ${byReason[k]}`);

  const verify = await client.query(`
    select (select count(*) from customers)                                   as customers,
           (select count(*) from consultations)                               as consultations,
           (select count(*) from consultations where state='done')            as done,
           (select count(*) from consultations where state='pending')         as pending,
           (select count(*) from consultations where state='cancelled')       as cancelled,
           (select count(*) from orders)                                      as orders,
           (select count(*) from orders where is_repeat)                      as repeat_orders,
           (select count(*) from orders where course_duration_days=15)        as fifteen_day,
           (select count(*) from order_items)                                 as order_items,
           (select count(*) from followups)                                   as followups,
           (select count(*) from orders where next_followup_at is not null)   as with_rrr_date`);
  console.log('\nin the database now:');
  console.table(verify.rows);

  if (COMMIT) { await client.query('commit'); }
  else { await client.query('rollback'); console.log('rolled back — re-run with --commit to keep it'); }
  await client.end();
}

main().catch(async (e) => {
  console.error('\nimport failed:', e.message);
  try { await client.query('rollback'); await client.end(); } catch {}
  process.exit(1);
});
