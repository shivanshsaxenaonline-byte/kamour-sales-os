const labels: Record<string, string> = {
  pending_confirm: "Pending confirm",
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Partial",
  refunded: "Refunded",
  failed: "Failed",
  pending: "Pending",
  confirmed: "Confirmed",
  dispatched: "Dispatched",
  delivered: "Delivered",
  rto: "RTO",
  cancelled: "Cancelled",
  junk: "Junk",
  done: "Done",
  sla_breach: "SLA breach",
  paid_lead: "Paid lead",
  rrr_due: "Repeat due",
  followup_due: "Follow-up due",
  unpaid_lead: "Unpaid",
};
export function StatusPill({
  value,
  label,
}: {
  value: string | null | undefined;
  label?: string;
}) {
  const state = value ?? "unknown";
  const kind = ["paid", "paid_lead", "delivered", "done"].includes(state)
    ? "positive"
    : state === "confirmed"
      ? "positive-outline"
      : [
            "pending",
            "pending_confirm",
            "partial",
            "rrr_due",
            "followup_due",
          ].includes(state)
        ? "attention"
        : ["unpaid", "unpaid_lead"].includes(state)
          ? "attention-outline"
          : ["rto", "failed", "sla_breach"].includes(state)
            ? "critical"
            : state === "cancelled"
              ? "critical-outline"
              : state === "junk"
                ? "dashed"
                : "neutral";
  return (
    <span className={`status-pill ${kind}`}>
      {label ?? labels[state] ?? value ?? "—"}
    </span>
  );
}
