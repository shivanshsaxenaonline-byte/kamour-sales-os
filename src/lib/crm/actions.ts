"use server";

import { createClient } from "@/lib/supabase/server";
import { ENTITY_TABLES } from "./config";
import type { EditRequest } from "@/types/crm";

/** Small, version-checked edits. Payments, ownership and fulfilment are never inferred. */
export async function saveRecordEdit(
  input: EditRequest,
): Promise<{ ok: true; updatedAt: string } | { ok: false; error: string }> {
  try {
    if (
      !/^[0-9a-f-]{36}$/i.test(input.id) ||
      !input.version ||
      typeof input.value !== "string" ||
      input.value.length > 4000
    )
      throw new Error("Invalid edit. Reload the record and try again.");
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) throw new Error("Your session expired. Sign in again.");
    const { data: profile, error: profileError } = await db
      .from("users")
      .select("role,is_active")
      .eq("id", user.id)
      .single();
    if (profileError || !profile?.is_active)
      throw new Error("Your account cannot make changes.");
    const allowed: Record<string, string[]> = {
      lead: ["sales_exec", "sales_manager", "admin"],
      consultation: ["doctor", "sales_manager", "admin"],
      order: ["sales_exec", "sales_manager", "ops", "admin"],
      followup: ["sales_exec", "sales_manager", "admin"],
    };
    if (!allowed[input.entity]?.includes(profile.role))
      throw new Error("Your role has read-only access to this record.");
    let patch: Record<string, string | null>;
    if (input.entity === "lead") {
      const { data: status, error } = await db
        .from("lead_statuses")
        .select("id,code")
        .eq("id", input.value)
        .eq("is_active", true)
        .single();
      if (error || !status) throw new Error("Select an active lead status.");
      if (/lost|junk|cancel/i.test(status.code))
        throw new Error(
          "This status needs a reason workflow. Use a non-destructive status here.",
        );
      patch = { status_id: status.id };
    } else if (input.entity === "consultation")
      patch = { notes: input.value.trim() || null };
    else if (input.entity === "order")
      patch = { awb: input.value.trim() || null };
    else if (input.entity === "followup")
      patch = { remark: input.value.trim() || null };
    else throw new Error("Unsupported record type.");
    const { data, error } = await db
      .from(ENTITY_TABLES[input.entity])
      .update(patch)
      .eq("id", input.id)
      .eq("updated_at", input.version)
      .select("id,updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data)
      throw new Error(
        "The record changed or you no longer have permission. Reload before retrying; your draft is kept.",
      );
    return { ok: true, updatedAt: data.updated_at as string };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not save. Your previous value has been restored.",
    };
  }
}
