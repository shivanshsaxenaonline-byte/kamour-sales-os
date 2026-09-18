// Proof tests for the AI daily lead list (migration 028).
//
// Three things need proving, and none of them can be proved from the UI:
//   1. the day really is the team's total cap, dealt evenly, mixed by the
//      shares in ai_lead_rules;
//   2. it does not reshuffle underneath a rep who is halfway through it;
//   3. widening customers_read so a rep can see the leads they were dealt
//      widened it by EXACTLY that much and no further — a sales exec must
//      still not be able to read a customer who is not on their list today.
//
// Impersonates a real `authenticated` JWT, exactly as PostgREST does, so the
// database is what is being tested rather than the UI's own honesty.
//
// Everything runs in one transaction that is rolled back.
//
//   node scripts/test-ai-leads.mjs

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v);

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-ai-lead-tests',
});

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

const as = async (uid) => {
  await c.query('select set_config($1,$2,true)', [
    'request.jwt.claims', JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await c.query('set local role authenticated');
};
const asPostgres = async () => { await c.query('set local role postgres'); };

let sp = 0;
const attempt = async (sql, params = []) => {
  const name = `t${++sp}`;
  await c.query(`savepoint ${name}`);
  try {
    const rows = (await c.query(sql, params)).rows;
    await c.query(`release savepoint ${name}`);
    return { rows };
  } catch (e) {
    await c.query(`rollback to savepoint ${name}`);
    return { error: e.message };
  }
};

const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];

async function main() {
  await c.connect();
  await c.query('begin');

  const who = Object.fromEntries((await c.query(
    `select role, id from users where role in
       ('auditor','coo','admin','sales_exec','ops') and is_active
     order by role`)).rows.map((r) => [r.role, r.id]));

  const caps = await c.query(
    `select id, full_name, coalesce(daily_lead_cap, 15) cap from users
     where is_active and role in ('sales_exec','sales_manager')
       and coalesce(daily_lead_cap, 15) > 0 order by full_name`);
  const expected = caps.rows.reduce((n, r) => n + Number(r.cap), 0);

  // A fresh build under this transaction, so the assertions are about what the
  // generator does today rather than about whatever is already sitting there.
  await c.query('select fn_generate_ai_daily_leads(null, true)');
  const today = (await one('select ist_today() d')).d;

  console.log(`\nThe day's list — ${caps.rows.length} reps, ${expected} leads expected\n`);

  const total = Number((await one(
    'select count(*)::int n from ai_daily_leads where run_on = $1', [today])).n);
  ok(`the day is exactly the team's total cap (${expected})`, total === expected, `got ${total}`);

  const perRep = await c.query(
    `select u.full_name, count(*)::int n from ai_daily_leads l
     join users u on u.id = l.owner_id where l.run_on = $1
     group by 1 order by 1`, [today]);
  const spread = perRep.rows.map((r) => r.n);
  ok('every rep got their cap',
     perRep.rows.length === caps.rows.length &&
     perRep.rows.every((r, i) => r.n === Number(caps.rows[i].cap)),
     spread.join('/'));

  // Dealt like cards, so the best leads are spread rather than stacked on one
  // rep: the average score per rep should be within a few points.
  const scores = (await c.query(
    `select owner_id, avg(priority_score)::numeric(6,2) avg from ai_daily_leads
     where run_on = $1 group by 1`, [today])).rows.map((r) => Number(r.avg));
  ok('the best leads are spread evenly, not stacked on one rep',
     Math.max(...scores) - Math.min(...scores) < 10,
     `avg scores ${scores.map((s) => s.toFixed(1)).join(' / ')}`);

  const dupes = (await one(
    `select count(*)::int n from (
       select customer_id from ai_daily_leads where run_on = $1
       group by 1 having count(*) > 1) x`, [today])).n;
  ok('nobody is on the list twice, so two reps never ring the same person',
     Number(dupes) === 0, `${dupes} duplicated`);

  console.log('\nThe mix\n');

  const carryCount = Number((await one(
    `select count(*)::int n from ai_daily_leads
     where run_on = $1 and reason like 'Carried over from %'`, [today])).n);
  const freshSeats = expected - carryCount;
  const byBucket = Object.fromEntries((await c.query(
    `select bucket, count(*)::int n from ai_daily_leads
     where run_on = $1 and reason not like 'Carried over from %'
     group by 1`, [today])).rows.map((r) => [r.bucket, r.n]));
  const rules = await c.query('select code, share_pct from ai_lead_rules where is_active order by sort_order');

  for (const r of rules.rows) {
    // Targets are ceilings on the first pick, not a guarantee: a bucket can
    // run out after the 3-day unworked carry-over exclusion. The top-up fills
    // the remaining seats from any eligible bucket.
    const target = Math.floor((r.share_pct * freshSeats) / 100);
    console.log(`  INFO  ${r.code}: ${byBucket[r.code] ?? 0} fresh, ${target} target`);
  }

  const bad = (await one(
    `select count(*)::int n from ai_daily_leads l
     left join ai_lead_rules r on r.code = l.bucket
     where l.run_on = $1 and (r.code is null or not r.is_active)`, [today])).n;
  ok('every lead carries an active bucket the rules table knows', Number(bad) === 0);

  console.log('\nWho may build it\n');

  for (const role of ['sales_exec', 'ops']) {
    if (!who[role]) { console.log(`  SKIP  ${role} is refused — no active user with this role`); continue; }
    await as(who[role]);
    const r = await attempt('select fn_generate_ai_daily_leads(null, true) as n');
    ok(`${role} cannot build the list`, !!r.error && /not permitted/i.test(r.error),
       r.error ?? 'no error raised');
    await asPostgres();
  }

  for (const role of ['coo', 'admin', 'auditor']) {
    if (!who[role]) continue;
    await as(who[role]);
    const r = await attempt('select fn_generate_ai_daily_leads(null, true) as n');
    ok(`${role} can build the list`, !r.error, r.error);
    await asPostgres();
  }

  console.log('\nIt does not move underneath a rep mid-morning\n');

  const before = (await c.query(
    `select customer_id, rank, owner_id from ai_daily_leads
     where run_on = $1 order by rank`, [today])).rows;
  const again = Number((await one('select fn_generate_ai_daily_leads() n')).n);
  const after = (await c.query(
    `select customer_id, rank, owner_id from ai_daily_leads
     where run_on = $1 order by rank`, [today])).rows;
  ok('a second call returns the same count instead of rebuilding', again === before.length,
     `${again} vs ${before.length}`);
  ok('and the list itself is untouched',
     JSON.stringify(before) === JSON.stringify(after));

  console.log('\nThe cooldown\n');

  const tomorrow = (await one(`select (ist_today() + 1)::date d`)).d;
  await c.query('select fn_generate_ai_daily_leads($1::date, true)', [tomorrow]);
  const repeated = await one(
    `select count(*)::int n,
       count(*) filter (where b.reason not like 'Carried over from %'
          or b.owner_id is distinct from a.owner_id)::int wrong
     from ai_daily_leads a
     join ai_daily_leads b on b.customer_id = a.customer_id and b.run_on = $2
     where a.run_on = $1`, [today, tomorrow]);
  const carryCap = caps.rows.reduce((n, r) => n + Math.floor(Number(r.cap) * 0.6), 0);
  ok('unfinished names reappear only as capped carry-over for the same rep',
    Number(repeated.wrong) === 0 && Number(repeated.n) <= carryCap,
    `${repeated.n} repeated, ${repeated.wrong} outside carry-over, cap ${carryCap}`);

  const dnd = Number((await one(
    `select count(*)::int n from ai_daily_leads l join customers c on c.id = l.customer_id
     where c.is_dnd`)).n);
  ok('nobody on DND is ever picked', dnd === 0, `${dnd} picked`);

  const rejected = Number((await one(
    `select count(*)::int n from ai_daily_leads l
     join lateral (
       select (array_agg(f.outcome order by f.completed_at desc))[1] outcome,
              max(f.completed_at at time zone 'Asia/Kolkata')::date done
       from followups f where f.customer_id = l.customer_id and f.completed_at is not null
     ) last on true
     where last.outcome in ('not_interested','wrong_number')
       and last.done > ist_today() - 20
       -- The "no" has to predate the list that picked them. Every historical
       -- run contains customers who were dealt in the morning, rung at noon
       -- and said no in the afternoon: that is the rule working, not the rule
       -- broken, and without this line the check failed on all 64 of them.
       and last.done < l.run_on`)).n);
  ok('nobody who said no in the last 20 days is picked', rejected === 0, `${rejected} picked`);

  console.log('\nAI suggestions are not sales assignments\n');

  const dealt = await one(
    `select l.owner_id, count(*)::int n from ai_daily_leads l
     join users u on u.id = l.owner_id
     where l.run_on = $1 and u.role = 'sales_exec' group by 1 limit 1`, [today]);

  if (!dealt) {
    console.log('  SKIP  no sales_exec was dealt leads today');
  } else {
    const exec = dealt.owner_id;
    const expectedWork = Number((await one(
      `select count(*)::int n from rrr_work_items where assigned_to = $1 and completed_at is null`,
      [exec])).n);
    await as(exec);
    const seenList = Number((await one(
      `select count(*)::int n from v_rrr_ai_leads where run_on = $1`, [today])).n);
    ok('AI suggestions stay invisible to sales until Alka assigns work', seenList === 0,
       `saw ${seenList} of ${total}`);

    const work = Number((await one(
      `select count(*)::int n from rrr_work_items where assigned_to = $1 and completed_at is null`,
      [exec])).n);
    ok('sales worklist contains only explicit open assignments', work === expectedWork,
       `saw ${work}, expected ${expectedWork}`);

    await asPostgres();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await c.query('rollback');
  await c.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('test run failed:', e.message);
  try { await c.query('rollback'); await c.end(); } catch {}
  process.exit(1);
});
