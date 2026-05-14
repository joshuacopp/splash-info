// Brief 131 — Workflow column cell for the per-form submissions list.
//
// Reads the row's `workflow_stage` + the row's version-schema workflow
// definition to render one of three states:
//   1. No workflow on this submission's version → muted dash.
//   2. Workflow at terminal outcome → tinted pill (success / danger /
//      warning / info / neutral per the stage's `tint`, with a keyword
//      heuristic fallback).
//   3. Workflow in flight (non-terminal stage) → muted "in flight" pill
//      showing the stage's label.
//
// Mirrors the my-requests status_tint heuristic so a v1 schema without
// an explicit tint still renders sensible colors.

import type { FormWorkflow, WorkflowStage } from "@splash/forms-schema";

import type { SubmissionListItem } from "../../../_lib/worker-fetch";

type Tint = "success" | "danger" | "warning" | "info" | "neutral";

function stageIsOutcome(stage: WorkflowStage): boolean {
  if (stage.kind === "outcome") return true;
  if (
    stage.kind === "step" ||
    stage.kind === "approval" ||
    stage.kind === "email"
  ) {
    return false;
  }
  return stage.transitions.length === 0 && !stage.approver_source;
}

function resolveTint(stage: WorkflowStage): Tint {
  if (stage.tint) return stage.tint;
  const label = stage.label.toLowerCase();
  if (/\bapprov/.test(label)) return "success";
  if (/\bden|\breject|\bdecline/.test(label)) return "danger";
  return "neutral";
}

const TINT_STYLES: Record<Tint, string> = {
  success: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200",
  danger: "bg-racecar-red/10 text-racecar-red ring-1 ring-racecar-red/30",
  warning: "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
  info: "bg-sudsy-blue/15 text-splash-navy ring-1 ring-sudsy-blue/30",
  neutral: "bg-gray-light text-splash-navy/80 ring-1 ring-splash-navy/10"
};

export default function WorkflowOutcomeCell({
  item
}: {
  item: SubmissionListItem;
}) {
  const workflow = item.version?.schema?.workflow as FormWorkflow | undefined;
  const stageId = item.workflow_stage ?? null;
  if (!workflow || !stageId) {
    return <span className="text-splash-navy/40">—</span>;
  }
  const stage = workflow.stages.find((s) => s.id === stageId);
  if (!stage) {
    return (
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${TINT_STYLES.neutral}`}
        title={`Unknown stage: ${stageId}`}
      >
        {stageId}
      </span>
    );
  }
  if (stageIsOutcome(stage)) {
    const tint = resolveTint(stage);
    return (
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${TINT_STYLES[tint]}`}
      >
        {stage.label}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide ${TINT_STYLES.info}`}
      title="In flight — awaiting approver action"
    >
      {stage.label}
    </span>
  );
}
