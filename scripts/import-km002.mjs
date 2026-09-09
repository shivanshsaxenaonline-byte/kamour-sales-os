// Import the KM002 "Master Sheet" — one row per order, spanning 2023-09 to
// 2026-09. Unlike the July import, this is a single file: no separate
// consultation tab, and no fee/status data to build a `consultations` row
// from, so this importer only ever writes customers + orders + order_items.
// Doctor Name and Lead Note are read from the sheet but have nowhere to go
// in this schema without fabricating a consultation record, so they are
// left on the floor deliberately rather than invented into one.
//
//   node scripts/import-km002.mjs            dry run — reports, writes nothing
//   node scripts/import-km002.mjs --commit   actually writes
//
// Same convention as scripts/import-sheets.mjs: anything not understood goes
// to import_rejects with a reason. Re-run is safe — customers upsert on
// phone, and rejected/imported orders are not re-detected across runs (no
// natural key on the source), so --commit should only be run once per file.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // dates as strings, not JS Date (D-016)

const COMMIT = process.argv.includes('--commit');

// Both order tabs share the same column set, so one importer covers both.
// --tab picks which; the reject `source` records which file a row came from.
const TABS = {
  master: 'Master Sheet',
  shop:   'Kamour.in & Kamour.shop',
};
const tabArg = (process.argv.find((a) => a.startsWith('--tab=')) ?? '--tab=master').slice(6);
if (!TABS[tabArg]) {
  console.error(`unknown --tab=${tabArg}. use one of: ${Object.keys(TABS).join(', ')}`);
  process.exit(1);
}
const FILE = `data/incoming/sheets/KM002 - MASTER MEDICINE ORDER 2026 - ${TABS[tabArg]}.csv`;
const SOURCE = `km002_${tabArg}`;

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

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
const BLANK = new Set(['', '-', '--', 'n/a', 'N/A', 'na', 'NA', 'null', '#N/A']);
const blank = (v) => !v || BLANK.has(v.trim());

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
  // "1 Dec 2023" — 147 rows in the Master Sheet use this, and missing it sent
  // them in dated `now()`, which made three-year-old customers look Active.
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/))) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31)
      return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

function money(v) {
  if (blank(v)) return null;
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
  application_name: 'kamour-import-km002',
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
  const products = Object.fromEntries(
    (await client.query('select id, sku from products')).rows.map((r) => [r.sku, r.id]));
  const users = (await client.query(
    `select id, full_name, role from users where role in ('sales_exec','sales_manager')`)).rows;

  // Match "Conversion By" against real team members by first name, current
  // and former. A one-token name (e.g. the "Ashutosh" sales_manager account,
  // distinct from "Ashutosh Saxena") is registered LAST so it wins a
  // collision — same precedence the July importer used for this exact pair.
  const byFirstToken = {};
  for (const u of [...users].sort((a, b) => b.full_name.split(' ').length - a.full_name.split(' ').length)) {
    byFirstToken[norm(u.full_name.split(' ')[0])] = u.id;
  }
  const salesId = (raw) => (blank(raw) ? undefined : byFirstToken[norm(raw)]);

  const srcId = (v) => {
    if (blank(v)) return null;
    const n = norm(v);
    const map = { cga:'cga', flipkart:'flipkart', indiamart:'indiamart',
      kamourin:'kamour_in', kamourshop:'kamour_shop',
      gokwik:'ecommerce', justdial:'justdial' };
    return sources[map[n]] ?? null; // unmapped source is left unrecorded, not guessed
  };

  const O = load(FILE);

  // =========================================================================
  // Pass 1 — Golden Customer. One file this time, not two: original_owner_id
  // from the earliest order, current_owner_id from the latest.
  // =========================================================================
  const people = new Map();
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

  O.body.forEach((r, n) => {
    const phone = toE164(O.get(r, 'Contact Number'));
    if (!phone) return reject(SOURCE, n + 2, 'unparseable_phone', { raw: O.get(r, 'Contact Number') });
    const age = Number(O.get(r, 'Age'));
    touch(phone, parseDate(O.get(r, 'Date of Order')), salesId(O.get(r, 'Conversion By')), {
      full_name: O.get(r, 'Customer Name') || 'Unknown',
      state: blank(O.get(r, 'State')) ? null : O.get(r, 'State'),
      age: (age >= 1 && age <= 120) ? age : null, // sheet uses 0 as "not provided", not a real age
      source: srcId(O.get(r, 'Source')) || null,
    });
  });

  // Re-running must not double the order book. Keyed the same way the
  // duplicate cleanup keys it: one customer, one date, one amount is one sale.
  const existingOrders = new Set((await client.query(
    `select customer_id || '|' || created_at::date || '|' || amount as k from orders`
  )).rows.map((r) => r.k));

  const idByPhone = new Map();
  for (const p of people.values()) {
    const { rows } = await client.query(
      `insert into customers
         (phone_e164, phone_raw, full_name, state, age, first_source_id, original_owner_id, current_owner_id)
       values ($1,$1,$2,$3,$4,$5,$6,$7)
       on conflict (phone_e164) where merged_into_id is null do update set
         full_name = coalesce(customers.full_name, excluded.full_name),
         state     = coalesce(customers.state,     excluded.state),
         age       = coalesce(customers.age,       excluded.age)
       returning id`,
      [p.phone, p.full_name, p.state ?? null, p.age ?? null,
       p.source ?? null, p.firstOwner ?? null, p.lastOwner ?? null]
    );
    idByPhone.set(p.phone, rows[0].id);
  }
  bump('customers', idByPhone.size);

  // =========================================================================
  // Pass 2 — orders + order_items
  // =========================================================================
  const SKU_COLS = {
    'Gold Plus 60N': 'GP60', 'Gold Plus 30N': 'GP30',
    'Daily Charge 60N': 'DC60', 'Daily Charge 30N': 'DC30',
    'Power Drive': 'PD', 'Boost Up Oil': 'BUO', 'Shilajit Resin': 'SGR',
  };
  const COURIER = { delhivery:'delhivery', shiprocket:'shiprocket', bluedart:'bluedart',
    dtdc:'dtdc', shadowfax:'shadowfax', maruti:'maruti', store:'store' };
  // Instrument-specific modes map directly; "Partial COD" and "Easebuzz" are
  // real labels in the sheet but not a known payment_modes row, so the mode
  // stays null (unknown instrument) while payment_state still reflects what
  // the label actually says about money received.
  const PAY_MODE = { razorpay:'razorpay', gpay:'gpay', cod:'cod', prepaid:'prepaid' };
  // upi/card/easebuzz appear on the website tab; each is money already taken,
  // but none is a payment_modes row, so the state is set and the instrument
  // is left null rather than mapped onto a mode it wasn't.
  const PAY_STATE = { razorpay:'paid', gpay:'paid', prepaid:'paid', easebuzz:'paid',
    upi:'paid', card:'paid', cod:'unpaid', partialcod:'partial' };

  for (const [n, r] of O.body.entries()) {
    const rowNo = n + 2;
    const phone = toE164(O.get(r, 'Contact Number'));
    if (!phone) continue; // already rejected in pass 1
    const cust = idByPhone.get(phone);

    // No product columns filled is common before ~Oct 2025 (the sheet
    // appears not to have tracked per-SKU breakdown before then) and still
    // happens occasionally after. Rather than reject the whole order, it's
    // imported with customer/amount/date intact and simply no order_items —
    // real revenue and repeat-buyer history is not thrown away over a column
    // gap, but nothing invents which product it was.
    const items = Object.entries(SKU_COLS)
      .map(([col, sku]) => [sku, Number(O.get(r, col).replace(/\D/g, ''))])
      .filter(([, q]) => q > 0);
    if (!items.length) bump('order_no_product_lines');

    // Same reasoning as the missing-product-lines case just above: importing
    // with course_duration_days = NULL (allowed for is_legacy rows since
    // migration 022) keeps the order's revenue/repeat-buyer history intact.
    // It just means the RRR clock cannot schedule a repeat-order call for
    // this order specifically — nothing invents a course length to get one.
    const daysRaw = Number((O.get(r, 'Course Duration').match(/\d+/) ?? [])[0]);
    const days = daysRaw > 0 ? daysRaw : null;
    if (!days) bump('order_no_course_duration');

    const amount = money(O.get(r, 'Order Amount'));
    if (amount == null) { reject(SOURCE, rowNo, 'unparseable_amount', { raw: O.get(r, 'Order Amount') }); continue; }

    // Blank "Conversion By" is the normal case on the website tabs — nobody
    // converted a self-serve checkout. Two other values appear that are not
    // team members either: "Doctor" (27 rows — the doctor closed it directly,
    // which is information, not a name) and "Vansh" (5 rows — someone with no
    // user account here). All three import UNASSIGNED (migration 023) rather
    // than being dropped: a real order with unclear attribution still belongs
    // in the customer's history, and the RRR screen treats unassigned rows as
    // the pool to hand out. The attribution itself is NOT preserved — the
    // sheet keeps it, this database does not. (D-068)
    const convBy = O.get(r, 'Conversion By');
    const owner = salesId(convBy) ?? null;
    if (!owner) bump(blank(convBy) ? 'order_unassigned_blank' : `order_unassigned_${norm(convBy)}`);

    // The sheet's "Order Amount" is already what the customer was charged and
    // its Discount column is recorded alongside as information — proved by the
    // row with amount 499 and discount 500, impossible if the amount were
    // gross. Storing the discount here would make lifetime_value
    // (sum(amount - discount)) understate every customer. (D-067)
    const discount = 0;

    const payKey = norm(O.get(r, 'Payment Mode'));
    const delivered = parseDate(O.get(r, 'Delivered Date')); // actual only — never the Estimated column (D-023)
    const stage = delivered ? 'delivered' : 'confirmed';
    const when = parseDate(O.get(r, 'Date of Order'));

    // Re-running must not double the order book. Same key the duplicate
    // cleanup uses: one customer, one date, one amount is one sale.
    const dupKey = `${cust}|${when ?? ''}|${Number(amount).toFixed(2)}`;
    if (existingOrders.has(dupKey)) { bump('skipped_already_imported'); continue; }
    existingOrders.add(dupKey);

    const { rows } = await client.query(
      `insert into orders
         (customer_id, stage, payment_state, payment_mode_id,
          amount, discount, shipping_amount, course_duration_days,
          ship_name, ship_state, courier_id, delivered_at, is_repeat, is_legacy,
          original_owner_id, current_owner_id, source_id, created_at)
       values ($1,$2::order_stage,$3::payment_state,$4,$5,$6,$7,$8,
               $9,$10,$11,$12::date,$13,true,$14,$14,$16,coalesce($15::date, now()))
       returning id`,
      [cust, stage, PAY_STATE[payKey] ?? 'unpaid', payModes[PAY_MODE[payKey]] ?? null,
       amount, discount, money(O.get(r, 'Shipping Charges')) ?? 0, days,
       O.get(r, 'Customer Name') || null,
       blank(O.get(r, 'State')) ? null : O.get(r, 'State'),
       couriers[COURIER[norm(O.get(r, 'Shipped By'))]] ?? null,
       delivered, /repeat/i.test(O.get(r, 'Order Type')), owner, when,
       srcId(O.get(r, 'Source'))]
    );

    for (const [sku, qty] of items) {
      // unit_price stays NULL: the sheet holds an order total, and splitting
      // it would invent a price on what is effectively a prescription record.
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
           (select count(*) from orders)                                      as orders,
           (select count(*) from orders where is_legacy)                      as legacy_orders,
           (select count(*) from orders where is_repeat)                      as repeat_orders,
           (select count(*) from order_items)                                 as order_items,
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
