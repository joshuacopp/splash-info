// Brief 125 — Settings tab.
//
// Form-level settings (title, description, audience, webhook, Turnstile,
// success message). 2026-11-14: these now SAVE, through their own "Save
// settings" button (PATCH .../settings) -- before, they were edited in the
// browser only and had to be set by SQL. They live on the forms row, not the
// versioned schema, so they take effect at once, without a republish. Two
// settings that were SQL-only are here too: Confidential (submissions not tied
// to a site) and Test mode (every workflow email to one address).

"use client";

import { useState, useTransition } from "react";

import type { FormMetaState } from "../_builder/reducer";
import { saveFormSettingsAction } from "../actions";

import AccessTagCard from "./AccessTagCard";
import CrdVisibleCard from "./CrdVisibleCard";
import FillAudienceCard from "./FillAudienceCard";

interface Props {
  formMeta: FormMetaState;
  onUpdate: (patch: Partial<FormMetaState>) => void;
  formId: string;
  accessTag: string | null;
  crdVisible: boolean;
  fillAudience: string[];
  /** forms.scope_location_field_key; "none:confidential" = confidential. */
  scopeLocationFieldKey: string | null;
  /** forms.test_email_to; null = live. */
  testEmailTo: string | null;
  /** Default test address: the admin's own email. */
  myEmail: string | null;
}

const CONFIDENTIAL = "none:confidential";

export default function SettingsTab({
  formMeta,
  onUpdate,
  formId,
  accessTag,
  crdVisible,
  fillAudience,
  scopeLocationFieldKey,
  testEmailTo,
  myEmail
}: Props) {
  const [confidential, setConfidential] = useState(scopeLocationFieldKey === CONFIDENTIAL);
  const [testOn, setTestOn] = useState(!!testEmailTo);
  const [testAddress, setTestAddress] = useState(testEmailTo ?? myEmail ?? "");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, startSaving] = useTransition();

  function save() {
    setStatus(null);
    startSaving(async () => {
      const r = await saveFormSettingsAction(formId, {
        title: formMeta.title,
        description: formMeta.description,
        audience: formMeta.audience,
        notify_webhook: formMeta.notifyWebhook,
        turnstile_required: formMeta.turnstileRequired,
        success_message: formMeta.successMessage,
        confidential,
        test_email_to: testOn ? testAddress.trim() || null : null
      });
      setStatus(
        r.ok
          ? { kind: "ok", text: "Settings saved. They apply right away, no republish needed." }
          : { kind: "error", text: r.error }
      );
    });
  }

  return (
    <div className="space-y-4">
    <section className="space-y-4 rounded-splash-md border border-gray-light bg-white p-5">
      <header className="border-b border-gray-light pb-2">
        <h2 className="text-lg font-bold text-splash-navy">Form settings</h2>
        <p className="mt-1 text-xs text-splash-navy/60">
          Saved with the button below and applied right away, without a
          republish. Title appears on the public form; audience controls who
          can submit.
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

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={confidential}
          onChange={(e) => setConfidential(e.currentTarget.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span className="flex-1 font-semibold">
          Confidential: don&apos;t tie submissions to a site
          <span className="mt-0.5 block text-xs font-normal text-splash-navy/60">
            For personnel forms. Site admins and location-scoped viewers never see these submissions; only admins
            and anyone given access to this form do. Off: publishing ties each submission to its site number.
          </span>
        </span>
      </label>

      <div className={`rounded-splash-sm border p-3 ${testOn ? "border-amber-400 bg-amber-50" : "border-gray-light"}`}>
        <label className="flex items-start gap-2 text-sm text-splash-navy">
          <input
            type="checkbox"
            checked={testOn}
            onChange={(e) => setTestOn(e.currentTarget.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span className="flex-1 font-semibold">
            Test mode
            <span className="mt-0.5 block text-xs font-normal text-splash-navy/60">
              Every email this form&apos;s workflow sends goes only to the address below, marked [TEST] and listing
              who it would have gone to. The form shows a TEST MODE banner. Turn off to go live.
            </span>
          </span>
        </label>
        {testOn ? (
          <input
            type="email"
            value={testAddress}
            onChange={(e) => setTestAddress(e.currentTarget.value)}
            placeholder="you@splashcarwashes.com"
            className="mt-2 w-full rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-light pt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-full bg-splash-navy px-5 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-navy/90 disabled:opacity-60"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
        {status ? (
          <span
            role={status.kind === "error" ? "alert" : "status"}
            className={`text-sm ${status.kind === "error" ? "text-red-700" : "text-emerald-700"}`}
          >
            {status.text}
          </span>
        ) : null}
      </div>
      </section>

      <AccessTagCard formId={formId} initialTag={accessTag} />

      <CrdVisibleCard formId={formId} initialVisible={crdVisible} />

      {/* Enforced only for internal forms; for public / link-only the link is
          the permission, so the card would promise something it can't do. */}
      {formMeta.audience === "internal" && (
        <FillAudienceCard
          formId={formId}
          initialAudience={fillAudience}
          accessTag={accessTag}
        />
      )}
    </div>
  );
}
