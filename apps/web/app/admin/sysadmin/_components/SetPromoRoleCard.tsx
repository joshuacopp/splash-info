// Brief 159 — Set Promo Role card. Seventh Manage Users card.
//
// Writes the promotions permission domain (promo_user_roles — single-
// scalar table; no companion locations table). Independent of
// user_permissions.role (Set Role card) and damage_claim_user_roles
// (Set DC Role card) — a user can be `location_admin` in user_permissions,
// `gm` in dc_role, AND `marketing` in promo_role; all three are
// independent permission domains and must be set separately.
//
// Server component shape mirrors the other Brief 7 user-mgmt cards. The
// role select is a plain <select> (no conditional sub-picker), so unlike
// Brief 61's SetDcRoleCard there's no separate `SetPromoRoleFields.tsx`
// client wrapper. A small inline script swaps the per-role hint copy on
// change via event delegation on document — same pattern as
// PASSWORD_MATCH_SCRIPT in ResetPasswordCard, which survives
// <ActionForm>'s post-success remount.
//
// Worker re-validates on POST as defense in depth — UI gating is a UX
// hint, not access control. Role copy is sourced from the role-by-role
// permission table in CLAUDE.md's "Promotions feature" glossary so the
// UI and docs stay in sync.

import { ActionForm } from "../../_components/ActionForm";
import {
  FieldLabel,
  OperationCard,
  inputClass,
  submitClass
} from "./OperationCard";
import { UserPicker } from "./UserPicker";
import { setPromoRoleAction } from "../actions";

// Inline browser-side script that swaps the per-role hint copy when the
// select changes. Event delegation on document survives <ActionForm>'s
// post-success remount (Brief 19 pattern; see PASSWORD_MATCH_SCRIPT in
// UserOperations.tsx for the prior art).
const PROMO_ROLE_HINT_SCRIPT = `
(function () {
  function update() {
    var sel = document.getElementById('set-promo-role-role');
    if (!sel) return;
    var value = sel.value;
    var hints = document.querySelectorAll('[data-promo-role-hint]');
    for (var i = 0; i < hints.length; i++) {
      var h = hints[i];
      h.hidden = h.getAttribute('data-promo-role-hint') !== value;
    }
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.id === 'set-promo-role-role') update();
  });
  // Also fire after ActionForm remounts the form on success — the input
  // event delegates the same listener; an initial pass on DOMContentLoaded
  // catches the first render.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', update);
  } else {
    update();
  }
})();
`;

export function SetPromoRoleCard() {
  return (
    <OperationCard
      title="Set Promo Role"
      description="Set or clear a user's promotions role on promo_user_roles. Independent of user_permissions.role and dc_role above."
    >
      <ActionForm action={setPromoRoleAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="set-promo-role-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker
            name="user_id"
            inputId="set-promo-role-user-id"
            required
          />
        </div>

        <div>
          <FieldLabel htmlFor="set-promo-role-role">Promo Role</FieldLabel>
          <select
            id="set-promo-role-role"
            name="role"
            defaultValue=""
            className={inputClass}
          >
            <option value="">— Clear access (no promo role) —</option>
            <option value="super_admin">super_admin</option>
            <option value="it">it</option>
            <option value="marketing">marketing</option>
            <option value="ops">ops</option>
          </select>

          {/* Per-role hint copy. The PROMO_ROLE_HINT_SCRIPT below shows
              the entry matching the current select value and hides the
              rest. Empty-value matches "" (the clear-access option). */}
          <p
            data-promo-role-hint=""
            className="mt-1 text-[0.6875rem] text-splash-navy/60"
          >
            This will revoke all /admin/promotions access.
          </p>
          <p
            data-promo-role-hint="super_admin"
            hidden
            className="mt-1 text-[0.6875rem] text-splash-navy/60"
          >
            Full read + write on every promotion.
          </p>
          <p
            data-promo-role-hint="it"
            hidden
            className="mt-1 text-[0.6875rem] text-splash-navy/60"
          >
            Full IT queue access + ticket edits + materials + announcements.
          </p>
          <p
            data-promo-role-hint="marketing"
            hidden
            className="mt-1 text-[0.6875rem] text-splash-navy/60"
          >
            Create + announce promotions; materials + PTP; read all.
          </p>
          <p
            data-promo-role-hint="ops"
            hidden
            className="mt-1 text-[0.6875rem] text-splash-navy/60"
          >
            Read-only access to all promotions.
          </p>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Set Promo Role
          </button>
        </div>
      </ActionForm>
      <script dangerouslySetInnerHTML={{ __html: PROMO_ROLE_HINT_SCRIPT }} />
    </OperationCard>
  );
}
