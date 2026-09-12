// Pull Consultation Leads live from Zoho CRM into the CSV the importer reads.
//
//   node scripts/zoho-pull.mjs                    everything
//   node scripts/zoho-pull.mjs --since 2026-09-07 only what changed since
//   node scripts/zoho-pull.mjs --limit 500        try a slice first
//
// Writes data/incoming/zoho/Consultation_Lead_<today>.csv with the exact header
// the Zoho web export produces, so scripts/import-zoho.mjs consumes it
// unchanged — same mapping, same dedupe, same idempotency.
//
// Timestamps are written as local wall-clock without the offset, which is what
// the web export does. Keeping that convention means a pulled row and an
// exported row land on the same instant in the database.

import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const SINCE = arg('--since');
const LIMIT = arg('--limit') ? Number(arg('--limit')) : Infinity;

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in';
const API = process.env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.in';

// [csv column, zoho api name]. In the export's column order.
//
// Read the second column carefully before touching it: this module's API names
// do NOT follow their labels, and two of them are actively misleading.
//
//   "Connection Status"   is  Lead_Status      <- not Connection_Status
//   "Lead Status"         is  Lead_Status1     <- the one the importer maps
//   "Gender"              is  Genderr          <- two r's
//   "Contacted Person"    is  Calling_Done_By
//   "Date of Connection"  is  Date_of_Calling
//   "Follow-up 1 Done By" is  Follow_up_Done_By
//   "Follow-up 1 Remark"  is  Chat_Follow_up
//   "Follow-up 2 Date"    is  Date_5
//   "Follow-up 3 Date"    is  Date_6
//   "Follow-up 2 Done On" is  Follow_up_Done_On
//
// Taking Lead_Status for "Lead Status" silently files every connection state
// as a lead state. Names came from /settings/fields, not from guesswork.
//
// Two columns have no field behind them at all — Connected To is a related
// record the export flattens, Change Log Time is internal — so they stay empty.
const MAP = [
  ['Record Id', 'id'],
  ['Customer Name', 'Name'],
  ['Consultation Leads Owner.id', 'Owner.id'],
  ['Consultation Leads Owner', 'Owner.name'],
  ['Email', 'Email'],
  ['Created Time', 'Created_Time'],
  ['Modified Time', 'Modified_Time'],
  ['Last Activity Time', 'Last_Activity_Time'],
  ['Tag', 'Tag'],
  ['Unsubscribed Mode', 'Unsubscribed_Mode'],
  ['Unsubscribed Time', 'Unsubscribed_Time'],
  ['Locked', 'Locked__s'],
  ['Date of Login', 'Date_of_Login'],
  ['Contact Number', 'Contact_Number'],
  ['Connection Status', 'Lead_Status'],
  ['Contacted Person', 'Calling_Done_By'],
  ['Diseases', 'Diseases'],
  ['Date of Connection', 'Date_of_Calling'],
  ['Lead Status', 'Lead_Status1'],
  ['Consultation Lead', 'Consultation_Lead'],
  ['Lead Source', 'Lead_Source'],
  ['Alternate Number', 'Alternate_Number'],
  ['Follow-up 1 Done By', 'Follow_up_Done_By'],
  ['Age', 'Age'],
  ['Address', 'Address'],
  ['Follow-up 1 Date', 'Follow_up_1_Date'],
  ['Gender', 'Genderr'],
  ['Follow-up 2 Date', 'Date_5'],
  ['Follow-up 3 Date', 'Date_6'],
  ['State', 'State'],
  ['Lead Insights', 'Lead_Insights'],
  ['Follow-up 2 Done By', 'Follow_up_2_Done_By'],
  ['Mode Of Connection', 'Mode_Of_Connection'],
  ['Follow-up 1 Remark', 'Chat_Follow_up'],
  ['Important Notes', 'Important_Notes'],
  ['Profession', 'Profession'],
  ['Follow-up 4 Done By', 'Follow_up_4_Done_By'],
  ['Follow-up 3 Done By', 'Follow_up_3_Done_By'],
  ['Connected To.module', null],
  ['Connected To.id', null],
  ['Follow-up 2 Done On', 'Follow_up_Done_On'],
  ['Follow-up 2 Remark', 'Follow_up_2_Remark'],
  ['Follow-up  1  Done On', 'Follow_up_1_Done_On'],
  ['Follow-up 3 Done On', 'Follow_up_3_Done_On'],
  ['Follow-up 4 Date', 'Follow_up_4_Date'],
  ['Follow-up 3 Remark', 'Follow_up_3_Remark'],
  ['Follow-up 4 Done On', 'Follow_up_4_Done_On'],
  ['Follow-up 4 Remark', 'Follow_up_4_Remark'],
  ['UTM Content', 'UTM_Content'],
  ['UTM Source', 'UTM_Source'],
  ['UTM Term', 'UTM_Term'],
  ['UTM Medium', 'UTM_Medium'],
  ['Google Click Identifier', 'Google_Click_Identifier'],
  ['UTM Campaign', 'UTM_Campaign'],
  ["What's Your Concern?", 'What_s_Your_Concern'],
  ['First WhatsApp Sent', 'First_WhatsApp_Sent'],
  ['Payment Status', 'Payment_Status'],
  ['Change Log Time', null],
];

// `id` is always returned; Owner.x is one request for Owner. The API caps a
// request at 50 fields, so the pull asks in two halves and joins them on id.
const FIELDS = [...new Set(
  MAP.map(([, f]) => f).filter((f) => f && f !== 'id').map((f) => f.split('.')[0]),
)];
const HALF = Math.ceil(FIELDS.length / 2);
const FIELD_BATCHES = [FIELDS.slice(0, HALF), FIELDS.slice(HALF)];

// Values arrive as scalars, or as objects for lookups (Owner) and tags.
const stamp = (v) => (typeof v === 'string' ? v.slice(0, 19).replace('T', ' ') : '');

// The web export prefixes every record id with "zcrm_"; the API returns it
// bare. The importer's skip-list is keyed on what was imported before, so a
// bare id here would look like a brand new lead and re-import all 52k of them.
const zcrm = (id) => (id ? `zcrm_${id}` : '');

function read(rec, spec) {
  if (!spec) return '';
  if (spec === 'id') return zcrm(rec.id);
  const [field, sub] = spec.split('.');
  if (sub === 'id') return zcrm(rec[field]?.id);
  const v = rec[field];
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => x?.name ?? x).join(';');
  if (typeof v === 'object') return v[sub ?? 'name'] ?? '';
  return /^\d{4}-\d{2}-\d{2}T/.test(v) ? stamp(v) : v;
}

const cell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function accessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const json = await (await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body })).json();
  if (!json.access_token) throw new Error(`zoho refresh failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function main() {
  const headers = { Authorization: `Zoho-oauthtoken ${await accessToken()}` };
  if (SINCE) headers['If-Modified-Since'] = `${SINCE}T00:00:00+05:30`;
  console.log(SINCE ? `pulling changes since ${SINCE}...` : 'pulling all consultation leads...');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  const out = path.resolve(`data/incoming/zoho/Consultation_Lead_${today}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fh = fs.openSync(out, 'w');
  fs.writeSync(fh, MAP.map(([h]) => cell(h)).join(',') + '\n');

  // Each half is paged independently. Both are sorted the same way and asked
  // for the same rows, so page N of one lines up with page N of the other and
  // the join on id is a check, not a lookup.
  const tokens = [undefined, undefined];
  let rows = 0;
  let more = true;

  while (more) {
    const pages = await Promise.all(FIELD_BATCHES.map(async (batch, i) => {
      const p = new URLSearchParams({
        fields: batch.join(','), per_page: '200',
        sort_by: 'Modified_Time', sort_order: 'asc',
      });
      if (tokens[i]) p.set('page_token', tokens[i]);

      const res = await fetch(`${API}/crm/v7/Consultation_Lead?${p}`, { headers });
      if (res.status === 204) return { data: [], info: {} };
      const json = await res.json();
      if (!res.ok) throw new Error(`zoho ${res.status}: ${JSON.stringify(json)}`);
      return json;
    }));

    const [a, b] = pages;
    const second = new Map((b.data ?? []).map((r) => [r.id, r]));

    for (const rec of a.data ?? []) {
      if (rows >= LIMIT) { more = false; break; }
      const full = { ...rec, ...(second.get(rec.id) ?? {}) };
      fs.writeSync(fh, MAP.map(([, spec]) => cell(read(full, spec))).join(',') + '\n');
      rows++;
    }
    if (!more) break;

    pages.forEach((pg, i) => { tokens[i] = pg.info?.more_records ? pg.info.next_page_token : undefined; });
    more = Boolean(tokens[0]);
    if (rows % 2000 === 0 && rows) console.log(`  ${rows} rows...`);
  }

  fs.closeSync(fh);
  const rel = path.relative(process.cwd(), out).replace(/\\/g, '/');
  console.log(`\n${rows} rows -> ${rel}`);
  console.log(`next: node scripts/import-zoho.mjs --file ${rel}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
