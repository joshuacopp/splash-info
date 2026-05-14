// Brief 127 — single email-step card.
//
// Header row: drag handle, "Step N" badge + amber "Email" pill, label
// input, duplicate + remove buttons. Body: To: picker (reuses Brief 125
// ApproverPicker shape but allows multi-recipient via add-another),
// Subject template input, Body template textarea, "Then go to" select.

"use client";

import { useSortable } from "@dnd-kit/sortable";
import type {
  ApproverSource,
  Field,
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import ApproverPicker from "./ApproverPicker";

interface DndTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

function transformToCss(t: DndTransform | null): string | undefined {
  if (!t) return undefined;
  return `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`;
}

const PLACEHOLDER_REFERENCE = [
  "{form.title}",
  "{form.url}",
  "{submission.url}",
  "{submitter.email}",
  "{submitter.name}",
  "{outcome.label}",
  "{outcome.reached_at}",
  "{payload.summary}"
];

export interface EmailStepCardProps {
  step: WorkflowStage;
  stepIndex: number;
  isFirst: boolean;
  fields: Field[];
  destinationOptions: Array<{
    id: string;
    label: string;
    kind: "step" | "outcome";
    disabled?: boolean;
    disabledReason?: string;
  }>;
  onUpdateLabel: (label: string) => void;
  onUpdateTemplates: (
    patch: Partial<
      Pick<
        WorkflowStage,
        "subject_template" | "body_template" | "attach_pdf"
      >
    >
  ) => void;
  onSetRecipients: (recipients: ApproverSource[]) => void;
  onUpdateTransition: (
    index: number,
    patch: Partial<WorkflowTransition>
  ) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

export default function EmailStepCard(props: EmailStepCardProps) {
  const {
    step,
    stepIndex,
    isFirst,
    fields,
    destinationOptions,
    onUpdateLabel,
    onUpdateTemplates,
    onSetRecipients,
    onUpdateTransition,
    onDuplicate,
    onRemove
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: step._uiKey ?? step.id });

  const style = {
    transform: transformToCss(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const recipients = step.recipients ?? [];
  const onlyTransition = step.transitions[0] ?? { to: "", label: "Continue" };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className="rounded-splash-md border border-amber-300/70 bg-amber-50/30 p-4 shadow-sm"
    >
      <header className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder step"
          title="Drag to reorder"
          className="cursor-grab rounded-splash-sm border border-transparent px-1 text-base text-splash-navy/40 hover:border-gray-light hover:text-splash-navy"
        >
          ⋮⋮
        </button>
        <span className="inline-flex items-center rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-bold text-amber-900">
          Step {stepIndex + 1}
        </span>
        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300">
          Email
        </span>
        {isFirst && (
          <span className="inline-flex items-center rounded-full bg-splash-navy/10 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-splash-navy">
            Start
          </span>
        )}
        <input
          type="text"
          value={step.label}
          onChange={(e) => onUpdateLabel(e.currentTarget.value)}
          placeholder={`Step ${stepIndex + 1}`}
          className="ml-1 flex-1 rounded-splash-sm border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-splash-navy focus:border-gray-light focus:bg-white"
        />
        <button
          type="button"
          onClick={onDuplicate}
          title="Duplicate this step"
          className="rounded-splash-sm border border-gray-light px-2 py-0.5 text-xs font-semibold text-splash-navy/80 hover:bg-gray-light"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="Remove this step"
          className="rounded-splash-sm border border-racecar-red/40 px-2 py-0.5 text-xs font-semibold text-racecar-red hover:bg-racecar-red/10"
        >
          Remove
        </button>
      </header>

      <div className="mt-3 space-y-3">
        <RecipientsList
          recipients={recipients}
          fields={fields}
          onChange={onSetRecipients}
        />

        <label className="block text-sm font-semibold text-splash-navy">
          Subject
          <input
            type="text"
            value={step.subject_template ?? ""}
            onChange={(e) =>
              onUpdateTemplates({ subject_template: e.currentTarget.value })
            }
            placeholder="New {form.title} submission"
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
          />
        </label>

        <label className="block text-sm font-semibold text-splash-navy">
          Body
          <textarea
            value={step.body_template ?? ""}
            onChange={(e) =>
              onUpdateTemplates({ body_template: e.currentTarget.value })
            }
            rows={8}
            placeholder="Hi {submitter.name}, …"
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 font-mono text-xs text-splash-navy"
          />
        </label>

        <details className="text-xs text-splash-navy/70">
          <summary className="cursor-pointer font-semibold">
            Use placeholders like {"{field.label}"} or {"{field.key}"}
          </summary>
          <div className="mt-1 rounded-splash-sm border border-gray-light bg-white p-2">
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
              Built-ins
            </p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {PLACEHOLDER_REFERENCE.map((p) => (
                <li
                  key={p}
                  className="rounded-full bg-amber-50 px-2 py-0.5 font-mono text-[0.65rem] text-splash-navy ring-1 ring-amber-200"
                >
                  {p}
                </li>
              ))}
            </ul>
            {fields.length > 0 && (
              <>
                <p className="mt-2 text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
                  Form fields
                </p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {fields
                    .filter(
                      (f) => f.type !== "heading" && f.type !== "image"
                    )
                    .map((f) => (
                      <li
                        key={f.id}
                        className="rounded-full bg-sudsy-blue/5 px-2 py-0.5 font-mono text-[0.65rem] text-splash-navy ring-1 ring-gray-light"
                        title={f.label}
                      >
                        {`{field.${f.key}}`}
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>
        </details>

        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input
            type="checkbox"
            checked={Boolean(step.attach_pdf)}
            onChange={(e) =>
              onUpdateTemplates({ attach_pdf: e.currentTarget.checked || undefined })
            }
            className="mt-0.5 h-4 w-4 rounded border-gray-light text-splash-blue focus:ring-splash-blue"
          />
          <span className="flex-1">
            <span className="font-semibold">Attach PDF of completed form</span>
            <span className="mt-0.5 block text-xs text-splash-navy/60">
              Includes form fields (minus any marked "Don't include in PDF")
              and the full approval history with signatures.
            </span>
          </span>
        </label>

        <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Then go to
          <select
            value={onlyTransition.to}
            onChange={(e) =>
              onUpdateTransition(0, {
                to: e.currentTarget.value,
                label: onlyTransition.label || "Continue"
              })
            }
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-normal text-splash-navy"
          >
            <option value="">— Pick a destination —</option>
            {destinationOptions.map((d) => (
              <option key={d.id} value={d.id} disabled={d.disabled}>
                {d.kind === "outcome" ? `Outcome: ${d.label}` : d.label}
                {d.disabled ? ` ${d.disabledReason ?? "(unavailable)"}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

interface RecipientsListProps {
  recipients: ApproverSource[];
  fields: Field[];
  onChange: (recipients: ApproverSource[]) => void;
}

function RecipientsList({
  recipients,
  fields,
  onChange
}: RecipientsListProps) {
  const list = recipients.length > 0 ? recipients : [];
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-splash-navy">To</p>
      {list.length === 0 && (
        <ApproverPicker
          source={undefined}
          fields={fields}
          onChange={(src) => {
            if (src) onChange([src]);
            else onChange([]);
          }}
        />
      )}
      {list.map((src, idx) => (
        <div key={idx} className="rounded-splash-sm border border-gray-light bg-white p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <ApproverPicker
                source={src}
                fields={fields}
                onChange={(next) => {
                  if (!next) {
                    onChange(list.filter((_, i) => i !== idx));
                  } else {
                    onChange(list.map((s, i) => (i === idx ? next : s)));
                  }
                }}
              />
            </div>
            {list.length > 1 && (
              <button
                type="button"
                onClick={() => onChange(list.filter((_, i) => i !== idx))}
                className="rounded-splash-sm border border-racecar-red/40 px-1.5 py-0.5 text-[0.65rem] font-semibold text-racecar-red hover:bg-racecar-red/10"
                aria-label="Remove this recipient"
                title="Remove"
              >
                ×
              </button>
            )}
          </div>
        </div>
      ))}
      {list.length > 0 && (
        <button
          type="button"
          onClick={() =>
            onChange([...list, { type: "static_emails", emails: [] }])
          }
          className="inline-flex items-center rounded-splash-sm border border-dashed border-splash-navy/40 px-2 py-0.5 text-[0.7rem] font-semibold text-splash-navy/80 hover:bg-splash-navy/5"
        >
          + Add another recipient
        </button>
      )}
    </div>
  );
}
