// Phase 0 step 1 — read-only inventory of the existing Supabase project.
// Writes docs/schema-current.md. Touches nothing. No DDL, no DML.
//
// Usage:  npm install && npm run db:inspect
// Needs:  SUPABASE_DB_URL in .env.local (Session pooler string, port 5432)

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// --- tiny .env.local reader (no dependency) -------------------------------
const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    'SUPABASE_DB_URL is not set.\n' +
      'Add it to .env.local. Supabase dashboard > Project Settings > Database >\n' +
      'Connection string > Session pooler (port 5432, IPv4-safe).'
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60_000,
  application_name: 'kamour-schema-inspect',
});

const q = async (sql, params = []) => {
  try {
    return (await client.query(sql, params)).rows;
  } catch (e) {
    return [{ __error: e.message }];
  }
};

// --- markdown helpers -----------------------------------------------------
const esc = (v) =>
  v === null || v === undefined
    ? ''
    : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function table(rows, cols) {
  if (!rows.length) return '_none_\n';
  if (rows[0].__error) return `> query failed: ${rows[0].__error}\n`;
  const keys = cols ?? Object.keys(rows[0]);
  return (
    `| ${keys.join(' | ')} |\n` +
    `|${keys.map(() => '---').join('|')}|\n` +
    rows.map((r) => `| ${keys.map((k) => esc(r[k])).join(' | ')} |`).join('\n') +
    '\n'
  );
}

// --- the inventory --------------------------------------------------------
const SQL = {
  version: `select version() as version, current_database() as db, current_user as usr`,

  dbSize: `select pg_size_pretty(pg_database_size(current_database())) as size,
                  pg_database_size(current_database()) as bytes`,

  schemas: `select nspname as schema from pg_namespace
            where nspname not like 'pg\\_%' and nspname <> 'information_schema'
            order by 1`,

  extensions: `select extname as extension, extversion as version from pg_extension order by 1`,

  // reltuples is an estimate; exact counts are run separately and only for
  // small tables, to avoid a full scan on a 50k-row legacy import.
  tables: `select c.relname as "table",
                  c.reltuples::bigint as approx_rows,
                  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
                  c.relrowsecurity as rls_enabled,
                  c.relforcerowsecurity as rls_forced
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
           order by c.reltuples desc, c.relname`,

  views: `select table_name as view, view_definition is not null as has_def
          from information_schema.views where table_schema = 'public' order by 1`,

  columns: `select table_name, ordinal_position as pos, column_name, data_type,
                   is_nullable as nullable, column_default as "default"
            from information_schema.columns
            where table_schema = 'public'
            order by table_name, ordinal_position`,

  indexes: `select tablename as "table", indexname as index, indexdef as definition
            from pg_indexes where schemaname = 'public'
            order by tablename, indexname`,

  constraints: `select conrelid::regclass::text as "table", conname as constraint,
                       pg_get_constraintdef(oid) as definition
                from pg_constraint
                where connamespace = 'public'::regnamespace
                order by 1, 2`,

  policies: `select tablename as "table", policyname as policy, cmd, roles::text as roles,
                    qual as using_expr, with_check as check_expr
             from pg_policies where schemaname = 'public'
             order by tablename, policyname`,

  functions: `select p.proname as function,
                     pg_get_function_identity_arguments(p.oid) as args,
                     l.lanname as language,
                     p.prosecdef as security_definer
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              join pg_language l on l.oid = p.prolang
              where n.nspname = 'public'
              order by 1`,

  triggers: `select event_object_table as "table", trigger_name as trigger,
                    action_timing as timing, event_manipulation as event
             from information_schema.triggers
             where trigger_schema = 'public'
             order by 1, 2`,

  enums: `select t.typname as enum, string_agg(e.enumlabel, ', '
                 order by e.enumsortorder) as values
          from pg_type t join pg_enum e on e.enumtypid = t.oid
          join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
          group by t.typname order by 1`,

  sequences: `select sequence_name as sequence from information_schema.sequences
              where sequence_schema = 'public' order by 1`,

  authUsers: `select count(*)::int as auth_users from auth.users`,

  storage: `select name as bucket, public from storage.buckets order by 1`,

  cron: `select jobname, schedule, command from cron.job order by 1`,
};

// Concepts from PROJECT.md DATA MODEL, checked against what actually exists.
const EXPECTED = [
  'customers', 'customer_identities', 'leads', 'consultations', 'prescriptions',
  'prescription_items', 'orders', 'order_items', 'followups', 'course_plans',
  'products', 'combo_items', 'users', 'roles', 'attendance', 'assignments',
  'absence_events', 'wa_conversations', 'ad_spend', 'audit_log', 'webhook_events',
  'lead_sources', 'lead_statuses', 'concerns', 'couriers', 'payment_modes',
  'lost_reasons', 'cancel_reasons',
];

const run = async () => {
  await client.connect();

  const out = {};
  for (const [k, sql] of Object.entries(SQL)) out[k] = await q(sql);

  const tables = out.tables.filter((r) => !r.__error);
  const tableNames = new Set(tables.map((r) => r.table));

  // Exact counts, but only where the estimate is small enough that a
  // count(*) is cheap. Anything bigger keeps the estimate.
  const exact = [];
  for (const t of tables) {
    if (t.approx_rows >= 0 && t.approx_rows < 50_000) {
      const r = await q(`select count(*)::int as n from public."${t.table}"`);
      if (!r[0]?.__error) exact.push({ table: t.table, exact_rows: r[0].n });
    }
  }
  const exactBy = Object.fromEntries(exact.map((e) => [e.table, e.exact_rows]));

  // Columns grouped per table.
  const colsBy = {};
  for (const c of out.columns.filter((r) => !r.__error)) {
    (colsBy[c.table_name] ??= []).push(c);
  }

  const present = EXPECTED.filter((t) => tableNames.has(t));
  const missing = EXPECTED.filter((t) => !tableNames.has(t));
  const unexpected = [...tableNames].filter((t) => !EXPECTED.includes(t));

  const noRls = tables.filter((t) => !t.rls_enabled).map((t) => t.table);
  const policied = new Set(out.policies.filter((p) => !p.__error).map((p) => p.table));
  const rlsOnNoPolicy = tables
    .filter((t) => t.rls_enabled && !policied.has(t.table))
    .map((t) => t.table);

  const ts = new Date().toISOString();
  const L = [];
  L.push('# schema-current.md');
  L.push('');
  L.push(`Generated by \`npm run db:inspect\` at ${ts}. **Read-only inventory — nothing was changed.**`);
  L.push('');
  L.push(`- ${out.version[0]?.db ?? '?'} as \`${out.version[0]?.usr ?? '?'}\``);
  L.push(`- ${out.version[0]?.version ?? '?'}`);
  L.push(`- \`pg_database_size()\` = **${out.dbSize[0]?.size ?? '?'}** (${out.dbSize[0]?.bytes ?? '?'} bytes)`);
  L.push(`- \`auth.users\` = ${out.authUsers[0]?.auth_users ?? 'n/a'}`);
  L.push('');

  L.push('## Findings');
  L.push('');
  L.push(`**DATA MODEL concepts present (${present.length}/${EXPECTED.length}):** ${present.join(', ') || '_none_'}`);
  L.push('');
  L.push(`**Missing:** ${missing.join(', ') || '_none_'}`);
  L.push('');
  L.push(`**Tables not in the target model (inspect before assuming they are junk):** ${unexpected.join(', ') || '_none_'}`);
  L.push('');
  L.push(`**RLS disabled on:** ${noRls.join(', ') || '_none_'}`);
  L.push('');
  L.push(`**RLS enabled but zero policies (reads return nothing — easy to mistake for an empty table):** ${rlsOnNoPolicy.join(', ') || '_none_'}`);
  L.push('');

  L.push('## Tables');
  L.push('');
  L.push(
    table(
      tables.map((t) => ({
        table: t.table,
        approx_rows: t.approx_rows,
        exact_rows: exactBy[t.table] ?? '(estimate only)',
        total_size: t.total_size,
        rls: t.rls_enabled ? (t.rls_forced ? 'on+forced' : 'on') : 'OFF',
      }))
    )
  );

  const section = (title, rows, cols) => {
    L.push(`## ${title}`);
    L.push('');
    L.push(table(rows, cols));
    L.push('');
  };

  section('Views', out.views);
  section('Enums', out.enums);
  section('Indexes', out.indexes);
  section('Constraints', out.constraints);
  section('RLS policies', out.policies);
  section('Functions', out.functions);
  section('Triggers', out.triggers);
  section('Sequences', out.sequences);
  section('Extensions', out.extensions);
  section('Schemas', out.schemas);
  section('Storage buckets', out.storage);
  section('Cron jobs', out.cron);

  L.push('## Columns');
  L.push('');
  for (const t of Object.keys(colsBy).sort()) {
    L.push(`### \`${t}\``);
    L.push('');
    L.push(table(colsBy[t], ['pos', 'column_name', 'data_type', 'nullable', 'default']));
    L.push('');
  }

  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(path.join('docs', 'schema-current.md'), L.join('\n'), 'utf8');

  await client.end();

  console.log('Wrote docs/schema-current.md');
  console.log(`  tables: ${tables.length}   db size: ${out.dbSize[0]?.size}`);
  console.log(`  present: ${present.length}/${EXPECTED.length}   missing: ${missing.length}`);
  if (unexpected.length) console.log(`  unexpected tables: ${unexpected.join(', ')}`);
  if (noRls.length) console.log(`  RLS OFF on: ${noRls.join(', ')}`);
};

run().catch(async (e) => {
  console.error('Inspection failed:', e.message);
  try { await client.end(); } catch {}
  process.exit(1);
});
