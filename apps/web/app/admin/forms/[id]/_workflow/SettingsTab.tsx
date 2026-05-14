// Brief 125 — Settings tab.
//
// Houses form-level meta editors (title, description, audience,
// notify_webhook, turnstile_required, success_message) that used to live
// in the right-panel Inspector. Persistence beyond `schema.fields` +
// `schema.workflow` is currently client-only (Brief 95 limitation —
// `PATCH /draft` only handles schema). The Save Draft button on the
// TopBar still works but won't persist these widgets until a future
// brief widens the worker endpoint.

"use client";

import type { FormMetaState } from "../_builder/reducer";

interface Props {
  formMeta: FormMetaState;
  onUpdate: (patch: Partial<FormMetaState>) => void;
}

export default function SettingsTab({ formMeta, onUpdate }: Props) {
  return (
    <section className="space-y-4 rounded-splash-md border border-gray-light bg-white p-5">
      <header className="border-b border-gray-light pb-2">
        <h2 className="text-lg font-bold text-splash-navy">Form settings</h2>
        <p className="mt-1 text-xs text-splash-navy/60">
          These widgets persist alongside the form. Title and slug appear
          on the public form; audience controls who can submit.
        </p>
      </header>

      <label className="block text-sm font-semibold text-splash-navy">
        Title
        <input
          type="text"
          value={formMeta.title}
          onChange={(e) => onUpdate({ title: e.currentTarget.value })}
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>

      <label className="block text-sm font-semibold text-splash-navy">
        Description
        <textarea
          rows={3}
          value={formMeta.description ?? ""}
          onChange={(e) =>
            onUpdate({ description: e.currentTarget.value || null })
          }
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>

      <label className="block text-sm font-semibold text-splash-navy">
        Audience
        <select
          value={formMeta.audience}
          onChange={(e) =>
            onUpdate({
              audience: e.currentTarget.value as FormMetaState["audience"]
            })
          }
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm font-normal text-splash-navy"
        >
          <option value="public">Public — anyone with the link</option>
          <option value="internal">Internal — Splash sign-in required</option>
          <option value="link-only">Link-only — anyone with the URL</option>
        </select>
      </label>

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={formMeta.notifyWebhook}
          onChange={(e) => onUpdate({ notifyWebhook: e.currentTarget.checked })}
          className="mt-0.5 h-4 w-4"
        />
        <span className="flex-1 font-semibold">
          Send a webhook on every submission
          <span className="mt-0.5 block text-xs font-normal text-splash-navy/60">
            Fires the form's submission webhook to Power Automate. Independent
            of approval-flow notifications.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={formMeta.turnstileRequired}
          onChange={(e) =>
            onUpdate({ turnstileRequired: e.currentTarget.checked })
          }
          className="mt-0.5 h-4 w-4"
        />
        <span className="flex-1 font-semibold">
          Require Turnstile bot challenge (public audience only)
        </span>
      </label>

      <label className="block text-sm font-semibold text-splash-navy">
        Success message
        <textarea
          rows={2}
          value={formMeta.successMessage ?? ""}
          onChange={(e) =>
            onUpdate({ successMessage: e.currentTarget.value || null })
          }
          placeholder="Optional. Default: 'Submitted — thanks!'"
          className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm font-normal text-splash-navy"
        />
      </label>
    </section>
  );
}
