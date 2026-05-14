// Brief 125 — single approval-step card.
//
// Header row: drag handle, "Step N" badge, label input, duplicate +
// remove buttons. Body: "Who approves?" picker + actions grid.

"use client";

import { useSortable } from "@dnd-kit/sortable";
import type {
  ApproverSource,
  Field,
  WorkflowStage,
  WorkflowTransition,
  WorkflowTransitionRequirements
} from "@splash/forms-schema";

import ApproverPicker from "./ApproverPicker";

interface DndTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

// Inline equivalent of `@dnd-kit/utilities` CSS.Transform.toString.
// Not added as a workspace dep just for this serializer.
function transformToCss(t: DndTransform | null): string | undefined {
  if (!t) return undefined;
  return `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`;
}

export interface StepCardProps {
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
  onSetApprover: (source: ApproverSource | undefined) => void;
  onAddTransition: () => void;
  onUpdateTransition: (
    index: number,
    patch: Partial<WorkflowTransition>
  ) => void;
  onRemoveTransition: (index: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

const POSITIVE_TOKENS = [
  "approve",
  "accept",
  "ok",
  "yes",
  "submit",
  "confirm"
];
const NEGATIVE_TOKENS = ["deny", "decline", "reject", "no", "cancel"];

function actionTint(label: string): "positive" | "negative" | "neutral" {
  const lower = label.toLowerCase();
  if (POSITIVE_TOKENS.some((t) => lower.includes(t))) return "positive";
  if (NEGATIVE_TOKENS.some((t) => lower.includes(t))) return "negative";
  return "neutral";
}

export default function StepCard(props: StepCardProps) {
  const {
    step,
    stepIndex,
    isFirst,
    fields,
    destinationOptions,
    onUpdateLabel,
    onSetApprover,
    onAddTransition,
    onUpdateTransition,
    onRemoveTransition,
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

  const actions = step.transitions;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className="rounded-splash-md border border-gray-light bg-white p-4 shadow-sm"
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
        <span className="inline-flex items-center rounded-full bg-splash-blue/10 px-2.5 py-0.5 text-xs font-bold text-splash-blue">
          Step {stepIndex + 1}
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

      <div className="mt-3">
        <ApproverPicker
          source={step.approver_source}
          fields={fields}
          onChange={onSetApprover}
        />
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold text-splash-navy">
          What can the approver do?
        </p>
        <p className="mt-0.5 text-xs text-splash-navy/60">
          Each action below is a button the approver will see on the review
          page.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          {actions.map((action, idx) => (
            <ActionSubCard
              key={idx}
              action={action}
              destinationOptions={destinationOptions}
              onUpdate={(patch) => onUpdateTransition(idx, patch)}
              onRemove={() => onRemoveTransition(idx)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onAddTransition}
          className="mt-2 inline-flex items-center rounded-splash-md border border-dashed border-splash-navy/60 px-3 py-1.5 text-xs font-semibold text-splash-navy/80 hover:border-splash-navy hover:bg-splash-navy/5"
        >
          + Add another action
        </button>
      </div>
    </article>
  );
}

interface ActionProps {
  action: WorkflowTransition;
  destinationOptions: StepCardProps["destinationOptions"];
  onUpdate: (patch: Partial<WorkflowTransition>) => void;
  onRemove: () => void;
}

function ActionSubCard({
  action,
  destinationOptions,
  onUpdate,
  onRemove
}: ActionProps) {
  const tint = actionTint(action.label);
  const dotColor =
    tint === "positive"
      ? "bg-emerald-500"
      : tint === "negative"
        ? "bg-racecar-red"
        : "bg-slate-400";

  const req: WorkflowTransitionRequirements = action.requires ?? {};

  function setRequires(patch: Partial<WorkflowTransitionRequirements>) {
    const next: WorkflowTransitionRequirements = { ...req };
    for (const key of Object.keys(patch) as Array<
      keyof WorkflowTransitionRequirements
    >) {
      const value = patch[key];
      if (value) {
        next[key] = true;
      } else {
        delete next[key];
      }
    }
    onUpdate({
      requires: Object.keys(next).length > 0 ? next : undefined
    });
  }

  return (
    <div className="rounded-splash-md border border-gray-light bg-white p-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${dotColor}`}
          aria-hidden="true"
        />
        <input
          type="text"
          value={action.label}
          onChange={(e) => onUpdate({ label: e.currentTarget.value })}
          placeholder="e.g. Approve, Deny, Send back"
          className="flex-1 rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-semibold text-splash-navy"
        />
        <button
          type="button"
          onClick={onRemove}
          title="Remove this action"
          className="rounded-splash-sm border border-racecar-red/40 px-1.5 text-[0.7rem] text-racecar-red hover:bg-racecar-red/10"
        >
          ×
        </button>
      </div>

      <fieldset className="mt-2">
        <legend className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Required action
        </legend>
        <p className="mt-0.5 text-[0.65rem] text-splash-navy/60">
          What the approver must do before clicking this button.
        </p>
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-splash-navy">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!req.signature}
              onChange={(e) => setRequires({ signature: e.currentTarget.checked })}
            />
            Signature
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!req.note}
              onChange={(e) => setRequires({ note: e.currentTarget.checked })}
            />
            Note
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!!req.typed_name}
              onChange={(e) => setRequires({ typed_name: e.currentTarget.checked })}
            />
            Typed name
          </label>
        </div>
      </fieldset>

      <label className="mt-2 block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
        Then go to
        <select
          value={action.to}
          onChange={(e) => onUpdate({ to: e.currentTarget.value })}
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
  );
}
