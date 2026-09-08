import type { UserRole } from "./db";

export type ModuleName = "today" | "leads" | "consultation" | "orders";
export type EntityName = "lead" | "consultation" | "order" | "followup";

/** Only summary fields from the existing narrow views belong in a grid row. */
export interface CrmRow {
  id: string;
  customer_id: string;
  full_name: string;
  phone: string | null;
  entity_id?: string;
  entity_type?: EntityName;
  rank_bucket?: number;
  bucket?: string;
  action_label?: string;
  due_at?: string | null;
  source?: string;
  status?: string;
  payment_state?: string;
  fee_state?: string;
  amount?: number | null;
  fee_amount?: number | null;
  is_junk?: boolean;
  sla_due_at?: string | null;
  first_contacted_at?: string | null;
  owner_id?: string | null;
  current_owner_id?: string;
  owner_name?: string | null;
  doctor_id?: string | null;
  doctor_name?: string | null;
  scheduled_at?: string | null;
  completed_at?: string | null;
  state?: string;
  cancel_reason?: string | null;
  order_no?: string;
  stage?: string;
  discount?: number;
  payment_mode?: string | null;
  courier?: string | null;
  awb?: string | null;
  dispatch_date?: string | null;
  course_duration_days?: number;
  next_followup_at?: string | null;
  is_repeat?: boolean;
  created_at?: string;
}

export interface RecordDetail {
  id: string;
  customer_id: string;
  updated_at: string;
  status_id?: string;
  concern_id?: string | null;
  channel?: string;
  payment_state?: string;
  paid_at?: string | null;
  first_contacted_at?: string | null;
  owner_id?: string | null;
  state?: string;
  scheduled_at?: string | null;
  completed_at?: string | null;
  notes?: string | null;
  doctor_id?: string | null;
  cancel_reason_id?: string | null;
  fee_state?: string;
  fee_amount?: number | null;
  stage?: string;
  amount?: number;
  discount?: number;
  ship_name?: string | null;
  ship_address?: string | null;
  ship_pincode?: string | null;
  ship_city?: string | null;
  ship_state?: string | null;
  awb?: string | null;
  courier_id?: string | null;
  dispatch_date?: string | null;
  course_duration_days?: number;
  next_followup_at?: string | null;
  due_at?: string;
  kind?: string;
  outcome?: string | null;
  remark?: string | null;
  next_due_at?: string | null;
  order_id?: string | null;
  lead_id?: string | null;
}

export interface Lookup {
  id: string;
  code: string;
  label_en: string;
}
export interface Viewer {
  id: string;
  name: string;
  role: UserRole;
}
export interface ListOptions {
  module: ModuleName;
  tab: string;
  page: number;
  search: string;
  sort: string;
  ascending: boolean;
}
export interface ListResult {
  rows: CrmRow[];
  count: number;
}
export interface EditRequest {
  entity: EntityName;
  id: string;
  version: string;
  value: string;
}
