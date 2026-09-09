// Import the KM002 "AI Daily Queue" tab — the team's real RRR call log.
// 1,769 follow-up attempts on 819 customers over 44 days (24 Jul - 8 Sep 2026),
// with who called, when, and what happened.
//
//   node scripts/import-ai-queue.mjs            dry run — reports, writes nothing
//   node scripts/import-ai-queue.mjs --commit   actually writes
//
// Each row becomes one `followups` row. `followups_one_parent` requires
// exactly one of lead/consultation/order, and these are retention calls on
// people who already bought, so the parent is the customer's own order —
// matched on the queue's "Last Order Date" where possible, else their most
// recent order at the time of the call. A customer with no order in the
// database cannot satisfy that constraint and is rejected, not attached to
// an unrelated order.
//
// Re-running is safe: a follow-up is skipped when one already exists for the
// same customer on the same selection date, which is the queue's own natural
// key (Selection Date + Customer Key).

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);

const COMMIT = process.argv.includes('--commit');
const FILE = 'data/incoming/sheets/KM002 - MASTER MEDICINE ORDER 2026 - AI Daily Queue.csv';
const SOURCE = 'km002_ai_queue';
const IST = '+05:30';

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

const blank = (v) => !v || !String(v).trim();
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test((v ?? '').trim()) ? v.trim() : null);
const isoStamp = (v) => {
  const s = (v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(s)) return s;
  const d = isoDate(s);
  return d ? `${d}T00:00:00${IST}` : null;
};

function toE164(raw) {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The nine dropdown values the sheet actually uses. Three of them only exist
// as outcomes after migration 024; "Others" and "Not Contacted" carry no
// outcome signal at all and stay NULL, with the original text kept in remark.
const OUTCOME = {
  'orderplaced':          'order_placed',
  'notinterested':        'not_interested',
  'interested':           'will_buy',
  'contacted':            'connected',
  'callnotpickedbusy':    'no_answer',
  'medicinenotfinished':  'medicine_not_finished',
  'willupdatelater':      'will_update_later',
  'others':               null,
  'notcontacted':         null,
};

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300_000,
  application_name: 'kamour-import-ai-queue',
});

const rejects = [];
const reject = (rowNo, reason, payload) => rejects.push({ rowNo, reason, payload });
const stats = {};
const bump = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

async function main() {
  await client.connect();
  await client.query('begin');

  const users = (await client.query(
    `select id, full_name from users where role in ('sales_exec','sales_manager')`)).rows;
  const byFirstToken = {};
  for (const u of [...users].sort((a, b) => b.full_name.split(' ').length - a.full_name.split(' ').length))
    byFirstToken[norm(u.full_name.split(' ')[0])] = u.id;

  const raw = parseCsv(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
  const header = raw[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const body = raw.slice(1).filter((r) => r.some((c) => (c || '').trim()));
  const g = (r, c) => (r[idx[c]] ?? '').trim();

  // ---- customer + order lookup, in two queries rather than per row ----
  const phones = [...new Set(body.map((r) => toE164(g(r, 'Phone'))).filter(Boolean))];
  const custRows = (await client.query(
    `select id, phone_e164 from customers where phone_e164 = any($1) and merged_into_id is null`,
    [phones])).rows;
  const custByPhone = new Map(custRows.map((c) => [c.phone_e164, c.id]));

  const orderRows = (await client.query(
    `select id, customer_id, created_at::date as on_date from orders
      where customer_id = any($1) order by created_at`,
    [[...custByPhone.values()]])).rows;
  const ordersByCust = new Map();
  for (const o of orderRows) {
    if (!ordersByCust.has(o.customer_id)) ordersByCust.set(o.customer_id, []);
    ordersByCust.get(o.customer_id).push(o);
  }

  // Existing follow-ups, so a re-run does not duplicate the same call. Held
  // as a COUNT per key, not a flag: the same customer legitimately appears
  // twice on one day (a second attempt logged through the manual flow), and
  // a flag would silently drop the second call on every run.
  // due_at is stored at 00:00 IST, which is 18:30 UTC the PREVIOUS day, and
  // this database runs in UTC — so a plain `due_at::date` returns the day
  // before the sheet's Selection Date and the key never matches. Casting
  // through Asia/Kolkata is what makes a re-run idempotent; without it a
  // second run silently doubles the entire call history.
  const already = new Map((await client.query(
    `select customer_id || '|' || (due_at at time zone 'Asia/Kolkata')::date as k,
            count(*)::int n
       from followups where kind = 'order' group by 1`)).rows
    .map((r) => [r.k, r.n]));

  for (const [n, r] of body.entries()) {
    const rowNo = n + 2;

    // On 2026-08-03 an older version of the Apps Script wrote 84 rows with
    // the fields in the wrong columns (product lists landing in Attempt
    // Count). Those rows cannot be read field-by-field, so they are rejected
    // rather than half-interpreted.
    // Numeric alone is not enough to trust the column: eight of the shifted
    // rows carry a Source Row number (1699..1744) where the attempt count
    // belongs. A real attempt count on this floor is 0-4, so anything past a
    // generous ceiling is the same corruption wearing a number.
    const attempt = g(r, 'Attempt Count');
    const selection = isoDate(g(r, 'Selection Date'));
    if (!selection || !/^\d*$/.test(attempt) || Number(attempt) > 20) {
      reject(rowNo, 'column_shifted_source_row', { selection: g(r, 'Selection Date'), attempt }); continue;
    }

    const phone = toE164(g(r, 'Phone'));
    if (!phone) { reject(rowNo, 'unparseable_phone', { raw: g(r, 'Phone') }); continue; }
    const cust = custByPhone.get(phone);
    if (!cust) { reject(rowNo, 'customer_not_in_database', { phone }); continue; }

    const orders = ordersByCust.get(cust);
    if (!orders?.length) { reject(rowNo, 'customer_has_no_order_to_attach_to', { phone }); continue; }

    // Prefer the exact order the queue was built from; otherwise the latest
    // order that existed when the call was made; otherwise their first order.
    const lastOrderDate = isoDate(g(r, 'Last Order Date'));
    const order =
      (lastOrderDate && orders.find((o) => o.on_date === lastOrderDate)) ||
      [...orders].reverse().find((o) => o.on_date <= selection) ||
      orders[0];

    const key = `${cust}|${selection}`;
    const seen = already.get(key) ?? 0;
    if (seen > 0) { already.set(key, seen - 1); bump('skipped_already_imported'); continue; }

    const status = g(r, 'Follow-up Status');
    const outcome = OUTCOME[norm(status)] ?? null;
    if (status && !(norm(status) in OUTCOME)) bump('outcome_unmapped_kept_in_remark');

    // Everything the sheet said, in the operator's own words. The mapped
    // outcome above is a summary of this, never a replacement for it.
    const remark = [
      status && `Status: ${status}`,
      !blank(g(r, 'Outcome Note')) && `Note: ${g(r, 'Outcome Note')}`,
      !blank(g(r, 'Reminder Reason')) && `Reminder: ${g(r, 'Reminder Reason')}`,
      !blank(g(r, 'Segment Label')) && `Segment: ${g(r, 'Segment Label')}`,
      !blank(g(r, 'Lead Origin')) && `Origin: ${g(r, 'Lead Origin')}`,
      !blank(g(r, 'Follow-up Number')) && `Called from: ${g(r, 'Follow-up Number')}`,
    ].filter(Boolean).join(' | ') || null;

    const completed = isoStamp(g(r, 'Outcome Saved At')) ?? isoStamp(g(r, 'Last Contacted'));
    const attemptNo = Math.max(1, Number(attempt) || 1);

    await client.query(
      `insert into followups
         (customer_id, kind, order_id, due_at, owner_id, outcome, remark,
          next_due_at, completed_at, attempt_no)
       values ($1,'order',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [cust, order.id, `${selection}T00:00:00${IST}`,
       byFirstToken[norm(g(r, 'Assigned To'))] ?? null,
       outcome, remark,
       isoStamp(g(r, 'Next Follow-up Date')), completed, attemptNo]);

    bump(outcome ? `outcome_${outcome}` : 'outcome_not_recorded');
    if (!byFirstToken[norm(g(r, 'Assigned To'))]) bump('unassigned_followup');
    bump('followups');
  }

  for (const r of rejects)
    await client.query(
      `insert into import_rejects (source, source_row_no, reason, payload) values ($1,$2,$3,$4)`,
      [SOURCE, r.rowNo, r.reason, JSON.stringify(r.payload)]);

  console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN (nothing written)'}\n`);
  console.log('loaded:');
  for (const k of Object.keys(stats).sort()) console.log(`  ${k.padEnd(34)} ${stats[k]}`);
  const byReason = {};
  for (const r of rejects) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  console.log(`\nrejects (${rejects.length}):`);
  for (const k of Object.keys(byReason).sort()) console.log(`  ${k.padEnd(38)} ${byReason[k]}`);

  const v = await client.query(`
    select (select count(*) from followups)                              as followups_total,
           (select count(*) from followups where kind='order')           as from_queue,
           (select count(*) from followups where outcome='order_placed') as converted,
           (select count(distinct customer_id) from followups)           as customers_touched,
           (select count(*) from followups where completed_at is null)   as never_completed`);
  console.log('\nin the database now:');
  console.table(v.rows);

  if (COMMIT) await client.query('commit');
  else { await client.query('rollback'); console.log('rolled back — re-run with --commit to keep it'); }
  await client.end();
}

main().catch(async (e) => {
  console.error('\nimport failed:', e.message);
  try { await client.query('rollback'); await client.end(); } catch {}
  process.exit(1);
});
