// Confirm PostgREST has reloaded the new table and both FK joins.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]])
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const result = await db.from('rrr_work_items')
  .select('id,source,medicine_days_left,customers!inner(full_name),orders!inner(order_no)').limit(1);
if (result.error) {
  console.error(`RRR REST schema check failed: ${result.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`RRR REST joins ready; anon sees ${result.data.length} rows.`);
  if (result.data.length) process.exitCode = 1;
}
