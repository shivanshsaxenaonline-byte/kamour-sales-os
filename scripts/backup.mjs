// Local logical backup. Dumps every public table to newline-delimited JSON.
//
//   node scripts/backup.mjs              -> backups/<timestamp>/
//   node scripts/backup.mjs --restore X  -> reload from backups/X (DESTRUCTIVE)
//
// This is not pg_dump — it captures DATA only, not schema. That is deliberate
// and sufficient: the schema lives in supabase/migrations/, which is versioned
// in git. A full restore is `migrate up` on an empty database, then --restore.
//
// Phase 0 step 6 wants this in R2 on a schedule. Until those credentials exist,
// running it locally is the difference between "recoverable" and "not".

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // date -> string, never a JS Date (D-016)

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const RESTORE = process.argv.includes('--restore')
  ? process.argv[process.argv.indexOf('--restore') + 1]
  : null;

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 600_000,
  application_name: 'kamour-backup',
});

// Parent before child, so foreign keys resolve on the way back in.
const ORDER = [
  'users', 'lead_sources', 'lead_statuses', 'concerns', 'couriers',
  'payment_modes', 'lost_reasons', 'cancel_reasons', 'products', 'combo_items',
  'course_plans', 'customers', 'customer_identities', 'leads', 'consultations',
  'prescriptions', 'prescription_items', 'orders', 'order_items', 'followups',
  'attendance', 'absence_events', 'assignments', 'wa_conversations', 'ad_spend',
  'audit_log', 'webhook_events', 'import_rejects', 'schema_migrations',
];

async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join('backups', stamp);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { created_at: new Date().toISOString(), tables: {} };
  let total = 0;

  for (const t of ORDER) {
    const exists = await c.query(
      `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=$1 and c.relkind='r'`, [t]);
    if (!exists.rowCount) continue;

    const { rows } = await c.query(`select * from public.${t}`);
    fs.writeFileSync(
      path.join(dir, `${t}.ndjson`),
      rows.map((r) => JSON.stringify(r)).join('\n'),
      'utf8');
    manifest.tables[t] = rows.length;
    total += rows.length;
    console.log(`  ${t.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
  }

  // auth.users too — without it every users.id foreign key dangles on restore.
  const au = await c.query(
    `select id, instance_id, aud, role, email, encrypted_password,
            email_confirmed_at, created_at, updated_at,
            raw_app_meta_data, raw_user_meta_data
     from auth.users`);
  fs.writeFileSync(path.join(dir, 'auth_users.ndjson'),
    au.rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  manifest.tables['auth.users'] = au.rowCount;
  console.log(`  ${'auth.users'.padEnd(24)} ${String(au.rowCount).padStart(7)} rows`);

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const size = fs.readdirSync(dir)
    .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  console.log(`\n${total} rows -> ${dir}  (${(size / 1e6).toFixed(1)} MB)`);
  console.log('Schema is not in here — it lives in supabase/migrations/. Keep both.');
  return dir;
}

async function restore(dir) {
  if (!fs.existsSync(dir)) throw new Error(`no such backup: ${dir}`);
  console.log(`restoring from ${dir} — this DELETES current data\n`);
  await c.query('begin');
  await c.query('set local session_replication_role = replica'); // defer FK + triggers

  for (const t of [...ORDER].reverse()) {
    const f = path.join(dir, `${t}.ndjson`);
    if (fs.existsSync(f)) await c.query(`delete from public.${t}`);
  }

  for (const t of ORDER) {
    const f = path.join(dir, `${t}.ndjson`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) continue;
    for (const line of lines) {
      const row = JSON.parse(line);
      const cols = Object.keys(row);
      // generated columns cannot be written back
      const skip = new Set(['next_followup_at', 'line_total']);
      const use = cols.filter((k) => !skip.has(k));
      await c.query(
        `insert into public.${t} (${use.map((k) => `"${k}"`).join(',')})
         values (${use.map((_, i) => `$${i + 1}`)}) on conflict do nothing`,
        use.map((k) => row[k]));
    }
    console.log(`  ${t.padEnd(24)} ${String(lines.length).padStart(7)} rows`);
  }

  await c.query('commit');
  console.log('\nrestored');
}

(async () => {
  await c.connect();
  try {
    if (RESTORE) await restore(RESTORE);
    else await backup();
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
