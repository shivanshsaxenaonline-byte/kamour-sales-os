import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SHEET_ID = "1TVYa2UMtK8JIAinIBfhIlo_AkaOUlYZHtkJqzj7Fwos";
const TAB_NAME = "Consultation Record - AP+TA+SS";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Consultation%20Record%20-%20AP%2BTA%2BSS`;

type SourceRow = Record<string, string>;
type Snapshot = Record<string, string | number | null>;

export type ConsultationSyncResult = {
  ok: true;
  locked?: boolean;
  rowsSeen: number;
  created: number;
  updated: number;
  skipped: { row: number; reason: string }[];
  finishedAt?: string;
};

type LinkRow = {
  source_row_number: number;
  consultation_id: string;
  identity_key: string;
  source_snapshot: Snapshot;
};

type ExistingConsultation = {
  id: string;
  customer_id: string;
  scheduled_at: string | null;
  state: "pending" | "done" | "cancelled";
  fee_amount: number | null;
  customers: { phone_e164: string } | null;
};

const BLANKS = new Set(["", "-", "--", "n/a", "na", "null", "#n/a"]);
const FOLLOW_UP = /^follow\s*up$/i;
const norm = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (value: string | null | undefined) => {
  const text = (value ?? "").trim();
  return BLANKS.has(text.toLowerCase()) ? null : text;
};
const toE164 = (value: string | null | undefined) => {
  let digits = (value ?? "").replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
};
const number = (value: string | null | undefined) => {
  const text = clean(value);
  if (!text || FOLLOW_UP.test(text)) return null;
  if (/^free$/i.test(text)) return 0;
  const parsed = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const age = (value: string | null | undefined) => {
  const parsed = number(value);
  return parsed != null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 120
    ? parsed
    : null;
};

function date(value: string | null | undefined) {
  const text = clean(value);
  if (!text) return null;
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  let match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const month = months[match[1]!.slice(0, 3).toLowerCase()];
    return month
      ? `${match[3]!}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`
      : null;
  }
  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!match) return null;
  const year = match[3]!.length === 2 ? `20${match[3]!}` : match[3]!;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const istTimestamp = (value: string | null) =>
  value ? `${value}T00:00:00+05:30` : null;

function istDate(value: string | null) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function sourceRows(csv: string): SourceRow[] {
  const matrix = parseCsv(csv.replace(/^\uFEFF/, ""));
  const headers = matrix[0]?.map((header) => header.trim()) ?? [];
  return matrix
    .slice(1)
    .filter((row) => row.some((value) => value.trim()))
    .map((row) =>
      Object.fromEntries(
        headers
          .map((header, index) => [header, (row[index] ?? "").trim()] as const)
          .filter(([header]) => header),
      ),
    );
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("server_not_configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function changed(previous: Snapshot | undefined, next: Snapshot, key: string) {
  return !previous || stable(previous[key]) !== stable(next[key]);
}

function userId(
  raw: string | null,
  exactUsers: Map<string, string>,
  roleUsers?: { id: string; normalized: string }[],
) {
  const normalized = norm(raw);
  if (!normalized) return null;
  const exact = exactUsers.get(normalized);
  if (exact) return exact;
  return (
    roleUsers?.find(
      (user) =>
        user.normalized.includes(normalized) || normalized.includes(user.normalized),
    )?.id ?? null
  );
}

function doctorId(
  raw: string | null,
  exactUsers: Map<string, string>,
  doctors: { id: string; normalized: string }[],
) {
  const normalized = norm(raw);
  if (!normalized || normalized.includes("nodoctor") || normalized === "salesteam")
    return null;
  const aliases = ["rupend", "harsh", "shubham", "dinesh", "rajeev"];
  const alias = aliases.find((value) => normalized.includes(value));
  if (alias) return doctors.find((doctor) => doctor.normalized.includes(alias))?.id ?? null;
  return userId(raw, exactUsers, doctors);
}

async function customersByPhone(db: SupabaseClient, phones: string[]) {
  const customers = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < phones.length; index += 100) {
    const { data, error } = await db
      .from("customers")
      .select("id,phone_e164,full_name,age,state,current_owner_id,original_owner_id")
      .in("phone_e164", phones.slice(index, index + 100))
      .is("merged_into_id", null)
      .range(0, 199);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) customers.set(row.phone_e164, row);
  }
  return customers;
}

export async function syncConsultationSheet(): Promise<ConsultationSyncResult> {
  const db = serviceClient();
  const { data: claimed, error: claimError } = await db.rpc(
    "claim_sheet_consultation_sync",
    { p_sheet_id: SHEET_ID, p_tab_name: TAB_NAME },
  );
  if (claimError) throw new Error(claimError.message);
  if (!claimed)
    return {
      ok: true,
      locked: true,
      rowsSeen: 0,
      created: 0,
      updated: 0,
      skipped: [],
    };

  const skipped: { row: number; reason: string }[] = [];
  let rowsSeen = 0;
  let created = 0;
  let updated = 0;

  try {
    const response = await fetch(CSV_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`sheet_fetch_${response.status}`);
    const rows = sourceRows(await response.text());
    rowsSeen = rows.length;

    const [usersResult, sourcesResult, reasonsResult, linksResult, existingResult] =
      await Promise.all([
        db.from("users").select("id,full_name,role").eq("is_active", true).range(0, 199),
        db.from("lead_sources").select("id,code,label_en").eq("is_active", true).range(0, 199),
        db.from("cancel_reasons").select("id,code").eq("is_active", true).range(0, 99),
        db
          .from("sheet_consultation_links")
          .select("source_row_number,consultation_id,identity_key,source_snapshot")
          .eq("sheet_id", SHEET_ID)
          .eq("tab_name", TAB_NAME)
          .range(0, 2999),
        db
          .from("consultations")
          .select("id,customer_id,scheduled_at,state,fee_amount,customers!inner(phone_e164)")
          .range(0, 4999),
      ]);
    for (const result of [
      usersResult,
      sourcesResult,
      reasonsResult,
      linksResult,
      existingResult,
    ])
      if (result.error) throw new Error(result.error.message);

    const exactUsers = new Map<string, string>();
    const doctors: { id: string; normalized: string }[] = [];
    const salespeople: { id: string; normalized: string }[] = [];
    for (const user of usersResult.data ?? []) {
      const normalized = norm(user.full_name);
      exactUsers.set(normalized, user.id);
      if (user.role === "doctor") doctors.push({ id: user.id, normalized });
      if (user.role === "sales_exec" || user.role === "sales_manager")
        salespeople.push({ id: user.id, normalized });
    }
    const sourceIds = new Map<string, string>();
    for (const source of sourcesResult.data ?? []) {
      sourceIds.set(norm(source.code), source.id);
      sourceIds.set(norm(source.label_en), source.id);
    }
    const legacyCancelReason =
      (reasonsResult.data ?? []).find((reason) => reason.code === "legacy_unknown")?.id ??
      null;
    if (!legacyCancelReason)
      throw new Error("legacy_cancel_reason_missing");

    const links = new Map(
      ((linksResult.data ?? []) as LinkRow[]).map((link) => [
        link.source_row_number,
        link,
      ]),
    );
    const candidates = new Map<string, ExistingConsultation[]>();
    for (const consultation of existingResult.data as unknown as ExistingConsultation[]) {
      const phone = consultation.customers?.phone_e164;
      const scheduledOn = istDate(consultation.scheduled_at);
      if (!phone || !scheduledOn) continue;
      const key = `${phone}|${scheduledOn}`;
      candidates.set(key, [...(candidates.get(key) ?? []), consultation]);
    }
    const consumed = new Set([...links.values()].map((link) => link.consultation_id));
    const parsed = rows.map((row, index) => ({ row, rowNumber: index + 2 }));
    const phones = [
      ...new Set(parsed.map(({ row }) => toE164(row.Number)).filter(Boolean)),
    ] as string[];
    const customers = await customersByPhone(db, phones);

    for (const { row, rowNumber } of parsed) {
      const phone = toE164(row.Number);
      const state = {
        consultationdone: "done",
        pending: "pending",
        cancelled: "cancelled",
      }[norm(row["Consultation Status"])] as
        | "pending"
        | "done"
        | "cancelled"
        | undefined;
      const scheduledOn =
        date(row["Consultation Date"]) ?? date(row["Payment Date"]);
      if (!phone) {
        skipped.push({ row: rowNumber, reason: "missing_or_invalid_phone" });
        continue;
      }
      if (!state) {
        skipped.push({ row: rowNumber, reason: "unknown_consultation_status" });
        continue;
      }
      if (state === "done" && !scheduledOn) {
        skipped.push({ row: rowNumber, reason: "done_without_date" });
        continue;
      }

      const owner = userId(
        clean(row["Joined By"]) ?? clean(row["Consultation Taken By Sales Team"]),
        exactUsers,
        salespeople,
      );
      const doctor = doctorId(clean(row["Doctor Name"]), exactUsers, doctors);
      const sourceId = sourceIds.get(norm(row["Lead Source"])) ?? null;
      const feeAmount = number(row.Amount);
      const payment = clean(row.Payment);
      const feeState = payment && !FOLLOW_UP.test(payment) ? "paid" : "unpaid";
      const notes = [
        clean(row["Notes (Before Consultation)"]),
        clean(row["Medicine Remark (Immediately After Consultation)"]),
      ]
        .filter(Boolean)
        .join("\n---\n") || null;
      const snapshot: Snapshot = {
        phone,
        customer_name: clean(row["Customer Name"]),
        customer_age: age(row.Age),
        customer_state: clean(row.State),
        source_id: sourceId,
        owner_id: owner,
        scheduled_on: scheduledOn,
        state,
        doctor_id: doctor,
        taken_by_id: userId(
          clean(row["Consultation Taken By Sales Team"]),
          exactUsers,
          salespeople,
        ),
        fee_amount: feeAmount,
        fee_state: feeState,
        notes,
      };
      const identityKey = `${phone}|${scheduledOn ?? norm(row["Consultation Date"])}|${norm(row["OPD NO."])}`;
      const link = links.get(rowNumber);
      const previous = link?.source_snapshot;
      if (link && link.identity_key === identityKey && stable(previous) === stable(snapshot)) {
        consumed.add(link.consultation_id);
        continue;
      }

      let customer = customers.get(phone);
      let customerChanged = false;
      if (!customer) {
        const { data: inserted, error } = await db
          .from("customers")
          .insert({
            phone_e164: phone,
            phone_raw: row.Number,
            full_name: snapshot.customer_name ?? "Unknown",
            age: snapshot.customer_age,
            state: snapshot.customer_state,
            first_source_id: sourceId,
            original_owner_id: owner,
            current_owner_id: owner,
          })
          .select("id,phone_e164,full_name,age,state,current_owner_id,original_owner_id")
          .single();
        if (error) {
          skipped.push({ row: rowNumber, reason: `customer:${error.message}` });
          continue;
        }
        customer = inserted;
        customers.set(phone, inserted);
        customerChanged = true;
      } else {
        const customerPatch: Record<string, unknown> = {};
        const customerFields: Record<string, string> = {
          customer_name: "full_name",
          customer_age: "age",
          customer_state: "state",
          owner_id: "current_owner_id",
        };
        for (const [sourceKey, targetKey] of Object.entries(customerFields)) {
          // A blank Sheet name must never erase the CRM's required customer name.
          if (sourceKey === "customer_name" && snapshot[sourceKey] == null) continue;
          if (changed(previous, snapshot, sourceKey))
            customerPatch[targetKey] = snapshot[sourceKey];
        }
        if (!previous && owner) customerPatch.original_owner_id = owner;
        if (!previous && sourceId) customerPatch.first_source_id = sourceId;
        if (Object.keys(customerPatch).length) {
          const { error } = await db
            .from("customers")
            .update(customerPatch)
            .eq("id", customer.id as string);
          if (error) {
            skipped.push({ row: rowNumber, reason: `customer_update:${error.message}` });
            continue;
          }
          customerChanged = true;
        }
      }

      let consultationId = link?.consultation_id ?? null;
      if (!consultationId && scheduledOn) {
        const sameDay = candidates.get(`${phone}|${scheduledOn}`) ?? [];
        const exact = sameDay.find(
          (candidate) =>
            !consumed.has(candidate.id) &&
            candidate.state === state &&
            Number(candidate.fee_amount) === Number(feeAmount),
        );
        consultationId =
          exact?.id ?? sameDay.find((candidate) => !consumed.has(candidate.id))?.id ?? null;
      }

      let rowChanged = customerChanged;
      let insertedConsultation = false;
      const consultationValues = {
        customer_id: customer.id,
        doctor_id: doctor,
        taken_by_id: snapshot.taken_by_id,
        scheduled_at: istTimestamp(scheduledOn),
        state,
        completed_at: state === "done" ? istTimestamp(scheduledOn) : null,
        cancel_reason_id: state === "cancelled" ? legacyCancelReason : null,
        fee_amount: feeAmount,
        fee_state: feeState,
        notes,
      };
      if (!consultationId) {
        const { data: inserted, error } = await db
          .from("consultations")
          .insert(consultationValues)
          .select("id")
          .single();
        if (error) {
          skipped.push({ row: rowNumber, reason: `consultation:${error.message}` });
          continue;
        }
        consultationId = inserted.id;
        insertedConsultation = true;
        rowChanged = true;
        created += 1;
      } else {
        const consultationPatch: Record<string, unknown> = {};
        const consultationFields: Record<string, keyof typeof consultationValues> = {
          doctor_id: "doctor_id",
          taken_by_id: "taken_by_id",
          scheduled_on: "scheduled_at",
          state: "state",
          fee_amount: "fee_amount",
          fee_state: "fee_state",
          notes: "notes",
        };
        for (const [sourceKey, targetKey] of Object.entries(consultationFields))
          if (changed(previous, snapshot, sourceKey))
            consultationPatch[targetKey] = consultationValues[targetKey];
        if (changed(previous, snapshot, "state") || changed(previous, snapshot, "scheduled_on")) {
          consultationPatch.completed_at = consultationValues.completed_at;
          consultationPatch.cancel_reason_id = consultationValues.cancel_reason_id;
        }
        if (customerChanged && !Object.keys(consultationPatch).length)
          consultationPatch.updated_at = new Date().toISOString();
        if (Object.keys(consultationPatch).length) {
          const { error } = await db
            .from("consultations")
            .update(consultationPatch)
            .eq("id", consultationId);
          if (error) {
            skipped.push({ row: rowNumber, reason: `consultation_update:${error.message}` });
            continue;
          }
          rowChanged = true;
        }
      }

      if (!consultationId) {
        skipped.push({ row: rowNumber, reason: "consultation_id_missing_after_write" });
        continue;
      }
      const { error: linkError } = await db.from("sheet_consultation_links").upsert(
        {
          sheet_id: SHEET_ID,
          tab_name: TAB_NAME,
          source_row_number: rowNumber,
          consultation_id: consultationId,
          identity_key: identityKey,
          source_snapshot: snapshot,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "sheet_id,tab_name,source_row_number" },
      );
      if (linkError) {
        skipped.push({ row: rowNumber, reason: `link:${linkError.message}` });
        continue;
      }
      consumed.add(consultationId);
      if (rowChanged && !insertedConsultation) updated += 1;
    }

    const finishedAt = new Date().toISOString();
    await db
      .from("sheet_consultation_sync_sources")
      .update({
        last_finished_at: finishedAt,
        last_success_at: finishedAt,
        lock_until: null,
        rows_seen: rowsSeen,
        rows_created: created,
        rows_updated: updated,
        rows_skipped: skipped.length,
        last_error: skipped.length ? JSON.stringify(skipped.slice(0, 20)) : null,
      })
      .eq("sheet_id", SHEET_ID)
      .eq("tab_name", TAB_NAME);
    return { ok: true, rowsSeen, created, updated, skipped, finishedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from("sheet_consultation_sync_sources")
      .update({
        last_finished_at: new Date().toISOString(),
        lock_until: null,
        last_error: message.slice(0, 2000),
      })
      .eq("sheet_id", SHEET_ID)
      .eq("tab_name", TAB_NAME);
    throw error;
  }
}
