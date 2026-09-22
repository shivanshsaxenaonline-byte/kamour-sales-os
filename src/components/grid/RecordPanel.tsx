"use client";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useRecordDetail } from "@/lib/crm/queries";
import { dateLabel, money } from "@/lib/crm/config";
import { useViewer } from "../CrmProvider";
import { StatusPill } from "../StatusPill";
import { RecordEditor } from "./RecordEditor";
import { OrderWorkspaceEditor } from "./OrderWorkspaceEditor";
import type { CrmRow, EntityName, OrderItemDetail } from "@/types/crm";

interface OrderCustomer {
  full_name: string;
  phone_e164: string;
  email: string | null;
  age: number | null;
  address: string | null;
  pincode: string | null;
  city: string | null;
  state: string | null;
}
interface OrderConsultation {
  scheduled_at: string | null;
  completed_at: string | null;
  state: string;
  notes: string | null;
  doctor: { full_name: string } | null;
  taken_by: { full_name: string } | null;
}
export function RecordPanel({
  row,
  entity,
  editing,
  onEdit,
  onClose,
  onDone,
  onPatch,
  canEdit,
}: {
  row: CrmRow;
  entity: EntityName;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onDone: () => void;
  onPatch: (patch: Partial<CrmRow> | null) => void;
  canEdit: boolean;
}) {
  const viewer = useViewer(),
    id = row.entity_id ?? row.id;
  const detail = useRecordDetail(viewer.id, entity, id);
  const items = useQuery({
    queryKey: ["crm", viewer.id, "order-items", id],
    enabled: entity === "order",
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .from("order_items")
        .select("id,product_id,quantity,unit_price,line_total,products(name,variant)")
        .eq("order_id", id)
        .order("created_at")
        .range(0, 49)
        .abortSignal(signal)
        .returns<OrderItemDetail[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
  const customer = useQuery({
    queryKey: ["crm", viewer.id, "order-customer", row.customer_id],
    enabled: entity === "order" && !!row.customer_id,
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .from("customers")
        .select("full_name,phone_e164,email,age,address,pincode,city,state")
        .eq("id", row.customer_id)
        .abortSignal(signal)
        .single<OrderCustomer>();
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const consultation = useQuery({
    queryKey: ["crm", viewer.id, "order-consultation", detail.data?.consultation_id],
    enabled: entity === "order" && !!detail.data?.consultation_id,
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .from("consultations")
        .select("scheduled_at,completed_at,state,notes,doctor:users!consultations_doctor_id_fkey(full_name),taken_by:users!consultations_taken_by_id_fkey(full_name)")
        .eq("id", detail.data!.consultation_id!)
        .abortSignal(signal)
        .single<OrderConsultation>();
      if (error) throw new Error(error.message);
      return data;
    },
  });
  if (detail.isPending)
    return (
      <div className="record-panel" role="status">
        <p className="muted">Loading full record…</p>
        <div className="detail-skeletons">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      </div>
    );
  if (detail.error || !detail.data)
    return (
      <div className="record-panel" role="alert">
        <h3>Full record could not load</h3>
        <p className="muted">
          {detail.error?.message ?? "This record is no longer available."}
        </p>
        <button onClick={() => void detail.refetch()}>Retry</button>
        <button onClick={onClose}>Close</button>
      </div>
    );
  const d = detail.data;
  const fields: [string, React.ReactNode][] = [
    ["Phone", row.phone ?? "—"],
    ["Record ID", id],
    ["Last updated", dateLabel(d.updated_at, true)],
  ];
  if (entity === "lead")
    fields.push(
      ["Source", row.source ?? d.channel ?? "—"],
      [
        "Assigned to",
        row.owner_name ?? (d.owner_id ? "Assigned" : "Unassigned"),
      ],
      ["Payment", <StatusPill key="payment" value={d.payment_state} />],
      ["First contacted", dateLabel(d.first_contacted_at, true)],
      ["Paid at", dateLabel(d.paid_at, true)],
    );
  if (entity === "consultation")
    fields.push(
      ["Doctor", row.doctor_name ?? "Unassigned"],
      ["Scheduled", dateLabel(d.scheduled_at, true)],
      ["Completed", dateLabel(d.completed_at, true)],
      ["Fee", money(d.fee_amount)],
      ["Fee state", <StatusPill key="payment" value={d.fee_state} />],
      ["Cancellation reason", row.cancel_reason ?? "—"],
      ["Notes", d.notes || "No notes recorded."],
    );
  if (entity === "order")
    fields.push(
      ["Age", customer.data?.age ?? "—"],
      ["Email", customer.data?.email ?? "—"],
      ["Order date", dateLabel(d.created_at)],
      ["Stage", <StatusPill key="stage" value={d.stage} />],
      ["Source", row.source ?? "—"],
      ["Order type", d.is_repeat ? "Repeat order" : "New order"],
      ["Ship to", d.ship_name ?? "—"],
      [
        "Address",
        [d.ship_address, d.ship_city, d.ship_state, d.ship_pincode]
          .filter(Boolean)
          .join(", ") || "Not recorded",
      ],
      ["Amount", money(d.amount)],
      ["Discount", money(d.discount)],
      ["Shipping", money(d.shipping_amount)],
      ["COD amount", money(d.cod_amount)],
      ["Payment", <StatusPill key="payment" value={d.payment_state} />],
      ["Payment mode", row.payment_mode ?? "—"],
      [
        "Course",
        d.course_duration_days ? `${d.course_duration_days} days` : "—",
      ],
      ["Dispatched", dateLabel(d.dispatch_date)],
      ["Delivered", dateLabel(d.delivered_at)],
      ["RTO", dateLabel(d.rto_at)],
      ["Next follow-up", dateLabel(d.next_followup_at)],
      ["Courier", row.courier ?? "—"],
      ["Tracking (AWB)", d.awb ?? "Not recorded"],
      ["Ad", d.ad_code ?? "—"],
      ["GCLID", d.gclid ?? "—"],
      ["Order notes", d.order_notes || "No notes recorded."],
      ["Consultation date", dateLabel(consultation.data?.scheduled_at)],
      ["Doctor", consultation.data?.doctor?.full_name ?? "—"],
      ["Consultation taken by", consultation.data?.taken_by?.full_name ?? "—"],
      ["Consultation notes", consultation.data?.notes || "No notes recorded."],
    );
  if (entity === "followup")
    fields.push(
      ["Kind", d.kind ?? "—"],
      ["Due", dateLabel(d.due_at, true)],
      ["Outcome", d.outcome?.replaceAll("_", " ") ?? "Not recorded"],
      ["Completed", dateLabel(d.completed_at, true)],
      ["Remark", d.remark || "No remark recorded."],
      ["Next due", dateLabel(d.next_due_at, true)],
    );
  return (
    <div
      className="record-panel"
      role="region"
      aria-label={`Full record for ${row.full_name}`}
    >
      <div className="record-panel-heading">
        <h2>{row.full_name}</h2>
        <span className="muted">{row.order_no ?? entity}</span>
        <div className="toolbar-spacer" />
        {canEdit && !editing ? (
          <button onClick={onEdit}>
            Edit{" "}
            {entity === "lead"
              ? "status"
              : entity === "order"
                ? "order"
                : entity === "consultation"
                  ? "notes"
                  : "remark"}{" "}
            <kbd>e</kbd>
          </button>
        ) : null}
        <button onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </div>
      {editing ? (
        entity === "order" ? (
          items.isPending ? <p className="muted">Loading products...</p> : items.error ? (
            <p role="alert">Product lines must load before editing. <button onClick={() => void items.refetch()}>Retry</button></p>
          ) : (
            <OrderWorkspaceEditor
              row={row}
              detail={d}
              items={items.data ?? []}
              onPatch={onPatch}
              onDone={onDone}
              onCancel={onDone}
            />
          )
        ) : (
          <RecordEditor
            row={row}
            entity={entity}
            onPatch={onPatch}
            onDone={onDone}
            onCancel={onDone}
          />
        )
      ) : null}
      {!editing ? <dl className="record-fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl> : null}
      {entity === "order" && !editing ? (
        <div className="order-lines">
          <h3>Product lines</h3>
          {items.isPending ? (
            <span className="skeleton" />
          ) : items.error ? (
            <p role="alert">
              Could not load product lines.{" "}
              <button onClick={() => void items.refetch()}>Retry</button>
            </p>
          ) : items.data?.length ? (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Quantity</th>
                  <th>Unit price</th>
                  <th>Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.products
                        ? [item.products.name, item.products.variant]
                            .filter(Boolean)
                            .join(" · ")
                        : "Product unavailable"}
                    </td>
                    <td>{item.quantity}</td>
                    <td>{money(item.unit_price)}</td>
                    <td>{money(item.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No product lines are recorded for this order.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
