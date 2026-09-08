// Create the team's login accounts directly in auth.users — no email
// verification, no invite mail. Usernames are placeholder addresses that can be
// swapped for real ones later without touching any foreign key.
//
// Re-runnable: existing accounts are left alone.
//
//   node scripts/seed-team.mjs
//
// The temporary password is printed at the end. Change it before real use.

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TEMP_PASSWORD = process.env.SEED_TEMP_PASSWORD || 'Kamour@2026';
const DOMAIN = 'kamour.local';

// login = true  -> can sign in with the temp password
// login = false -> a record only, so consultations can point at them.
//                  Doctors do not need logins yet (user's call); giving them one
//                  later is a single password update, not a data migration.
const TEAM = [
  { user: 'shreyansh', name: 'Shreyansh',       role: 'sales_exec',    login: true,  manager: 'ashutosh' },
  { user: 'tejasv',    name: 'Tejasv',          role: 'sales_exec',    login: true,  manager: 'ashutosh' },
  { user: 'ashutosh',  name: 'Ashutosh',        role: 'sales_manager', login: true },
  { user: 'nakul',     name: 'Nakul Sharma',    role: 'ops',           login: true },
  { user: 'nishant',   name: 'Nishant Agarwal', role: 'ceo',           login: true },
  { user: 'kratika',   name: 'Kratika',         role: 'coo',           login: true },
  { user: 'shivansh',  name: 'Shivansh',        role: 'admin',         login: true },
  { user: 'alka',      name: 'Alka',            role: 'auditor',       login: true },

  // Doctors: records, not logins.
  { user: 'dr.rupendra', name: 'Dr. Rupendra Singh',  role: 'doctor', login: false },
  { user: 'dr.harsh',    name: 'Dr. Harsh',           role: 'doctor', login: false },
  { user: 'dr.shubham',  name: 'Dr. Shubham Saxena',  role: 'doctor', login: false },
  { user: 'dr.dinesh',   name: 'Dr. Dinesh Biswas',   role: 'doctor', login: false },
  { user: 'dr.rajeev',   name: 'Dr. Rajeev',          role: 'doctor', login: false },
];

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  application_name: 'kamour-seed-team',
});

const run = async () => {
  await c.connect();
  await c.query('begin');

  const ids = {};
  for (const m of TEAM) {
    const email = `${m.user}@${DOMAIN}`;

    const existing = await c.query('select id from auth.users where email = $1', [email]);
    if (existing.rowCount) {
      ids[m.user] = existing.rows[0].id;
      console.log(`  exists   ${email}`);
      continue;
    }

    // A null encrypted_password means the account cannot sign in at all.
    const { rows } = await c.query(
      `insert into auth.users (
         id, instance_id, aud, role, email, encrypted_password,
         email_confirmed_at, created_at, updated_at,
         raw_app_meta_data, raw_user_meta_data,
         -- GoTrue scans these into non-nullable Go strings. Leaving them NULL
         -- makes every login fail with "Database error querying schema" — the
         -- account looks fine in the table and simply cannot sign in. (D-036)
         confirmation_token, recovery_token,
         email_change_token_new, email_change_token_current, email_change
       ) values (
         gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
         'authenticated', 'authenticated', $1,
         case when $2 then extensions.crypt($3, extensions.gen_salt('bf')) else null end,
         now(), now(), now(),
         '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
         '', '', '', '', ''
       ) returning id`,
      [email, m.login, TEMP_PASSWORD]
    );
    const id = rows[0].id;
    ids[m.user] = id;

    // Recent GoTrue requires a matching identity row for password sign-in.
    if (m.login) {
      await c.query(
        `insert into auth.identities
           (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
         values (gen_random_uuid(), $1::uuid,
                 jsonb_build_object('sub', $3::text, 'email', $2::text),
                 'email', $3::text, null, now(), now())`,
        [id, email, id]
      );
    }
    console.log(`  created  ${email}  ${m.login ? '(can log in)' : '(record only)'}`);
  }

  // users rows, then managers in a second pass so the FK always resolves
  for (const m of TEAM) {
    await c.query(
      `insert into users (id, full_name, role, is_active)
       values ($1, $2, $3::user_role, $4)
       on conflict (id) do update set full_name = excluded.full_name, role = excluded.role`,
      [ids[m.user], m.name, m.role, m.login]
    );
  }
  for (const m of TEAM.filter((x) => x.manager)) {
    await c.query('update users set manager_id = $2 where id = $1',
      [ids[m.user], ids[m.manager]]);
  }

  await c.query('commit');

  const out = await c.query(
    `select u.full_name, u.role, a.email, u.is_active,
            m.full_name as reports_to,
            (a.encrypted_password is not null) as can_login
     from users u
     join auth.users a on a.id = u.id
     left join users m on m.id = u.manager_id
     order by u.role::text, u.full_name`
  );
  console.table(out.rows);
  console.log(`\nTemporary password for every login account: ${TEMP_PASSWORD}`);
  console.log('Change it before the team starts using the app.');
  await c.end();
};

run().catch(async (e) => {
  console.error('failed:', e.message);
  try { await c.query('rollback'); await c.end(); } catch {}
  process.exit(1);
});
