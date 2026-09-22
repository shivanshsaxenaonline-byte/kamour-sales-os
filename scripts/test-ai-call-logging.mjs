// The live daily list may include an open follow-up owned by another rep.
// Verify that today's assigned rep can close it, while another rep cannot.
// Every attempted write is rolled back.
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'kamour-ai-call-logging-test' });
let failed = false;
const check = (name, value, detail = '') => {
  console.log(`  ${value ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  failed ||= !value;
};
const as = async (uid) => {
  await db.query('select set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.query('set local role authenticated');
};
const attempt = async (sql, params) => {
  await db.query('savepoint probe');
  try {
    const result = await db.query(sql, params);
    await db.query('release savepoint probe');
    return { rows: result.rows };
  } catch (error) {
    await db.query('rollback to savepoint probe');
    return { error: error.message };
  }
};

try {
  await db.connect();
  await db.query('begin');
  const target = (await db.query(`
    select l.owner_id as assigned_rep, q.open_followup_id as followup_id,
           l.customer_id
    from ai_daily_leads l
    join users u on u.id = l.owner_id and u.role = 'sales_exec'
    join v_rrr_queue q on q.customer_id = l.customer_id
    join followups f on f.id = q.open_followup_id
    where l.run_on = ist_today() and f.owner_id is distinct from l.owner_id
    order by l.rank limit 1`)).rows[0];
  if (!target) throw new Error('No today-assigned AI lead with a foreign-owned open follow-up to test');

  const other = (await db.query(`
    select id from users where role = 'sales_exec' and is_active
      and id <> $1 and id is distinct from
        (select owner_id from followups where id = $2)
    limit 1`, [target.assigned_rep, target.followup_id])).rows[0];
  if (!other) throw new Error('No second sales rep available for isolation check');

  await as(target.assigned_rep);
  const assigned = await attempt(`
    update followups set outcome = 'no_answer', completed_at = now(), owner_id = $2
    where id = $1 and completed_at is null returning id`,
    [target.followup_id, target.assigned_rep]);
  check('today-assigned rep closes an existing open follow-up', assigned.rows?.length === 1, assigned.error);

  await db.query('set local role postgres');
  await db.query('update followups set outcome = null, completed_at = null, owner_id = null where id = $1', [target.followup_id]);
  await as(other.id);
  const stranger = await attempt(`
    update followups set outcome = 'no_answer', completed_at = now(), owner_id = $2
    where id = $1 and completed_at is null returning id`,
    [target.followup_id, other.id]);
  check('another rep cannot close that follow-up', !stranger.error && stranger.rows?.length === 0, stranger.error);

  await db.query('set local role postgres');
  await db.query('rollback');
  await db.end();
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(error.message);
  try { await db.query('rollback'); await db.end(); } catch {}
  process.exitCode = 1;
}
