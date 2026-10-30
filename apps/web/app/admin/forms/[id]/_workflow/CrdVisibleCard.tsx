// "Visible to CRD" switch for a form. Admin-tier only; the worker re-checks.
//
// On: every CRD agent and supervisor reads this form's submissions at the
// sites they cover in crd_site_coverage -- agents their own sites, supervisors
// their region plus uncovered sites. Read live, so reassigning a site moves
// visibility with no per-user grants to maintain. Same rule as JotForm and
// MaxPass.
//
// Saves immediately, like the access tag card beside it, because it is an
// access control rather than part of the draft.

"use client";

import { useState, useTransition } from "react";

import { setCrdVisibleAction } from "../actions";

interface Props {
  formId: string;
  initialVisible: boolean;
}

export default function CrdVisibleCard({ formId, initialVisible }: Props) {
  const [visible, setVisible] = useState(initialVisible);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(next: boolean) {
    if (pending) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setCrdVisibleAction(formId, next);
      if (res.ok) {
        setVisible(res.crd_visible);
        setMsg({
          ok: true,
          text: res.crd_visible
            ? "On. CRD can now see this form's submissions for the sites they cover."
            : "Off. CRD no longer sees this form's submissions."
        });
      } else {
        setMsg({
          ok: false,
          text: res.error.includes("form_not_location_scoped")
            ? "This form doesn't record a site, so CRD access can't be limited to their sites. Add a location field first."
            : res.error
        });
      }
    });
  }

  return (
    <section className="space-y-3 rounded-splash-md border border-amber-300 bg-amber-50/40 p-5">
      <header>
        <h2 className="text-lg font-bold text-splash-navy">Visible to CRD</h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          CRD agents see submissions from the sites assigned to them;
          supervisors see their whole region plus sites with no CRD assigned.
          Follows CRD site assignments automatically.
        </p>
        <p className="mt-1 text-[0.6875rem] font-semibold text-amber-800">
          Saves immediately — not on Save Draft.
        </p>
      </header>

      <label className="flex items-center gap-2 text-sm font-semibold text-splash-navy">
        <input
          type="checkbox"
          checked={visible}
          disabled={pending}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4"
        />
        {pending ? "Saving…" : "CRD can see this form's submissions"}
      </label>

      {msg && (
        <p
          role="status"
          className={msg.ok ? "text-xs text-splash-navy/80" : "text-xs text-racecar-red"}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
