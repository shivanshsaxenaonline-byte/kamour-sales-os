import type { CrmRow, EntityName, ModuleName } from "@/types/crm";

export const PAGE_SIZE = 50;
export const MODULES = {
  today: {
    title: "Today",
    subtitle: "One queue. Start at the top.",
    view: "v_aaj_ka_kaam",
    defaultTab: "all",
    sort: "rank_bucket",
    ascending: true,
    columns:
      "rank_bucket,bucket,entity_type,entity_id,customer_id,full_name,phone,due_at,owner_id,action_label",
    tabs: [{ id: "all", label: "All work" }],
    sortKeys: ["rank_bucket", "full_name", "due_at"],
  },
  leads: {
    title: "Leads",
    subtitle: "Every conversation starts here.",
    view: "v_leads_list",
    defaultTab: "paid",
    sort: "created_at",
    ascending: false,
    columns:
      "id,customer_id,full_name,phone,source,status,payment_state,amount,is_junk,sla_due_at,first_contacted_at,owner_id,owner_name,created_at",
    tabs: [
      { id: "paid", label: "Paid" },
      { id: "unpaid", label: "Unpaid" },
      { id: "junk", label: "Junk" },
    ],
    sortKeys: [
      "full_name",
      "source",
      "status",
      "created_at",
      "owner_name",
      "amount",
    ],
  },
  consultation: {
    title: "Consultations",
    subtitle: "Keep the next conversation moving.",
    view: "v_consultations_list",
    defaultTab: "paid",
    sort: "scheduled_at",
    ascending: false,
    columns:
      "id,customer_id,full_name,phone,doctor_id,doctor_name,scheduled_at,state,completed_at,fee_state,fee_amount,cancel_reason,created_at",
    tabs: [
      { id: "paid", label: "Paid" },
      { id: "unpaid", label: "Unpaid" },
      { id: "cancelled", label: "Cancelled" },
      { id: "done", label: "Done today" },
    ],
    sortKeys: [
      "full_name",
      "doctor_name",
      "scheduled_at",
      "state",
      "fee_amount",
    ],
  },
  orders: {
    title: "Orders",
    subtitle: "From confirmation to delivery.",
    view: "v_orders_list",
    defaultTab: "pending_confirm",
    sort: "created_at",
    ascending: false,
    columns:
      "id,order_no,customer_id,full_name,phone,amount,discount,stage,payment_state,payment_mode,courier,awb,dispatch_date,course_duration_days,next_followup_at,is_repeat,current_owner_id,owner_name,created_at",
    tabs: [
      { id: "pending_confirm", label: "Pending confirm" },
      { id: "confirmed", label: "Confirmed" },
      { id: "dispatched", label: "Dispatched" },
      { id: "delivered", label: "Delivered" },
      { id: "rto", label: "RTO" },
      { id: "cancelled", label: "Cancelled" },
    ],
    sortKeys: [
      "order_no",
      "full_name",
      "amount",
      "created_at",
      "dispatch_date",
      "next_followup_at",
      "owner_name",
    ],
  },
} satisfies Record<
  ModuleName,
  {
    title: string;
    subtitle: string;
    view: string;
    columns: string;
    defaultTab: string;
    sort: string;
    ascending: boolean;
    tabs: { id: string; label: string }[];
    sortKeys: string[];
  }
>;

export const BUCKET_LABELS: Record<string, string> = {
  sla_breach: "SLA breach",
  paid_lead: "Paid lead",
  rrr_due: "Repeat due",
  followup_due: "Follow-up due",
  unpaid_lead: "Unpaid",
};
export const ENTITY_TABLES: Record<EntityName, string> = {
  lead: "leads",
  consultation: "consultations",
  order: "orders",
  followup: "followups",
};
export const DETAIL_COLUMNS: Record<EntityName, string> = {
  lead: "id,customer_id,status_id,concern_id,channel,payment_state,paid_at,first_contacted_at,owner_id,updated_at",
  consultation:
    "id,customer_id,doctor_id,state,scheduled_at,completed_at,notes,cancel_reason_id,fee_state,fee_amount,updated_at",
  order:
    "id,customer_id,stage,amount,discount,ship_name,ship_address,ship_pincode,ship_city,ship_state,awb,courier_id,dispatch_date,course_duration_days,next_followup_at,updated_at",
  followup:
    "id,customer_id,kind,due_at,outcome,remark,next_due_at,completed_at,order_id,lead_id,owner_id,updated_at",
};
export function entityFor(module: ModuleName, row: CrmRow): EntityName {
  return module === "today"
    ? (row.entity_type ?? "lead")
    : module === "leads"
      ? "lead"
      : module === "orders"
        ? "order"
        : "consultation";
}
export function dateLabel(
  value: string | null | undefined,
  includeTime = false,
): string {
  if (!value) return "—";
  // Date-only PostgreSQL values retain their civil date, independent of host timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit" }
      : { year: "numeric" }),
  }).format(date);
}
export function money(value: number | null | undefined) {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
      }).format(value);
}
export function istDayBounds(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const start = `${get("year")}-${get("month")}-${get("day")}T00:00:00+05:30`;
  return {
    start,
    end: new Date(new Date(start).getTime() + 86400000).toISOString(),
  };
}
