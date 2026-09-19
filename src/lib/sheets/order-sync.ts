import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SHEET_ID = "1TVYa2UMtK8JIAinIBfhIlo_AkaOUlYZHtkJqzj7Fwos";
const TAB_NAME = "Medicine Order Record - AP+TA+S";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Medicine%20Order%20Record%20-%20AP%2BTA%2BS`;

// The floor's own holding pen. A row lands here when the customer has not
// confirmed — no address yet, asking their wife, gone quiet — and its
// Confirmation Status says how it ended: Pending, Confirmed or Cancelled.
//
// An order the sheet never confirmed is not an order, and a rep must not spend
// a call on it. Two marks say so and both are honoured below: the tick in the
// main tab's `Pending Status`, and a Cancelled row here.
const PENDING_TAB_NAME = "Pending Confirmation Medicine Order - AP+TA+SS";
const PENDING_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Pending%20Confirmation%20Medicine%20Order%20-%20AP%2BTA%2BSS`;

type SourceRow = Record<string, string>;
type JsonRow = Record<string, string | number | boolean | null | JsonItem[]>;
type JsonItem = { product_id: string; quantity: number };
type SyncResult = {
  ok: boolean;
  locked?: boolean;
  rowsSeen: number;
  created: number;
  updated: number;
  /** Orders removed because the sheet says they were never confirmed. */
  discarded: number;
  skipped: { row: number; reason: string }[];
  finishedAt?: string;
};

type LinkRow = {
  source_row_number: number;
  order_id: string;
  identity_key: string;
  source_snapshot: JsonRow;
};

type ExistingOrder = {
  id: string;
  customer_id: string;
  amount: number;
  created_at: string;
  consultation_id: string | null;
  customers: { phone_e164: string } | null;
};

const norm = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (value: string | null | undefined) => {
  const text = (value ?? "").trim();
  return !text || ["-", "--", "n/a", "na", "null", "#n/a"].includes(text.toLowerCase())
    ? null
    : text;
};
const toE164 = (value: string | null | undefined) => {
  let digits = (value ?? "").replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
};
const number = (value: string | null | undefined) => {
  const text = clean(value);
  if (!text) return null;
  const parsed = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const date = (value: string | null | undefined) => {
  const text = clean(value);
  if (!text) return null;
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
  return `${year}-${match[2]!.padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
};
const istTimestamp = (value: string | null) =>
  value ? `${value}T00:00:00+05:30` : null;
const istDate = (value: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

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
      Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? "").trim()])),
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

async function lookup(
  db: SupabaseClient,
  table: "lead_sources" | "payment_modes" | "couriers",
) {
  const { data, error } = await db
    .from(table)
    .select("id,code,label_en")
    .eq("is_active", true)
    .range(0, 199);
  if (error) throw new Error(error.message);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(norm(row.code), row.id);
    map.set(norm(row.label_en), row.id);
  }
  return map;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function changed(snapshot: JsonRow | undefined, next: JsonRow, key: string) {
  if (!snapshot) return true;
  return stable(snapshot[key]) !== stable(next[key]);
}

/** How an order is recognised across the two tabs and the database: who, when,
 *  how much. The same key the sheet link already stores. */
const identity = (phone: string, orderDate: string, amount: number) =>
  `${phone}|${orderDate}|${amount}`;

/** Every order the Pending Confirmation tab marks Cancelled, by identity.
 *
 *  Matched on all three parts, never on the phone alone: two of these people
 *  came back and bought for real months later (Nitin has thirteen orders, one
 *  of them the cancelled one), and dropping a customer because they once
 *  cancelled would throw away the orders they did place.
 */
async function cancelledIdentities(): Promise<Set<string>> {
  const response = await fetch(PENDING_CSV_URL, { cache: "no-store" });
  // The holding pen being unreadable must not stop the day's orders importing.
  // The tick in the main tab still catches everything currently pending.
  if (!response.ok) return new Set();
  const keys = new Set<string>();
  for (const row of sourceRows(await response.text())) {
    if (norm(row["Confirmation Status"]) !== "cancelled") continue;
    const phone = toE164(row["Contact Number"]);
    const orderDate = date(row["Date of Order"]);
    const amount = number(row["Order Amount"]);
    if (phone && orderDate && amount != null) keys.add(identity(phone, orderDate, amount));
  }
  return keys;
}

async function rowsByPhones(db: SupabaseClient, phones: string[]) {
  const customers = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < phones.length; index += 100) {
    const { data, error } = await db
      .from("customers")
      .select("id,phone_e164,full_name,age,address,pincode,city,state,current_owner_id,original_owner_id")
      .in("phone_e164", phones.slice(index, index + 100))
      .is("merged_into_id", null)
      .range(0, 199);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) customers.set(row.phone_e164, row);
  }
  return customers;
}

export async function syncMedicineOrderSheet(): Promise<SyncResult> {
  const db = serviceClient();
  const { data: claimed, error: claimError } = await db.rpc("claim_sheet_order_sync", {
    p_sheet_id: SHEET_ID,
    p_tab_name: TAB_NAME,
  });
  if (claimError) throw new Error(claimError.message);
  if (!claimed)
    return { ok: true, locked: true, rowsSeen: 0, created: 0, updated: 0, discarded: 0, skipped: [] };

  const skipped: { row: number; reason: string }[] = [];
  let rowsSeen = 0;
  let created = 0;
  let updated = 0;
  let discarded = 0;

  /** Remove an order the sheet has disowned. Returns whether one went. */
  const discard = async (orderId: string | null | undefined) => {
    if (!orderId) return false;
    const { data, error } = await db.rpc("fn_discard_sheet_order", { p_order_id: orderId });
    if (error) throw new Error(`discard:${error.message}`);
    if (data?.removed) discarded += 1;
    return !!data?.removed;
  };

  try {
    const [response, cancelled] = await Promise.all([
      fetch(CSV_URL, { cache: "no-store" }),
      cancelledIdentities(),
    ]);
    if (!response.ok) throw new Error(`sheet_fetch_${response.status}`);
    const rows = sourceRows(await response.text());
    rowsSeen = rows.length;

    const [sources, paymentModes, couriers, usersResult, productsResult, linksResult, ordersResult] =
      await Promise.all([
        lookup(db, "lead_sources"),
        lookup(db, "payment_modes"),
        lookup(db, "couriers"),
        db.from("users").select("id,full_name,role").eq("is_active", true).range(0, 199),
        db.from("products").select("id,sku,name,variant").eq("is_active", true).range(0, 199),
        db
          .from("sheet_order_links")
          .select("source_row_number,order_id,identity_key,source_snapshot")
          .eq("sheet_id", SHEET_ID)
          .eq("tab_name", TAB_NAME)
          .range(0, 1999),
        db
          .from("orders")
          .select("id,customer_id,amount,created_at,consultation_id,customers!inner(phone_e164)")
          .gte("created_at", "2026-07-01T00:00:00+05:30")
          .range(0, 2999),
      ]);
    for (const result of [usersResult, productsResult, linksResult, ordersResult])
      if (result.error) throw new Error(result.error.message);

    const users = new Map<string, string>();
    const doctors = new Map<string, string>();
    for (const user of usersResult.data ?? []) {
      users.set(norm(user.full_name), user.id);
      if (user.role === "doctor") doctors.set(norm(user.full_name), user.id);
    }
    const products = new Map(
      (productsResult.data ?? []).map((product) => [product.sku, product.id]),
    );
    const links = new Map(
      ((linksResult.data ?? []) as LinkRow[]).map((link) => [link.source_row_number, link]),
    );
    const orderCandidates = new Map<string, ExistingOrder[]>();
    for (const order of (ordersResult.data ?? []) as unknown as ExistingOrder[]) {
      const phone = order.customers?.phone_e164;
      if (!phone) continue;
      const key = `${phone}|${istDate(order.created_at)}|${Number(order.amount)}`;
      orderCandidates.set(key, [...(orderCandidates.get(key) ?? []), order]);
    }
    const consumedOrders = new Set<string>(
      [...links.values()].map((link) => link.order_id),
    );

    const parsed = rows.map((row, index) => ({ row, rowNumber: index + 2 }));
    const validPhones = [...new Set(parsed.map(({ row }) => toE164(row["Contact Number"])).filter(Boolean))] as string[];
    const customers = await rowsByPhones(db, validPhones);

    const productColumns: Record<string, string> = {
      "Gold Plus 60N": "GP60",
      "Gold Plus 30N": "GP30",
      "Boost Up Oil": "BUO",
      "Power Drive": "PD",
      "Daily Charge 60N": "DC60",
      "Daily Charge 30N": "DC30",
      "Shilajit Resin": "SGR",
    };
    const sourceCodes: Record<string, string> = {
      kapeefit: "kapeefit",
      flipkart: "flipkart",
      justdial: "justdial",
      indiamart: "indiamart",
    };
    const paymentCodes: Record<string, string> = {
      gpaycod: "gpay_cod",
      gpay: "gpay",
      cod: "cod",
      razorpay: "razorpay",
      prepaid: "prepaid",
    };
    const courierCodes: Record<string, string> = {
      delhivery: "delhivery",
      shiprocket: "shiprocket",
      bluedart: "bluedart",
      dtdc: "dtdc",
      shadowfax: "shadowfax",
      maruti: "maruti",
      store: "store",
    };

    for (const { row, rowNumber } of parsed) {
      const phone = toE164(row["Contact Number"]);
      const orderDate = date(row["Date of Order"]);
      const amount = number(row["Order Amount"]);
      const courseDays = Number((row["Course Duration"]?.match(/\d+/) ?? [])[0]);

      // Never confirmed, so never an order — and this is asked before anything
      // else can turn the row away, because a pending row is often half filled
      // in. Nikhil's had lost its phone number by the time the tick went on,
      // and a row that stops at `missing_or_invalid_phone` leaves the order it
      // already created sitting in the reps' lists.
      //
      // The tick normally goes on AFTER the row was entered and imported, which
      // is how all seven got into the calling lists in the first place. So a
      // row that turns pending takes its order with it rather than merely being
      // refused entry the next time.
      const key = phone && orderDate && amount != null ? identity(phone, orderDate, amount) : null;
      const unconfirmed = /^true$/i.test(row["Pending Status"] ?? "")
        ? "pending_confirmation"
        : key && cancelled.has(key) ? "cancelled_in_pending_tab" : null;
      if (unconfirmed) {
        const existing = links.get(rowNumber)?.order_id
          ?? (key ? (orderCandidates.get(key) ?? []).find((order) => !consumedOrders.has(order.id))?.id : null);
        const removed = await discard(existing);
        await db.from("sheet_order_links").delete()
          .eq("sheet_id", SHEET_ID).eq("tab_name", TAB_NAME).eq("source_row_number", rowNumber);
        skipped.push({ row: rowNumber, reason: removed ? `${unconfirmed}:removed` : unconfirmed });
        continue;
      }

      if (!phone) {
        skipped.push({ row: rowNumber, reason: "missing_or_invalid_phone" });
        continue;
      }
      if (!orderDate || amount == null || !courseDays) {
        skipped.push({ row: rowNumber, reason: "missing_order_date_amount_or_course" });
        continue;
      }

      const sourceId = sources.get(norm(sourceCodes[norm(row.Source)] ?? row.Source)) ?? null;
      const paymentCode = paymentCodes[norm(row["Payment Mode"])] ?? null;
      const paymentModeId = paymentModes.get(norm(paymentCode)) ?? null;
      const courierCode = courierCodes[norm(row["Shipped By"])] ?? null;
      const courierId = couriers.get(norm(courierCode)) ?? null;
      const ownerId = users.get(norm(row["Conversion By"])) ?? null;
      const consultationTakenById = users.get(norm(row["Consultation Taken By"])) ?? null;
      const doctorId = doctors.get(norm(row["Doctor Name"])) ?? null;
      const consultationDate = date(row["Date of Consultation"]);
      const deliveredDate = date(row["Delivered Date"]);
      const deliveryText = norm(row["Delivered Date"]);
      // No `pending_confirm` any more: a ticked row never reaches this point.
      // The stage stays in the enum for orders edited by hand in the workspace.
      //
      // "Delivered Date" is not always a date. Ops write the courier's answer
      // into the same cell — 19 "RTO Returned", 16 "Intransit", 3 "RTO
      // Intransit", a "LOST" and a "Cancelled" in the current tab — and every
      // one of those used to land here as a plain `confirmed` order, which
      // reads as "bought, waiting to ship" forever. It cost real calls: a
      // customer whose parcel came back is indistinguishable from one who is
      // happily on their new course, so the medicine-ending list treated the
      // failed order as a reorder and stopped calling them.
      //
      // The enum already had somewhere to put all of it.
      const stage = deliveredDate
        ? "delivered"
        : deliveryText === "intransit"
          ? "dispatched"
          // Came back, or never arrived. Both mean the customer has no medicine
          // in hand, whatever the invoice says.
          // norm() has already stripped the spaces: "RTO Returned" arrives
          // here as "rtoreturned".
          : deliveryText.startsWith("rto") || deliveryText === "lost"
            ? "rto"
            : deliveryText.startsWith("cancel")
              ? "cancelled"
              : "confirmed";
      const paymentState = paymentCode === "gpay" || paymentCode === "razorpay" || paymentCode === "prepaid"
        ? "paid"
        : paymentCode === "gpay_cod"
          ? "partial"
          : "unpaid";
      const pincode = (row.Pincode ?? "").replace(/\D/g, "");
      const items: JsonItem[] = Object.entries(productColumns)
        .map(([column, sku]) => ({ product_id: products.get(sku) ?? "", quantity: Number((row[column] ?? "").replace(/\D/g, "")) }))
        .filter((item) => item.product_id && item.quantity > 0);
      const snapshot: JsonRow = {
        phone,
        customer_name: clean(row["Customer Name"]),
        age: number(row.Age),
        address: clean(row["Complete Address"]),
        city: clean(row.City),
        pincode: /^[1-9]\d{5}$/.test(pincode) ? pincode : null,
        state: clean(row.State),
        order_date: orderDate,
        ad_code: clean(row.Ad),
        gclid: clean(row.GCLID),
        source_id: sourceId,
        payment_mode_id: paymentModeId,
        payment_state: paymentState,
        amount,
        shipping_amount: number(row["Shipping Charges"]) ?? 0,
        discount: number(row.Discount) ?? 0,
        order_notes: clean(row.Notes),
        is_repeat: /repeat/i.test(row["Order Type"] ?? ""),
        course_duration_days: courseDays,
        courier_id: courierId,
        delivered_at: deliveredDate,
        stage,
        owner_id: ownerId,
        consultation_date: consultationDate,
        doctor_id: doctorId,
        consultation_taken_by_id: consultationTakenById,
        items,
      };
      const identityKey = identity(phone, orderDate, amount);
      const link = links.get(rowNumber);
      const previous = link?.source_snapshot;
      if (
        link &&
        link.identity_key === identityKey &&
        stable(previous) === stable(snapshot)
      ) {
        consumedOrders.add(link.order_id);
        continue;
      }

      let customer = customers.get(phone);
      if (!customer) {
        const { data, error } = await db
          .from("customers")
          .insert({
            phone_e164: phone,
            phone_raw: row["Contact Number"],
            full_name: snapshot.customer_name ?? "Unknown",
            age: snapshot.age,
            address: snapshot.address,
            pincode: snapshot.pincode,
            city: snapshot.city,
            state: snapshot.state,
            first_source_id: sourceId,
            original_owner_id: ownerId,
            current_owner_id: ownerId,
          })
          .select("id,phone_e164,full_name,age,address,pincode,city,state,current_owner_id,original_owner_id")
          .single();
        if (error) {
          skipped.push({ row: rowNumber, reason: `customer:${error.message}` });
          continue;
        }
        customer = data;
        customers.set(phone, data);
      } else {
        const customerPatch: Record<string, unknown> = {};
        const customerFields: Record<string, string> = {
          customer_name: "full_name",
          age: "age",
          address: "address",
          pincode: "pincode",
          city: "city",
          state: "state",
        };
        for (const [sourceKey, targetKey] of Object.entries(customerFields))
          if (changed(previous, snapshot, sourceKey)) customerPatch[targetKey] = snapshot[sourceKey];
        if (Object.keys(customerPatch).length) {
          const { error } = await db.from("customers").update(customerPatch).eq("id", customer.id as string);
          if (error) {
            skipped.push({ row: rowNumber, reason: `customer_update:${error.message}` });
            continue;
          }
        }
      }

      let consultationId = link
        ? ((orderCandidates.get(identityKey) ?? []).find((order) => order.id === link.order_id)?.consultation_id ?? null)
        : null;
      if (!consultationId && consultationDate) {
        const { data: consultation } = await db
          .from("consultations")
          .select("id")
          .eq("customer_id", customer.id as string)
          .gte("scheduled_at", `${consultationDate}T00:00:00+05:30`)
          .lt("scheduled_at", `${consultationDate}T23:59:59+05:30`)
          .limit(1)
          .maybeSingle();
        consultationId = consultation?.id ?? null;
        if (!consultationId) {
          const { data: inserted, error } = await db
            .from("consultations")
            .insert({
              customer_id: customer.id,
              doctor_id: doctorId,
              taken_by_id: consultationTakenById,
              scheduled_at: istTimestamp(consultationDate),
              completed_at: istTimestamp(consultationDate),
              state: "done",
              fee_state: "unpaid",
            })
            .select("id")
            .single();
          if (error) {
            skipped.push({ row: rowNumber, reason: `consultation:${error.message}` });
            continue;
          }
          consultationId = inserted.id;
        }
      }
      if (consultationId && (changed(previous, snapshot, "doctor_id") || changed(previous, snapshot, "consultation_taken_by_id"))) {
        const { error } = await db
          .from("consultations")
          .update({ doctor_id: doctorId, taken_by_id: consultationTakenById })
          .eq("id", consultationId);
        if (error) {
          skipped.push({ row: rowNumber, reason: `consultation_update:${error.message}` });
          continue;
        }
      }

      let orderId = link?.order_id ?? null;
      let insertedOrder = false;
      if (!orderId) {
        const candidate = (orderCandidates.get(identityKey) ?? []).find(
          (order) => !consumedOrders.has(order.id),
        );
        orderId = candidate?.id ?? null;
      }

      const orderValues: Record<string, unknown> = {
        customer_id: customer.id,
        consultation_id: consultationId,
        stage,
        payment_state: paymentState,
        payment_mode_id: paymentModeId,
        source_id: sourceId,
        amount,
        discount: snapshot.discount,
        shipping_amount: snapshot.shipping_amount,
        course_duration_days: courseDays,
        ship_name: snapshot.customer_name,
        ship_address: snapshot.address,
        ship_pincode: snapshot.pincode,
        ship_city: snapshot.city,
        ship_state: snapshot.state,
        courier_id: courierId,
        delivered_at: istTimestamp(deliveredDate),
        is_repeat: snapshot.is_repeat,
        is_legacy: true,
        original_owner_id: ownerId,
        current_owner_id: ownerId,
        order_notes: snapshot.order_notes,
        ad_code: snapshot.ad_code,
        gclid: snapshot.gclid,
        created_at: istTimestamp(orderDate),
        sheet_row_number: rowNumber,
      };

      let rowChanged = false;
      if (!orderId) {
        const { data, error } = await db.from("orders").insert(orderValues).select("id").single();
        if (error) {
          skipped.push({ row: rowNumber, reason: `order_insert:${error.message}` });
          continue;
        }
        orderId = data.id;
        created += 1;
        insertedOrder = true;
        rowChanged = true;
      } else {
        const orderPatch: Record<string, unknown> = {};
        const orderFields: Record<string, string> = {
          consultation_date: "consultation_id",
          stage: "stage",
          payment_state: "payment_state",
          payment_mode_id: "payment_mode_id",
          source_id: "source_id",
          amount: "amount",
          discount: "discount",
          shipping_amount: "shipping_amount",
          course_duration_days: "course_duration_days",
          customer_name: "ship_name",
          address: "ship_address",
          pincode: "ship_pincode",
          city: "ship_city",
          state: "ship_state",
          courier_id: "courier_id",
          delivered_at: "delivered_at",
          is_repeat: "is_repeat",
          order_notes: "order_notes",
          ad_code: "ad_code",
          gclid: "gclid",
          order_date: "created_at",
          owner_id: "current_owner_id",
        };
        for (const [sourceKey, targetKey] of Object.entries(orderFields)) {
          if (!changed(previous, snapshot, sourceKey)) continue;
          if (sourceKey === "consultation_date") orderPatch[targetKey] = consultationId;
          else if (sourceKey === "delivered_at") orderPatch[targetKey] = istTimestamp(deliveredDate);
          else if (sourceKey === "order_date") orderPatch[targetKey] = istTimestamp(orderDate);
          else orderPatch[targetKey] = snapshot[sourceKey];
        }
        if (!previous && ownerId) orderPatch.original_owner_id = ownerId;
        if (!previous) orderPatch.sheet_row_number = rowNumber;
        if (Object.keys(orderPatch).length) {
          const { error } = await db.from("orders").update(orderPatch).eq("id", orderId);
          if (error) {
            skipped.push({ row: rowNumber, reason: `order_update:${error.message}` });
            continue;
          }
          rowChanged = true;
        }
      }

      if (changed(previous, snapshot, "items")) {
        const { error: deleteError } = await db.from("order_items").delete().eq("order_id", orderId);
        if (deleteError) {
          skipped.push({ row: rowNumber, reason: `items_delete:${deleteError.message}` });
          continue;
        }
        if (items.length) {
          const { error: insertError } = await db
            .from("order_items")
            .insert(items.map((item) => ({ order_id: orderId, ...item })));
          if (insertError) {
            skipped.push({ row: rowNumber, reason: `items_insert:${insertError.message}` });
            continue;
          }
        }
        rowChanged = true;
      }

      const { error: linkError } = await db.from("sheet_order_links").upsert(
        {
          sheet_id: SHEET_ID,
          tab_name: TAB_NAME,
          source_row_number: rowNumber,
          order_id: orderId,
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
      if (!orderId) {
        skipped.push({ row: rowNumber, reason: "order_id_missing_after_write" });
        continue;
      }
      consumedOrders.add(orderId);
      if (rowChanged && !insertedOrder) updated += 1;
    }

    // The holding pen goes back further than this tab does. Most of its
    // cancelled rows are from March to June and have no row in the July sheet
    // at all — they came in with the legacy import and are sitting in the base
    // as ordinary confirmed orders. The loop above cannot see them, so they
    // are matched against the database directly, on the same three parts.
    if (cancelled.size) {
      const phones = [...new Set([...cancelled].map((cancelledKey) => cancelledKey.split("|")[0]!))];
      const owners = new Map<string, string>();
      for (let index = 0; index < phones.length; index += 100) {
        const { data, error } = await db
          .from("customers")
          .select("id,phone_e164")
          .in("phone_e164", phones.slice(index, index + 100))
          .is("merged_into_id", null)
          .range(0, 199);
        if (error) throw new Error(error.message);
        for (const customer of data ?? []) owners.set(customer.id, customer.phone_e164);
      }
      const ids = [...owners.keys()];
      for (let index = 0; index < ids.length; index += 100) {
        const { data, error } = await db
          .from("orders")
          .select("id,customer_id,amount,created_at")
          .in("customer_id", ids.slice(index, index + 100))
          .range(0, 999);
        if (error) throw new Error(error.message);
        for (const order of data ?? []) {
          const phone = owners.get(order.customer_id);
          if (!phone) continue;
          const key = identity(phone, istDate(order.created_at), Number(order.amount));
          if (!cancelled.has(key)) continue;
          if (await discard(order.id))
            skipped.push({ row: 0, reason: `cancelled_in_pending_tab:removed:${key}` });
        }
      }
    }

    const finishedAt = new Date().toISOString();
    await db
      .from("sheet_order_sync_sources")
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
    return { ok: true, rowsSeen, created, updated, discarded, skipped, finishedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from("sheet_order_sync_sources")
      .update({ last_finished_at: new Date().toISOString(), lock_until: null, last_error: message.slice(0, 2000) })
      .eq("sheet_id", SHEET_ID)
      .eq("tab_name", TAB_NAME);
    throw error;
  }
}
