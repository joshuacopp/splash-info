"use client";

// Brief 61 — DC role select + Locations multi-picker bound together.
//
// Server-rendered <SetDcRoleCard> hands the LocationCodeMultiPicker into
// this small client wrapper as a `locationPicker` prop so the picker
// itself stays a server-island boundary. The wrapper owns a single piece
// of state — the chosen dc_role — so it can show/hide the locations
// section + the inline hint without needing a parent client component.
//
// Conditional UX (per Brief 61 §4.1):
//   - role === "" (none/clear): hide locations; hint "This will revoke
//     all /admin/damage access."
//   - role === "super_admin" | "admin": hide locations; hint
//     "super_admin and admin bypass location scoping — no locations
//     needed."
//   - role === "gm" | "rm": render the locations picker.
//
// Worker re-validates regardless — UI gating is a UX hint, not access
// control.

import { useState, type ReactNode } from "react";
import { FieldLabel, inputClass } from "./OperationCard";

export type DcRoleValue =
  | ""
  | "gm"
  | "rm"
  | "admin"
  | "super_admin";

export function SetDcRoleFields({
  selectId,
  locationPicker
}: {
  selectId: string;
  locationPicker: ReactNode;
}) {
  const [role, setRole] = useState<DcRoleValue>("");
  const showLocations = role === "gm" || role === "rm";

  return (
    <>
      <div>
        <FieldLabel htmlFor={selectId}>DC Role</FieldLabel>
        <select
          id={selectId}
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value as DcRoleValue)}
          className={inputClass}
        >
          <option value="">— Clear access (no DC role) —</option>
          <option value="gm">gm</option>
          <option value="rm">rm</option>
          <option value="admin">admin</option>
          <option value="super_admin">super_admin</option>
        </select>
        {role === "" ? (
          <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
            This will revoke all /admin/damage access.
          </p>
        ) : null}
        {role === "admin" || role === "super_admin" ? (
          <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
            super_admin and admin bypass location scoping — no locations
            needed.
          </p>
        ) : null}
      </div>

      {showLocations ? (
        <div>
          <FieldLabel
            htmlFor="set-dc-role-locations"
            helper="Required for gm/rm — pick one or more"
          >
            Locations
          </FieldLabel>
          {locationPicker}
        </div>
      ) : null}
    </>
  );
}
