// Seven user-management cards. Brief 30 split this out from page.tsx as
// part of the two-mode hub restructure (Manage Users / Manage Tables).
//
// Cards (in order): Create user, Set role, Set DC Role (Brief 61), Set
// Promo Role (Brief 159), Grant tool, Revoke tool, Reset password. All
// wrap their forms in <ActionForm> and POST to /sysadmin/api/* via the
// actions in ../actions.ts. Brief 18 / 19 patterns intact (UserPicker +
// ActionForm).
//
// Set Role (user_permissions), Set DC Role (damage_claim_user_roles +
// damage_claim_user_locations), and Set Promo Role (promo_user_roles) are
// three independent permission domains — all must be set separately. Set
// DC Role and Set Promo Role are positioned right after Set Role for
// visual symmetry.

import { ActionForm } from "../../_components/ActionForm";
import {
  FieldLabel,
  OperationCard,
  inputClass,
  submitClass
} from "../_components/OperationCard";
import { CreateUserToolsAndDcRole } from "../_components/CreateUserToolsAndDcRole";
import { LocationCodePicker } from "../_components/LocationCodePicker";
import { SetDcRoleCard } from "../_components/SetDcRoleCard";
import { SetPromoRoleCard } from "../_components/SetPromoRoleCard";
import { UserPicker } from "../_components/UserPicker";
import {
  createUserAction,
  grantToolAction,
  resetPasswordAction,
  revokeToolAction,
  setRoleAction
} from "../actions";

export function UserOperations() {
  return (
    <>
      <CreateUserCard />
      <SetRoleCard />
      <SetDcRoleCard />
      <SetPromoRoleCard />
      <GrantToolCard />
      <RevokeToolCard />
      <ResetPasswordCard />
    </>
  );
}

/* ============================================================
 * 1. Create user
 * ============================================================ */

function CreateUserCard() {
  return (
    <OperationCard
      title="Create user"
      description="Provision a new auth.users row plus optional role + tool grants."
    >
      <ActionForm action={createUserAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="create-email">Email</FieldLabel>
          <input
            id="create-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            className={inputClass}
            placeholder="alice@splashcarwashes.com"
          />
        </div>

        <div>
          <FieldLabel
            htmlFor="create-password"
            helper="At least 8 characters"
          >
            Initial password
          </FieldLabel>
          <input
            id="create-password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            User will be flagged with must_change_password = true and prompted
            to reset on first sign-in.
          </p>
        </div>

        <div>
          <FieldLabel htmlFor="create-role" helper="Optional">
            Role
          </FieldLabel>
          <select
            id="create-role"
            name="role"
            defaultValue=""
            className={inputClass}
          >
            <option value="">— No role (auth user only) —</option>
            <option value="super_admin">super_admin</option>
            <option value="location_admin">location_admin</option>
          </select>
        </div>

        <div>
          <FieldLabel
            htmlFor="create-location-code"
            helper="Required for location_admin role; also used as dc_locations when DC role is gm/rm"
          >
            Location
          </FieldLabel>
          <LocationCodePicker
            name="location_code"
            inputId="create-location-code"
          />
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            Ignored for super_admin and no-role.
          </p>
        </div>

        <CreateUserToolsAndDcRole />

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Create user
          </button>
        </div>
      </ActionForm>
    </OperationCard>
  );
}

/* ============================================================
 * 2. Set role
 * ============================================================ */

function SetRoleCard() {
  return (
    <OperationCard
      title="Set role"
      description="Set or clear a user's role on user_permissions."
    >
      <ActionForm action={setRoleAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="set-role-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker name="user_id" inputId="set-role-user-id" required />
        </div>

        <div>
          <FieldLabel htmlFor="set-role-role">Role</FieldLabel>
          <select
            id="set-role-role"
            name="role"
            defaultValue=""
            className={inputClass}
          >
            <option value="">— Clear role —</option>
            <option value="super_admin">super_admin</option>
            <option value="location_admin">location_admin</option>
          </select>
        </div>

        <div>
          <FieldLabel
            htmlFor="set-role-location-code"
            helper="Required for location_admin role — search by site #, name, or code"
          >
            Location
          </FieldLabel>
          <LocationCodePicker
            name="location_code"
            inputId="set-role-location-code"
          />
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            Ignored for super_admin and clear-role operations.
            Worker rejects location_admin role without a location_code.
          </p>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Set role
          </button>
        </div>
      </ActionForm>
    </OperationCard>
  );
}

/* ============================================================
 * 3. Grant tool
 * ============================================================ */

function GrantToolCard() {
  return (
    <OperationCard
      title="Grant tool"
      description="Add a row to user_tool_access. Idempotent — re-grants are no-ops."
    >
      <ActionForm action={grantToolAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="grant-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker name="user_id" inputId="grant-user-id" required />
        </div>

        <div>
          <FieldLabel htmlFor="grant-tool">Tool</FieldLabel>
          <select
            id="grant-tool"
            name="tool"
            defaultValue="pricing"
            required
            className={inputClass}
          >
            <option value="pricing">pricing</option>
            <option value="claims">claims</option>
            <option value="pertrack">pertrack</option>
          </select>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Grant tool
          </button>
        </div>
      </ActionForm>
    </OperationCard>
  );
}

/* ============================================================
 * 4. Revoke tool
 * ============================================================ */

function RevokeToolCard() {
  return (
    <OperationCard
      title="Revoke tool"
      description="Delete a row from user_tool_access. Idempotent — missing rows are no-ops."
    >
      <ActionForm action={revokeToolAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="revoke-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker name="user_id" inputId="revoke-user-id" required />
        </div>

        <div>
          <FieldLabel htmlFor="revoke-tool">Tool</FieldLabel>
          <select
            id="revoke-tool"
            name="tool"
            defaultValue="pricing"
            required
            className={inputClass}
          >
            <option value="pricing">pricing</option>
            <option value="claims">claims</option>
            <option value="pertrack">pertrack</option>
          </select>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Revoke tool
          </button>
        </div>
      </ActionForm>
    </OperationCard>
  );
}

/* ============================================================
 * 5. Reset password
 * ============================================================ */

// Inline browser-side script that wires the new + confirm password inputs
// for cross-field validation via setCustomValidity. Avoids spinning up a
// client component / React state for a single mismatch check. The worker
// doesn't enforce confirm; UI hygiene only.
//
// Brief 19 — uses event delegation on document. The original (Brief 7)
// version captured element references at parse-time; after Brief 19's
// <ActionForm> remounts the form on success (clearing fields), those
// references pointed at removed nodes and the new inputs had no listeners.
// Delegating to document survives remounts because the listener resolves
// the elements at event time.
const PASSWORD_MATCH_SCRIPT = `
(function () {
  function check() {
    var newEl = document.getElementById('reset-new-password');
    var cnfEl = document.getElementById('reset-confirm-password');
    if (!newEl || !cnfEl) return;
    if (cnfEl.value && cnfEl.value !== newEl.value) {
      cnfEl.setCustomValidity('Passwords do not match');
    } else {
      cnfEl.setCustomValidity('');
    }
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'reset-new-password' || t.id === 'reset-confirm-password') {
      check();
    }
  });
})();
`;

function ResetPasswordCard() {
  return (
    <OperationCard
      title="Reset password"
      description="Admin-set new password. Forces must_change_password = true."
    >
      <ActionForm action={resetPasswordAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="reset-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker name="user_id" inputId="reset-user-id" required />
        </div>

        <div>
          <FieldLabel htmlFor="reset-new-password" helper="At least 8 characters">
            New password
          </FieldLabel>
          <input
            id="reset-new-password"
            name="new_password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
        </div>

        <div>
          <FieldLabel htmlFor="reset-confirm-password">Confirm password</FieldLabel>
          <input
            id="reset-confirm-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className={inputClass}
          />
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            Browser-side check only; the worker stores whichever password lands
            in the &ldquo;new password&rdquo; field.
          </p>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Reset password
          </button>
        </div>
      </ActionForm>
      <script dangerouslySetInnerHTML={{ __html: PASSWORD_MATCH_SCRIPT }} />
    </OperationCard>
  );
}
