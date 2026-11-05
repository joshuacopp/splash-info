"use client";

// The POS provider's own tech support (Micrologic, DRB, ICS) -- NOT Splash's
// internal IT support. The report form asks whether a ticket has been opened
// with them; the issue page logs each later call. IT sees both.

import { useEffect, useState } from "react";
import { POS_PROVIDERS, etLocalInput } from "../_lib/types";

const hint = "mt-1 text-xs text-splash-navy/60";

/** Provider, when they were called, and their ticket #. */
export function ProviderContactFields({
  inputClass,
  labelClass,
  requireTicket,
  defaultProvider,
  idPrefix = "pos"
}: {
  inputClass: string;
  labelClass: string;
  requireTicket: boolean;
  defaultProvider?: string | null;
  idPrefix?: string;
}) {
  // Filled in after mount so server and browser agree on the first render.
  const [when, setWhen] = useState("");
  const [max, setMax] = useState<string | undefined>(undefined);
  useEffect(() => {
    const now = etLocalInput();
    setWhen(now);
    setMax(now);
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`${idPrefix}_provider`}>POS provider</label>
        <input
          id={`${idPrefix}_provider`}
          name="pos_provider"
          list={`${idPrefix}_providers`}
          required
          maxLength={60}
          defaultValue={defaultProvider ?? ""}
          placeholder="Micrologic, DRB, ICS…"
          className={inputClass}
        />
        <datalist id={`${idPrefix}_providers`}>
          {POS_PROVIDERS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`${idPrefix}_called_at`}>When did you call them?</label>
          <input
            id={`${idPrefix}_called_at`}
            name="pos_provider_called_at"
            type="datetime-local"
            required
            value={when}
            max={max}
            onChange={(e) => setWhen(e.target.value)}
            className={inputClass}
          />
          <p className={hint}>Eastern time.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${idPrefix}_ticket_no`}>
            Their ticket #{requireTicket ? "" : " (if new or different)"}
          </label>
          <input
            id={`${idPrefix}_ticket_no`}
            name="pos_provider_ticket_no"
            required={requireTicket}
            maxLength={60}
            className={inputClass}
          />
        </div>
      </div>
    </div>
  );
}

/** The report-form question, with the call details asked only on "Yes". */
export function ProviderQuestion({ inputClass, labelClass }: { inputClass: string; labelClass: string }) {
  const [answer, setAnswer] = useState<"" | "yes" | "no">("");
  return (
    <fieldset className="space-y-3">
      <legend className={labelClass}>
        Has a ticket been opened with the POS provider? (e.g. Micrologic, DRB, ICS)
      </legend>
      <p className="-mt-2 text-xs text-splash-navy/60">
        The POS company&apos;s own tech support - not our IT support.
      </p>
      <div className="flex gap-5 text-sm text-splash-navy">
        {(["yes", "no"] as const).map((v) => (
          <label key={v} className="inline-flex items-center gap-2">
            <input type="radio" name="pos_provider_opened" value={v} required checked={answer === v} onChange={() => setAnswer(v)} />
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </div>
      {answer === "yes" && <ProviderContactFields inputClass={inputClass} labelClass={labelClass} requireTicket />}
    </fieldset>
  );
}
