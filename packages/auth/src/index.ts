// =============================================================================
// @splash/auth — Supabase Auth + role/tool gating for the MaxPass workers.
// =============================================================================
//
// SECURITY CONTRACT — must_change_password
// ------------------------------------------------------------------------
// `user_permissions.must_change_password` is a per-user boolean (legacy
// updates ALL of a user's user_permissions rows when toggling — preserved).
// When TRUE, the user MUST be redirected to a password-change flow before
// any tool grants a session.
//
// THE BUG THIS PACKAGE CLOSES: legacy/dashboard.js (the new SSO entry
// point) does NOT enforce the flag. A user can log in via the dashboard
// with the default password and bypass the forced reset that legacy's
// /admin/* login flow in signupworker.js does enforce.
//
// FINDING (2026-05-02): legacy NEVER sets must_change_password = true
// anywhere — the column exists but no code path turns it on. apiCreateUser,
// apiSetRole, and apiResetPassword all leave it false (or default-insert
// it false). adminResetPassword in this package is the FIRST sanctioned
// path that flips the flag to true.
//
// THE FOUR BUG-CLASS FIXES (encoded at the data layer in @splash/db-supabase
// and @splash/auth):
//
//   1. adminResetPassword                    — admin-side password set
//      (in @splash/auth/admin.ts)              ALWAYS flips flag = true.
//                                              Replaces legacy/sysadmin.js
//                                              apiResetPassword which left
//                                              the flag alone.
//
//   2. createUserPermissionsRow              — new user_permissions rows
//      (in @splash/db-supabase/users.ts)       DEFAULT mustChangePassword =
//                                              true. Newly-onboarded users
//                                              always start gated. Legacy
//                                              defaulted to false.
//
//   3. setRole                               — role reassignment PRESERVES
//      (in @splash/db-supabase/users.ts)       the existing flag value via
//                                              read-modify-write. Legacy
//                                              hardcoded false on the new
//                                              row, silently wiping the gate
//                                              for any user mid-reset who
//                                              got re-roled.
//
//   4. dashboard-worker SSO gate             — POST /api/login refuses to
//      (in apps/dashboard-worker)              issue tool access without
//                                              first running the user
//                                              through /change-password
//                                              when mustChangePassword is
//                                              true. Legacy/dashboard.js
//                                              never read the flag.
//
// Each is documented in detail at its function definition. The default IS
// the policy in every case — encoded at the data layer so no handler can
// accidentally circumvent it.
//
// =============================================================================
// CANONICAL AUTH READ PATH — auth_unified view
// =============================================================================
//
//   5. auth_unified is the SINGLE query path for auth context.
//      `getAuthContext(client, userId)` from @splash/db-supabase reads it.
//      Do NOT query user_permissions / user_tool_access /
//      damage_claim_user_roles / damage_claim_user_locations directly from
//      worker code — the view aggregates them with the correct semantics
//      (BOOL_OR for must_change_password, MAX for role, array_agg for
//      locations / tools / dc_locations).
//
//   damage_claim_user_roles.must_change_password (if it ever gets added)
//   is INTENTIONALLY IGNORED by the view. user_permissions.must_change_password
//   is canonical. The view should NEVER read it from a second source —
//   that would create drift between the two flag locations. If anyone
//   ever "fixes" the view to merge them, they're introducing a bug.
//
// PASSWORD-SET POLICY (Josh, 2026-05-02):
//   "No @splash code path may set a password without flipping
//    must_change_password according to the action's intent."
//
// Three sanctioned password-mutation functions, one per intent:
//
//   adminResetPassword(env, userId, newPassword)
//     — admin-triggered, sets flag = true + sets password.
//       Replaces legacy/sysadmin.js:492 apiResetPassword (which left
//       the flag alone — that's the bug).
//
//   userCompleteForcedReset(env, session, newPassword)
//     — user fulfilling the gate; sets password + clears flag = false.
//       Maps from legacy/signupworker.js:656 handleChangePassword
//       (legacy unified this with voluntary change — we split them).
//
//   userChangePassword(env, session, currentPassword, newPassword)
//     — user voluntary change; verifies currentPassword first, sets
//       password, leaves flag UNCHANGED. NOT YET IMPLEMENTED — no
//       legacy equivalent. Throws on call. Hook exists for future ports.
//
// The raw "set Supabase password" primitive is a module-private helper in
// admin.ts — not exported. There is no public API for setting a password
// without choosing one of the three intent-bearing functions.
//
// SESSION SHAPE: `authenticate(request, env)` returns a Session with
// `mustChangePassword` pre-computed. `requiresPasswordChange(session)` is
// a one-line readability sugar — callers can also read the field directly.
// `checkToolAccess()` deliberately does NOT short-circuit on the flag —
// different workers route differently when reset is required.
//
// Step 6 backlog (when porting workers):
//   • dashboard-worker:   the SSO login MUST call requiresPasswordChange()
//                         after authenticate() and 302-redirect to a
//                         change-password page (which posts to
//                         userCompleteForcedReset) before issuing the auth
//                         cookies. THIS IS THE BUG FIX.
//   • signup-worker:      legacy /admin/change-password preserves through
//                         Step 6 but moves to apps/web in Step 7. Update
//                         it to call userCompleteForcedReset (was the
//                         unified handleChangePassword).
//   • sysadmin-worker:    /sysadmin/api/reset-password switches from the
//                         legacy "PUT password only" path to
//                         adminResetPassword (closes the policy gap on the
//                         admin tool).
//                         /sysadmin/api/create-user MUST insert the
//                         user_permissions row with
//                         must_change_password = TRUE (legacy inserts
//                         FALSE, which leaves admin-known default passwords
//                         valid until the user proactively changes them —
//                         same bug class as the dashboard SSO bypass).
//   • Every worker port:  the auth gate must be wired BEFORE any handler
//                         logic. Stubs returning 501 are safe; stubs that
//                         do real work without auth are not.
//
// USER ONBOARDING — must_change_password = TRUE on every new permissions row:
// ANY code path that creates a user_permissions row for a newly-onboarded
// user MUST set must_change_password = TRUE. This applies to:
//   • sysadmin-worker apiCreateUser (legacy default is FALSE — change it)
//   • sysadmin-worker apiSetRole when promoting someone for the first time
//     (legacy default is FALSE — change it)
//   • Bulk onboarding scripts and SQL templates outside this codebase
//     (no @splash code can enforce this — call it out in any onboarding doc)
// The default password ("NewPassword123" or similar admin-known value) must
// never grant tool access. setMustChangePassword(client, userId, true) is the
// helper to call after the insert if you can't include it in the insert body.
//
// =============================================================================

export * from "./cookies.js";
export * from "./session.js";
export * from "./tool-access.js";
export * from "./admin.js";
export * from "./password-policy.js";
export * from "./mfa.js";
export * from "./mfa-policy.js";
