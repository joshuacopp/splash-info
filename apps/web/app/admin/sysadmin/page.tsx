// Sysadmin UI (/admin/sysadmin). Brief 7.
//
// Server component. Top-of-page super_admin gate via getMe(); the page never
// renders the operation cards for non-super_admins (worker re-validates on
// POST as defense in depth).
//
// Layout (top → bottom):
//   1. Action-error / action-success banners (driven by ?action_error /
//      ?action_success search params).
//   2. Page banner (eyebrow + title + helper text).
//   3. Five collapsed <details> cards, one per worker endpoint:
//        - Create user
//        - Set role
//        - Grant tool
//        - Revoke tool
//        - Reset password
//
// Each card is a plain server-rendered <form action={fn}> with the fields
// the worker handler reads (apps/sysadmin-worker/src/index.ts handlers).
// No client islands, no useState — server actions navigate after submit
// via redirect(). Worker validates inputs and returns inline errors.
//
// The worker has no list-users / search-users endpoint today; v1 expects
// user_id pasted from Supabase auth.users.id (or the auth_unified view).

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { NoAccessCard } from "./_components/NoAccessCard";
import {
  createUserAction,
  grantToolAction,
  resetPasswordAction,
  revokeToolAction,
  setRoleAction
} from "./actions";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function SysadminPage({ searchParams }: PageProps) {
  const session = await getMe().catch(() => null);

  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/sysadmin" />;
  }
  if (session.role !== "super_admin") {
    return <NoAccessCard reason="forbidden" />;
  }

  const params = await searchParams;
  const actionError = firstParam(params.action_error);
  const actionSuccess = firstParam(params.action_success);

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <PageBanner />

      <ActionAlert message={actionError} variant="error" />
      <ActionAlert message={actionSuccess} variant="success" />

      <div className="flex flex-col gap-4">
        <CreateUserCard />
        <SetRoleCard />
        <GrantToolCard />
        <RevokeToolCard />
        <ResetPasswordCard />
      </div>
    </section>
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

function ActionAlert({
  message,
  variant
}: {
  message: string | null;
  variant: "error" | "success";
}) {
  if (!message) return null;
  const isError = variant === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={
        isError
          ? "mb-4 flex flex-col gap-2 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-deny sm:flex-row sm:items-center sm:justify-between"
          : "mb-4 flex flex-col gap-2 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm text-splash-success sm:flex-row sm:items-center sm:justify-between"
      }
    >
      <div className="flex-1 whitespace-pre-line">
        <span className="font-bold">
          {isError ? "Action failed: " : "Success: "}
        </span>
        {message}
      </div>
      <Link
        href="/admin/sysadmin"
        className={
          isError
            ? "text-xs font-semibold underline underline-offset-2 hover:text-splash-deny/80"
            : "text-xs font-semibold underline underline-offset-2 hover:text-splash-success/80"
        }
      >
        Dismiss
      </Link>
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

const userIdHelper = "Paste from Supabase auth.users.id";

/* ============================================================
 * 1. Create user
 * ============================================================ */

function CreateUserCard() {
  return (
    <OperationCard
      title="Create user"
      description="Provision a new auth.users row plus optional role + tool grants."
    >
      <form action={createUserAction} className="space-y-4">
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
          <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
            location_admin row will be created with location_code = NULL.
            Use Set role afterwards to attach a location.
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
      </form>
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
      <form action={setRoleAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="set-role-user-id" helper={userIdHelper}>
            User ID
          </FieldLabel>
          <input
            id="set-role-user-id"
            name="user_id"
            type="text"
            required
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
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
            helper="Required only for location_admin role"
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
          </p>
        </div>

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Set role
          </button>
        </div>
      </form>
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
      <form action={grantToolAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="grant-user-id" helper={userIdHelper}>
            User ID
          </FieldLabel>
          <input
            id="grant-user-id"
            name="user_id"
            type="text"
            required
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
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
      </form>
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
      <form action={revokeToolAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="revoke-user-id" helper={userIdHelper}>
            User ID
          </FieldLabel>
          <input
            id="revoke-user-id"
            name="user_id"
            type="text"
            required
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
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
      </form>
    </OperationCard>
  );
}

/* ============================================================
 * 5. Reset password
 * ============================================================ */

// Inline browser-side script that wires the new + confirm password inputs
// for cross-field validation via setCustomValidity. Runs as soon as the
// browser parses the script tag (the inputs precede this script in DOM
// order). Avoids spinning up a client component / React state for a single
// mismatch check. The worker doesn't enforce confirm; UI hygiene only.
const PASSWORD_MATCH_SCRIPT = `
(function () {
  var newEl = document.getElementById('reset-new-password');
  var cnfEl = document.getElementById('reset-confirm-password');
  if (!newEl || !cnfEl) return;
  function check() {
    if (cnfEl.value && cnfEl.value !== newEl.value) {
      cnfEl.setCustomValidity('Passwords do not match');
    } else {
      cnfEl.setCustomValidity('');
    }
  }
  newEl.addEventListener('input', check);
  cnfEl.addEventListener('input', check);
})();
`;

function ResetPasswordCard() {
  return (
    <OperationCard
      title="Reset password"
      description="Admin-set new password. Forces must_change_password = true."
    >
      <form action={resetPasswordAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="reset-user-id" helper={userIdHelper}>
            User ID
          </FieldLabel>
          <input
            id="reset-user-id"
            name="user_id"
            type="text"
            required
            autoComplete="off"
            className={`${inputClass} font-mono`}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
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
      </form>
      <script dangerouslySetInnerHTML={{ __html: PASSWORD_MATCH_SCRIPT }} />
    </OperationCard>
  );
}
