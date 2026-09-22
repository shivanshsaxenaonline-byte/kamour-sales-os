"use server";

import { createClient } from "@/lib/supabase/server";
import { ENTITY_TABLES } from "./config";
import type { EditRequest, OrderWorkspaceRequest } from "@/types/crm";

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

export async function saveOrderWorkspace(
  input: OrderWorkspaceRequest,
): Promise<{ ok: true; updatedAt: string } | { ok: false; error: string }> {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(input.id) || !input.version)
      throw new Error("Invalid order. Reload it and try again.");
    const allowedFields = new Set([
      "stage", "payment_state", "payment_mode_id", "source_id", "amount",
      "discount", "shipping_amount", "cod_amount", "course_duration_days",
      "ship_name", "ship_address", "ship_pincode", "ship_city", "ship_state",
      "courier_id", "awb", "dispatch_date", "delivered_at", "rto_at",
      "is_repeat", "order_notes", "ad_code", "gclid", "order_date",
    ]);
    for (const [key, value] of Object.entries(input.patch)) {
      if (!allowedFields.has(key) || (typeof value !== "string" && typeof value !== "boolean"))
        throw new Error("Unsupported order change.");
      if (typeof value === "string" && value.length > 4000)
        throw new Error("One of the fields is too long.");
    }
    const nonNegative = ["amount", "discount", "shipping_amount", "cod_amount"];
    for (const field of nonNegative) {
      const value = String(input.patch[field] ?? "");
      if (value && (!Number.isFinite(Number(value)) || Number(value) < 0))
        throw new Error(`${field.replaceAll("_", " ")} must be zero or more.`);
    }
    if (Number(input.patch.discount) > Number(input.patch.amount))
      throw new Error("Discount cannot be higher than the order amount.");
    const course = Number(input.patch.course_duration_days);
    if (!Number.isInteger(course) || course < 1 || course > 365)
      throw new Error("Course duration must be between 1 and 365 days.");
    const pincode = String(input.patch.ship_pincode ?? "");
    if (pincode && !/^[1-9]\d{5}$/.test(pincode.replace(/\D/g, "")))
      throw new Error("Enter a valid six digit pincode.");
    if (!Array.isArray(input.items) || input.items.length > 50)
      throw new Error("Invalid product lines.");
    for (const item of input.items)
      if (!/^[0-9a-f-]{36}$/i.test(item.product_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)
        throw new Error("Select valid product quantities.");

    const db = await createClient();
    const { data: { user } } = await db.auth.getUser();
    if (!user) throw new Error("Your session expired. Sign in again.");
    const { data: profile, error: profileError } = await db
      .from("users")
      .select("role,is_active")
      .eq("id", user.id)
      .single();
    if (profileError || !profile?.is_active)
      throw new Error("Your account cannot make changes.");
    if (!["sales_exec", "sales_manager", "ops", "admin"].includes(profile.role))
      throw new Error("Your role has read-only access to this order.");

    const { data, error } = await db.rpc("save_order_workspace", {
      p_order_id: input.id,
      p_version: input.version,
      p_patch: input.patch,
      p_items: input.items,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.updated_at) throw new Error("The order did not save. Reload and try again.");
    return { ok: true, updatedAt: row.updated_at as string };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save the order.",
    };
  }
}
