"use client";

// "Your name" for every IT-issue action. Users are not mapped to people (sites
// share logins), so the name is typed each time -- and remembered in this
// browser so it only has to be typed once. Convenience only: storage can be
// blocked, and the field then simply starts empty.

import { useEffect, useState } from "react";

const KEY = "itIssues.actorName";

export function NameInput({ className, label = "Your name" }: { className?: string; label?: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    try {
      setValue(localStorage.getItem(KEY) ?? "");
    } catch {
      // storage unavailable -- leave it blank
    }
  }, []);
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-semibold text-splash-navy">{label}</span>
      <input
        name="actor_name"
        required
        maxLength={80}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          try {
            localStorage.setItem(KEY, e.target.value);
          } catch {
            // ignore
          }
        }}
        className={className ?? "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm"}
      />
    </label>
  );
}
