// Fill leads.zoho_record_id for everything the original import loaded.
//
//   node scripts/backfill-zoho-lead-ids.mjs              newest export in data/incoming/zoho
//   node scripts/backfill-zoho-lead-ids.mjs --file X.csv a specific one
//   node scripts/backfill-zoho-lead-ids.mjs --dry-run    count, change nothing
//
// Why this is possible at all: import-zoho.mjs set leads.created_at from the
// record's own Created Time, and customer_identities already ties the record to
// a customer by phone. So (customer, created_at) names the lead a given Zoho
// record produced, and the export still on disk carries all three columns.
//
// Deliberately conservative. A pairing is written ONLY when it is unique from
// both directions — one CSV row for that (phone, created_at), and one lead for
// that (customer, created_at). Anything ambiguous is counted and left null
// rather than guessed: a wrong id here would send a future status edit to
// somebody else's lead, which is worse than leaving the row unlinked.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);

for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const DRY = process.argv.includes('--dry-run');
const DIR = 'data/incoming/zoho';
// Every export, not just the newest: the first pull is the full 52k and the
// later ones are incremental slices, so any single file on its own would leave
// most of the base unlinked. Read oldest first so a record that appears twice
// keeps its latest spelling.
const FILES = process.argv.includes('--file')
  ? [process.argv[process.argv.indexOf('--file') + 1]]
  : fs.readdirSync(DIR).filter((f) => f.endsWith('.csv')).sort().map((f) => path.join(DIR, f));

// Same parser and transforms as import-zoho.mjs — a different reading of the
// same file would pair rows the importer never created.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\r') {}
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const toE164 = (raw) => {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
};
const ts = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 19).replace(' ', 'T') + 'Z' : null);

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 600_000,
  application_name: 'kamour-zoho-backfill',
});

async function main() {
  // (phone, created_at) -> record id, across every export. A key that two
  // DIFFERENT record ids claim is unusable and is marked null: two records at
  // the same instant for one person cannot be told apart by this key. The same
  // id arriving twice (the full export plus an incremental pull) is not a
  // collision — it is the same fact stated twice.
  const seen = new Map();
  let read = 0;
  for (const file of FILES) {
    const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
    const head = rows.shift().map((h) => h.trim());
    const col = (name) => head.indexOf(name);
    const iId = col('Record Id'), iPhone = col('Contact Number'), iCreated = col('Created Time');
    if (iId < 0 || iPhone < 0 || iCreated < 0) {
      console.log(`  skipped ${file} — no Record Id / Contact Number / Created Time`);
      continue;
    }
    let used = 0;
    for (const r of rows) {
      const id = (r[iId] || '').trim();
      const phone = toE164(r[iPhone]);
      const created = ts(r[iCreated]);
      if (!id || !phone || !created) continue;
      const key = `${phone}|${created}`;
      const prior = seen.get(key);
      if (prior === undefined) seen.set(key, id);
      else if (prior !== id) seen.set(key, null);     // genuinely ambiguous
      used++;
    }
    read += rows.length;
    console.log(`  ${String(rows.length).padStart(6)} rows  ${used} keyed  ${file}`);
  }

  const usable = [...seen.entries()].filter(([, id]) => id);
  const collided = seen.size - usable.length;
  console.log(`\n${read} export rows -> ${usable.length} uniquely keyed, ${collided} dropped as ambiguous\n`);

  await c.connect();

  await c.query('begin');
  await c.query(`create temp table zmap (external_id text, phone text, created_at timestamptz) on commit drop`);

  const CHUNK = 5000;
  for (let i = 0; i < usable.length; i += CHUNK) {
    const slice = usable.slice(i, i + CHUNK);
    const vals = [], params = [];
    slice.forEach(([key, id], n) => {
      const [phone, created] = key.split('|');
      vals.push(`($${n * 3 + 1},$${n * 3 + 2},$${n * 3 + 3}::timestamptz)`);
      params.push(id, phone, created);
    });
    await c.query(`insert into zmap (external_id, phone, created_at) values ${vals.join(',')}`, params);
  }
  console.log(`staged ${usable.length} pairs`);

  // Only where the lead side is unique too.
  const { rows: [pre] } = await c.query(`
    select count(*) filter (where l.zoho_record_id is null) as unlinked,
           count(*) as total
    from leads l`);
  console.log(`leads: ${pre.total} total, ${pre.unlinked} unlinked before\n`);

  const sql = `
    with candidate as (
      select l.id as lead_id, m.external_id,
             count(*) over (partition by l.id)          as leads_per_record,
             count(*) over (partition by m.external_id) as records_per_lead
      from zmap m
      join customers c on c.phone_e164 = m.phone
      join leads l on l.customer_id = c.id and l.created_at = m.created_at
      where l.zoho_record_id is null
    )
    update leads l
       set zoho_record_id = candidate.external_id
      from candidate
     where l.id = candidate.lead_id
       and candidate.leads_per_record = 1
       and candidate.records_per_lead = 1`;

  if (DRY) {
    const { rows: [n] } = await c.query(`
      with candidate as (
        select l.id as lead_id, m.external_id,
               count(*) over (partition by l.id)          as leads_per_record,
               count(*) over (partition by m.external_id) as records_per_lead
        from zmap m
        join customers c on c.phone_e164 = m.phone
        join leads l on l.customer_id = c.id and l.created_at = m.created_at
        where l.zoho_record_id is null
      )
      select count(*) n from candidate
       where leads_per_record = 1 and records_per_lead = 1`);
    console.log(`would link ${n.n} leads`);
    await c.query('rollback');
  } else {
    const res = await c.query(sql);
    console.log(`linked ${res.rowCount} leads`);
    await c.query('commit');
  }

  const { rows: [post] } = await c.query(`
    select count(*) filter (where zoho_record_id is not null) as linked,
           count(*) filter (where zoho_record_id is null)     as unlinked
    from leads`);
  console.log(`\nafter: ${post.linked} linked, ${post.unlinked} unlinked`);
  console.log('unlinked leads stay unlinked on purpose — a future Zoho edit for');
  console.log('one of those creates a new lead rather than overwriting a guess.');

  await c.end();
}

main().catch(async (e) => {
  console.error('\nfailed:', e.message);
  try { await c.query('rollback'); } catch {}
  try { await c.end(); } catch {}
  process.exit(1);
});
