"use client";

// Brief 149 — Initial tool grants + conditional DC Role picker for the
// Create User card.
//
// The Create User form previously wrote only auth.users + user_permissions
// + user_tool_access rows. When the operator checked `claims`, the new user
// signed in fine but hit "no access" on /admin/damage because the damage
// gate (constraint #5 / Brief 71) reads session.dcRole + session.dcLocations
// off `damage_claim_user_roles` + `damage_claim_user_locations` — neither
// was populated until the operator separately used the Set DC Role card.
//
// This island owns one piece of state — whether the `claims` checkbox is
// checked — so the DC Role picker conditionally renders directly beneath
// the tool grants. The picker is HTML5-required when visible, so submitting
// without picking a DC role surfaces the browser's native validation
// bubble. When `claims` is unchecked the picker disappears and dc_role is
// NOT included in FormData, so the existing Create User code path is
// unchanged (no DC writes, no regression for non-claims users).
//
// The Locations field higher up in the form serves as the dc_locations
// source when dc_role is gm/rm — no second picker per the operator's
// directive in the brief. createUserAction reads location_codes once and
// forwards the whole array to both worker calls (2026-08-17: it was a
// single location_code, so a GM with six sites got dc_locations for one).

import { useState, type ChangeEvent } from "react";
import { FieldLabel, inputClass } from "./OperationCard";
import { TOOL_HELP } from "./tools";

type DcRoleValue = "" | "gm" | "rm" | "admin" | "super_admin";

export function CreateUserToolsAndDcRole() {
  const [claimsChecked, setClaimsChecked] = useState(false);
  const [dcRole, setDcRole] = useState<DcRoleValue>("");

  function onClaimsToggle(e: ChangeEvent<HTMLInputElement>) {
    setClaimsChecked(e.target.checked);
  }

  return (
    <>
      <fieldset>
        <FieldLabel htmlFor="create-tools-pricing" helper="Multi-select">
          Initial tool grants
        </FieldLabel>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
            <input
              id="create-tools-pricing"
              type="checkbox"
              name="tools"
              value="pricing"
            />
            pricing
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
            <input
              id="create-tools-claims"
              type="checkbox"
              name="tools"
              value="claims"
              checked={claimsChecked}
              onChange={onClaimsToggle}
            />
            claims
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
            <input type="checkbox" name="tools" value="pertrack" />
            pertrack
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
            <input type="checkbox" name="tools" value="form_submissions" />
            form_submissions
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
            <input type="checkbox" name="tools" value="schedule" />
            schedule
          </label>
          {/* Chemical inventory is three nested tiers — tick ONE. `claims` is
              still hand-written above because it owns the DC-role state; the
              rest stay literal to match. */}
          <label
            className="inline-flex items-center gap-2 text-sm text-splash-navy"
            title={TOOL_HELP.inventory_view}
          >
            <input type="checkbox" name="tools" value="inventory_view" />
            inventory_view
          </label>
          <label
            className="inline-flex items-center gap-2 text-sm text-splash-navy"
            title={TOOL_HELP.inventory}
          >
            <input type="checkbox" name="tools" value="inventory" />
            inventory
          </label>
          <label
            className="inline-flex items-center gap-2 text-sm text-splash-navy"
            title={TOOL_HELP.inventory_admin}
          >
            <input type="checkbox" name="tools" value="inventory_admin" />
            inventory_admin
          </label>
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-splash-navy/60">
          Chemical inventory has three tiers — view is read-only, inventory can
          submit visits, admin can also edit products and recipients. Tick one.
        </p>
        {claimsChecked ? (
          <p className="mt-1.5 text-[0.6875rem] text-splash-navy/60">
            Claims access also requires a DC role — pick one below.
          </p>
        ) : null}
      </fieldset>

      {claimsChecked ? (
        <div>
          <FieldLabel
            htmlFor="create-dc-role"
            helper="Required when claims is granted"
          >
            DC Role
          </FieldLabel>
          <select
            id="create-dc-role"
            name="dc_role"
            value={dcRole}
            onChange={(e) => setDcRole(e.target.value as DcRoleValue)}
            required
            className={inputClass}
          >
            <option value="">— Pick a DC role for claims access —</option>
            <option value="gm">gm</option>
            <option value="rm">rm</option>
            <option value="admin">admin</option>
            <option value="super_admin">super_admin</option>
          </select>
          {dcRole === "gm" || dcRole === "rm" ? (
            <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
              dc_locations will be set to the Location picked above.
            </p>
          ) : null}
          {dcRole === "admin" || dcRole === "super_admin" ? (
            <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
              super_admin and admin bypass location scoping — no locations
              stored.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
