import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { syncPocConsultationSheet } from '@/lib/sheets/poc-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') === `Bearer ${secret}`) return true;
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const { data: profile } = await db.from('users').select('role,is_active').eq('id', user.id).single();
  return !!profile?.is_active && ['admin', 'auditor', 'ceo', 'coo', 'sales_manager', 'sales_exec'].includes(profile.role);
}

async function run(request: NextRequest) {
  if (!(await authorized(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await syncPocConsultationSheet());
  } catch (error) {
    console.error('[poc-sync] failed', { error });
    return NextResponse.json({ error: 'POC sync failed.' }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
