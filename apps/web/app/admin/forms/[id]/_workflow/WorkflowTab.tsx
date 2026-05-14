// Brief 125 — Workflow tab (top-level, not nested in the Inspector).
// Brief 127 — added email-step support + Quick patterns + removed the
// Notifications panel (its use cases now expressed as explicit email
// steps in the workflow).
//
// Top-to-bottom layout:
//   1. Header — "Approval workflow" + description + Disable button.
//   2. Entry anchor — "Form submitted" pill + downward arrow.
//   3. Step cards stack — vertical list with drag-to-reorder. Approval
//      steps render via StepCard; email steps render via EmailStepCard.
//   4. "+ Add step" choice popover (Approval / Email) + "Quick
//      patterns…" popover.
//   5. Outcomes section.
//   6. Live flow preview.
//
// Schema mapping: the workflow JSONB's `stages[]` contains approval
// steps, email steps, AND outcomes. This tab buckets them via the
// `stageIsOutcome` + `stageIsEmail` + `stageIsApproval` predicates
// (Brief 125 + Brief 127). `default_stage` always points at the first
// stage in the steps list.

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
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import {
  stageIsApproval,
  stageIsEmail,
  stageIsOutcome,
  type QuickPattern
} from "../_builder/reducer";
import StepCard from "./StepCard";
import EmailStepCard from "./EmailStepCard";
import OutcomesSection from "./OutcomesSection";
import AddStepPopover from "./AddStepPopover";
import QuickPatternsPopover from "./QuickPatternsPopover";

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
  onAddEmailStep: () => void;
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
  // Brief 127 — email-step dispatchers. Brief 129 widened the patch
  // shape to include `attach_pdf` so EmailStepCard's PDF checkbox can
  // ride the same dispatch.
  onUpdateEmailTemplates: (
    stepId: string,
    patch: Partial<
      Pick<
        WorkflowStage,
        "subject_template" | "body_template" | "attach_pdf"
      >
    >
  ) => void;
  onSetEmailRecipients: (
    stepId: string,
    recipients: ApproverSource[]
  ) => void;
  onApplyQuickPattern: (pattern: QuickPattern) => void;
  // Brief 131 — inline "+ Create new email step here" routed from an
  // approval action's Then-go-to dropdown. Atomic: creates the step,
  // wires the action at it, picks a default outcome destination.
  onCreateAndRouteToEmailStep: (
    stepId: string,
    transitionIndex: number
  ) => void;
  onAddOutcome: () => void;
  onUpdateOutcome: (
    outcomeId: string,
    patch: Partial<Pick<WorkflowStage, "label" | "tint">>
  ) => void;
  onRemoveOutcome: (outcomeId: string) => void;
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
          Enable a workflow to add review steps, email notifications, and
          outcome routing.
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

  // Brief 127 — steps are the non-outcome stages (both approval AND
  // email). Outcomes render separately in the OutcomesSection.
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
            actions you list; email steps send a message and move on.
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
                No steps yet. Add an approval step or an email step
                below.
              </p>
            )}
            {steps.map((step, idx) => (
              <div key={step._uiKey ?? step.id}>
                {stageIsEmail(step) ? (
                  <EmailStepCard
                    step={step}
                    stepIndex={idx}
                    isFirst={idx === 0}
                    fields={fields}
                    destinationOptions={destinationOptionsFor(step.id)}
                    onUpdateLabel={(label) =>
                      dispatch.onUpdateStepLabel(step.id, label)
                    }
                    onUpdateTemplates={(patch) =>
                      dispatch.onUpdateEmailTemplates(step.id, patch)
                    }
                    onSetRecipients={(recipients) =>
                      dispatch.onSetEmailRecipients(step.id, recipients)
                    }
                    onUpdateTransition={(index, patch) =>
                      dispatch.onUpdateTransition(step.id, index, patch)
                    }
                    onDuplicate={() => dispatch.onDuplicateStep(step.id)}
                    onRemove={() => {
                      if (
                        window.confirm(
                          `Remove "${step.label || "this email step"}"?`
                        )
                      ) {
                        dispatch.onRemoveStep(step.id);
                      }
                    }}
                  />
                ) : (
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
                    onCreateAndRouteToEmailStep={(index) =>
                      dispatch.onCreateAndRouteToEmailStep(step.id, index)
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
                )}
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1">
          <AddStepPopover
            onAddApprovalStep={dispatch.onAddStep}
            onAddEmailStep={dispatch.onAddEmailStep}
          />
        </div>
        <QuickPatternsPopover onApply={dispatch.onApplyQuickPattern} />
      </div>

      <OutcomesSection
        outcomes={outcomes}
        onAdd={dispatch.onAddOutcome}
        onRemove={dispatch.onRemoveOutcome}
        onUpdate={dispatch.onUpdateOutcome}
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

// Re-export the predicate that callers (e.g. the BuilderClient legacy
// detection / external integrations) may want without re-importing
// from the reducer module.
export { stageIsApproval };
