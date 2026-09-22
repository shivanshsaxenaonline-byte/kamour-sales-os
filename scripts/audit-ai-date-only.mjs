// Verify timestamp-less Order Placed rows from the September sheet snapshot.
import fs from 'node:fs';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

function csv(input) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const file = process.argv.find((arg) => arg.startsWith('--file='))?.slice(7);
if (!file) throw new Error('Pass --file=<AI Daily Queue CSV>');
const masterFile = process.argv.find((arg) => arg.startsWith('--master-file='))?.slice(14);
const masterRows = masterFile ? csv(fs.readFileSync(masterFile, 'utf8').replace(/^\uFEFF/, '')) : null;
const masterIdx = masterRows ? Object.fromEntries(masterRows[0].map((header, col) => [header.trim(), col])) : null;
const [headers, ...data] = csv(fs.readFileSync(file, 'utf8'));
const records = data.map((row, index) => ({
  sheetRow: index + 2,
  ...Object.fromEntries(headers.map((header, col) => [header, row[col] ?? ''])),
})).filter((row) => row['Selection Date'] >= '2026-09-09' && row['Selection Date'] <= '2026-09-14'
  && row['Follow-up Status'] === 'Order Placed' && !row['Outcome Saved At'] && !row['Last Contacted']);

const groups = new Map();
for (const row of records) {
  const phone = row['Customer Key'].replace(/\D/g, '').slice(-10);
  const key = `${row['Selection Date']}|${phone}`;
  const group = groups.get(key) ?? { date: row['Selection Date'], phone, rows: [], aliases: new Set() };
  group.rows.push(row.sheetRow);
  const sourceRow = Number(row['Source Row']);
  if (row['Source Sheet'] === 'Master Sheet' && masterRows?.[sourceRow - 1]) {
    const rawPhones = masterRows[sourceRow - 1][masterIdx['Contact Number']] ?? '';
    const phones = rawPhones.match(/[6-9]\d{9}/g) ?? [];
    if (phones.includes(phone)) for (const other of phones) group.aliases.add(other);
  }
  groups.set(key, group);
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'kamour-date-only-audit' });
try {
  await db.connect();
  let matched = 0, mismatched = 0;
  for (const group of groups.values()) {
    const result = await db.query(`
      select count(f.id) filter (where f.remark like '%exact call time not recorded%')::int as date_only,
        count(f.id) filter (where f.outcome = 'order_placed')::int as order_placed,
        count(f.id)::int as all_calls,
        count(distinct c.id) filter (where exists
          (select 1 from orders o where o.customer_id = c.id))::int as with_order
      from customers c
      left join followups f on f.customer_id = c.id and f.kind = 'order'
        and (f.due_at at time zone 'Asia/Kolkata')::date = $2::date
      where right(c.phone_e164,10) = any($1::text[])`,
      [[group.phone, ...group.aliases], group.date]);
    const current = result.rows[0];
    if (current.date_only >= group.rows.length) matched += group.rows.length;
    else {
      mismatched += group.rows.length;
      const rejects = (await db.query(`select source_row_no, reason from import_rejects
        where source = 'km002_ai_queue' and source_row_no = any($1::int[])`, [group.rows])).rows;
      console.log(JSON.stringify({ sheetRows: group.rows, date: group.date, expected: group.rows.length, ...current, rejects }));
    }
  }
  console.log(JSON.stringify({ sheetRows: records.length, matched, mismatched }));
  if (mismatched) process.exitCode = 1;
} finally {
  await db.end();
}
