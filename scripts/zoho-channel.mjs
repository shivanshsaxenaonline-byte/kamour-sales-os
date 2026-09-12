// Inspect, renew or (re)create the Zoho instant-notification channel.
//
//   node scripts/zoho-channel.mjs                 show current channels
//   node scripts/zoho-channel.mjs --renew         extend the existing channel
//   node scripts/zoho-channel.mjs --create        register it from scratch
//   node scripts/zoho-channel.mjs --url https://… point it somewhere else
//
// A Zoho watch channel EXPIRES. The one registered on 11 Sep expires
// 2026-09-18T10:33+05:30, and when it does the notifications simply stop —
// no error, no bounce, the CRM just goes quiet and the app silently drifts out
// of date. Renewing is a one-line API call that nothing was making.
//
// Run --renew from cron weekly, or set a calendar reminder. The channel is
// registered WITHOUT return_affected_field_values, because the payload's values
// are not trusted anyway: the sync always re-fetches the record from Zoho, so
// asking for values would enlarge every delivery for nothing.

import fs from 'node:fs';
import path from 'node:path';

for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in';
const API = process.env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.in';
const MODULE = 'Consultation_Lead';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const NOTIFY_URL = arg('--url')
  ?? process.env.ZOHO_NOTIFY_URL
  ?? 'https://kamour-sales-os.vercel.app/api/zoho/webhook';
const TOKEN = process.env.ZOHO_WEBHOOK_TOKEN ?? 'kamour_zoho_live';

/** Zoho wants an ISO 8601 timestamp WITH a numeric offset and no milliseconds
 *  — "2026-09-19T10:33:42+05:30". A plain toISOString() (…000Z) is rejected
 *  with "invalid data" on $.watch[0].channel_expiry, which is not an obvious
 *  message for a formatting problem. Written in IST because that is the CRM's
 *  own timezone and what the dashboard shows back.
 *
 *  Zoho also caps how far ahead a channel may run and clamps a longer request
 *  down rather than refusing it, so asking for a week is safe. */
const expiryIn = (days) => {
  const ist = new Date(Date.now() + days * 86_400_000 + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 19) + '+05:30';
};

// Cached for the life of the run. Refreshing per request is what earns
// "You have made too many requests continuously" from Zoho: a single --renew
// makes three API calls, and a token refresh for each one is three refreshes
// to do one job. src/lib/zoho/client.ts caches for the same reason.
let cachedToken = null;
async function token() {
  if (cachedToken) return cachedToken;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  cachedToken = j.access_token;
  return cachedToken;
}

async function call(method, path, body) {
  const r = await fetch(`${API}/crm/v7/${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${await token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

function show(watch) {
  if (!watch?.length) return console.log('no channels registered — run with --create');
  for (const w of watch) {
    const left = (new Date(w.channel_expiry) - Date.now()) / 86_400_000;
    console.log(`channel ${w.channel_id}`);
    console.log(`  module   ${w.resource_name}`);
    console.log(`  notify   ${w.notify_url}`);
    console.log(`  events   ${(w.events ?? []).join(', ')}`);
    console.log(`  expires  ${w.channel_expiry}   (${left.toFixed(1)} days left)`);
    if (left < 2) console.log('  ** EXPIRING — run with --renew **');
  }
}

async function main() {
  const current = await call('GET', 'actions/watch');
  const existing = current.json?.watch ?? [];

  if (process.argv.includes('--create') || process.argv.includes('--renew')) {
    const renew = process.argv.includes('--renew');
    const mine = existing.find((w) => w.resource_name === MODULE);

    if (renew && !mine) {
      console.log('nothing to renew for', MODULE, '— use --create');
      process.exit(1);
    }

    const watch = [{
      channel_id: renew ? mine.channel_id : String(Date.now()),
      events: [`${MODULE}.create`, `${MODULE}.edit`, `${MODULE}.delete`],
      channel_expiry: expiryIn(7),
      token: TOKEN,
      notify_url: NOTIFY_URL,
      // The sync re-fetches every record from Zoho, so shipping values in the
      // notification would just make each delivery bigger for no gain.
      return_affected_field_values: false,
    }];

    const res = await call(renew ? 'PATCH' : 'POST', 'actions/watch', { watch });
    console.log(renew ? 'renew:' : 'create:', res.status);
    console.log(JSON.stringify(res.json, null, 2).slice(0, 800));
    console.log();
  }

  const after = await call('GET', 'actions/watch');
  show(after.json?.watch ?? []);
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
