// Copies the three operational Zoho fields needed by Paid Elementor into
// structured CRM columns. It updates existing leads by their Zoho record ID.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in';
const API = process.env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.in';
const FIELDS = 'id,Lead_Status,Lead_Insights,Calling_Done_By';
const BATCH_SIZE = 500;

function value(field) {
  if (field == null) return null;
  if (Array.isArray(field)) return field.map(value).filter(Boolean).join(', ') || null;
  if (typeof field === 'object') return value(field.name ?? field.value);
  const text = String(field).trim();
  return text || null;
}

async function accessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID ?? '',
    client_secret: process.env.ZOHO_CLIENT_SECRET ?? '',
    refresh_token: process.env.ZOHO_REFRESH_TOKEN ?? '',
  });
  const response = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body });
  const json = await response.json();
  if (!json.access_token) throw new Error(`Zoho authentication failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function flush(client, rows) {
  if (!rows.length) return;
  const ids = rows.map(row => row.id);
  const connection = rows.map(row => row.connection);
  const insight = rows.map(row => row.insight);
  const contactedPerson = rows.map(row => row.contactedPerson);
  await client.query(
    `update leads as lead set
       zoho_connection_status = data.connection,
       zoho_lead_insight = data.insight,
       zoho_contacted_person = data.contacted_person
     from unnest($1::uuid[], $2::text[], $3::text[], $4::text[])
       as data(id, connection, insight, contacted_person)
     where lead.id = data.id`,
    [ids, connection, insight, contactedPerson],
  );
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 300000,
  application_name: 'kamour-zoho-lead-metadata-backfill',
});

try {
  await client.connect();
  const { rows: identities } = await client.query(
    `select lead.id, identity.external_id
     from customer_identities as identity
     join leads as lead on lead.customer_id = identity.customer_id
     where identity.system = 'zoho' and lead.channel = 'zoho_legacy'`,
  );
  const leadByZohoId = new Map(identities.map(row => [row.external_id.replace(/^zcrm_/, ''), row.id]));
  const token = await accessToken();
  const pending = [];
  let pageToken;
  let seen = 0;
  let matched = 0;

  do {
    const url = new URL(`${API}/crm/v7/Consultation_Lead`);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('per_page', '200');
    url.searchParams.set('sort_by', 'Modified_Time');
    url.searchParams.set('sort_order', 'asc');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const json = await response.json();
    if (!response.ok) throw new Error(`Zoho read failed: ${response.status} ${JSON.stringify(json)}`);
    for (const record of json.data ?? []) {
      seen++;
      const id = leadByZohoId.get(String(record.id));
      if (!id) continue;
      pending.push({
        id,
        connection: value(record.Lead_Status),
        insight: value(record.Lead_Insights),
        contactedPerson: value(record.Calling_Done_By),
      });
      matched++;
      if (pending.length === BATCH_SIZE) {
        await flush(client, pending.splice(0));
        process.stdout.write(`Updated ${matched} matched Zoho leads\n`);
      }
    }
    pageToken = json.info?.more_records ? json.info.next_page_token : undefined;
  } while (pageToken);

  await flush(client, pending);
  console.log(`Finished. Read ${seen} Zoho leads and updated ${matched} CRM leads.`);
} finally {
  await client.end();
}
