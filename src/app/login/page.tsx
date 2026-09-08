import { headers } from 'next/headers';
import AccountPicker from './account-picker';
import PasswordLogin from './password-login';

export default async function LoginPage() {
  const host = (await headers()).get('host') ?? '';
  const localPicker = process.env.KAMOUR_LOCAL_ACCOUNT_PICKER === '1' &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return localPicker ? <AccountPicker /> : <PasswordLogin />;
}
