import { createClient } from '@/lib/supabase/server';
import { ROLES } from '@/lib/razorpay/analytics';
import { RazorpayScreen } from './razorpay-screen';
export const dynamic = 'force-dynamic';
export default async function RazorpayPage() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: profile } = user ? await db.from('users').select('role,is_active').eq('id', user.id).single() : { data: null };
  if (!profile?.is_active || !ROLES.includes(profile.role)) return <div style={{ padding: 24 }} role="alert">Razorpay reporting is available to managers and oversight roles.</div>;
  return <RazorpayScreen />;
}
