"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ModuleName, Viewer } from "@/types/crm";

/** Only a notification is staged. Explicit refresh applies ordering/filter changes. */
export function useLiveUpdates(viewer: Viewer, module: ModuleName) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("Connecting");
  useEffect(() => {
    setPending(false);
    setStatus("Connecting");
    const client = createClient(),
      channel = client.channel(`crm:${viewer.id}:${module}`);
    const seesAll = ["admin", "ceo", "coo", "sales_manager", "auditor"].includes(
      viewer.role,
    );
    const subscriptions =
      module === "today"
        ? [
            ["leads", "owner_id"],
            ["followups", "owner_id"],
          ]
        : module === "leads"
          ? [["leads", "owner_id"]]
          : module === "orders"
            ? [["orders", seesAll || viewer.role === "ops" ? null : "current_owner_id"]]
            : [["consultations", seesAll ? null : "doctor_id"]];
    for (const [table, column] of subscriptions)
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: table!,
          ...(column ? { filter: `${column}=eq.${viewer.id}` } : {}),
        },
        () => setPending(true),
      );
    channel.subscribe((state) =>
      setStatus(
        state === "SUBSCRIBED"
          ? "Own records connected"
          : state === "CHANNEL_ERROR" || state === "TIMED_OUT"
            ? "Live connection unavailable"
            : "Connecting",
      ),
    );
    return () => {
      void client.removeChannel(channel);
    };
  }, [viewer.id, viewer.role, module]);
  const clear = useCallback(() => setPending(false), []);
  return { pending, status, clear };
}
