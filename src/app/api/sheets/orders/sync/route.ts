import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncMedicineOrderSheet } from "@/lib/sheets/order-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorised(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true;

  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const { data: profile } = await db
    .from("users")
    .select("role,is_active")
    .eq("id", user.id)
    .single();
  return !!profile?.is_active && ["admin", "auditor", "ceo", "coo", "sales_manager", "ops"].includes(profile.role);
}

export async function GET(request: Request) {
  return POST(request);
}

export async function POST(request: Request) {
  if (!(await authorised(request)))
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const result = await syncMedicineOrderSheet();
    return NextResponse.json(result, { status: result.locked ? 202 : 200 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "sync_failed" },
      { status: 500 },
    );
  }
}
