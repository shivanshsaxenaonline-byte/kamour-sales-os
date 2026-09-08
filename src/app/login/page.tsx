import AccountPicker from './account-picker';
import PasswordLogin from './password-login';

export default async function LoginPage() {
  const idPicker = process.env.KAMOUR_ID_PICKER === '1';
  return idPicker ? <AccountPicker /> : <PasswordLogin />;
}
