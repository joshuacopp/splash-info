// Brief 120 — workflow section on the submission detail page.
//
// Renders:
//   1. Current stage label (prominent at top)
//   2. Per-allowed-transition button row (only transitions the caller can
//      take — gated client-side on `current_approver_emails` + the caller's
//      email; super_admin / admin tier always sees every transition button
//      as the escape hatch).
//   3. Modal-style requirements collector (note / typed_name / signature
//      checkboxes from the transition's `requires` block).
//   4. Vertical history timeline mirroring the damage activity log.
//
// The transition POST runs through Brief 19 `useActionState` pattern via
// <ActionForm> for the textual requirements (note + typed_name); the
// signature input is a stub — full canvas wiring deferred to a Brief 121
// follow-up (the worker accepts a signature_r2_key today, the apps/web
// signature capture is non-trivial and not blocking the data-model brief).

"use client";

import { useState } from "react";
import type {
  FormWorkflow,
  WorkflowHistoryEntry,
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

import { ActionForm, type ActionResult } from "../../../../../_components/ActionForm";

interface Props {
  workflow: FormWorkflow;
  currentStageId: string;
  history: WorkflowHistoryEntry[];
  currentApproverEmails: string[];
  callerEmail: string;
  isAdminTier: boolean;
  transitionAction: (
    toStageId: string,
    _prev: ActionResult | null,
    formData: FormData
  ) => Promise<ActionResult>;
}

export default function WorkflowSection(props: Props) {
  const stages = props.workflow.stages;
  const currentStage = stages.find((s) => s.id === props.currentStageId);
  const callerEmail = props.callerEmail.trim().toLowerCase();
  const onApproverList = props.currentApproverEmails
    .map((e) => e.trim().toLowerCase())
    .includes(callerEmail);
  const canActOnCurrentStage = props.isAdminTier || onApproverList;

  // One open-modal state per button: the active transition's `to` stage id.
  const [activeTransition, setActiveTransition] = useState<string | null>(null);
  const activeTx = currentStage?.transitions.find(
    (t) => t.to === activeTransition
  );

  return (
    <section className="mb-6 rounded-md border border-gray-light bg-white p-5">
      <h2 className="mb-2 text-lg font-semibold text-splash-navy">Workflow</h2>

      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
          Current stage
        </p>
        <p className="text-base font-bold text-splash-navy">
          {currentStage?.label ?? props.currentStageId}
        </p>
        {!canActOnCurrentStage && (
          <p className="text-xs text-splash-navy/60">
            (Approvers:{" "}
            {props.currentApproverEmails.length > 0
              ? props.currentApproverEmails.join(", ")
              : "none assigned"}
            )
          </p>
        )}
      </div>

      {currentStage && currentStage.transitions.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {currentStage.transitions.map((t) => (
            <button
              key={`${t.to}:${t.label}`}
              type="button"
              onClick={() => setActiveTransition(t.to)}
              disabled={!canActOnCurrentStage}
              className="rounded-splash-md bg-splash-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
              title={
                canActOnCurrentStage
                  ? undefined
                  : "You are not on this stage's approver list."
              }
            >
              {t.label} →{" "}
              {stages.find((s) => s.id === t.to)?.label ?? t.to}
            </button>
          ))}
        </div>
      )}

      {currentStage && currentStage.transitions.length === 0 && (
        <p className="mb-4 text-xs text-splash-navy/60">
          Terminal stage. No further transitions.
        </p>
      )}

      {activeTx && (
        <TransitionModal
          transition={activeTx}
          stages={stages}
          onCancel={() => setActiveTransition(null)}
          action={props.transitionAction.bind(null, activeTx.to)}
        />
      )}

      <HistoryTimeline history={props.history} stages={stages} />
    </section>
  );
}

interface TransitionModalProps {
  transition: WorkflowTransition;
  stages: WorkflowStage[];
  onCancel: () => void;
  action: (
    _prev: ActionResult | null,
    formData: FormData
  ) => Promise<ActionResult>;
}

function TransitionModal(p: TransitionModalProps) {
  const requires = p.transition.requires ?? {};
  const destLabel =
    p.stages.find((s) => s.id === p.transition.to)?.label ?? p.transition.to;
  return (
    <div className="mb-4 rounded-md border border-splash-blue bg-sudsy-blue/5 p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="font-semibold text-splash-navy">
          {p.transition.label} → {destLabel}
        </p>
        <button
          type="button"
          onClick={p.onCancel}
          className="text-xs text-splash-navy/60 hover:text-splash-navy"
        >
          Cancel
        </button>
      </div>
      <ActionForm
        action={p.action}
        resetOnSuccess
        className="space-y-3"
      >
        {requires.note && (
          <label className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Note (required)
            <textarea
              name="note"
              rows={3}
              required
              className="mt-1 block w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy"
            />
          </label>
        )}
        {requires.typed_name && (
          <label className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Typed name (required)
            <input
              type="text"
              name="typed_name"
              required
              className="mt-1 block w-full rounded-splash-md border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
            />
          </label>
        )}
        {requires.signature && (
          <label className="block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Signature R2 key (required)
            <input
              type="text"
              name="signature_r2_key"
              required
              placeholder="form-submission-files/.../signature.png"
              className="mt-1 block w-full rounded-splash-md border border-gray-light bg-white px-3 py-1.5 text-sm font-mono text-splash-navy"
            />
            <span className="mt-1 block text-[0.65rem] text-splash-navy/60">
              Full signature-canvas wiring is a Brief 121 follow-up; for v1
              paste an existing r2_key.
            </span>
          </label>
        )}
        {!requires.note && !requires.typed_name && !requires.signature && (
          <p className="text-xs text-splash-navy/60">
            No additional fields required. Click Confirm to advance.
          </p>
        )}
        <button
          type="submit"
          className="rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white hover:bg-splash-blue-dark"
        >
          Confirm: {p.transition.label}
        </button>
      </ActionForm>
    </div>
  );
}

interface HistoryProps {
  history: WorkflowHistoryEntry[];
  stages: WorkflowStage[];
}

function HistoryTimeline(p: HistoryProps) {
  if (p.history.length === 0) {
    return (
      <p className="text-xs text-splash-navy/60">
        No workflow events yet.
      </p>
    );
  }
  return (
    <div className="border-t border-gray-light pt-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
        History
      </p>
      <ol className="space-y-2">
        {p.history
          .slice()
          .reverse()
          .map((h, i) => {
            const fromLabel =
              p.stages.find((s) => s.id === h.from)?.label ?? h.from;
            const toLabel =
              p.stages.find((s) => s.id === h.to)?.label ?? h.to;
            return (
              <li
                key={`${h.at}:${i}`}
                className="rounded-md border border-gray-light bg-white p-2 text-xs text-splash-navy"
              >
                <p>
                  <strong>{h.actor_email}</strong> · {fromLabel} → {toLabel}
                </p>
                <p className="mt-0.5 text-splash-navy/60">
                  {new Date(h.at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit"
                  })}
                </p>
                {h.note && (
                  <p className="mt-1 whitespace-pre-wrap text-splash-navy/80">
                    “{h.note}”
                  </p>
                )}
                {(h.typed_name || h.signature_r2_key) && (
                  <p className="mt-1 text-splash-navy/60">
                    {h.typed_name && (
                      <span>Typed: {h.typed_name}</span>
                    )}
                    {h.signature_r2_key && (
                      <span>
                        {h.typed_name ? " · " : ""}Signature attached
                      </span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
      </ol>
    </div>
  );
}
