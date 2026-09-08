"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  DETAIL_COLUMNS,
  ENTITY_TABLES,
  istDayBounds,
  MODULES,
  PAGE_SIZE,
} from "./config";
import type {
  CrmRow,
  EntityName,
  ListOptions,
  ListResult,
  Lookup,
  ModuleName,
  RecordDetail,
} from "@/types/crm";

function makeListQuery(
  module: ModuleName,
  tab: string,
  search: string,
  head = false,
) {
  const config = MODULES[module];
  let query = createClient()
    .from(config.view)
    .select(head ? (module === "today" ? "entity_id" : "id") : config.columns, {
      count: "exact",
      head,
    });
  if (module === "leads") {
    query = query.eq("is_junk", tab === "junk");
    if (tab === "paid") query = query.eq("payment_state", "paid");
    if (tab === "unpaid") query = query.neq("payment_state", "paid");
  } else if (module === "consultation") {
    if (tab === "cancelled") query = query.eq("state", "cancelled");
    else if (tab === "done") {
      const { start, end } = istDayBounds();
      query = query
        .eq("state", "done")
        .gte("completed_at", start)
        .lt("completed_at", end);
    } else {
      query = query.neq("state", "cancelled");
      query =
        tab === "paid"
          ? query.eq("fee_state", "paid")
          : query.neq("fee_state", "paid");
    }
  } else if (module === "orders") query = query.eq("stage", tab);
  // Strip PostgREST filter grammar, not just SQL syntax. Phone search uses the masked view.
  const safe = search
    .trim()
    .replace(/[^\p{L}\p{N}\s+@.\-]/gu, "")
    .slice(0, 80);
  if (safe)
    query = query.or(
      `full_name.ilike.%${safe}%,phone.ilike.%${safe}%${module === "orders" ? `,order_no.ilike.%${safe}%` : ""}`,
    );
  return query;
}

export function useRecords(userId: string, options: ListOptions) {
  return useQuery({
    queryKey: ["crm", userId, "list", options],
    enabled: !!userId,
    queryFn: async ({ signal }): Promise<ListResult> => {
      const config = MODULES[options.module];
      const key = (config.sortKeys as readonly string[]).includes(options.sort)
        ? options.sort
        : config.sort;
      let query = makeListQuery(options.module, options.tab, options.search);
      if (options.module === "today")
        query = query
          .order("rank_bucket", { ascending: true })
          .order("due_at", { ascending: true, nullsFirst: false });
      else
        query = query.order(key, {
          ascending: options.ascending,
          nullsFirst: false,
        });
      const { data, count, error } = await query
        .order(options.module === "today" ? "entity_id" : "id", {
          ascending: true,
        })
        .range(options.page * PAGE_SIZE, (options.page + 1) * PAGE_SIZE - 1)
        .abortSignal(signal)
        .returns<CrmRow[]>();
      if (error) throw new Error(error.message);
      return {
        rows: (data ?? []).map((r) => ({
          ...r,
          id:
            options.module === "today"
              ? `${r.entity_type}:${r.entity_id}`
              : r.id,
        })),
        count: count ?? 0,
      };
    },
  });
}
export function useTabCounts(userId: string, module: ModuleName) {
  return useQuery({
    queryKey: ["crm", userId, "counts", module],
    enabled: !!userId && module !== "today",
    staleTime: 300000,
    queryFn: async ({ signal }) =>
      Object.fromEntries(
        await Promise.all(
          MODULES[module].tabs.map(async (tab) => {
            const { count, error } = await makeListQuery(
              module,
              tab.id,
              "",
              true,
            )
              .range(0, 0)
              .abortSignal(signal);
            if (error) throw new Error(error.message);
            return [tab.id, count ?? 0];
          }),
        ),
      ),
  });
}
export function useRecordDetail(
  userId: string,
  entity: EntityName,
  id: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["crm", userId, "detail", entity, id],
    enabled: !!userId && !!id && enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .from(ENTITY_TABLES[entity])
        .select(DETAIL_COLUMNS[entity])
        .eq("id", id)
        .abortSignal(signal)
        .single<RecordDetail>();
      if (error) throw new Error(error.message);
      return data;
    },
  });
}
export function useLeadStatuses(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["crm", userId, "lookups", "lead_statuses"],
    enabled: !!userId && enabled,
    staleTime: 3600000,
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .from("lead_statuses")
        .select("id,code,label_en")
        .eq("is_active", true)
        .order("sort_order")
        .range(0, 49)
        .abortSignal(signal)
        .returns<Lookup[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}
