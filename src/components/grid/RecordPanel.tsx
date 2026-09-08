"use client";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useRecordDetail } from "@/lib/crm/queries";
import { dateLabel, money } from "@/lib/crm/config";
import { useViewer } from "../CrmProvider";
import { StatusPill } from "../StatusPill";
import { RecordEditor } from "./RecordEditor";
import type { CrmRow, EntityName } from "@/types/crm";

interface OrderItem {
  id: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  products: { name: string; variant: string | null } | null;
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
        .select("id,quantity,unit_price,line_total,products(name,variant)")
        .eq("order_id", id)
        .order("created_at")
        .range(0, 49)
        .abortSignal(signal)
        .returns<OrderItem[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
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
      ["Ship to", d.ship_name ?? "—"],
      [
        "Address",
        [d.ship_address, d.ship_city, d.ship_state, d.ship_pincode]
          .filter(Boolean)
          .join(", ") || "Not recorded",
      ],
      ["Amount", money(d.amount)],
      ["Discount", money(d.discount)],
      [
        "Course",
        d.course_duration_days ? `${d.course_duration_days} days` : "—",
      ],
      ["Dispatched", dateLabel(d.dispatch_date)],
      ["Next follow-up", dateLabel(d.next_followup_at)],
      ["Tracking (AWB)", d.awb ?? "Not recorded"],
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
                ? "tracking"
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
        <RecordEditor
          row={row}
          entity={entity}
          onPatch={onPatch}
          onDone={onDone}
          onCancel={onDone}
        />
      ) : null}
      <dl className="record-fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {entity === "order" ? (
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
