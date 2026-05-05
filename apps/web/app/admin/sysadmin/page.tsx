// Sysadmin UI (/admin/sysadmin). Briefs 7 + 18 + 19 + 24 + 26 + 27.
//
// Server component. Top-of-page super_admin gate via getMe(); the page never
// renders the operation cards for non-super_admins (worker re-validates on
// POST as defense in depth).
//
// Layout (top → bottom):
//   1. Page banner (eyebrow + title + helper text).
//   2. Eight collapsed <details> cards, one per worker endpoint:
//        - Create user
//        - Set role
//        - Grant tool
//        - Revoke tool
//        - Reset password
//        - Add location (Brief 24 — pricing_simple bulk insert)
//        - Update package (Brief 26 — pricing_simple per-row edit)
//        - Update location (Brief 27 — locations row edit; cascades via
//                           triggers to pricing_simple + user_permissions)
//
// Brief 19 — pattern flip:
//   The page-level ?action_error / ?action_success banners are gone. Each
//   card is now wrapped in the shared <ActionForm> client component
//   (apps/web/app/admin/_components/ActionForm.tsx) which dispatches the
//   server action via useActionState and renders the per-form result inline
//   (success toast or error banner) directly under the form. On a fresh ok
//   result, ActionForm calls router.refresh() so the page's server-rendered
//   data re-loads (paired with revalidatePath() inside the action).
//
// Brief 18 added the UserPicker client island for the four user-targeted
// forms (Set role / Grant tool / Revoke tool / Reset password) — replaces
// the v1 paste-the-user-id-from-Supabase UX with an email-substring
// typeahead backed by GET /sysadmin/api/users. Server actions still
// receive the selected user_id via a hidden input the picker writes.

import { getMe } from "../../_lib/me";
import { ActionForm } from "../_components/ActionForm";
import { AddLocationCard } from "./_components/AddLocationCard";
import { NoAccessCard } from "./_components/NoAccessCard";
import { UpdateLocationCard } from "./_components/UpdateLocationCard";
import { UpdatePackageCard } from "./_components/UpdatePackageCard";
import { UserPicker } from "./_components/UserPicker";
import {
  createUserAction,
  grantToolAction,
  resetPasswordAction,
  revokeToolAction,
  setRoleAction
} from "./actions";

export default async function SysadminPage() {
  const session = await getMe().catch(() => null);

  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/sysadmin" />;
  }
  if (session.role !== "super_admin") {
    return <NoAccessCard reason="forbidden" />;
  }

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <PageBanner />

      <div className="flex flex-col gap-4">
        <CreateUserCard />
        <SetRoleCard />
        <GrantToolCard />
        <RevokeToolCard />
        <ResetPasswordCard />
        <AddLocationOperationCard />
        <UpdatePackageOperationCard />
        <UpdateLocationOperationCard />
      </div>
    </section>
  );
}

/* ============================================================
 * 6. Add location (Brief 24)
 * ============================================================ */

function AddLocationOperationCard() {
  return (
    <OperationCard
      title="Add location"
      description="Insert pricing_simple rows for a brand-new location. Atomic — all rows or none. Defaults to pricing = 'full'."
    >
      <AddLocationCard />
    </OperationCard>
  );
}

/* ============================================================
 * 7. Update package (Brief 26)
 * ============================================================ */

function UpdatePackageOperationCard() {
  return (
    <OperationCard
      title="Update package"
      description="Search a pricing_simple row by location/code/site, then edit per-package fields (pkg$, single, flash2/5, sort, pkg name, pricing mode)."
    >
      <UpdatePackageCard />
    </OperationCard>
  );
}

/* ============================================================
 * 8. Update location (Brief 27)
 * ============================================================ */

function UpdateLocationOperationCard() {
  return (
    <OperationCard
      title="Update location"
      description="Search a locations row by site #, name, address, or manager, then edit denormalized fields (manager names + emails, address, hrt_email, rm_group, site). DB triggers cascade into pricing_simple + user_permissions."
    >
      <UpdateLocationCard />
    </OperationCard>
  );
}

/* ============================================================
 * Page chrome
 * ============================================================ */

function PageBanner() {
  return (
    <div className="mb-5">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">System Admin</h1>
      <p className="mt-1 text-sm text-splash-navy/70">
        Super-admin user management. Each operation posts directly to
        sysadmin-worker; every successful mutation writes a row to
        <code className="mx-1 rounded bg-gray-light/60 px-1 py-0.5 font-mono text-[0.8125rem]">
          sysadmin_audit_log
        </code>
        .
      </p>
    </div>
  );
}

/* ============================================================
 * Card primitives
 * ============================================================ */

function OperationCard({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card open:shadow-splash-card-hover">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div>
          <div className="text-base font-bold text-splash-navy">{title}</div>
          <div className="mt-0.5 text-xs text-splash-navy/60">{description}</div>
        </div>
        <span
          aria-hidden="true"
          className="text-xs font-semibold uppercase tracking-wider text-sudsy-blue group-open:hidden"
        >
          Open
        </span>
        <span
          aria-hidden="true"
          className="hidden text-xs font-semibold uppercase tracking-wider text-sudsy-blue group-open:inline"
        >
          Close
        </span>
      </summary>
      <div className="border-t border-gray-light px-5 py-5">{children}</div>
    </details>
  );
}

function FieldLabel({
  htmlFor,
  children,
  helper
}: {
  htmlFor: string;
  children: React.ReactNode;
  helper?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70"
    >
      {children}
      {helper ? (
        <span className="ml-2 normal-case tracking-normal text-[0.6875rem] font-normal text-splash-navy/50">
          {helper}
        </span>
      ) : null}
    </label>
  );
}

const inputClass =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";

const submitClass =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";

// Brief 18: user_id text inputs (paste-from-Supabase) replaced with the
// UserPicker email typeahead on the four user-targeted forms.

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
            helper="Required only for location_admin role"
          >
            Location code
          </FieldLabel>
          <input
            id="create-location-code"
            name="location_code"
            type="text"
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="binghamton"
          />
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            Ignored for super_admin and no-role.
          </p>
        </div>

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
              <input type="checkbox" name="tools" value="claims" />
              claims
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-splash-navy">
              <input type="checkbox" name="tools" value="pertrack" />
              pertrack
            </label>
          </div>
        </fieldset>

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
            helper="Required for location_admin role"
          >
            Location code
          </FieldLabel>
          <input
            id="set-role-location-code"
            name="location_code"
            type="text"
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="binghamton"
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
