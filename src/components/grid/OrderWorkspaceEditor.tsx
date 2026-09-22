"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { saveOrderWorkspace } from "@/lib/crm/actions";
import { useToast, useViewer } from "../CrmProvider";
import type { CrmRow, OrderItemDetail, RecordDetail } from "@/types/crm";

type Lookup = { id: string; code: string; label_en: string };
type Product = { id: string; sku: string; name: string; variant: string | null };

const day = (value: string | null | undefined) => value?.slice(0, 10) ?? "";
const text = (value: string | number | null | undefined) => value == null ? "" : String(value);

export function OrderWorkspaceEditor({
  row,
  detail,
  items,
  onPatch,
  onDone,
  onCancel,
}: {
  row: CrmRow;
  detail: RecordDetail;
  items: OrderItemDetail[];
  onPatch: (patch: Partial<CrmRow> | null) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const viewer = useViewer();
  const notify = useToast();
  const client = useQueryClient();
  const lookups = useQuery({
    queryKey: ["crm", viewer.id, "order-workspace-lookups"],
    staleTime: 3_600_000,
    queryFn: async () => {
      const db = createClient();
      const [paymentModes, couriers, sources, products] = await Promise.all([
        db.from("payment_modes").select("id,code,label_en").eq("is_active", true).order("sort_order").returns<Lookup[]>(),
        db.from("couriers").select("id,code,label_en").eq("is_active", true).order("sort_order").returns<Lookup[]>(),
        db.from("lead_sources").select("id,code,label_en").eq("is_active", true).order("sort_order").returns<Lookup[]>(),
        db.from("products").select("id,sku,name,variant").eq("is_active", true).order("sort_order").returns<Product[]>(),
      ]);
      for (const result of [paymentModes, couriers, sources, products])
        if (result.error) throw new Error(result.error.message);
      return {
        paymentModes: paymentModes.data ?? [],
        couriers: couriers.data ?? [],
        sources: sources.data ?? [],
        products: products.data ?? [],
      };
    },
  });
  const initial = useMemo(() => ({
    order_date: day(detail.created_at),
    stage: detail.stage ?? "pending_confirm",
    payment_state: detail.payment_state ?? "unpaid",
    payment_mode_id: detail.payment_mode_id ?? "",
    source_id: detail.source_id ?? "",
    amount: text(detail.amount),
    discount: text(detail.discount ?? 0),
    shipping_amount: text(detail.shipping_amount ?? 0),
    cod_amount: text(detail.cod_amount),
    course_duration_days: text(detail.course_duration_days),
    ship_name: detail.ship_name ?? "",
    ship_address: detail.ship_address ?? "",
    ship_pincode: detail.ship_pincode ?? "",
    ship_city: detail.ship_city ?? "",
    ship_state: detail.ship_state ?? "",
    courier_id: detail.courier_id ?? "",
    awb: detail.awb ?? "",
    dispatch_date: day(detail.dispatch_date),
    delivered_at: day(detail.delivered_at),
    rto_at: day(detail.rto_at),
    is_repeat: detail.is_repeat ?? false,
    order_notes: detail.order_notes ?? "",
    ad_code: detail.ad_code ?? "",
    gclid: detail.gclid ?? "",
  }), [detail]);
  const [form, setForm] = useState(initial);
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(items.map((item) => [item.product_id, item.quantity])),
  );
  const mutation = useMutation({
    mutationFn: async () => {
      const selected = Object.entries(quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([product_id, quantity]) => ({ product_id, quantity }));
      const result = await saveOrderWorkspace({
        id: detail.id,
        version: detail.updated_at,
        patch: form,
        items: selected,
      });
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    onSuccess: async (result) => {
      const payment = lookups.data?.paymentModes.find((item) => item.id === form.payment_mode_id);
      const courier = lookups.data?.couriers.find((item) => item.id === form.courier_id);
      const source = lookups.data?.sources.find((item) => item.id === form.source_id);
      onPatch({
        stage: form.stage,
        payment_state: form.payment_state,
        payment_mode: payment?.label_en ?? null,
        courier: courier?.label_en ?? null,
        source: source?.label_en ?? null,
        amount: Number(form.amount),
        discount: Number(form.discount),
        shipping_amount: Number(form.shipping_amount),
        awb: form.awb || null,
        course_duration_days: Number(form.course_duration_days),
        delivered_at: form.delivered_at || null,
        is_repeat: form.is_repeat,
        created_at: form.order_date,
      });
      client.setQueryData<RecordDetail>(["crm", viewer.id, "detail", "order", detail.id], {
        ...detail,
        ...form,
        amount: Number(form.amount),
        discount: Number(form.discount),
        shipping_amount: Number(form.shipping_amount),
        cod_amount: form.cod_amount ? Number(form.cod_amount) : null,
        course_duration_days: Number(form.course_duration_days),
        delivered_at: form.delivered_at || null,
        rto_at: form.rto_at || null,
        dispatch_date: form.dispatch_date || null,
        created_at: form.order_date,
        updated_at: result.updatedAt,
      });
      await client.invalidateQueries({ queryKey: ["crm", viewer.id, "order-items", detail.id] });
      notify("Order saved", row.order_no ?? row.full_name);
      onDone();
    },
    onError: (error) => notify("Order could not save", error.message),
  });
  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  if (lookups.isPending) return <p className="muted">Loading order editor...</p>;
  if (lookups.error)
    return <p role="alert">Editor could not load. <button onClick={() => void lookups.refetch()}>Retry</button></p>;

  return (
    <form className="order-workspace-editor" data-saving={mutation.isPending} onSubmit={(event) => {
      event.preventDefault();
      mutation.mutate();
    }}>
      <fieldset>
        <legend>Order</legend>
        <label><span>Order date</span><input type="date" required value={form.order_date} onChange={(event) => set("order_date", event.target.value)} /></label>
        <label><span>Stage</span><select value={form.stage} onChange={(event) => set("stage", event.target.value)}>{["pending_confirm", "confirmed", "dispatched", "delivered", "rto", "cancelled"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        <label><span>Source</span><select value={form.source_id} onChange={(event) => set("source_id", event.target.value)}><option value="">Not recorded</option>{lookups.data?.sources.map((item) => <option key={item.id} value={item.id}>{item.label_en}</option>)}</select></label>
        <label className="check-field"><input type="checkbox" checked={form.is_repeat} onChange={(event) => set("is_repeat", event.target.checked)} /><span>Repeat order</span></label>
      </fieldset>
      <fieldset>
        <legend>Payment</legend>
        <label><span>Amount</span><input type="number" min="0" step="0.01" required value={form.amount} onChange={(event) => set("amount", event.target.value)} /></label>
        <label><span>Discount</span><input type="number" min="0" step="0.01" required value={form.discount} onChange={(event) => set("discount", event.target.value)} /></label>
        <label><span>Shipping</span><input type="number" min="0" step="0.01" required value={form.shipping_amount} onChange={(event) => set("shipping_amount", event.target.value)} /></label>
        <label><span>COD amount</span><input type="number" min="0" step="0.01" value={form.cod_amount} onChange={(event) => set("cod_amount", event.target.value)} /></label>
        <label><span>Payment state</span><select value={form.payment_state} onChange={(event) => set("payment_state", event.target.value)}>{["unpaid", "paid", "partial", "refunded", "failed"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Payment mode</span><select value={form.payment_mode_id} onChange={(event) => set("payment_mode_id", event.target.value)}><option value="">Not recorded</option>{lookups.data?.paymentModes.map((item) => <option key={item.id} value={item.id}>{item.label_en}</option>)}</select></label>
      </fieldset>
      <fieldset>
        <legend>Shipping</legend>
        <label><span>Ship to</span><input value={form.ship_name} onChange={(event) => set("ship_name", event.target.value)} /></label>
        <label><span>City</span><input value={form.ship_city} onChange={(event) => set("ship_city", event.target.value)} /></label>
        <label><span>State</span><input value={form.ship_state} onChange={(event) => set("ship_state", event.target.value)} /></label>
        <label><span>Pincode</span><input inputMode="numeric" maxLength={6} value={form.ship_pincode} onChange={(event) => set("ship_pincode", event.target.value.replace(/\D/g, ""))} /></label>
        <label className="wide"><span>Complete address</span><textarea value={form.ship_address} onChange={(event) => set("ship_address", event.target.value)} /></label>
      </fieldset>
      <fieldset>
        <legend>Fulfilment</legend>
        <label><span>Course days</span><input type="number" min="1" max="365" required value={form.course_duration_days} onChange={(event) => set("course_duration_days", event.target.value)} /></label>
        <label><span>Courier</span><select value={form.courier_id} onChange={(event) => set("courier_id", event.target.value)}><option value="">Not recorded</option>{lookups.data?.couriers.map((item) => <option key={item.id} value={item.id}>{item.label_en}</option>)}</select></label>
        <label><span>AWB / tracking</span><input value={form.awb} onChange={(event) => set("awb", event.target.value)} /></label>
        <label><span>Dispatch date</span><input type="date" value={form.dispatch_date} onChange={(event) => set("dispatch_date", event.target.value)} /></label>
        <label><span>Delivered date</span><input type="date" value={form.delivered_at} onChange={(event) => set("delivered_at", event.target.value)} /></label>
        <label><span>RTO date</span><input type="date" value={form.rto_at} onChange={(event) => set("rto_at", event.target.value)} /></label>
      </fieldset>
      <fieldset>
        <legend>Products</legend>
        <div className="order-product-grid">
          {lookups.data?.products.map((product) => (
            <label key={product.id}>
              <span>{[product.name, product.variant].filter(Boolean).join(" / ")}</span>
              <input type="number" min="0" max="99" value={quantities[product.id] ?? 0} onChange={(event) => setQuantities((previous) => ({ ...previous, [product.id]: Number(event.target.value) }))} />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Source notes</legend>
        <label><span>Ad</span><input value={form.ad_code} onChange={(event) => set("ad_code", event.target.value)} /></label>
        <label className="wide"><span>GCLID</span><input value={form.gclid} onChange={(event) => set("gclid", event.target.value)} /></label>
        <label className="wide"><span>Notes</span><textarea value={form.order_notes} onChange={(event) => set("order_notes", event.target.value)} /></label>
      </fieldset>
      <div className="order-editor-actions">
        <button className="primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : "Save order"}</button>
        <button type="button" disabled={mutation.isPending} onClick={onCancel}>Cancel</button>
        {mutation.error ? <span className="edit-error" role="alert">{mutation.error.message}</span> : null}
      </div>
    </form>
  );
}
