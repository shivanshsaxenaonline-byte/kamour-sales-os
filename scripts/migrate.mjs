// Migration runner. Each migration runs inside a transaction and is recorded
// in public.schema_migrations, so re-running is a no-op.
//
//   node scripts/migrate.mjs up            apply all pending
//   node scripts/migrate.mjs status        list applied / pending
//   node scripts/migrate.mjs down 009      roll back one migration
//   node scripts/migrate.mjs down --all    roll back everything, newest first

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL missing from .env.local');
  process.exit(1);
}

const DIR = path.resolve('supabase/migrations');
const all = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300_000,
  application_name: 'kamour-migrate',
});

const [cmd = 'status', arg] = process.argv.slice(2);

const applied = async () =>
  (await client.query('select version from schema_migrations order by version'))
    .rows.map((r) => r.version);

const run = async () => {
  await client.connect();
  await client.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )`);

  const done = new Set(await applied());

  if (cmd === 'status') {
    for (const f of all) {
      console.log(`${done.has(f) ? '  applied ' : '  PENDING '} ${f}`);
    }
    return;
  }

  if (cmd === 'up') {
    const pending = all.filter((f) => !done.has(f));
    if (!pending.length) return console.log('Nothing pending.');
    for (const f of pending) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      process.stdout.write(`applying ${f} ... `);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values ($1)', [f]);
        await client.query('commit');
        console.log('ok');
      } catch (e) {
        await client.query('rollback');
        console.log('FAILED');
        console.error(`\n${f}: ${e.message}`);
        if (e.position) {
          const upto = sql.slice(0, Number(e.position));
          console.error(`  at line ${upto.split('\n').length}`);
        }
        process.exitCode = 1;
        return;
      }
    }
    return;
  }

  if (cmd === 'down') {
    const targets =
      arg === '--all'
        ? [...done].sort().reverse()
        : all.filter((f) => f.startsWith(String(arg))).filter((f) => done.has(f));
    if (!targets.length) return console.log('Nothing to roll back.');
    for (const f of targets) {
      const downFile = f.replace(/\.sql$/, '.down.sql');
      const p = path.join(DIR, downFile);
      if (!fs.existsSync(p)) {
        console.error(`missing ${downFile} — refusing to roll back ${f}`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`reverting ${f} ... `);
      try {
        await client.query('begin');
        await client.query(fs.readFileSync(p, 'utf8'));
        await client.query('delete from schema_migrations where version = $1', [f]);
        await client.query('commit');
        console.log('ok');
      } catch (e) {
        await client.query('rollback');
        console.log('FAILED');
        console.error(`\n${downFile}: ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exitCode = 1;
};

run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end().catch(() => {}));
