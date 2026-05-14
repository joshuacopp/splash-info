// Brief 125 — workflow notifications panel.
//
// Three trigger groups with user-language checkboxes. The "Sent via
// Power Automate (admin-managed)" subtitle is the only infrastructure
// hint operators see. No mention of secrets, webhook URLs, or PA flow
// IDs anywhere on this surface.

"use client";

import type { WorkflowNotifications } from "@splash/forms-schema";

interface Props {
  notifications: WorkflowNotifications | undefined;
  onChange: (patch: Partial<WorkflowNotifications>) => void;
}

const DEFAULTS = {
  notify_approver_on_assignment: true,
  notify_submitter_on_outcome: true,
  notify_approvers_on_outcome: false
} satisfies Required<WorkflowNotifications>;

export default function NotificationsPanel({
  notifications,
  onChange
}: Props) {
  const n = { ...DEFAULTS, ...(notifications ?? {}) };
  return (
    <section className="space-y-3 rounded-splash-md border border-gray-light bg-white p-4">
      <header>
        <h3 className="text-base font-bold text-splash-navy">Notifications</h3>
        <p className="text-xs text-splash-navy/60">
          Sent via Power Automate (admin-managed).
        </p>
      </header>

      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-splash-navy">
          When a step gets a new approver
        </legend>
        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input
            type="checkbox"
            checked={n.notify_approver_on_assignment}
            onChange={(e) =>
              onChange({
                notify_approver_on_assignment: e.currentTarget.checked
              })
            }
            className="mt-0.5 h-4 w-4"
          />
          <span>
            Email the approver
            <span className="block text-xs text-splash-navy/60">
              "You have a new item to review."
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-splash-navy">
          When the workflow reaches an outcome
        </legend>
        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input
            type="checkbox"
            checked={n.notify_submitter_on_outcome}
            onChange={(e) =>
              onChange({
                notify_submitter_on_outcome: e.currentTarget.checked
              })
            }
            className="mt-0.5 h-4 w-4"
          />
          <span>
            Email the submitter
            <span className="block text-xs text-splash-navy/60">
              "Your submission was {"{outcome}"}."
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input
            type="checkbox"
            checked={n.notify_approvers_on_outcome}
            onChange={(e) =>
              onChange({
                notify_approvers_on_outcome: e.currentTarget.checked
              })
            }
            className="mt-0.5 h-4 w-4"
          />
          <span>Email each approver who acted on it</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-splash-navy/50">
          <input
            type="checkbox"
            disabled
            className="mt-0.5 h-4 w-4"
            aria-disabled="true"
          />
          <span>
            Attach a PDF of the completed form with all approvals
            <span className="ml-2 inline-flex items-center rounded-full bg-slate-100 px-1.5 text-[0.6rem] font-bold uppercase tracking-wide text-slate-600">
              v2
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-splash-navy">
          Already running
        </legend>
        <p className="text-xs text-splash-navy/70">
          Daily digest of pending items per approver — configured
          globally; no per-form opt-out.
        </p>
      </fieldset>
    </section>
  );
}
