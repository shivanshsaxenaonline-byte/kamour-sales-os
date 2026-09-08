// Import the full Zoho "Consultation Leads" export — all 52,177 rows.
//
//   node scripts/import-zoho.mjs --limit 2000   try a slice first
//   node scripts/import-zoho.mjs                the lot
//
// Batched at 5,000 with VACUUM ANALYZE between, per PROJECT.md: Supabase flips
// the project to read-only if a single load exceeds ~1.5x current DB size.
// Database size is logged after every batch.
//
// Idempotent. `customer_identities(system='zoho', external_id)` records every
// Record Id already loaded, so a re-run skips them and picks up where it stopped.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);

const FILE = 'data/incoming/zoho/Consultation_Lead_2026_09_07.csv';
const BATCH = 5000;
const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;

for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 600_000,
  application_name: 'kamour-zoho-import',
});

// ---------------------------------------------------------------- csv
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

// ------------------------------------------------------------ transforms
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (v) => !v || ['-', '--', 'null', 'n/a', 'na'].includes(v.trim().toLowerCase());

const toE164 = (raw) => {
  let d = (raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
};

// Zoho writes ISO already: "2023-01-18 13:37:12"
const ts = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 19).replace(' ', 'T') + 'Z' : null);
const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 10) : null);

// "Pankaj Chauhan WATI" and "Pankaj chauhan" are one person. The channel
// suffix is noise on the name, not part of it.
const cleanName = (v) =>
  (v || '').replace(/\s*\b(wati|whatsapp|elementor)\b\s*$/i, '').replace(/\s+/g, ' ').trim();

// The column holds birth years, 0, and three-digit typos. Anything outside a
// plausible range becomes null rather than being clamped into a wrong number.
const age = (v) => {
  const n = Number((v || '').replace(/\D/g, ''));
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : null;
};

const gender = (v) => {
  const n = norm(v);
  if (['male', 'm', 'mail', 'maleq'].includes(n)) return 'male';
  if (['female', 'f', 'femal', 'feamle', 'femail'].includes(n)) return 'female';
  return null;   // "Job", "-Gender-" and friends are not genders
};

// ------------------------------------------------------------ bulk insert
async function bulk(table, cols, rows, conflict = '') {
  if (!rows.length) return;
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const values = slice.map((r) => {
      const ph = r.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    await c.query(
      `insert into ${table} (${cols.map((x) => `"${x}"`).join(',')})
       values ${values.join(',')} ${conflict}`, params);
  }
}

const stats = {}; const bump = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n);

// ---------------------------------------------------------------- main
async function main() {
  await c.connect();

  console.log('reading csv...');
  const raw = parseCsv(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
  const header = raw[0].map((h) => h.trim());
  const H = {}; header.forEach((h, i) => { H[norm(h)] = i; });
  const g = (r, name) => { const i = H[norm(name)]; return i == null ? '' : (r[i] ?? '').trim(); };

  let body = raw.slice(1).filter((r) => r.some((x) => (x || '').trim()));
  // Oldest first: the FIRST time a phone appears is its earliest contact, which
  // fixes original_owner_id without a separate global pass. (D-024)
  body.sort((a, b) => (g(a, 'Created Time') || '').localeCompare(g(b, 'Created Time') || ''));
  if (LIMIT < body.length) body = body.slice(0, LIMIT);
  console.log(`${body.length} rows\n`);

  // ---- 1. people referenced in the data ----
  // Former staff become inactive records so ~15k follow-ups keep their author (D-039).
  const NAME_TO_USER = {
    shreyansh: 'Shreyansh', tejas: 'Tejasv', tejasv: 'Tejasv',
    ashutoshpal: 'Ashutosh',                       // ours (D-038)
  };
  const FORMER = ['Anshu Chauhan', 'Tripti Chauhan', 'Harshal Deep', 'Nisha',
    'Saloni Srivastava', 'Varun Kumar', 'Priyanka', 'Prerna Agarwal', 'Ashutosh Saxena'];

  for (const name of FORMER) {
    const slug = norm(name);
    const email = `${slug}@kamour.local`;
    const ex = await c.query('select id from auth.users where email=$1', [email]);
    let id = ex.rows[0]?.id;
    if (!id) {
      id = (await c.query(
        `insert into auth.users (id,instance_id,aud,role,email,encrypted_password,
           email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,
           confirmation_token,recovery_token,email_change_token_new,
           email_change_token_current,email_change)
         values (gen_random_uuid(),'00000000-0000-0000-0000-000000000000','authenticated',
           'authenticated',$1,null,now(),now(),now(),
           '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,'','','','','')
         returning id`, [email])).rows[0].id;
    }
    await c.query(
      `insert into users (id, full_name, role, is_active) values ($1,$2,'sales_exec',false)
       on conflict (id) do update set is_active=false`, [id, name]);
  }
  console.log(`former staff: ${FORMER.length} inactive records ready`);

  const users = (await c.query('select id, full_name from users')).rows;
  const byName = Object.fromEntries(users.map((u) => [norm(u.full_name), u.id]));
  const userId = (raw) => {
    const n = norm(raw);
    if (!n) return null;
    if (NAME_TO_USER[n]) return byName[norm(NAME_TO_USER[n])] ?? null;
    return byName[n] ?? null;
  };

  // ---- 2. lookups the export needs ----
  const srcSeen = [...new Set(body.map((r) => g(r, 'Lead Source')).filter((x) => x && !blank(x)))];
  for (const s of srcSeen) {
    // "Click Funnels"/"ClickFunnels" collapse; "Wati Faceebook" is a typo of Facebook
    const code = norm(s).replace('faceebook', 'facebook');
    await c.query(
      `insert into lead_sources (code,label_en,sort_order) values ($1,$2,200)
       on conflict (code) do nothing`, [code, s]);
  }
  const dzSeen = [...new Set(body.map((r) => g(r, 'Diseases')).filter((x) => x && !blank(x)))];
  for (const d of dzSeen) {
    const code = norm(d).replace(/s$/, '');   // Stomach Problem(s), Male Problem(s)
    await c.query(
      `insert into concerns (code,label_en,sort_order) values ($1,$2,200)
       on conflict (code) do nothing`, [code, d]);
  }
  const sources = Object.fromEntries((await c.query('select id,code from lead_sources')).rows.map((r) => [r.code, r.id]));
  const concerns = Object.fromEntries((await c.query('select id,code from concerns')).rows.map((r) => [r.code, r.id]));
  const statuses = Object.fromEntries((await c.query('select id,code from lead_statuses')).rows.map((r) => [r.code, r.id]));
  console.log(`lookups: ${Object.keys(sources).length} sources, ${Object.keys(concerns).length} concerns\n`);

  const STATUS = { needfollowup: 'contacted', converted: 'converted' };

  // ---- 3. skip anything already imported ----
  const done = new Set((await c.query(
    `select external_id from customer_identities where system='zoho'`)).rows.map((r) => r.external_id));
  if (done.size) console.log(`${done.size} rows already imported — skipping those\n`);

  // running memory of each phone, so current_owner can be fixed at the end
  const lastOwner = new Map();
  const rejects = [];

  for (let start = 0; start < body.length; start += BATCH) {
    const slice = body.slice(start, start + BATCH).filter((r) => !done.has(g(r, 'Record Id')));
    if (!slice.length) continue;

    await c.query('begin');

    // -- customers already present?
    const phones = [...new Set(slice.map((r) => toE164(g(r, 'Contact Number'))).filter(Boolean))];
    const found = await c.query(
      'select id, phone_e164 from customers where phone_e164 = any($1)', [phones]);
    const idByPhone = new Map(found.rows.map((r) => [r.phone_e164, r.id]));

    const newCustomers = [], identities = [], leads = [], follows = [];

    for (const r of slice) {
      const rec = g(r, 'Record Id');
      const phone = toE164(g(r, 'Contact Number'));
      if (!phone) { rejects.push([rec, 'unparseable_phone', g(r, 'Contact Number')]); continue; }

      const created = ts(g(r, 'Created Time')) ?? new Date().toISOString();
      const owner = userId(g(r, 'Follow-up 1 Done By'));

      let cid = idByPhone.get(phone);
      if (!cid) {
        cid = crypto.randomUUID();
        idByPhone.set(phone, cid);
        newCustomers.push([
          cid, phone, g(r, 'Contact Number'),
          toE164(g(r, 'Alternate Number')),
          cleanName(g(r, 'Customer Name')) || 'Unknown',
          blank(g(r, 'Email')) ? null : g(r, 'Email').toLowerCase(),
          gender(g(r, 'Gender')),
          age(g(r, 'Age')),
          blank(g(r, 'State')) ? null : g(r, 'State'),
          blank(g(r, 'Address')) ? null : g(r, 'Address'),   // never cleaned
          concerns[norm(g(r, 'Diseases')).replace(/s$/, '')] ?? null,
          sources[norm(g(r, 'Lead Source')).replace('faceebook', 'facebook')] ?? null,
          owner, owner, created,
        ]);
      }
      lastOwner.set(phone, owner ?? lastOwner.get(phone) ?? null);

      identities.push([crypto.randomUUID(), cid, 'zoho', rec]);

      const leadId = crypto.randomUUID();
      leads.push([
        leadId, cid,
        sources[norm(g(r, 'Lead Source')).replace('faceebook', 'facebook')] ?? sources['zoho_legacy'],
        'zoho_legacy',
        statuses[STATUS[norm(g(r, 'Lead Status'))] ?? 'new'],
        concerns[norm(g(r, 'Diseases')).replace(/s$/, '')] ?? null,
        owner,
        blank(g(r, 'UTM Source')) ? null : g(r, 'UTM Source'),
        blank(g(r, 'UTM Medium')) ? null : g(r, 'UTM Medium'),
        blank(g(r, 'UTM Campaign')) ? null : g(r, 'UTM Campaign'),
        day(g(r, 'Date of Connection')) ? ts(g(r, 'Date of Connection')) : null,
        created,
      ]);
      bump('leads');

      for (const n of [1, 2, 3, 4]) {
        const d = day(g(r, `Follow-up ${n} Date`));
        if (!d) continue;
        const remark = g(r, `Follow-up ${n} Remark`);
        follows.push([
          crypto.randomUUID(), cid, 'lead', leadId, `${d}T00:00:00Z`,
          userId(g(r, `Follow-up ${n} Done By`)),
          blank(remark) ? null : remark,
          day(g(r, `Follow-up ${n} Done On`)) ? `${day(g(r, `Follow-up ${n} Done On`))}T00:00:00Z` : `${d}T00:00:00Z`,
          n,
        ]);
        bump('followups');
      }
    }

    await bulk('customers',
      ['id','phone_e164','phone_raw','alt_phone_e164','full_name','email','gender','age','state',
       'address','primary_concern_id','first_source_id','original_owner_id','current_owner_id','created_at'],
      newCustomers, 'on conflict do nothing');
    bump('customers', newCustomers.length);

    // Re-read the ids that actually landed. `on conflict do nothing` can silently
    // skip a row (any unique index, not just the phone one), and a generated uuid
    // that was never inserted would then break every child foreign key.
    const settled = await c.query(
      'select id, phone_e164 from customers where phone_e164 = any($1)', [phones]);
    const realId = new Map(settled.rows.map((r) => [r.phone_e164, r.id]));
    const remap = new Map();                       // planned uuid -> the real one
    for (const [ph, planned] of idByPhone) {
      const actual = realId.get(ph);
      if (actual && actual !== planned) remap.set(planned, actual);
    }
    if (remap.size) {
      for (const row of identities) row[1] = remap.get(row[1]) ?? row[1];
      for (const row of leads)      row[1] = remap.get(row[1]) ?? row[1];
      for (const row of follows)    row[1] = remap.get(row[1]) ?? row[1];
      bump('remapped_customers', remap.size);
    }
    // anything still unresolved has no customer row at all — drop it, do not orphan
    const known = new Set(settled.rows.map((r) => r.id));
    const keep = (row) => known.has(row[1]);
    const dropped = identities.length - identities.filter(keep).length;
    if (dropped) bump('dropped_no_customer', dropped);

    await bulk('customer_identities', ['id','customer_id','system','external_id'],
      identities.filter(keep), 'on conflict (system, external_id) do nothing');

    await bulk('leads',
      ['id','customer_id','source_id','channel','status_id','concern_id','owner_id',
       'utm_source','utm_medium','utm_campaign','first_contacted_at','created_at'],
      leads.filter(keep), 'on conflict do nothing');

    await bulk('followups',
      ['id','customer_id','kind','lead_id','due_at','owner_id','remark','completed_at','attempt_no'],
      follows.filter(keep), 'on conflict do nothing');

    await c.query('commit');

    // VACUUM cannot run inside a transaction
    await c.query('vacuum analyze customers, leads, followups, customer_identities');
    const size = (await c.query(
      `select pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
    console.log(`  ${String(Math.min(start + BATCH, body.length)).padStart(6)}/${body.length}` +
                `  +${String(newCustomers.length).padStart(5)} customers` +
                `  +${String(leads.length).padStart(5)} leads` +
                `  +${String(follows.length).padStart(5)} follow-ups   db=${size}`);
  }

  // ---- current_owner_id = whoever touched them most recently ----
  const entries = [...lastOwner.entries()].filter(([, u]) => u);
  for (let i = 0; i < entries.length; i += 500) {
    const s = entries.slice(i, i + 500);
    await c.query(
      `update customers set current_owner_id = v.uid::uuid
       from (select unnest($1::text[]) ph, unnest($2::text[]) uid) v
       where customers.phone_e164 = v.ph`,
      [s.map((x) => x[0]), s.map((x) => x[1])]);
  }

  for (const [rec, reason, val] of rejects)
    await c.query(
      `insert into import_rejects (source, reason, payload) values ('zoho',$1,$2)`,
      [reason, JSON.stringify({ record_id: rec, value: val })]);

  console.log('\nloaded:');
  for (const k of Object.keys(stats).sort()) console.log(`  ${k.padEnd(14)} ${stats[k]}`);
  console.log(`  rejects       ${rejects.length}`);

  console.table((await c.query(`
    select (select count(*) from customers) customers,
           (select count(*) from leads) leads,
           (select count(*) from followups) followups,
           (select count(*) from customer_identities) identities,
           (select count(*) from customers where current_owner_id is null) unowned,
           pg_size_pretty(pg_database_size(current_database())) db_size`)).rows);

  await c.end();
}

main().catch(async (e) => {
  console.error('\nfailed:', e.message);
  try { await c.query('rollback'); } catch {}
  try { await c.end(); } catch {}
  process.exit(1);
});
