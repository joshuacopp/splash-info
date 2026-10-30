// "Who can fill this out" for an internal form. Admin-tier only; the worker
// re-checks. Enforced by forms-worker on the /forms list, the form page AND
// submit (see apps/forms-worker/src/fill-audience.ts), so this is real access
// control, not just hiding a card.
//
// Nothing ticked = everyone signed in. Admins can always fill every form.
// Groups come from the email columns on each location (sysadmin → Update
// location), read live -- no per-user upkeep, no sign-out needed.
//
// Saves immediately, like the access tag and CRD cards beside it.

"use client";

import { useState, useTransition } from "react";

import { setFillAudienceAction } from "../actions";

type Group = "site" | "rm" | "rd" | "tag";

const OPTIONS: { value: Group; label: string; hint: string }[] = [
  { value: "site", label: "Site accounts", hint: "Site email on a location" },
  { value: "rm", label: "Regional Managers", hint: "RM email on a location" },
  { value: "rd", label: "Regional Directors", hint: "RD (area manager) email on a location" },
  { value: "tag", label: "People granted this form's access tag", hint: "Granted per person in sysadmin" }
];

interface Props {
  formId: string;
  initialAudience: string[];
  accessTag: string | null;
}

export default function FillAudienceCard({ formId, initialAudience, accessTag }: Props) {
  const [audience, setAudience] = useState<Group[]>(
    initialAudience.filter((v): v is Group => OPTIONS.some((o) => o.value === v))
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(value: Group, on: boolean) {
    if (pending) return;
    const next = on ? [...audience, value] : audience.filter((v) => v !== value);
    setMsg(null);
    startTransition(async () => {
      const res = await setFillAudienceAction(formId, next);
      if (res.ok) {
        setAudience(res.fill_audience as Group[]);
        setMsg({
          ok: true,
          text:
            res.fill_audience.length === 0
              ? "Saved. Everyone signed in can fill this out."
              : "Saved. Only the ticked groups (and admins) can see and fill this out."
        });
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  const tagWithoutTag = audience.includes("tag") && !accessTag;

  return (
    <section className="space-y-3 rounded-splash-md border border-gray-light bg-white p-5">
      <header>
        <h2 className="text-lg font-bold text-splash-navy">Who can fill this out</h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Leave everything unticked to let anyone signed in fill it out. Admins can always.
          People outside the ticked groups won&rsquo;t see it on the Forms page and can&rsquo;t
          open it by link.
        </p>
        <p className="mt-1 text-[0.6875rem] font-semibold text-amber-800">
          Saves immediately — not on Save Draft.
        </p>
      </header>

      <div className="space-y-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-splash-navy">
            <input
              type="checkbox"
              checked={audience.includes(o.value)}
              disabled={pending}
              onChange={(e) => toggle(o.value, e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="font-semibold">{o.label}</span>
              <span className="block text-xs text-splash-navy/60">
                {o.value === "tag" && accessTag ? `Tag: ${accessTag}. ` : ""}
                {o.hint}
              </span>
            </span>
          </label>
        ))}
      </div>

      {tagWithoutTag && (
        <p className="text-xs text-racecar-red">
          This form has no access tag yet, so nobody but admins gets in through this option.
          Set a tag in the Access tag card above (then reload this page).
        </p>
      )}

      {msg && (
        <p
          role="status"
          className={msg.ok ? "text-xs text-splash-navy/80" : "text-xs text-racecar-red"}
        >
          {pending ? "Saving…" : msg.text}
        </p>
      )}
    </section>
  );
}
