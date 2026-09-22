// The sheet's two "never confirmed" marks, checked against the live base.
//
//   node scripts/test-unconfirmed-orders.mjs
//
// Read-only. It re-reads both tabs of the Medicine Order sheet and asserts what
// the sync promises: an order the floor ticked as pending, or a row the Pending
// Confirmation tab marks Cancelled, has no order in the database and therefore
// nobody in the calling lists. Run it after a sync, or any time the floor asks
// why somebody is or is not on a rep's list.
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const SHEET_ID = '1TVYa2UMtK8JIAinIBfhIlo_AkaOUlYZHtkJqzj7Fwos';
const tab = (name) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;

let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

// Same parsing rules as src/lib/sheets/order-sync.ts — a test that normalised
// differently would pass while the sync was wrong.
const norm = (v) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toE164 = (v) => {
  let d = (v ?? '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
};
const amount = (v) => {
  const t = (v ?? '').replace(/[^\d.-]/g, '');
  return t ? Number(t) : null;
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const day = (v) => {
  const t = (v ?? '').trim();
  let m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
  }
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
async function rows(name) {
  const response = await fetch(tab(name), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${name}: sheet_fetch_${response.status}`);
  const matrix = parseCsv((await response.text()).replace(/^﻿/, ''));
  const headers = (matrix[0] ?? []).map((h) => h.trim());
  return matrix.slice(1)
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-unconfirmed-test' });

try {
  await db.connect();
  const [main, pendingTab] = await Promise.all([
    rows('Medicine Order Record - AP+TA+S'),
    rows('Pending Confirmation Medicine Order - AP+TA+SS'),
  ]);

  const ticked = main.filter((r) => /^true$/i.test(r['Pending Status'] ?? ''));
  const cancelled = pendingTab.filter((r) => norm(r['Confirmation Status']) === 'cancelled');
  console.log(`sheet: ${main.length} order rows, ${ticked.length} ticked pending; `
    + `holding pen: ${pendingTab.length} rows, ${cancelled.length} cancelled\n`);

  // An order is the same order in all three places when the customer, the day
  // and the amount agree.
  const order = async (phone, orderDay, orderAmount) => (await db.query(
    `select o.id, o.stage from orders o join customers cu on cu.id = o.customer_id
     where cu.phone_e164 = $1 and (o.created_at at time zone 'Asia/Kolkata')::date = $2::date
       and o.amount = $3`, [phone, orderDay, orderAmount])).rows;

  for (const row of ticked) {
    const phone = toE164(row['Contact Number']);
    const when = day(row['Date of Order']);
    const value = amount(row['Order Amount']);
    const name = row['Customer Name'] || 'unnamed';
    if (!phone || !when || value == null) {
      // Half-filled pending rows are normal — Nikhil's lost its number. What
      // matters is that such a row cannot become an order, which it cannot:
      // the sync reads the tick before it reads anything else.
      console.log(`SKIP ${name} — ticked row is incomplete, nothing to match`);
      continue;
    }
    const found = await order(phone, when, value);
    check(`ticked: ${name} has no order`, found.length === 0,
      found.map((o) => `${o.id}/${o.stage}`).join(' '));
  }

  for (const row of cancelled) {
    const phone = toE164(row['Contact Number']);
    const when = day(row['Date of Order']);
    const value = amount(row['Order Amount']);
    const name = row['Customer Name']?.trim() || 'unnamed';
    if (!phone || !when || value == null) {
      console.log(`SKIP ${name} — cancelled row is incomplete, nothing to match`);
      continue;
    }
    const found = await order(phone, when, value);
    check(`cancelled: ${name} ${when} has no order`, found.length === 0,
      found.map((o) => `${o.id}/${o.stage}`).join(' '));
  }

  // The sync can no longer write this stage, so anything holding it is an order
  // that slipped past both marks — or one somebody set by hand in the workspace.
  const stuck = await db.query(`select cu.full_name, cu.phone_e164, o.amount
    from orders o join customers cu on cu.id = o.customer_id where o.stage = 'pending_confirm'`);
  check('no order is sitting at pending_confirm', stuck.rows.length === 0,
    stuck.rows.map((r) => `${r.full_name} ${r.phone_e164} ${r.amount}`).join(' | '));

  // And nobody who lost their only order is still reachable by the floor.
  const ghosts = await db.query(`select count(*)::int n from v_rrr_queue q
    where not exists (select 1 from orders o where o.customer_id = q.customer_id)`);
  check('no customer is in the RRR queue without an order', ghosts.rows[0].n === 0,
    `count=${ghosts.rows[0].n}`);
} catch (error) {
  console.error(error.message);
  failures++;
} finally {
  await db.end();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
