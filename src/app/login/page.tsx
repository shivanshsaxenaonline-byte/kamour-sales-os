import AccountPicker from './account-picker';
import PasswordLogin from './password-login';

// Without a dynamic API call, this page has nothing forcing per-request
// rendering, so Next.js can prerender it to static HTML at build time and
// bake in whatever KAMOUR_ID_PICKER was at that moment. Force it dynamic so
// the env var is always read fresh, on every request.
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const idPicker = process.env.KAMOUR_ID_PICKER === '1';
  return idPicker ? <AccountPicker /> : <PasswordLogin />;
}
