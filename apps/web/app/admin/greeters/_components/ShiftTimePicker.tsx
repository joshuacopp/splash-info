"use client";

// Hour / minute / AM-PM shift time picker.
//
// Three native <select>s rather than <input type="time">. The native time input
// renders differently in every browser (Safari has no keyboard fallback,
// Firefox's spinner is fiddly on touch) and on a phone it opens a wheel the
// user has to fight. Three selects scroll predictably everywhere and are
// keyboard-searchable — typing "4" jumps to 4.
//
// The visible controls are 12-hour because that's how a shift gets said out
// loud; the hidden input carries 24-hour HH:MM, which is what Postgres `time`
// wants. Nothing 12-hour reaches the worker.
//
// PARTIAL STATE IS PREVENTED, NOT VALIDATED: picking an hour auto-fills minute
// "00" and AM/PM, so the three selects can never disagree about whether a time
// was entered. A half-filled time would serialize to an empty hidden value and
// silently drop the shift, which the user would have no way to notice.

import { useState } from "react";

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const selectCls =
  "rounded-splash-sm border border-gray-light bg-white px-2 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none";

/** 12-hour parts -> "HH:MM" 24-hour. Midnight is 12 AM -> 00, noon 12 PM -> 12. */
function to24h(hour: string, minute: string, meridiem: string): string {
  if (!hour || !minute || !meridiem) return "";
  let h = Number(hour);
  if (meridiem === "AM" && h === 12) h = 0;
  else if (meridiem === "PM" && h !== 12) h += 12;
  return `${String(h).padStart(2, "0")}:${minute}`;
}

export function ShiftTimePicker({
  name,
  label
}: {
  name: string;
  label: string;
}) {
  const [hour, setHour] = useState("");
  const [minute, setMinute] = useState("");
  const [meridiem, setMeridiem] = useState("");

  const value = to24h(hour, minute, meridiem);

  function pickHour(next: string) {
    setHour(next);
    if (!next) {
      // Clearing the hour clears the whole time — the other two alone mean
      // nothing, and leaving them set would look like a time was entered.
      setMinute("");
      setMeridiem("");
      return;
    }
    if (!minute) setMinute("00");
    if (!meridiem) setMeridiem("AM");
  }

  return (
    <div className="flex flex-col gap-1">
      <span className={labelCls}>{label}</span>
      <div className="flex items-center gap-1.5">
        <select
          aria-label={`${label} hour`}
          value={hour}
          onChange={(e) => pickHour(e.target.value)}
          className={selectCls}
        >
          <option value="">--</option>
          {HOURS.map((h) => (
            <option key={h} value={String(h)}>
              {h}
            </option>
          ))}
        </select>
        <span className="text-sm font-semibold text-splash-navy/50">:</span>
        <select
          aria-label={`${label} minute`}
          value={minute}
          onChange={(e) => setMinute(e.target.value)}
          disabled={!hour}
          className={`${selectCls} disabled:bg-gray-50 disabled:text-splash-navy/40`}
        >
          <option value="">--</option>
          {MINUTES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} AM or PM`}
          value={meridiem}
          onChange={(e) => setMeridiem(e.target.value)}
          disabled={!hour}
          className={`${selectCls} disabled:bg-gray-50 disabled:text-splash-navy/40`}
        >
          <option value="">--</option>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </div>
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
