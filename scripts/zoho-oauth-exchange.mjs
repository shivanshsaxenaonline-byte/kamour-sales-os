// Exchange a Zoho self-client grant code and save the refresh token locally.
//
//   node scripts/zoho-oauth-exchange.mjs --code 1000....
//
// Prints only status, never the token. The code is one-time use, so this script
// writes .env.local during the same request that receives the refresh token.

import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('.env.local');
const envText = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const code = arg('--code');
const redirectUri = arg('--redirect-uri') ?? env.ZOHO_REDIRECT_URI ?? 'https://www.zoho.com';
const accounts = env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in';

if (!code) throw new Error('Missing --code');
for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env.local`);
}

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: env.ZOHO_CLIENT_ID,
  client_secret: env.ZOHO_CLIENT_SECRET,
  redirect_uri: redirectUri,
  code,
});

const res = await fetch(`${accounts}/oauth/v2/token`, { method: 'POST', body });
const json = await res.json();
if (!json.refresh_token) {
  throw new Error(`Zoho code exchange failed: ${JSON.stringify(json)}`);
}

let next = envText;
if (/^ZOHO_REFRESH_TOKEN=/m.test(next)) {
  next = next.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, `ZOHO_REFRESH_TOKEN=${json.refresh_token}`);
} else {
  next += `${next.endsWith('\n') ? '' : '\n'}ZOHO_REFRESH_TOKEN=${json.refresh_token}\n`;
}
if (json.api_domain) {
  if (/^ZOHO_API_DOMAIN=/m.test(next)) {
    next = next.replace(/^ZOHO_API_DOMAIN=.*$/m, `ZOHO_API_DOMAIN=${json.api_domain}`);
  } else {
    next += `ZOHO_API_DOMAIN=${json.api_domain}\n`;
  }
}
if (!/^ZOHO_REDIRECT_URI=/m.test(next)) {
  next += `ZOHO_REDIRECT_URI=${redirectUri}\n`;
}

fs.writeFileSync(envPath, next);
console.log(`Zoho refresh token saved. Scope: ${json.scope ?? 'unknown'}`);
