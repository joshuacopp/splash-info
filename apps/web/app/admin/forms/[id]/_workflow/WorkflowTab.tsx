// Brief 125 — Workflow tab (top-level, not nested in the Inspector).
//
// Top-to-bottom layout:
//   1. Header — "Approval workflow" + description + Disable button (when enabled).
//   2. Entry anchor — "Form submitted" pill + downward arrow.
//   3. Step cards stack — vertical list with drag-to-reorder.
//   4. "+ Add approval step" dashed button.
//   5. Outcomes section.
//   6. Notifications panel.
//   7. Live flow preview.
//
// Schema mapping: the workflow JSONB's `stages[]` contains BOTH steps and
// outcomes. This tab buckets them via the `stageIsOutcome` predicate in
// reducer.ts (which respects the optional `kind` hint added in Brief 125).
// `default_stage` always points at the first step.

"use client";

import dynamic from "next/dynamic";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import type {
  ApproverSource,
  Field,
  FormWorkflow,
  WorkflowNotifications,
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import { stageIsOutcome } from "../_builder/reducer";
import StepCard from "./StepCard";
import OutcomesSection from "./OutcomesSection";
import NotificationsPanel from "./NotificationsPanel";

// Lazy-load Mermaid so the heavy lib only ships to operators editing
// workflows. The Brief 123 chunk split is preserved.
const WorkflowFlowPreview = dynamic(
  () => import("./WorkflowFlowPreview"),
  { ssr: false }
);

export interface WorkflowTabDispatch {
  onEnable: () => void;
  onDisable: () => void;
  onAddStep: () => void;
  onDuplicateStep: (stepId: string) => void;
  onRemoveStep: (stepId: string) => void;
  onReorderSteps: (fromIndex: number, toIndex: number) => void;
  onUpdateStepLabel: (stepId: string, label: string) => void;
  onSetStepApprover: (stepId: string, source: ApproverSource | undefined) => void;
  onAddTransition: (stepId: string) => void;
  onUpdateTransition: (
    stepId: string,
    index: number,
    patch: Partial<WorkflowTransition>
  ) => void;
  onRemoveTransition: (stepId: string, index: number) => void;
  onAddOutcome: () => void;
  onUpdateOutcome: (
    outcomeId: string,
    patch: Partial<Pick<WorkflowStage, "label" | "tint">>
  ) => void;
  onRemoveOutcome: (outcomeId: string) => void;
  onSetNotifications: (patch: Partial<WorkflowNotifications>) => void;
}

interface Props {
  workflow: FormWorkflow | null;
  fields: Field[];
  dispatch: WorkflowTabDispatch;
}

export default function WorkflowTab({ workflow, fields, dispatch }: Props) {
  if (!workflow) {
    return (
      <section className="rounded-splash-md border border-gray-light bg-white p-6">
        <h2 className="text-lg font-bold text-splash-navy">Approval workflow</h2>
        <p className="mt-1 text-sm text-splash-navy/70">
          This form has no approval workflow. Submissions are saved and
          stop there.
        </p>
        <p className="mt-2 text-sm text-splash-navy/70">
          Enable a workflow to add review steps. Each step picks an
          approver, defines what actions they can take, and routes the
          submission to an outcome (Approved, Denied, or anything you
          define).
        </p>
        <button
          type="button"
          onClick={dispatch.onEnable}
          className="mt-4 inline-flex items-center rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-bold text-white hover:bg-splash-blue-dark"
        >
          Enable workflow
        </button>
      </section>
    );
  }

  const steps = workflow.stages.filter((s) => !stageIsOutcome(s));
  const outcomes = workflow.stages.filter((s) => stageIsOutcome(s));

  function destinationOptionsFor(currentStepId: string) {
    const options: Array<{
      id: string;
      label: string;
      kind: "step" | "outcome";
      disabled?: boolean;
      disabledReason?: string;
    }> = [];
    for (const o of outcomes) {
      options.push({
        id: o.id,
        label: o.label || "(unnamed)",
        kind: "outcome"
      });
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s) continue;
      const isSelf = s.id === currentStepId;
      options.push({
        id: s.id,
        label: `Step ${i + 1}: ${s.label || "(unnamed)"}`,
        kind: "step",
        disabled: isSelf,
        disabledReason: isSelf ? "(current step)" : undefined
      });
    }
    return options;
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = steps.findIndex(
      (s) => (s._uiKey ?? s.id) === active.id
    );
    const toIndex = steps.findIndex(
      (s) => (s._uiKey ?? s.id) === over.id
    );
    if (fromIndex < 0 || toIndex < 0) return;
    dispatch.onReorderSteps(fromIndex, toIndex);
  }

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3 border-b border-gray-light pb-3">
        <div>
          <h2 className="text-lg font-bold text-splash-navy">Approval workflow</h2>
          <p className="mt-1 text-sm text-splash-navy/70">
            Each submission walks through these steps. Approvers see the
            actions you list; the destination decides what happens next.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                "Disable the workflow? Past submissions keep their workflow snapshot; new submissions will skip approval entirely."
              )
            ) {
              dispatch.onDisable();
            }
          }}
          className="rounded-splash-md border border-racecar-red/40 px-3 py-1.5 text-xs font-semibold text-racecar-red hover:bg-racecar-red/10"
        >
          Disable workflow
        </button>
      </header>

      <div className="flex flex-col items-center">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-4 py-1.5 text-sm font-semibold text-slate-700">
          Form submitted
        </span>
        <span aria-hidden="true" className="my-1 text-lg text-splash-navy/40">
          ↓
        </span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={steps.map((s) => s._uiKey ?? s.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {steps.length === 0 && (
              <p className="rounded-splash-md border border-dashed border-gray-light bg-white p-4 text-center text-sm text-splash-navy/60">
                No approval steps yet. Add one below to require an
                approver.
              </p>
            )}
            {steps.map((step, idx) => (
              <div key={step._uiKey ?? step.id}>
                <StepCard
                  step={step}
                  stepIndex={idx}
                  isFirst={idx === 0}
                  fields={fields}
                  destinationOptions={destinationOptionsFor(step.id)}
                  onUpdateLabel={(label) =>
                    dispatch.onUpdateStepLabel(step.id, label)
                  }
                  onSetApprover={(source) =>
                    dispatch.onSetStepApprover(step.id, source)
                  }
                  onAddTransition={() => dispatch.onAddTransition(step.id)}
                  onUpdateTransition={(index, patch) =>
                    dispatch.onUpdateTransition(step.id, index, patch)
                  }
                  onRemoveTransition={(index) =>
                    dispatch.onRemoveTransition(step.id, index)
                  }
                  onDuplicate={() => dispatch.onDuplicateStep(step.id)}
                  onRemove={() => {
                    if (
                      window.confirm(
                        `Remove "${step.label || "this step"}"? Actions pointing at it will be cleared.`
                      )
                    ) {
                      dispatch.onRemoveStep(step.id);
                    }
                  }}
                />
                {idx < steps.length - 1 && (
                  <div className="my-1 flex justify-center text-base text-splash-navy/40">
                    ↓
                  </div>
                )}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={dispatch.onAddStep}
        className="block w-full rounded-splash-md border border-dashed border-splash-navy/60 py-3 text-sm font-semibold text-splash-navy/80 hover:bg-splash-navy/5"
      >
        + Add approval step
      </button>

      <OutcomesSection
        outcomes={outcomes}
        onAdd={dispatch.onAddOutcome}
        onRemove={dispatch.onRemoveOutcome}
        onUpdate={dispatch.onUpdateOutcome}
      />

      <NotificationsPanel
        notifications={workflow.notifications}
        onChange={dispatch.onSetNotifications}
      />

      <section className="space-y-2 rounded-splash-md border border-gray-light bg-white p-4">
        <header>
          <h3 className="text-base font-bold text-splash-navy">Flow preview</h3>
          <p className="text-xs text-splash-navy/60">
            Live diagram of how submissions move through this workflow.
          </p>
        </header>
        <WorkflowFlowPreview workflow={workflow} />
      </section>
    </section>
  );
}
