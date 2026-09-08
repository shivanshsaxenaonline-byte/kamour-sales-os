// Push a local backup to Supabase Storage (private bucket), and pull one back.
//
//   node scripts/backup-upload.mjs              back up + upload + prune
//   node scripts/backup-upload.mjs --list       what is stored remotely
//   node scripts/backup-upload.mjs --pull NAME  download + expand to backups/NAME
//
// NOTE: this is a convenience copy, not disaster recovery. It lives in the same
// Supabase project as the database it protects, so a deleted or suspended
// project takes the backups with it. The off-provider copy (GitHub / R2) is
// still the one that matters. See decisions.md D-035.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const envPath = path.resolve('.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BACKUP_BUCKET || 'db-backups';
if (!URL_BASE || !KEY) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const H = { Authorization: `Bearer ${KEY}`, apikey: KEY };

// Free tier is 1 GB. Keep a short daily tail plus a few weeklies.
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;

const arg = (f) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null);

async function list() {
  const res = await fetch(`${URL_BASE}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 200, sortBy: { column: 'name', order: 'desc' } }),
  });
  if (!res.ok) throw new Error(`list failed ${res.status}: ${await res.text()}`);
  return (await res.json()).filter((o) => o.name.endsWith('.json.gz'));
}

async function upload(name, buf) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${name}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload failed ${res.status}: ${await res.text()}`);
}

async function remove(names) {
  if (!names.length) return;
  const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: names }),
  });
  if (!res.ok) throw new Error(`delete failed ${res.status}: ${await res.text()}`);
}

// Bundle a backup directory into one gzipped JSON document.
function pack(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tables = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue;
    tables[f.replace(/\.ndjson$/, '')] =
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, tables }), 'utf8'), { level: 9 });
}

function unpack(buf, dir) {
  const { manifest, tables } = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [t, lines] of Object.entries(tables))
    fs.writeFileSync(path.join(dir, `${t}.ndjson`), lines.join('\n'), 'utf8');
  return manifest;
}

(async () => {
  if (process.argv.includes('--list')) {
    const objs = await list();
    if (!objs.length) return console.log('nothing stored yet');
    let total = 0;
    for (const o of objs) {
      const size = o.metadata?.size ?? 0; total += size;
      console.log(`  ${o.name.padEnd(34)} ${(size / 1e6).toFixed(2)} MB   ${o.created_at ?? ''}`);
    }
    console.log(`\n${objs.length} backups, ${(total / 1e6).toFixed(1)} MB of the 1 GB free tier`);
    return;
  }

  const pull = arg('--pull');
  if (pull) {
    const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${pull}`, { headers: H });
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dir = path.join('backups', pull.replace(/\.json\.gz$/, ''));
    const manifest = unpack(buf, dir);
    console.log(`pulled ${pull} -> ${dir}`);
    console.table(manifest.tables);
    console.log(`restore with:  node scripts/backup.mjs --restore ${dir}`);
    return;
  }

  // fresh dump, then upload
  console.log('taking a local backup first...\n');
  execFileSync(process.execPath, ['scripts/backup.mjs'], { stdio: 'inherit' });

  const dir = path.join('backups', fs.readdirSync('backups').sort().pop());
  const name = `${path.basename(dir)}.json.gz`;
  const buf = pack(dir);
  await upload(name, buf);
  console.log(`\nuploaded ${name}  (${(buf.length / 1e6).toFixed(2)} MB, gzipped)`);

  // verify the stored copy really round-trips, rather than assuming it did
  const back = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${name}`, { headers: H });
  const rt = JSON.parse(zlib.gunzipSync(Buffer.from(await back.arrayBuffer())).toString('utf8'));
  const localRows = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).tables)
    .reduce((a, b) => a + b, 0);
  const remoteRows = Object.values(rt.tables).reduce((a, l) => a + l.length, 0);
  console.log(`verified: downloaded and re-parsed, ${remoteRows} rows (local manifest says ${localRows})`);
  if (remoteRows !== localRows) { console.error('MISMATCH — do not trust this backup'); process.exit(1); }

  // prune: keep the newest KEEP_DAILY, plus one per ISO week for KEEP_WEEKLY weeks
  const objs = (await list()).map((o) => o.name).sort().reverse();
  const keep = new Set(objs.slice(0, KEEP_DAILY));
  const weeks = new Set();
  for (const n of objs) {
    const wk = new Date(n.slice(0, 10)).toISOString().slice(0, 8) +
               Math.ceil(new Date(n.slice(0, 10)).getDate() / 7);
    if (!weeks.has(wk) && weeks.size < KEEP_WEEKLY) { weeks.add(wk); keep.add(n); }
  }
  const drop = objs.filter((n) => !keep.has(n));
  if (drop.length) { await remove(drop); console.log(`pruned ${drop.length} old backups`); }
  console.log(`retained ${keep.size}`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
