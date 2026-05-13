// Brief 120 — workflow editor rendered inside the right-side Inspector
// when no field is selected. The FormMetaInspector toggles the editor in
// via "Enable workflow"; once enabled, the operator picks a default
// stage and edits the stage list (id / label / approver_source /
// transitions) inline.
//
// Brief 123 UX fixes:
//   - Stage rows keyed by stable `_uiKey` (nanoid) so renaming `stage.id`
//     no longer remounts the input → focus persists across keystrokes.
//   - Stage id input dispatches `workflow_rename_stage` (atomic cascade
//     into `default_stage` + every `transition.to`). Snake_case sanitized
//     on every keystroke (KeyEditor pattern from Brief 95).
//   - Terminal stages (no `approver_source` AND no `transitions`) render
//     with a TERMINAL pill, muted background, hidden ApproverSource
//     picker, and disabled "+ Add transition" button.
//   - Transition destination dropdown disables the current stage (no
//     self-transitions).
//   - Below the stages list, a live Mermaid preview renders the workflow
//     graph (lazy-loaded via `./WorkflowMermaidPreview`).
//
// Validator-enforced constraints (forms-schema/validators/field-config.ts):
//   - default_stage matches some stage.id
//   - Every transition.to matches some stage.id, and !== stage.id (no self)
//   - No duplicate stage ids
//   - approver_source.field_key (payload_field type) references a real field
//   - No orphaned approval stages, no unreachable terminals (Brief 123)
//
// The strict variant runs at publish time; the lenient draft variant lets
// the operator save mid-build. Errors surface as the worker's 422
// `schema_invalid` issues array which apps/web threads back to the
// builder TopBar as a save error.

"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type {
  ApproverSource,
  Field,
  FormWorkflow,
  WorkflowStage,
  WorkflowTransition
} from "@splash/forms-schema";

// Lazy-load Mermaid so its ~250 KB bundle only ships to operators who open
// the builder page. The `ssr: false` flag also keeps the heavy lib out of
// the Worker runtime entirely.
const WorkflowMermaidPreview = dynamic(
  () => import("./WorkflowMermaidPreview"),
  { ssr: false }
);

interface Props {
  workflow: FormWorkflow | null;
  allFields: Field[];
  onEnable: () => void;
  onDisable: () => void;
  onSetDefaultStage: (stageId: string) => void;
  onAddStage: () => void;
  onRemoveStage: (stageId: string) => void;
  onMoveStage: (stageId: string, direction: -1 | 1) => void;
  onUpdateStage: (stageId: string, patch: Partial<WorkflowStage>) => void;
  onSetApproverSource: (stageId: string, source: ApproverSource) => void;
  onClearApproverSource: (stageId: string) => void;
  onAddTransition: (stageId: string) => void;
  onUpdateTransition: (
    stageId: string,
    index: number,
    patch: Partial<WorkflowTransition>
  ) => void;
  onRemoveTransition: (stageId: string, index: number) => void;
  onRenameStage: (oldId: string, newId: string) => void;
}

const STAGE_ID_RE = /^[a-z][a-z0-9_]*$/;

function isTerminalStage(stage: WorkflowStage): boolean {
  return stage.transitions.length === 0 && !stage.approver_source;
}

export default function WorkflowEditor(props: Props) {
  if (!props.workflow) {
    return (
      <section className="space-y-3 rounded-splash-md border border-gray-light bg-sudsy-blue/5 p-3">
        <header>
          <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/60">
            Approval workflow
          </p>
          <p className="text-sm font-bold text-splash-navy">
            No workflow on this form
          </p>
          <p className="mt-1 text-xs text-splash-navy/70">
            Submitted forms terminate immediately. Enable a workflow to add
            review / approval stages.
          </p>
        </header>
        <button
          type="button"
          onClick={props.onEnable}
          className="rounded-splash-md bg-splash-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-splash-blue-dark"
        >
          Enable workflow
        </button>
      </section>
    );
  }

  const workflow = props.workflow;
  const existingIds = useMemo(
    () => new Set(workflow.stages.map((s) => s.id)),
    [workflow.stages]
  );

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-2 border-b border-gray-light pb-2">
        <div>
          <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/60">
            Approval workflow
          </p>
          <p className="text-sm font-bold text-splash-navy">
            {workflow.stages.length} stage
            {workflow.stages.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onDisable}
          className="rounded-splash-sm border border-racecar-red/40 px-2 py-1 text-[0.65rem] font-semibold text-racecar-red hover:bg-racecar-red/10"
          title="Remove the workflow block. Past submissions keep their workflow snapshot."
        >
          Disable
        </button>
      </header>

      <label className="block text-xs font-semibold text-splash-navy/80">
        Default stage (where new submissions start)
        <select
          value={workflow.default_stage}
          onChange={(e) => props.onSetDefaultStage(e.currentTarget.value)}
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
        >
          {workflow.stages.map((s) => (
            <option key={s._uiKey ?? s.id} value={s.id}>
              {s.label || s.id}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-3">
        {workflow.stages.map((stage, idx) => (
          <StageEditor
            key={stage._uiKey ?? stage.id}
            stage={stage}
            allStages={workflow.stages}
            allFields={props.allFields}
            existingIds={existingIds}
            isDefaultStage={workflow.default_stage === stage.id}
            canMoveUp={idx > 0}
            canMoveDown={idx < workflow.stages.length - 1}
            onUpdate={(patch) => props.onUpdateStage(stage.id, patch)}
            onRename={(newId) => props.onRenameStage(stage.id, newId)}
            onSetApproverSource={(source) =>
              props.onSetApproverSource(stage.id, source)
            }
            onClearApproverSource={() =>
              props.onClearApproverSource(stage.id)
            }
            onAddTransition={() => props.onAddTransition(stage.id)}
            onUpdateTransition={(index, patch) =>
              props.onUpdateTransition(stage.id, index, patch)
            }
            onRemoveTransition={(index) =>
              props.onRemoveTransition(stage.id, index)
            }
            onMoveUp={() => props.onMoveStage(stage.id, -1)}
            onMoveDown={() => props.onMoveStage(stage.id, 1)}
            onRemove={() => props.onRemoveStage(stage.id)}
          />
        ))}
      </div>

      <WorkflowMermaidPreview workflow={workflow} />

      <button
        type="button"
        onClick={props.onAddStage}
        className="rounded-splash-md border border-splash-navy px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-splash-navy hover:text-white"
      >
        + Add stage
      </button>
    </section>
  );
}

interface StageProps {
  stage: WorkflowStage;
  allStages: WorkflowStage[];
  allFields: Field[];
  existingIds: Set<string>;
  isDefaultStage: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUpdate: (patch: Partial<WorkflowStage>) => void;
  onRename: (newId: string) => void;
  onSetApproverSource: (source: ApproverSource) => void;
  onClearApproverSource: () => void;
  onAddTransition: () => void;
  onUpdateTransition: (
    index: number,
    patch: Partial<WorkflowTransition>
  ) => void;
  onRemoveTransition: (index: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function StageEditor(p: StageProps) {
  const emailFieldKeys = useMemo(
    () =>
      p.allFields
        .filter((f) => f.type === "email")
        .map((f) => f.key),
    [p.allFields]
  );
  const idLooksValid = STAGE_ID_RE.test(p.stage.id);
  const terminal = isTerminalStage(p.stage);

  const wrapperClass = terminal
    ? "space-y-2 rounded-splash-md border border-gray-light bg-gray-50/60 p-3"
    : "space-y-2 rounded-splash-md border border-gray-light bg-white p-3";

  return (
    <div className={wrapperClass}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-splash-navy">
            Stage:{" "}
            <code className="text-[0.7rem] font-mono">{p.stage.id}</code>
          </p>
          {terminal && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-slate-600">
              Terminal
            </span>
          )}
          {p.isDefaultStage && (
            <span className="rounded-full bg-splash-blue/10 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-splash-blue">
              Start
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={p.onMoveUp}
            disabled={!p.canMoveUp}
            className="rounded-splash-sm border border-gray-light px-1.5 text-[0.7rem] text-splash-navy disabled:opacity-40"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={p.onMoveDown}
            disabled={!p.canMoveDown}
            className="rounded-splash-sm border border-gray-light px-1.5 text-[0.7rem] text-splash-navy disabled:opacity-40"
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={p.onRemove}
            className="rounded-splash-sm border border-racecar-red/40 px-1.5 text-[0.7rem] text-racecar-red hover:bg-racecar-red/10"
            title="Remove stage"
          >
            ×
          </button>
        </div>
      </div>

      <StageIdInput
        currentId={p.stage.id}
        existingIds={p.existingIds}
        idLooksValid={idLooksValid}
        onRename={p.onRename}
      />

      <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
        Display label
        <input
          type="text"
          value={p.stage.label}
          onChange={(e) => p.onUpdate({ label: e.currentTarget.value })}
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-normal text-splash-navy"
        />
      </label>

      {!terminal && p.stage.approver_source && (
        <ApproverSourceEditor
          source={p.stage.approver_source}
          emailFieldKeys={emailFieldKeys}
          onChange={p.onSetApproverSource}
          onClear={p.onClearApproverSource}
        />
      )}

      {terminal && (
        <div className="rounded-splash-sm border border-dashed border-gray-light bg-white/60 p-2 text-[0.7rem] text-splash-navy/70">
          Terminal stage — no approver needed, no transitions out.
          Add an approver source below to convert this back to an
          approval step.
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() =>
                p.onSetApproverSource({ type: "static_emails", emails: [] })
              }
              className="rounded-splash-sm border border-splash-navy px-2 py-0.5 text-[0.65rem] font-semibold text-splash-navy hover:bg-splash-navy hover:text-white"
            >
              Make approval step
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1.5 rounded-splash-sm border border-gray-light bg-sudsy-blue/5 p-2">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Transitions out of this stage
        </p>
        {p.stage.transitions.length === 0 && (
          <p className="text-[0.7rem] text-splash-navy/60">
            {terminal
              ? "Terminal — no outgoing transitions."
              : "No transitions yet. Add one below."}
          </p>
        )}
        {p.stage.transitions.map((t, i) => (
          <TransitionEditor
            key={i}
            transition={t}
            currentStageId={p.stage.id}
            allStages={p.allStages}
            onUpdate={(patch) => p.onUpdateTransition(i, patch)}
            onRemove={() => p.onRemoveTransition(i)}
          />
        ))}
        <button
          type="button"
          onClick={p.onAddTransition}
          disabled={terminal}
          title={
            terminal
              ? "Terminal stages have no outgoing transitions. Add an approver source to convert this back to an approval step."
              : "Add a transition out of this stage"
          }
          className="rounded-splash-sm border border-splash-navy px-2 py-0.5 text-[0.65rem] font-semibold text-splash-navy hover:bg-splash-navy hover:text-white disabled:cursor-not-allowed disabled:border-gray-light disabled:text-splash-navy/40 disabled:hover:bg-transparent disabled:hover:text-splash-navy/40"
        >
          + Add transition
        </button>
      </div>
    </div>
  );
}

interface StageIdInputProps {
  currentId: string;
  existingIds: Set<string>;
  idLooksValid: boolean;
  onRename: (sanitizedNewId: string) => void;
}

// Brief 123 — controlled stage id input with snake_case sanitization on
// every keystroke + live collision detection. The input is bound to
// `stage.id` (controlled). On change:
//   - sanitize raw → newId via the KeyEditor pattern,
//   - if newId === currentId: no-op,
//   - if newId is empty: no-op,
//   - if newId collides with another existing stage's id: show red
//     border + hint, no dispatch,
//   - otherwise: dispatch `workflow_rename_stage(currentId, newId)`,
//     which cascades into default_stage + every transition.to.
function StageIdInput(p: StageIdInputProps) {
  return (
    <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
      Stage id (snake_case)
      <input
        type="text"
        value={p.currentId}
        onChange={(e) => {
          const sanitized = e.currentTarget.value
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "")
            .replace(/^[^a-z]+/, "");
          if (!sanitized || sanitized === p.currentId) return;
          if (p.existingIds.has(sanitized)) return;
          p.onRename(sanitized);
        }}
        className={`mt-1 w-full rounded-splash-sm border bg-white px-2 py-1 text-sm font-mono text-splash-navy ${
          p.idLooksValid ? "border-gray-light" : "border-racecar-red"
        }`}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="mt-1 block font-normal text-[0.65rem] text-splash-navy/60">
        Lowercase letters, digits, underscores; must start with a letter.
        Renames cascade to the default stage + every transition out of /
        into this stage.
      </span>
    </label>
  );
}

interface ApproverSourceProps {
  source: ApproverSource;
  emailFieldKeys: string[];
  onChange: (next: ApproverSource) => void;
  onClear: () => void;
}

function ApproverSourceEditor(p: ApproverSourceProps) {
  return (
    <div className="space-y-1.5 rounded-splash-sm border border-gray-light bg-sudsy-blue/5 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Approver source
        </p>
        <button
          type="button"
          onClick={p.onClear}
          className="rounded-splash-sm border border-gray-light px-1.5 py-0.5 text-[0.6rem] font-semibold text-splash-navy/70 hover:bg-gray-light"
          title="Drop the approver source to make this a terminal stage. Existing transitions remain — remove them too if this should truly be terminal."
        >
          Make terminal
        </button>
      </div>
      <div className="flex flex-wrap gap-2 text-[0.7rem] text-splash-navy">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`approver-${p.source.type}-radio`}
            checked={p.source.type === "site_role"}
            onChange={() =>
              p.onChange({ type: "site_role", role: "site_email" })
            }
          />
          Site role
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`approver-${p.source.type}-radio`}
            checked={p.source.type === "static_emails"}
            onChange={() => p.onChange({ type: "static_emails", emails: [] })}
          />
          Static emails
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`approver-${p.source.type}-radio`}
            checked={p.source.type === "payload_field"}
            onChange={() =>
              p.onChange({
                type: "payload_field",
                field_key: p.emailFieldKeys[0] ?? ""
              })
            }
          />
          Payload field
        </label>
      </div>

      {p.source.type === "site_role" && (
        <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Role
          <select
            value={p.source.role}
            onChange={(e) =>
              p.onChange({
                type: "site_role",
                role: e.currentTarget.value as "am_email" | "rm_email" | "site_email"
              })
            }
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-normal text-splash-navy"
          >
            <option value="site_email">Site email</option>
            <option value="rm_email">Regional Manager (rm_email)</option>
            <option value="am_email">Regional Director (am_email)</option>
          </select>
          <span className="mt-1 block text-[0.65rem] text-splash-navy/60">
            Requires a Location field on the form so the worker can resolve the
            submission's site.
          </span>
        </label>
      )}

      {p.source.type === "static_emails" && (
        <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Approver emails (one per line)
          <textarea
            value={p.source.emails.join("\n")}
            onChange={(e) =>
              p.onChange({
                type: "static_emails",
                emails: e.currentTarget.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
              })
            }
            rows={2}
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-normal text-splash-navy"
          />
        </label>
      )}

      {p.source.type === "payload_field" && (
        <label className="block text-[0.65rem] font-semibold uppercase tracking-wide text-splash-navy/70">
          Email field on this form
          <select
            value={p.source.field_key}
            onChange={(e) =>
              p.onChange({
                type: "payload_field",
                field_key: e.currentTarget.value
              })
            }
            className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-sm font-normal text-splash-navy"
          >
            <option value="">— Pick a field —</option>
            {p.emailFieldKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          {p.emailFieldKeys.length === 0 && (
            <span className="mt-1 block text-[0.65rem] text-racecar-red">
              No Email fields on this form yet.
            </span>
          )}
        </label>
      )}
    </div>
  );
}

interface TransitionEditorProps {
  transition: WorkflowTransition;
  currentStageId: string;
  allStages: WorkflowStage[];
  onUpdate: (patch: Partial<WorkflowTransition>) => void;
  onRemove: () => void;
}

function TransitionEditor(p: TransitionEditorProps) {
  const req = p.transition.requires ?? {};
  const isSelfTransition = p.transition.to === p.currentStageId;
  return (
    <div className="space-y-1 rounded-splash-sm border border-gray-light bg-white p-2">
      <div className="flex items-start justify-between gap-2">
        <select
          value={p.transition.to}
          onChange={(e) => p.onUpdate({ to: e.currentTarget.value })}
          className={`flex-1 rounded-splash-sm border bg-white px-2 py-1 text-xs font-normal text-splash-navy ${
            isSelfTransition ? "border-racecar-red" : "border-gray-light"
          }`}
        >
          <option value="">→ destination stage</option>
          {p.allStages.map((s) => {
            const isCurrent = s.id === p.currentStageId;
            return (
              <option
                key={s._uiKey ?? s.id}
                value={s.id}
                disabled={isCurrent}
              >
                {isCurrent
                  ? `${s.label || s.id} (current — cannot self-transition)`
                  : `→ ${s.label || s.id}`}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={p.onRemove}
          className="rounded-splash-sm border border-racecar-red/40 px-1.5 text-[0.65rem] text-racecar-red hover:bg-racecar-red/10"
          title="Remove transition"
        >
          ×
        </button>
      </div>
      {isSelfTransition && (
        <p className="text-[0.65rem] text-racecar-red">
          This transition points to the current stage. Pick a different
          destination or remove this transition.
        </p>
      )}
      <input
        type="text"
        value={p.transition.label}
        onChange={(e) => p.onUpdate({ label: e.currentTarget.value })}
        placeholder="e.g. Approve, Decline, Send back"
        className="w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-xs font-normal text-splash-navy"
      />
      <div className="flex flex-wrap gap-2 text-[0.65rem] text-splash-navy">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!req.note}
            onChange={(e) =>
              p.onUpdate({
                requires: { ...req, note: e.currentTarget.checked || undefined }
              })
            }
          />
          Note
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!req.typed_name}
            onChange={(e) =>
              p.onUpdate({
                requires: {
                  ...req,
                  typed_name: e.currentTarget.checked || undefined
                }
              })
            }
          />
          Typed name
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!req.signature}
            onChange={(e) =>
              p.onUpdate({
                requires: {
                  ...req,
                  signature: e.currentTarget.checked || undefined
                }
              })
            }
          />
          Signature
        </label>
      </div>
    </div>
  );
}
