// Usage: node --env-file=.env.local scripts/set-login-password.mjs alka
// Supply KAMOUR_NEW_PASSWORD in the process environment; never log passwords.
import { createClient } from '@supabase/supabase-js';
const login = process.argv[2];
const password = process.env.KAMOUR_NEW_PASSWORD;
if (!login || !/^[a-z]+$/.test(login) || !password) throw new Error('Login and KAMOUR_NEW_PASSWORD required.');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
let target;
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  target = data.users.find(user => user.email === `${login}@kamour.local`);
  if (target || data.users.length < 100) break;
}
if (!target) throw new Error('Account not found.');
const { error } = await admin.auth.admin.updateUserById(target.id, { password });
if (error) throw error;
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
const { data, error: signInError } = await client.auth.signInWithPassword({ email: target.email, password });
if (signInError || data.user?.id !== target.id) throw signInError ?? new Error('Account verification failed.');
await client.auth.signOut();
console.log(`Password updated and login verified: ${login}`);
