"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast, useViewer } from "../CrmProvider";
import { useLeadStatuses, useRecordDetail } from "@/lib/crm/queries";
import { saveRecordEdit } from "@/lib/crm/actions";
import type { CrmRow, EntityName, RecordDetail } from "@/types/crm";

export function RecordEditor({
  row,
  entity,
  inline = false,
  onPatch,
  onDone,
  onCancel,
}: {
  row: CrmRow;
  entity: EntityName;
  inline?: boolean;
  onPatch: (patch: Partial<CrmRow> | null) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const viewer = useViewer(),
    notify = useToast(),
    client = useQueryClient();
  const id = row.entity_id ?? row.id,
    detail = useRecordDetail(viewer.id, entity, id),
    statuses = useLeadStatuses(viewer.id, entity === "lead");
  const draftKey = ["crm", viewer.id, "draft", entity, id];
  const [draft, setDraft] = useState<string | null>(
      () => client.getQueryData<string>(draftKey) ?? null,
    ),
    [validation, setValidation] = useState("");
  const field =
    entity === "lead"
      ? "status_id"
      : entity === "order"
        ? "awb"
        : entity === "consultation"
          ? "notes"
          : "remark";
  const label =
    entity === "lead"
      ? "Lead status"
      : entity === "order"
        ? "Tracking number (AWB)"
        : entity === "consultation"
          ? "Consultation notes"
          : "Follow-up remark";
  const value = draft ?? detail.data?.[field] ?? "";
  const detailKey = ["crm", viewer.id, "detail", entity, id];
  const mutation = useMutation({
    mutationFn: async ({
      value,
      version,
    }: {
      value: string;
      version: string;
    }) => {
      const result = await saveRecordEdit({ entity, id, value, version });
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    onMutate: async ({ value }) => {
      await client.cancelQueries({ queryKey: detailKey });
      const previous = client.getQueryData<RecordDetail>(detailKey);
      if (previous)
        client.setQueryData(detailKey, { ...previous, [field]: value });
      onPatch(
        entity === "lead"
          ? {
              status:
                statuses.data?.find((s) => s.id === value)?.label_en ??
                row.status,
            }
          : entity === "order"
            ? { awb: value }
            : {},
      );
      return { previous, previousRow: { ...row } };
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(detailKey, context.previous);
      // Roll back to this edit's snapshot, including an earlier successful edit.
      onPatch(context?.previousRow ?? null);
      notify("Save failed · previous value restored", error.message);
    },
    onSuccess: (result) => {
      client.removeQueries({ queryKey: draftKey, exact: true });
      client.setQueryData<RecordDetail>(detailKey, (previous) =>
        previous ? { ...previous, updated_at: result.updatedAt } : previous,
      );
      notify("Changes saved", row.full_name);
      onDone();
    },
  });
  function changeDraft(next: string) {
    setDraft(next);
    client.setQueryData(draftKey, next);
    mutation.reset();
  }
  function cancel() {
    if (mutation.isPending) return;
    client.removeQueries({ queryKey: draftKey, exact: true });
    onCancel();
  }
  if (detail.isPending || (entity === "lead" && statuses.isPending))
    return (
      <span className="muted" role="status">
        Loading editor…
      </span>
    );
  if (detail.error || statuses.error || !detail.data)
    return (
      <span className="editor-load-error">
        Editor unavailable{" "}
        <button
          onClick={() => {
            void detail.refetch();
            if (entity === "lead") void statuses.refetch();
          }}
        >
          Retry
        </button>
        <button onClick={onCancel}>Close</button>
      </span>
    );
  const previousValue = detail.data[field] ?? "";
  return (
    <form
      className={inline ? "inline-editor" : "detail-editor"}
      data-saving={mutation.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        if (entity === "lead" && !value) {
          setValidation("Select a lead status.");
          return;
        }
        setValidation("");
        mutation.mutate({ value, version: detail.data!.updated_at });
      }}
    >
      {!inline ? <label htmlFor={`edit-${id}`}>{label}</label> : null}
      {entity === "lead" ? (
        <select
          id={`edit-${id}`}
          autoFocus
          aria-label={label}
          disabled={mutation.isPending}
          value={value}
          onChange={(e) => {
            changeDraft(e.target.value);
          }}
        >
          <option value="">Select status</option>
          {statuses.data?.map((s) => (
            <option
              key={s.id}
              value={s.id}
              disabled={/lost|junk|cancel/i.test(s.code)}
            >
              {s.label_en}
              {/lost|junk|cancel/i.test(s.code) ? " · reason required" : ""}
            </option>
          ))}
        </select>
      ) : inline ? (
        <input
          id={`edit-${id}`}
          autoFocus
          aria-label={label}
          maxLength={4000}
          disabled={mutation.isPending}
          value={value}
          onChange={(e) => {
            changeDraft(e.target.value);
          }}
        />
      ) : (
        <textarea
          id={`edit-${id}`}
          autoFocus
          maxLength={4000}
          disabled={mutation.isPending}
          value={value}
          onChange={(e) => {
            changeDraft(e.target.value);
          }}
        />
      )}
      <button
        type="submit"
        className={inline ? "" : "primary"}
        disabled={mutation.isPending}
        aria-label={`Save ${label.toLowerCase()}`}
      >
        {mutation.isPending ? "Saving…" : mutation.isError ? "Retry" : "Save"}
      </button>
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={cancel}
        aria-label="Cancel edit"
      >
        {inline ? "×" : "Cancel"}
      </button>
      {validation || mutation.error ? (
        <span
          className="edit-error"
          role="alert"
          title={mutation.error?.message}
        >
          {validation ||
            `Save failed. Restored ${entity === "lead" ? row.status || "previous status" : previousValue || "blank value"}. Your draft is kept.`}
          {mutation.error ? (
            <button type="button" onClick={() => void detail.refetch()}>
              Reload record
            </button>
          ) : null}
        </span>
      ) : null}
    </form>
  );
}
