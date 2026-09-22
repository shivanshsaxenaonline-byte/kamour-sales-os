// Export AI Queue rows that still cannot be attached to a trustworthy order.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

function parseCsv(input) {
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
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
if (!file || !output) throw new Error('Pass --file=<AI Queue CSV> --output=<exception CSV>');
const [headers, ...body] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const index = Object.fromEntries(headers.map((header, col) => [header.trim(), col]));
const cols = ['Sheet Row', 'Reason', 'Selection Date', 'Customer Key', 'Phone',
  'Follow-up Status', 'Outcome Saved At', 'Last Contacted', 'Outcome Note',
  'Source Sheet', 'Source Row'];
const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }, application_name: 'kamour-ai-exceptions-export' });
try {
  await db.connect();
  const rejects = (await db.query(`select source_row_no, reason from import_rejects
    where source = 'km002_ai_queue' order by source_row_no, reason`)).rows;
  const rows = rejects.map(({ source_row_no: rowNo, reason }) => {
    const row = body[rowNo - 2] ?? [];
    return [rowNo, reason, ...cols.slice(2).map((column) => row[index[column]] ?? '')];
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '\uFEFF' + [cols, ...rows].map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n');
  const recent = rows.filter((row) => row[2] >= '2026-09-09').length;
  console.log(JSON.stringify({ output, exceptions: rows.length, sinceSep9: recent }));
} finally {
  await db.end();
}
