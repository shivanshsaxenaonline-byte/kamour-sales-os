"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DataGrid, type GridColumn } from "./grid/DataGrid";
import { RecordPanel } from "./grid/RecordPanel";
import { RecordEditor } from "./grid/RecordEditor";
import { useViewer } from "./CrmProvider";
import { StatusPill } from "./StatusPill";
import { Icon } from "./Icon";
import { useRecords, useTabCounts } from "@/lib/crm/queries";
import { useLiveUpdates } from "@/lib/crm/use-live-updates";
import {
  BUCKET_LABELS,
  dateLabel,
  entityFor,
  MODULES,
  money,
  PAGE_SIZE,
} from "@/lib/crm/config";
import type { CrmRow, EntityName, ModuleName } from "@/types/crm";

const rowId = (r: CrmRow) => r.id,
  rowLabel = (r: CrmRow) => r.full_name;
const EMPTY: CrmRow[] = [];
const canEditEntity = (role: string, entity: EntityName) =>
  ({
    lead: ["sales_exec", "sales_manager", "admin"],
    order: ["sales_exec", "sales_manager", "ops", "admin"],
    consultation: ["doctor", "sales_manager", "admin"],
    followup: ["sales_exec", "sales_manager", "admin"],
  })[entity].includes(role);

export function ModuleGrid({ module }: { module: ModuleName }) {
  const viewer = useViewer(),
    client = useQueryClient(),
    config = MODULES[module];
  const [tab, setTab] = useState<string>(config.defaultTab),
    [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<string>(config.sort),
    [ascending, setAscending] = useState(config.ascending);
  const [expanded, setExpanded] = useState<string | null>(null),
    [editing, setEditing] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, Partial<CrmRow>>>({}),
    [localChange, setLocalChange] = useState(false);
  const [savedFilter, setSavedFilter] = useState("");
  const live = useLiveUpdates(viewer, module);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const options = { module, tab, page, search: debounced, sort, ascending };
  const records = useRecords(viewer.id, options),
    counts = useTabCounts(viewer.id, module);
  const rows = useMemo(
    () =>
      (records.data?.rows ?? EMPTY).map((r) =>
        patches[r.id] ? { ...r, ...patches[r.id] } : r,
      ),
    [records.data, patches],
  );
  const updatedIds = useMemo(() => new Set(Object.keys(patches)), [patches]);
  const storageKey = `kamour:v1:${viewer.id}:${module}`;
  const saved = useRef<HTMLDialogElement>(null);
  const [savedViews, setSavedViews] = useState<
    {
      name: string;
      tab: string;
      search: string;
      sort: string;
      ascending: boolean;
    }[]
  >([]);
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(`${storageKey}:filters`) ?? "[]",
      );
      if (Array.isArray(value))
        setSavedViews(
          value
            .filter(
              (v): v is (typeof savedViews)[number] =>
                !!v &&
                typeof v === "object" &&
                typeof v.name === "string" &&
                typeof v.tab === "string" &&
                typeof v.search === "string" &&
                typeof v.sort === "string" &&
                typeof v.ascending === "boolean",
            )
            .slice(0, 10),
        );
    } catch {
      /* Optional preferences. */
    }
  }, [storageKey]);
  const patchRow = useCallback((id: string, patch: Partial<CrmRow> | null) => {
    setPatches((previous) => {
      const next = { ...previous };
      if (patch) next[id] = patch;
      else delete next[id];
      return next;
    });
  }, []);
  function resetInteraction() {
    setExpanded(null);
    setEditing(null);
  }
  function open(row: CrmRow) {
    if (editing) return;
    setExpanded((previous) => (previous === row.id ? null : row.id));
  }
  function startEdit(row: CrmRow) {
    if (!canEditEntity(viewer.role, entityFor(module, row))) return;
    setEditing(row.id);
    if (module === "today" || module === "consultation") setExpanded(row.id);
  }
  function doneEdit() {
    setEditing(null);
    setLocalChange(true);
  }
  function cancelEdit() {
    const row = rows.find((item) => item.id === editing);
    if (row)
      client.removeQueries({
        queryKey: [
          "crm",
          viewer.id,
          "draft",
          entityFor(module, row),
          row.entity_id ?? row.id,
        ],
        exact: true,
      });
    setEditing(null);
  }
  async function refresh() {
    if (editing) return;
    const result = await records.refetch();
    if (!result.error) {
      setPatches({});
      setLocalChange(false);
      live.clear();
      void counts.refetch();
      void client.invalidateQueries({
        queryKey: ["crm", viewer.id, "detail"],
        refetchType: "none",
      });
    }
  }
  const columns: GridColumn<CrmRow>[] = [
    ...(module === "today"
      ? [
          {
            id: "bucket",
            label: "Why",
            width: 148,
            fixed: true,
            render: (r: CrmRow) => (
              <StatusPill
                value={r.bucket}
                label={BUCKET_LABELS[r.bucket ?? ""]}
              />
            ),
          },
        ]
      : []),
    ...(module === "orders"
      ? [
          {
            id: "order_no",
            label: "Order",
            width: 112,
            sortKey: "order_no",
            render: (r: CrmRow) => <span>{r.order_no}</span>,
          },
        ]
      : []),
    {
      id: "full_name",
      label: "Customer",
      fixed: true,
      sortKey: module === "today" ? undefined : "full_name",
      render: (r) => (
        <button
          className="record-name"
          disabled={!!editing}
          onClick={() => open(r)}
          aria-expanded={expanded === r.id}
        >
          <span
            className={
              expanded === r.id ? "expand-icon expanded" : "expand-icon"
            }
          >
            <Icon name="chevron" />
          </span>
          {r.full_name}
        </button>
      ),
    },
    {
      id: "phone",
      label: "Phone",
      defaultHidden: module === "orders",
      width: 144,
      render: (r) => (
        <span
          className={r.phone?.includes("•") ? "muted" : ""}
          title={
            r.phone?.includes("•")
              ? "Unassigned lead · phone is masked"
              : undefined
          }
        >
          {r.phone ?? "—"}
        </span>
      ),
    },
    ...(module === "today"
      ? [
          {
            id: "due_at",
            label: "Due",
            width: 155,
            render: (r: CrmRow) => (
              <span className={r.bucket === "sla_breach" ? "overdue" : ""}>
                {dateLabel(r.due_at, true)}
              </span>
            ),
          },
          {
            id: "action",
            label: "Next action",
            width: 250,
            render: (r: CrmRow) => (
              <button className="text-action" onClick={() => open(r)}>
                {r.action_label ?? "Open record"}
              </button>
            ),
          },
        ]
      : []),
    ...(module === "leads"
      ? [
          {
            id: "payment",
            label: "Payment",
            width: 100,
            render: (r: CrmRow) => (
              <StatusPill value={r.is_junk ? "junk" : r.payment_state} />
            ),
          },
          {
            id: "status",
            label: "Status",
            width: 170,
            sortKey: "status",
            render: (r: CrmRow) =>
              editing === r.id ? (
                <RecordEditor
                  row={r}
                  entity="lead"
                  inline
                  onPatch={(patch) => patchRow(r.id, patch)}
                  onDone={doneEdit}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  className="editable-cell"
                  disabled={!canEditEntity(viewer.role, "lead")}
                  onClick={() => startEdit(r)}
                  title="Edit status · E"
                >
                  {r.status ?? "—"}
                  {patches[r.id] ? (
                    <span className="saved-mark"> · saved</span>
                  ) : null}
                </button>
              ),
          },
          {
            id: "source",
            label: "Source",
            width: 130,
            sortKey: "source",
            render: (r: CrmRow) => r.source ?? "—",
          },
          {
            id: "owner",
            label: "Owner",
            width: 125,
            sortKey: "owner_name",
            render: (r: CrmRow) => (
              <span className={r.owner_name ? "" : "muted"}>
                {r.owner_name ?? "Unassigned"}
              </span>
            ),
          },
          {
            id: "created_at",
            label: "Received",
            width: 136,
            sortKey: "created_at",
            render: (r: CrmRow) => dateLabel(r.created_at),
          },
        ]
      : []),
    ...(module === "consultation"
      ? [
          {
            id: "fee_state",
            label: "Fee",
            width: 96,
            render: (r: CrmRow) => <StatusPill value={r.fee_state} />,
          },
          {
            id: "state",
            label: "Status",
            width: 104,
            sortKey: "state",
            render: (r: CrmRow) => <StatusPill value={r.state} />,
          },
          {
            id: "doctor_name",
            label: "Doctor",
            width: 160,
            sortKey: "doctor_name",
            render: (r: CrmRow) => r.doctor_name ?? "Unassigned",
          },
          {
            id: "scheduled_at",
            label: "Scheduled",
            width: 176,
            sortKey: "scheduled_at",
            render: (r: CrmRow) => dateLabel(r.scheduled_at, true),
          },
          {
            id: "fee_amount",
            label: "Amount",
            width: 100,
            sortKey: "fee_amount",
            render: (r: CrmRow) => money(r.fee_amount),
          },
        ]
      : []),
    ...(module === "orders"
      ? [
          {
            id: "amount",
            label: "Amount",
            width: 104,
            sortKey: "amount",
            render: (r: CrmRow) => (
              <span className="money">{money(r.amount)}</span>
            ),
          },
          {
            id: "stage",
            label: "Stage",
            width: 134,
            render: (r: CrmRow) => <StatusPill value={r.stage} />,
          },
          {
            id: "payment_mode",
            label: "Payment",
            width: 118,
            render: (r: CrmRow) => r.payment_mode ?? "—",
          },
          {
            id: "courier",
            label: "Courier",
            width: 104,
            render: (r: CrmRow) => r.courier ?? "—",
          },
          {
            id: "awb",
            label: "Tracking",
            width: 160,
            render: (r: CrmRow) =>
              editing === r.id ? (
                <RecordEditor
                  row={r}
                  entity="order"
                  inline
                  onPatch={(patch) => patchRow(r.id, patch)}
                  onDone={doneEdit}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <button
                  className="editable-cell"
                  disabled={!canEditEntity(viewer.role, "order")}
                  onClick={() => startEdit(r)}
                  title="Edit tracking number · E"
                >
                  {r.awb ?? "Add tracking"}
                </button>
              ),
          },
          {
            id: "course",
            label: "Course",
            width: 66,
            render: (r: CrmRow) => `${r.course_duration_days ?? "—"}d`,
          },
        ]
      : []),
  ];
  return (
    <>
      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={rowId}
        rowLabel={rowLabel}
        storageKey={`${storageKey}:columns`}
        datasetKey={`${module}:${tab}:${page}:${debounced}:${sort}:${ascending}`}
        loading={records.isPending}
        error={records.error?.message}
        onRetry={() => void records.refetch()}
        sort={sort}
        ascending={ascending}
        onSort={(key) => {
          resetInteraction();
          setSort(key);
          setAscending(key === sort ? !ascending : true);
          setPage(0);
        }}
        page={page}
        pageSize={PAGE_SIZE}
        count={records.data?.count ?? 0}
        onPage={(next) => {
          resetInteraction();
          setPage(next);
        }}
        expandedId={expanded}
        onOpen={open}
        onClose={() => {
          setExpanded(null);
          setEditing(null);
        }}
        editingId={editing}
        onCancelEdit={cancelEdit}
        onEdit={
          viewer.role === "auditor" ||
          viewer.role === "coo" ||
          viewer.role === "ceo"
            ? undefined
            : startEdit
        }
        editingColumnId={
          module === "leads"
            ? "status"
            : module === "orders"
              ? "awb"
              : undefined
        }
        renderDetail={(row) => (
          <RecordPanel
            row={row}
            entity={entityFor(module, row)}
            editing={
              editing === row.id &&
              (module === "today" || module === "consultation")
            }
            onEdit={() => startEdit(row)}
            onClose={() => {
              setExpanded(null);
              setEditing(null);
            }}
            onDone={doneEdit}
            onPatch={(patch) => patchRow(row.id, patch)}
            canEdit={canEditEntity(viewer.role, entityFor(module, row))}
          />
        )}
        search={search}
        onSearch={(value) => {
          resetInteraction();
          setSearch(value);
        }}
        updatedIds={updatedIds}
        pendingUpdates={live.pending || localChange}
        onRefresh={() => void refresh()}
        busy={!!editing}
        heading={
          <>
            <h1 title={config.subtitle}>{config.title}</h1>
            {module !== "today" ? (
              <div
                className="module-tabs"
                role="tablist"
                aria-label={`${config.title} views`}
              >
                {config.tabs.map((t) => (
                  <button
                    role="tab"
                    aria-selected={tab === t.id}
                    key={t.id}
                    disabled={!!editing}
                    className={tab === t.id ? "active" : ""}
                    onClick={() => {
                      resetInteraction();
                      setTab(t.id);
                      setPage(0);
                    }}
                  >
                    {t.label}
                    <span>
                      {counts.data?.[t.id]?.toLocaleString("en-IN") ?? "—"}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="muted today-caption">Start at the top</span>
            )}
          </>
        }
        filters={
          <button
            className="icon-button"
            aria-label="Saved filters"
            title="Saved filters"
            onClick={() => saved.current?.showModal()}
            disabled={!!editing}
          >
            <svg
              className="crm-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M6 3h12v18l-6-4-6 4V3Z" />
            </svg>
          </button>
        }
        emptyTitle={
          module === "today"
            ? "All clear for today"
            : `No ${config.tabs.find((t) => t.id === tab)?.label.toLowerCase() ?? ""} ${module === "consultation" ? "consultations" : module}`
        }
        emptyDescription={
          module === "today"
            ? "There is nothing waiting in your queue. Refresh when you are ready to check for new work."
            : "Records you have permission to view will appear here when they enter this stage."
        }
      />
      <dialog ref={saved} className="crm-dialog saved-dialog">
        <div className="dialog-title">
          <h2>Saved filters</h2>
          <button
            onClick={() => saved.current?.close()}
            aria-label="Close saved filters"
          >
            ×
          </button>
        </div>
        <p className="muted">Keep a tab, search and sort for this module.</p>
        {savedViews.length ? (
          savedViews.map((filter, i) => (
            <div className="saved-filter" key={`${filter.name}-${i}`}>
              <button
                onClick={() => {
                  if (!config.tabs.some((t) => t.id === filter.tab)) return;
                  resetInteraction();
                  setTab(filter.tab);
                  setSearch(filter.search);
                  setSort(filter.sort);
                  setAscending(filter.ascending);
                  setPage(0);
                  saved.current?.close();
                }}
              >
                {filter.name}
              </button>
              <button
                aria-label={`Remove ${filter.name}`}
                onClick={() => {
                  const next = savedViews.filter((_, j) => i !== j);
                  setSavedViews(next);
                  try {
                    localStorage.setItem(
                      `${storageKey}:filters`,
                      JSON.stringify(next),
                    );
                  } catch {}
                }}
              >
                ×
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No saved filters yet.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!savedFilter.trim()) return;
            const next = [
              ...savedViews.filter((f) => f.name !== savedFilter.trim()),
              { name: savedFilter.trim(), tab, search, sort, ascending },
            ].slice(-10);
            setSavedViews(next);
            try {
              localStorage.setItem(
                `${storageKey}:filters`,
                JSON.stringify(next),
              );
            } catch {}
            setSavedFilter("");
          }}
        >
          <label htmlFor="filter-name">Name this view</label>
          <input
            id="filter-name"
            value={savedFilter}
            maxLength={40}
            onChange={(e) => setSavedFilter(e.target.value)}
            placeholder="For example: callbacks"
          />
          <button className="primary" disabled={!savedFilter.trim()}>
            Save current view
          </button>
        </form>
        <p
          className="muted live-caption"
          title="Only your own records are subscribed. Use Refresh for team-wide changes."
        >
          {live.status} ·{" "}
          {viewer.role === "sales_manager" ||
          viewer.role === "admin" ||
          viewer.role === "auditor"
            ? "refresh for team changes"
            : "refresh applies changes"}
        </p>
      </dialog>
    </>
  );
}
