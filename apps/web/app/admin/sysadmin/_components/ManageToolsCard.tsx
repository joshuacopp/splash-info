"use client";

// Brief 173, phase 1 — Manage tools.
//
// Replaces the Grant tool / Revoke tool pair. Those cards were one tool per
// submit, so putting a new regional manager on pricing + claims + schedule +
// inventory + pertrack meant five submits and five re-picks of the same
// person. This card is desired-state: pick the user once, check the tools
// they should end up with, submit once.
//
// The checkboxes are prefilled from the typeahead row the operator picked
// (UserPicker's onSelect, added in this brief). That row is a snapshot, so
// it is display state only — the worker re-reads live state at write time
// and diffs against that, and 409s if the snapshot has drifted. The
// snapshot rides along as `expect_tools` to make that check possible.
//
// resetOnSuccess is off deliberately. The stock behaviour remounts the form
// and clears every field, which is right for one-shot cards but wrong here:
// after saving you want to still be looking at the user you just edited.
// Instead the baseline re-syncs to what was saved, so the diff line goes
// quiet and further edits stay possible without re-picking.

import { useState } from "react";
import { ActionForm, type ActionResult } from "../../_components/ActionForm";
import { FieldLabel, submitClass } from "./OperationCard";
import { UserPicker, type SelectedUser } from "./UserPicker";
import { setToolAccessAction } from "../actions";

const ALL_TOOLS = [
  "pricing",
  "claims",
  "pertrack",
  "form_submissions",
  "schedule",
  "inventory"
] as const;

type Tool = (typeof ALL_TOOLS)[number];

/** What each grant actually opens up, in operator terms. */
const TOOL_HELP: Record<Tool, string> = {
  pricing: "Pricing admin",
  claims: "Damage claims — also needs a DC role",
  pertrack: "Greeter scorecard",
  form_submissions: "Form submissions viewer — also needs locations",
  schedule: "Scheduling",
  inventory: "Chemical inventory"
};

function sortTools(tools: readonly string[]): string[] {
  return ALL_TOOLS.filter((t) => tools.includes(t));
}

export function ManageToolsCard() {
  const [selected, setSelected] = useState<SelectedUser | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<string[]>([]);

  function onSelectUser(user: SelectedUser | null) {
    setSelected(user);
    const current = sortTools(user?.tools ?? []);
    setChecked(current);
    setBaseline(current);
  }

  function toggle(tool: Tool, isChecked: boolean) {
    setChecked((prev) =>
      isChecked ? sortTools([...prev, tool]) : prev.filter((t) => t !== tool)
    );
  }

  // Re-sync the baseline on a successful save so the diff line clears and a
  // second edit in the same sitting diffs from what's actually stored now.
  function onResult(result: ActionResult) {
    if (result.ok) setBaseline(checked);
  }

  const added = checked.filter((t) => !baseline.includes(t));
  const removed = baseline.filter((t) => !checked.includes(t));
  const dirty = added.length > 0 || removed.length > 0;

  // Claims without a DC role signs in fine and then hits "no access" on
  // /admin/damage — the damage gate reads dc_role/dc_locations, which live in
  // a different table this card doesn't write. Phase 2 folds that in; until
  // then, point at the card that does it.
  const claimsNeedsDcRole = added.includes("claims");

  return (
    <ActionForm
      action={setToolAccessAction}
      className="space-y-4"
      resetOnSuccess={false}
      onResult={onResult}
    >
      <div>
        <FieldLabel htmlFor="manage-tools-user" helper="Search by email">
          User
        </FieldLabel>
        <UserPicker
          name="user_id"
          inputId="manage-tools-user"
          required
          onSelect={onSelectUser}
        />
      </div>

      <fieldset disabled={selected === null}>
        <FieldLabel
          htmlFor="manage-tools-pricing"
          helper={
            selected === null
              ? "Pick a user first"
              : "Checked = what they should end up with"
          }
        >
          Tools
        </FieldLabel>
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {ALL_TOOLS.map((tool) => (
            <label
              key={tool}
              className="inline-flex items-start gap-2 text-sm text-splash-navy"
            >
              <input
                id={`manage-tools-${tool}`}
                type="checkbox"
                name="tools"
                value={tool}
                checked={checked.includes(tool)}
                onChange={(e) => toggle(tool, e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {tool}
                <span className="block text-[0.6875rem] text-splash-navy/60">
                  {TOOL_HELP[tool]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* The snapshot the checkboxes were rendered from. The worker compares
          it to live state and refuses the write if it has drifted. */}
      <input type="hidden" name="expect_tools" value={JSON.stringify(baseline)} />

      {selected !== null ? (
        <p className="text-xs text-splash-navy/70">
          {dirty ? (
            <>
              {added.length > 0 ? <>Granting {added.join(", ")}. </> : null}
              {removed.length > 0 ? <>Revoking {removed.join(", ")}.</> : null}
            </>
          ) : (
            <>No changes — this matches what {selected.email} has now.</>
          )}
        </p>
      ) : null}

      {claimsNeedsDcRole ? (
        <p className="text-xs text-splash-navy/70">
          Claims access also needs a DC role — set one with the Set DC Role
          card, or the user will hit &ldquo;no access&rdquo; on /admin/damage.
        </p>
      ) : null}

      <div className="pt-1">
        <button
          type="submit"
          className={submitClass}
          disabled={selected === null || !dirty}
        >
          Save tool access
        </button>
      </div>
    </ActionForm>
  );
}
