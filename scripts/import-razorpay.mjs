// Pull payments from Razorpay into razorpay_payments.
//
//   node scripts/import-razorpay.mjs                    dry run — last 90 days
//   node scripts/import-razorpay.mjs --commit           write them
//   node scripts/import-razorpay.mjs --from 2023-09-01 --to 2026-09-11 --commit
//   node scripts/import-razorpay.mjs --all --commit     everything Razorpay still holds
//
// Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.local. Read-only
// against Razorpay: this only ever calls GET /v1/payments.
//
// Safe to re-run. Rows are upserted on the Razorpay payment id, and a row that
// somebody has already matched to an order keeps its match — the gateway's
// facts are refreshed, the human's decision is not overwritten.
//
// Razorpay's API pages with skip/count and caps count at 100. The `from`/`to`
// filters are unix seconds on the payment's created_at.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // date -> string, never a JS Date (D-016)

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

const COMMIT = flag('--commit');
const ALL = flag('--all');

const KEY = process.env.RAZORPAY_KEY_ID;
const SECRET = process.env.RAZORPAY_KEY_SECRET;
if (!KEY || !SECRET) {
  console.error(
    'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from .env.local.\n' +
    'Razorpay Dashboard > Account & Settings > API Keys > Generate Test/Live Key.\n' +
    'The secret is shown once — copy it then.'
  );
  process.exit(1);
}

// Razorpay keeps payments for a long time but the API will not span an
// unbounded range in one call, so --all walks year by year from 2022.
const day = 86_400;
const now = Math.floor(Date.now() / 1000);
const toUnix = (s) => Math.floor(new Date(`${s}T00:00:00+05:30`).getTime() / 1000);

let FROM;
let TO = value('--to') ? toUnix(value('--to')) + day : now;
if (ALL) FROM = toUnix('2022-01-01');
else if (value('--from')) FROM = toUnix(value('--from'));
else FROM = now - 90 * day;

const auth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');

/** One window of payments, paged. Razorpay caps `count` at 100. */
async function fetchWindow(from, to) {
  const out = [];
  let skip = 0;
  for (;;) {
    const url = `https://api.razorpay.com/v1/payments?from=${from}&to=${to}&count=100&skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Razorpay ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    }
    const page = await res.json();
    const items = page.items ?? [];
    out.push(...items);
    process.stdout.write(`\r  fetched ${out.length}…`);
    if (items.length < 100) break;
    skip += 100;
    // Razorpay's skip window tops out; step the date range instead of paging
    // past it, or the tail of a busy year is silently never returned.
    if (skip >= 10_000) {
      const last = items[items.length - 1].created_at;
      console.log(`\n  (10k page limit reached, continuing from ${new Date(last * 1000).toISOString().slice(0, 10)})`);
      out.push(...(await fetchWindow(from, last)));
      break;
    }
  }
  process.stdout.write('\n');
  return out;
}

const rupees = (paise) => (paise == null ? null : Math.round(paise) / 100);

async function main() {
  console.log(
    `Razorpay payments from ${new Date(FROM * 1000).toISOString().slice(0, 10)} ` +
    `to ${new Date(TO * 1000).toISOString().slice(0, 10)}` +
    (COMMIT ? '' : '  (dry run — nothing will be written)')
  );

  // Year at a time, so one enormous window never trips the API's own limits.
  const all = [];
  const seen = new Set();
  for (let start = FROM; start < TO; start += 365 * day) {
    const end = Math.min(start + 365 * day, TO);
    console.log(`window ${new Date(start * 1000).toISOString().slice(0, 10)} → ${new Date(end * 1000).toISOString().slice(0, 10)}`);
    for (const p of await fetchWindow(start, end)) {
      if (!seen.has(p.id)) { seen.add(p.id); all.push(p); }
    }
  }

  if (!all.length) {
    console.log('\nNo payments in that range.');
    return;
  }

  const byStatus = {};
  let captured = 0;
  for (const p of all) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    if (p.status === 'captured') captured += p.amount;
  }
  console.log(`\n${all.length} payments`);
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)} ${n}`);
  }
  console.log(`  captured total: ₹${rupees(captured).toLocaleString('en-IN')}`);

  const noPhone = all.filter((p) => !p.contact).length;
  if (noPhone) console.log(`  ${noPhone} with no contact number — they will store with phone_e164 NULL`);

  if (!COMMIT) {
    console.log('\nDry run. Re-run with --commit to write.');
    console.log('First three, as they would be stored:');
    for (const p of all.slice(0, 3)) {
      console.log(`  ${p.id}  ₹${rupees(p.amount)}  ${p.status}  ${p.method ?? '—'}  ` +
        `${p.contact ?? '—'}  ${new Date(p.created_at * 1000).toISOString()}`);
    }
    return;
  }

  const c = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120_000,
    application_name: 'razorpay-backfill',
  });
  await c.connect();
  await c.query('begin');
  try {
    let written = 0;
    for (const p of all) {
      await c.query(
        `insert into razorpay_payments (
           id, razorpay_order_id, invoice_id, status, method, captured,
           amount, amount_refunded, fee, tax, currency,
           email, contact_raw, vpa, bank, wallet, card_last4, description,
           notes, acquirer_data, error_code, error_description,
           paid_at, raw, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22, to_timestamp($23), $24, 'backfill')
         on conflict (id) do update set
           status            = excluded.status,
           method            = excluded.method,
           captured          = excluded.captured,
           amount            = excluded.amount,
           amount_refunded   = excluded.amount_refunded,
           fee               = excluded.fee,
           tax               = excluded.tax,
           email             = excluded.email,
           contact_raw       = excluded.contact_raw,
           vpa               = excluded.vpa,
           bank              = excluded.bank,
           wallet            = excluded.wallet,
           card_last4        = excluded.card_last4,
           description       = excluded.description,
           notes             = excluded.notes,
           acquirer_data     = excluded.acquirer_data,
           error_code        = excluded.error_code,
           error_description = excluded.error_description,
           paid_at           = excluded.paid_at,
           raw               = excluded.raw`,
        // order_id / customer_id / matched_at are deliberately absent from the
        // update list: a re-run refreshes what Razorpay knows and never
        // disturbs a link a person already made.
        [
          p.id, p.order_id ?? null, p.invoice_id ?? null, p.status, p.method ?? null,
          !!p.captured, rupees(p.amount), rupees(p.amount_refunded ?? 0),
          rupees(p.fee), rupees(p.tax), p.currency ?? 'INR',
          p.email ?? null, p.contact ? String(p.contact) : null,
          p.vpa ?? null, p.bank ?? null, p.wallet ?? null,
          p.card?.last4 ?? null, p.description ?? null,
          p.notes ?? {}, p.acquirer_data ?? {},
          p.error_code ?? null, p.error_description ?? null,
          p.created_at, p,
        ]
      );
      written++;
    }
    await c.query('commit');
    console.log(`\n${written} payments stored.`);

    const { rows: [s] } = await c.query(
      `select count(*) as total,
              count(*) filter (where phone_e164 is not null) as with_phone,
              count(*) filter (where matched_at is null) as unmatched
       from razorpay_payments`);
    console.log(`razorpay_payments now: ${s.total} rows, ${s.with_phone} with a usable phone, ${s.unmatched} not yet linked to an order.`);
    console.log('Next: select * from v_razorpay_unmatched — it lists the orders each payment could be.');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
