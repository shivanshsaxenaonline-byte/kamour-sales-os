"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "../Icon";

export interface GridColumn<T> {
  id: string;
  label: string;
  width?: number;
  fixed?: boolean;
  defaultHidden?: boolean;
  sortKey?: string;
  render: (row: T) => ReactNode;
}
interface Props<T> {
  rows: T[];
  columns: GridColumn<T>[];
  getRowId: (row: T) => string;
  rowLabel: (row: T) => string;
  storageKey: string;
  datasetKey: string;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  sort: string;
  ascending: boolean;
  onSort: (key: string) => void;
  page: number;
  pageSize: number;
  count: number;
  onPage: (page: number) => void;
  expandedId: string | null;
  onOpen: (row: T) => void;
  onClose: () => void;
  renderDetail: (row: T) => ReactNode;
  onEdit?: (row: T) => void;
  editingId?: string | null;
  editingColumnId?: string;
  onCancelEdit?: () => void;
  search: string;
  onSearch: (value: string) => void;
  updatedIds?: Set<string>;
  pendingUpdates: boolean;
  onRefresh: () => void;
  busy?: boolean;
  heading: ReactNode;
  filters?: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
}
const features = {};

/** Presentation only: database queries, permissions and mutations stay in the module. */
export function DataGrid<T extends object>({
  rows,
  columns,
  getRowId,
  rowLabel,
  storageKey,
  datasetKey,
  loading,
  error,
  onRetry,
  sort,
  ascending,
  onSort,
  page,
  pageSize,
  count,
  onPage,
  expandedId,
  onOpen,
  onClose,
  renderDetail,
  onEdit,
  editingId,
  editingColumnId,
  onCancelEdit,
  search,
  onSearch,
  updatedIds,
  pendingUpdates,
  onRefresh,
  busy = false,
  heading,
  filters,
  emptyTitle,
  emptyDescription,
}: Props<T>) {
  const scroll = useRef<HTMLDivElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    columnDialog = useRef<HTMLDialogElement>(null),
    allCheckbox = useRef<HTMLInputElement>(null);
  const defaultHiddenKey = columns
    .filter((c) => c.defaultHidden)
    .map((c) => c.id)
    .join("|");
  const [hidden, setHidden] = useState<string[]>(() =>
      defaultHiddenKey ? defaultHiddenKey.split("|") : [],
    ),
    [selection, setSelection] = useState<Set<string>>(new Set()),
    [focus, setFocus] = useState<string | null>(null),
    [announcement, setAnnouncement] = useState("");
  const anchor = useRef(0);
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        version?: number;
        hidden?: unknown;
      } | null;
      setHidden(
        value?.version === 1 && Array.isArray(value.hidden)
          ? value.hidden.filter((id): id is string => typeof id === "string")
          : defaultHiddenKey
            ? defaultHiddenKey.split("|")
            : [],
      );
    } catch {
      setHidden(defaultHiddenKey ? defaultHiddenKey.split("|") : []);
    }
  }, [storageKey, defaultHiddenKey]);
  useEffect(() => {
    setSelection(new Set());
    setFocus(null);
    anchor.current = 0;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [datasetKey]);
  const visible = useMemo(
    () =>
      columns.filter(
        (c) =>
          c.fixed ||
          !hidden.includes(c.id) ||
          (editingId && c.id === editingColumnId),
      ),
    [columns, hidden, editingId, editingColumnId],
  );
  const definitions = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      visible.map((c) => ({
        id: c.id,
        header: c.label,
        accessorFn: (row: T) => row,
      })),
    [visible],
  );
  const table = useTable({
    features,
    columns: definitions,
    data: rows,
    getRowId,
  });
  const tableRows = table.getRowModel().rows;
  const entries = useMemo(
    () =>
      tableRows.flatMap((r) =>
        getRowId(r.original) === expandedId
          ? [
              { type: "row" as const, row: r.original },
              { type: "detail" as const, row: r.original },
            ]
          : [{ type: "row" as const, row: r.original }],
      ),
    [tableRows, expandedId, getRowId],
  );
  const itemKey = useCallback(
    (index: number) => {
      const item = entries[index];
      return item ? `${getRowId(item.row)}:${item.type}` : index;
    },
    [entries, getRowId],
  );
  const virtual = useVirtualizer({
    count: loading ? 0 : entries.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (entries[index]?.type === "detail" ? 260 : 32),
    getItemKey: itemKey,
    overscan: 6,
    scrollMargin: 36,
    scrollPaddingStart: 36,
    initialRect: { width: 1182, height: 676 },
  });
  const items = virtual.getVirtualItems();
  const selectedRows = rows.filter((r) => selection.has(getRowId(r)));
  const activeId =
    focus && rows.some((r) => getRowId(r) === focus)
      ? focus
      : rows[0]
        ? getRowId(rows[0])
        : null;
  useEffect(() => {
    if (allCheckbox.current)
      allCheckbox.current.indeterminate =
        selectedRows.length > 0 && selectedRows.length < rows.length;
  }, [selectedRows.length, rows.length]);
  function select(index: number, checked: boolean, range = false) {
    const next = new Set(selection);
    const start = range ? Math.min(anchor.current, index) : index;
    const end = range ? Math.max(anchor.current, index) : index;
    for (let i = start; i <= end; i++) {
      const row = rows[i];
      if (row) {
        const id = getRowId(row);
        if (checked) next.add(id);
        else next.delete(id);
      }
    }
    setSelection(next);
    if (!range) anchor.current = index;
  }
  function focusGrid() {
    scroll.current?.focus({ preventScroll: true });
  }
  const handlers = useRef<(e: KeyboardEvent) => void>(() => {});
  handlers.current = (e) => {
    if (
      document.querySelector("dialog[open]") ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    const target = e.target as HTMLElement;
    const typing = !!target.closest(
      'input,textarea,select,[contenteditable="true"]',
    );
    if (e.key === "Escape") {
      if (document.querySelector('[data-saving="true"]')) return;
      if (editingId) {
        onCancelEdit?.();
      } else if (expandedId) {
        onClose();
      } else if (selection.size) {
        setSelection(new Set());
      } else if (typing) {
        target.blur();
      }
      focusGrid();
      return;
    }
    if (typing || loading || busy) return;
    if (e.key === "/") {
      e.preventDefault();
      setSelection(new Set());
      searchInput.current?.focus();
      return;
    }
    const index = rows.findIndex((r) => getRowId(r) === activeId);
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      const next = Math.max(
        0,
        Math.min(rows.length - 1, index + (e.key === "j" ? 1 : -1)),
      );
      const row = rows[next];
      if (row) {
        setFocus(getRowId(row));
        setAnnouncement(rowLabel(row));
        virtual.scrollToIndex(
          entries.findIndex(
            (item) =>
              item.type === "row" && getRowId(item.row) === getRowId(row),
          ),
          { align: "auto" },
        );
        if (e.shiftKey) select(next, true, true);
        focusGrid();
      }
    }
    const row = rows[index];
    if (!row) return;
    if (e.key === "Enter" && !target.closest("button,a")) {
      e.preventDefault();
      onOpen(row);
    }
    if (e.key.toLowerCase() === "e") {
      e.preventDefault();
      onEdit?.(row);
    }
    if (e.key === " " && !target.closest("button,a")) {
      e.preventDefault();
      select(index, !selection.has(getRowId(row)), e.shiftKey);
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => handlers.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function toggleColumn(id: string) {
    const next = hidden.includes(id)
      ? hidden.filter((x) => x !== id)
      : [...hidden, id];
    setHidden(next);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ version: 1, hidden: next }),
      );
    } catch {
      /* Controls remain usable without storage. */
    }
  }
  const first = items[0],
    last = items[items.length - 1];
  const paddingTop = first ? Math.max(0, first.start - 36) : 0,
    paddingBottom = last
      ? Math.max(0, virtual.getTotalSize() - (last.end - 36))
      : 0;
  return (
    <section className="data-grid">
      <div className="grid-toolbar">
        {selectedRows.length ? (
          <>
            <strong>{selectedRows.length} selected</strong>
            <button
              onClick={() => {
                const row = selectedRows[0];
                if (row) onOpen(row);
              }}
            >
              Open first selected
            </button>
            <button onClick={() => setSelection(new Set())}>
              Clear <kbd>Esc</kbd>
            </button>
            <span className="muted toolbar-spacer">
              Selection is limited to this page
            </span>
          </>
        ) : (
          <>
            {heading}
            <div className="toolbar-spacer" />
            {filters}
            <label className="grid-search">
              <Icon name="search" />
              <span className="sr-only">Search records</span>
              <input
                ref={searchInput}
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search name or phone"
                disabled={busy}
              />
              <kbd>/</kbd>
            </label>
            <button
              className="icon-button"
              onClick={() => columnDialog.current?.showModal()}
              aria-label="Choose columns"
              title="Choose columns"
            >
              <Icon name="columns" />
            </button>
            <button
              className="icon-button"
              disabled={busy || loading}
              onClick={onRefresh}
              aria-label="Refresh records"
              title="Refresh records"
            >
              <Icon name="refresh" />
            </button>
          </>
        )}
      </div>
      <div
        className="grid-scroll"
        ref={scroll}
        tabIndex={0}
        role="region"
        aria-label="Records. J and K navigate, Enter opens, E edits, Space selects."
      >
        <table
          className="records-table"
          style={{
            minWidth: visible.reduce(
              (total, column) => total + (column.width ?? 180),
              34,
            ),
          }}
          aria-rowcount={count + 1}
          aria-busy={loading}
        >
          <colgroup>
            <col style={{ width: 34 }} />
            {visible.map((c) => (
              <col
                key={c.id}
                style={c.width ? { width: c.width } : undefined}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <input
                  ref={allCheckbox}
                  type="checkbox"
                  aria-label="Select all records on this page"
                  disabled={loading || busy || rows.length === 0}
                  checked={
                    rows.length > 0 && selectedRows.length === rows.length
                  }
                  onChange={(e) =>
                    setSelection(
                      e.target.checked
                        ? new Set(rows.map(getRowId))
                        : new Set(),
                    )
                  }
                />
              </th>
              {visible.map((c) => (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={
                    c.sortKey
                      ? sort === c.sortKey
                        ? ascending
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {c.sortKey ? (
                    <button
                      disabled={busy || loading}
                      onClick={() => onSort(c.sortKey!)}
                    >
                      {c.label}
                      <span aria-hidden="true" className="sort-icon">
                        {sort === c.sortKey ? (ascending ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 20 }, (_, i) => (
                <tr key={i} className="grid-skeleton" aria-hidden="true">
                  {Array.from({ length: visible.length + 1 }, (_, j) => (
                    <td key={j}>
                      <span
                        className={`skeleton ${j % 3 === 0 ? "short" : ""}`}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden="true">
                    <td
                      colSpan={visible.length + 1}
                      className="virtual-spacer"
                      style={{ height: paddingTop }}
                    />
                  </tr>
                ) : null}
                {items.map((item) => {
                  const entry = entries[item.index];
                  if (!entry) return null;
                  const row = entry.row,
                    id = getRowId(row),
                    index = rows.findIndex((r) => getRowId(r) === id);
                  return entry.type === "detail" ? (
                    <tr
                      key={item.key}
                      data-index={item.index}
                      ref={virtual.measureElement}
                      className="record-detail-row"
                    >
                      <td colSpan={visible.length + 1}>{renderDetail(row)}</td>
                    </tr>
                  ) : (
                    <tr
                      key={item.key}
                      data-index={item.index}
                      ref={virtual.measureElement}
                      aria-rowindex={page * pageSize + index + 2}
                      className={`record-row ${activeId === id ? "keyboard-focused" : ""} ${selection.has(id) ? "selected" : ""} ${updatedIds?.has(id) ? "record-updated" : ""}`}
                      onClick={(e) => {
                        if (
                          !(e.target as HTMLElement).closest(
                            "button,input,select,textarea,a",
                          )
                        ) {
                          setFocus(id);
                          focusGrid();
                        }
                      }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${rowLabel(row)}`}
                          checked={selection.has(id)}
                          disabled={busy}
                          onChange={(e) =>
                            select(
                              index,
                              e.target.checked,
                              (e.nativeEvent as MouseEvent).shiftKey === true,
                            )
                          }
                        />
                      </td>
                      {visible.map((c) => (
                        <td key={c.id}>{c.render(row)}</td>
                      ))}
                    </tr>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden="true">
                    <td
                      colSpan={visible.length + 1}
                      className="virtual-spacer"
                      style={{ height: paddingBottom }}
                    />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
        {!loading && error ? (
          <div className="grid-empty" role="alert">
            <h2>Records could not load</h2>
            <p>{error}</p>
            <button onClick={onRetry}>Try again</button>
          </div>
        ) : null}
        {!loading && !error && rows.length === 0 ? (
          <div className="grid-empty">
            <Icon name={search ? "search" : "check"} />
            <h2>{search ? "No matching records" : emptyTitle}</h2>
            <p>
              {search ? "Try another name or phone number." : emptyDescription}
            </p>
            {search ? (
              <button onClick={() => onSearch("")}>Clear search</button>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="grid-footer">
        <span>
          {loading
            ? "Loading…"
            : count
              ? `${(page * pageSize + 1).toLocaleString("en-IN")}–${Math.min((page + 1) * pageSize, count).toLocaleString("en-IN")} of ${count.toLocaleString("en-IN")}`
              : "0 records"}
        </span>
        {pendingUpdates ? (
          <button
            className="pending-updates"
            onClick={onRefresh}
            disabled={busy}
          >
            Updates available · refresh
          </button>
        ) : null}
        <span className="grid-shortcuts">
          <kbd>j</kbd>
          <kbd>k</kbd> move <kbd>Enter</kbd> open{" "}
          {onEdit ? (
            <>
              <kbd>e</kbd> edit
            </>
          ) : null}
        </span>
        <button
          className="page-button"
          aria-label="Previous page"
          disabled={page === 0 || loading || busy}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <span>Page {page + 1}</span>
        <button
          className="page-button"
          aria-label="Next page"
          disabled={(page + 1) * pageSize >= count || loading || busy}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
      </footer>
      <dialog ref={columnDialog} className="crm-dialog columns-dialog">
        <div className="dialog-title">
          <h2>Visible columns</h2>
          <button
            onClick={() => columnDialog.current?.close()}
            aria-label="Close columns"
          >
            ×
          </button>
        </div>
        <p className="muted">Saved for your account on this device.</p>
        {columns.map((c) => (
          <label className="column-choice" key={c.id}>
            <input
              type="checkbox"
              checked={!!c.fixed || !hidden.includes(c.id)}
              disabled={c.fixed}
              onChange={() => toggleColumn(c.id)}
            />
            {c.label}
            {c.fixed ? <small>Always visible</small> : null}
          </label>
        ))}
        <button
          className="primary"
          onClick={() => columnDialog.current?.close()}
        >
          Done
        </button>
      </dialog>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
