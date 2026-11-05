"use client";

// "When did it happen?" plus the optional customer references. Shared by the
// report form and "It happened again", so both ask the same way.

import { useEffect, useState } from "react";
import { etLocalInput } from "../_lib/types";

export function OccurrenceFields({ inputClass, labelClass }: { inputClass: string; labelClass: string }) {
  // Filled in after mount: the server's "now" and the browser's would differ
  // and break hydration. Left blank (no JS yet), the worker uses now anyway.
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
        <label className={labelClass} htmlFor="occurred_at">When did it happen?</label>
        <input
          id="occurred_at"
          name="occurred_at"
          type="datetime-local"
          required
          value={when}
          max={max}
          onChange={(e) => setWhen(e.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-splash-navy/60">Eastern time. Change it if you&apos;re logging this after the fact.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="customer_ticket_no">Customer ticket # (optional)</label>
          <input id="customer_ticket_no" name="customer_ticket_no" maxLength={60} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="customer_account_no">Customer account # (optional)</label>
          <input id="customer_account_no" name="customer_account_no" maxLength={60} className={inputClass} />
        </div>
      </div>
    </div>
  );
}
