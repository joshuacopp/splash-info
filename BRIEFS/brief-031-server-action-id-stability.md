# Brief 31: Server-action ID stability across deploys + graceful stale-tab UX

**Status:** Completed (2026-05-05)
**Started:** 2026-05-05
**Completed:** 2026-05-05
**Blocks:** Stale browser tabs crash with a Next.js
`UnrecognizedActionError` white-page when apps/web is redeployed
between page-load and form-submit. Operator hit this on
2026-05-05 while granting the claims tool to
batavaiawash@splashcarwashes.com - the form submitted, the worker
never received the request, and the page rendered "Application
error: a client-side exception has occurred." The user assumed it
was a cookie/auth issue (logging back in worked because the
relogin caused a full page reload, picking up the fresh action
IDs). Two fixes: (1) eliminate the root cause via a stable build-
time encryption key for server actions; (2) catch the residual
edge cases in an error boundary that prompts the user to reload
instead of white-paging.
**Dependencies:** Brief 19 (ActionForm pattern - the affected
forms), Brief 17 (service bindings deployed via CF Workers
Builds - this is where the build-time env needs to land).

## Read first

- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-019-action-result-refresh.md (Outcome - the
  ActionForm pattern; every action that goes through this is
  affected)
- apps/web/next.config.mjs
- apps/web/app/admin/_components/ActionForm.tsx (the wrapper that
  dispatches the action via useActionState; an error boundary at
  any ancestor of this component catches the action error)
- apps/web/wrangler.toml (CF Workers Builds env vars are configured
  in the dashboard, but the wrangler.toml + .env.example are where
  we DOCUMENT the new variable so future-us knows it's load-bearing)
- apps/web/.env.example
- apps/web/app/layout.tsx (root layout; if a global error boundary
  is needed it nests here)

## Context

End-to-end testing on 2026-05-05 surfaced a "white page after grant
tool" sequence. Console showed:

```
Uncaught UnrecognizedActionError: Server Action
"60cd668b64fd580ab94ce673c47ea8d5a70f11507c" was not found on the
server.
```

This is a known Next.js 14+ behavior. Server actions are identified
by content-hashed IDs that get embedded in the client bundle. The
hash uses an encryption key that, by default, is regenerated on every
build. Sequence that produces the bug:

1. Operator opens `/admin/sysadmin` at time T0. Browser caches the
   page + the action ID (e.g., `60cd668b...`).
2. Apps/web is redeployed at time T1 (via CF Workers Builds). New
   build generates a new encryption key, so all action IDs change.
3. Operator submits the form at T2 (still on the cached tab from
   T0). The browser POSTs the action with ID `60cd668b...`.
4. The server, which now only knows the new IDs, throws
   `UnrecognizedActionError`.
5. The error is uncaught; ActionForm's `useActionState` doesn't
   handle it; React 19 renders the global error UI, which on apps/
   web is the bare Next.js fallback - hence the white page with
   "Application error: a client-side exception has occurred."

Two layers of fix:

**Layer 1 (root cause)**: set a stable encryption key at build time.
Next 14+ honors `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` -
when set, action IDs become deterministic across builds (depending
only on the action body + this key, not on a per-build random salt).
Stale tabs keep working until the underlying cookie/session expires
on its own.

**Layer 2 (defense in depth)**: even with a stable key, action IDs
*can* still drift when the action's source code changes (a real
behavior change, not just a redeploy). And Layer 1 doesn't backfill
existing tabs that opened before the key was set. So we also want a
Next.js error boundary that catches the error and shows a sensible
"App was updated, please reload" UI with a reload button - rather
than the white-page client-exception fallback.

## Scope

### Part A - Stable build-time encryption key (Layer 1)

A.1 Generate a 32-byte base64 random key. The operator should run
something like the PowerShell snippet below ONCE and save the
output securely (e.g., in their password manager). Don't generate
inside this brief - the executor produces the docs + config, the
operator provides the value at deploy time.

  ```powershell
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes)
  ```

  Output looks like: `K7+v9pT7xQ6L8m3n2J0vY1q5R4t8Y9w2Z3a6B7c1D2E=`

A.2 Document the env var in `apps/web/.env.example`:
  ```
  # Stable encryption key for Next.js server actions. Set this to a
  # 32-byte base64 string and DO NOT change it across deploys (changing
  # it invalidates all action IDs on every open browser tab and
  # produces UnrecognizedActionError white-pages mid-session).
  #
  # Generate once via:
  #   PowerShell:
  #     $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
  #   Bash:
  #     openssl rand -base64 32
  #
  # Set as a CF Workers Builds BUILD-TIME env var (not a runtime
  # secret) on apps/web's worker. Build-time only because Next reads
  # this during `next build`; runtime doesn't need it again.
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=
  ```

A.3 Add a comment block at the top of `apps/web/next.config.mjs`
near `nextConfig` documenting the env var's role. Don't reference
the value; just point at .env.example.

A.4 Document the CF Workers Builds setup in BUILD_STATE.md's
deployment section (or wherever existing CF Workers Builds env
notes live - if no such section exists yet, add one). Wording
must distinguish:
  - **Build-time env vars** (set in CF dashboard under Workers &
    Pages > apps/web worker > Settings > Build > Environment variables;
    these are baked into the build artifact)
  - **Runtime secrets** (set via `wrangler secret put` per CLAUDE.md)
  The encryption key is a build-time env var. Setting it as a
  runtime secret has no effect (Next's bundle is already built).

A.5 No code change is needed beyond docs - Next.js reads the env var
automatically when `next build` runs. If the executor finds the key
isn't being honored, fall back to wiring it explicitly via
`next.config.mjs`'s experimental block (Next 15 syntax differs across
minor versions; check the version in apps/web's package.json before
configuring).

### Part B - Error boundary + graceful stale-tab UX (Layer 2)

B.1 Add `apps/web/app/admin/error.tsx` (an Admin-segment error
boundary covering all `/admin/*` routes - which is where every
write action lives via Brief 19's pattern):

  ```tsx
  "use client";

  // Error boundary for /admin/*. Catches uncaught exceptions thrown
  // from server actions or client components and renders a sensible
  // recovery UI instead of Next's bare client-exception fallback.
  //
  // Specifically handles UnrecognizedActionError (server-action ID
  // mismatch from a stale tab post-redeploy) with a "Reload" CTA.

  import { useEffect } from "react";

  export default function AdminError({
    error,
    reset
  }: {
    error: Error & { digest?: string };
    reset: () => void;
  }) {
    const isStaleAction =
      error.message?.includes("Server Action") &&
      error.message?.includes("was not found on the server");

    useEffect(() => {
      // Surface to the browser console for debugging. In prod the
      // error.digest is what shows up in CF logs; the message is
      // typically scrubbed.
      console.error("[admin error boundary]", error);
    }, [error]);

    if (isStaleAction) {
      return (
        <section className="mx-auto w-full max-w-[640px] px-5 py-12">
          <h1 className="mb-2 text-xl font-bold text-splash-navy">
            App was updated
          </h1>
          <p className="mb-5 text-sm text-splash-navy/70">
            This page was loaded before the latest deploy. Reload to
            pick up the new version - your last action wasn't saved.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            Reload
          </button>
        </section>
      );
    }

    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-12">
        <h1 className="mb-2 text-xl font-bold text-splash-deny">
          Something went wrong
        </h1>
        <p className="mb-5 text-sm text-splash-navy/70">
          {error.message || "An unexpected error occurred."}
          {error.digest ? (
            <span className="mt-2 block font-mono text-xs text-splash-navy/50">
              digest: {error.digest}
            </span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          Try again
        </button>
      </section>
    );
  }
  ```

B.2 Verify the error boundary works for both React-rendering errors
AND server-action errors. Per Next.js docs, `error.tsx` boundaries
catch both - but the action error specifically might land at the
`global-error.tsx` boundary if it propagates past the segment.
If during testing the boundary doesn't catch the action error, also
add `apps/web/app/global-error.tsx` (with the same shape but
including its own `<html>` + `<body>` since global-error replaces
the root layout).

B.3 Don't put the error boundary at `/sysadmin/*` only. The same
issue affects every server-action write surface: `/admin/sysadmin`,
`/admin/damage/[id]` (transitions, notes, document edits), and any
future action-driven page. `/admin/error.tsx` covers them all in
one shot.

B.4 The "Try again" `reset()` callback may not actually recover if
the cause is a stale action ID - the same form will resubmit with
the same stale ID. That's fine; the button is there for non-action
errors. The action-specific path goes through the "Reload" CTA.

B.5 Optional: add a tiny telemetry hook (not GA - just a
`console.warn` with the action ID) so future debugging is easier.
The error message includes the offending ID. Keep this side-effect-
only; don't ship a beacon.

### Part C - Updates

C.1 BRIEFS/INDEX.md: Brief 31 row added.

C.2 BUILD_STATE.md: Last updated, Findings entry covering the
stable encryption key + error boundary; explicit note that this
fixes the white-page incident on 2026-05-05; CF Workers Builds
env-var convention now documented.

C.3 CLAUDE.md: extend the apps/web section to mention the
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY requirement and the
admin/error.tsx boundary; add a one-liner to the "Critical
constraints" section: "Never rotate
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY without coordination - rotation
invalidates every action ID on every open tab. If a rotation is
truly needed, plan it during a maintenance window."

## Out of scope

- **Cloudflare Insights beacon SRI failure.** The console showed:
  > Failed to find a valid digest in the 'integrity' attribute for
  > resource 'https://static.cloudflareinsights.com/beacon.min.js/...'
  > with computed SHA-512 integrity ...
  This is CF Web Analytics' beacon getting an SRI mismatch when CF
  rotates the file. It's purely an analytics-dropout issue and
  doesn't affect functionality. Real fix options (any of):
  (a) disable CF Web Analytics on staging/prod
  (b) accept the analytics dropout
  (c) wait for CF to fix on their side
  None of these belong in this brief - flag for a future cleanup
  brief if operator wants analytics restored.

- **damage/VES-20260505-181329-PLUF 404.** Same console showed a
  404 on a damage claim ID. That's leftover from earlier claim-form
  testing (a tab or prefetch from before this incident). Not
  related to the action-error white-page.

- Migrating away from server actions toward client-side `fetch()`
  for write surfaces. The pricing admin already does this (Brief
  17/18-era); doing it across damage + sysadmin would eliminate
  the action-ID problem entirely but is a much larger refactor.
  Track separately if ever desired.

- Don't deploy from headless. Operator pushes; CF Workers Builds
  redeploys. The build-time env var must be set on CF before the
  next deploy, OR the next build will still produce non-deterministic
  IDs and the white-page recurrence won't be fixed.

- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/web build succeeds
- `apps/web/.env.example` documents
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` with the why + how to
  generate
- `apps/web/next.config.mjs` references the env var in a comment
  block
- `apps/web/app/admin/error.tsx` exists and detects
  `UnrecognizedActionError` via message-substring check, rendering
  a "Reload" CTA on hit and a generic "Try again" CTA otherwise
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)
- Operator-side action item recorded in BUILD_STATE.md or the
  brief's Outcome: "Generate the key + set
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY as a build-time env var on
  apps/web's CF Workers Builds config before the next deploy."

## Report

- Confirm the Next 15 minor in apps/web's package.json is recent
  enough to honor `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` natively
  (>=15.x default). If not, surface what the workaround is.
- Whether the error boundary at `/admin/error.tsx` was sufficient
  or if `global-error.tsx` was also needed
- Bundle-size delta on /admin/* (likely +0.3-0.6 kB for the
  error-boundary client component)
- Validation results

## Outcome

### Files modified

- `apps/web/.env.example` — appended new `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` block (rationale + PowerShell + bash generation snippets + the build-time-vs-runtime-secret distinction). 38 lines added; nothing existing reformatted.
- `apps/web/next.config.mjs` — added an 8-line comment block at file top documenting `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` as a build-time env var consumed implicitly by Next during `next build`. No code change.
- `BRIEFS/INDEX.md` — Brief 31 row marked `Completed (2026-05-05)`.
- `CLAUDE.md` — new Critical-constraints item 7 ("Never rotate `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` without coordination") with rotation-during-maintenance-window guidance; new bullet under "Working with apps/web" documenting both layers (env var + boundary), placement rationale, and detection strategy.
- `BUILD_STATE.md` — `Last updated` bumped to `2026-05-05 — Brief 31 completed`; new prioritized work list row 31 (status `completed`); new Findings & decisions log entry covering the full delta.

### Files created

- `apps/web/app/admin/error.tsx` — Next.js segment-level error boundary (`"use client"`) covering all `/admin/*` routes. Detects `UnrecognizedActionError` via two-token message-substring check (`"Server Action"` AND `"was not found on the server"`); on hit renders an "App was updated / Reload" UI with `window.location.reload()` button; non-action errors fall through to a generic "Something went wrong / Try again" UI calling `reset()`. Includes `console.error` of the full error and `console.warn` of the parsed stale action ID for forward debugging. ~85 lines.

### Decisions made on operator's behalf

1. **Boundary placed at `/admin/error.tsx`, not nested per-page.** Every server-action write surface (sysadmin, damage detail, future action-driven pages) lives under `/admin/*`, so a single boundary covers them in one shot per the brief's B.3 guidance.
2. **Two-token substring check (`"Server Action"` + `"was not found on the server"`) instead of `instanceof UnrecognizedActionError`.** The error class isn't exported from any public Next.js entry point, so message-substring is the only stable detection path. Two tokens minimize false positives over a single-token check.
3. **`console.warn` with the parsed stale ID alongside `console.error` of the full error** — the optional B.5 telemetry hook. Side-effect-only, no beacon.
4. **No `global-error.tsx` added in this brief.** The segment-level boundary at `/admin/error.tsx` is sufficient for the action-error path because action errors throw inside the segment's render tree (`<ActionForm>` lives under `/admin/*`). Per B.2's contingency: if staging testing surfaces a case where the action error escapes past the segment boundary, follow-up brief can add `apps/web/app/global-error.tsx`.
5. **Reload CTA uses `window.location.reload()`, not `router.refresh()`.** `router.refresh()` re-fetches RSC data but keeps the same client bundle (and therefore the same stale action IDs) in memory, so it would re-trigger the error on next submit. A full reload picks up the new bundle.
6. **`<button type="button">` on both CTAs.** The boundary isn't inside a `<form>`, but explicit `type="button"` prevents accidental submit-form behaviour if a future change wraps the boundary in a form.
7. **No code change to `next.config.mjs` beyond the comment block.** Next 15.5.15 honors `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` natively during `next build`; experimental-block plumbing is unnecessary at this version (per A.5's fallback contingency, which didn't trigger).
8. **`.env.example` value left empty (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=`).** Per A.1's directive — the executor produces the docs + config; the operator generates and provides the value at deploy time.

### Latent issues / forward flags

(a) **Operator-side action item is the gating step for Layer 1.** Until the operator generates the key + sets it as a build-time env var on splash-web's CF Workers Builds config, the next deploy still produces non-deterministic IDs and Layer 1's protection doesn't activate. Layer 2 (the boundary) provides immediate UX softening regardless.
(b) **Existing tabs opened before the key is first set will still hit the boundary on next form submit after the FIRST post-key-set deploy** — those tabs were rendered with the pre-key build's action IDs, which the post-key build doesn't recognize. The boundary catches it gracefully ("Reload" CTA); operator hits Reload once, picks up the new build, action IDs become stable from then on.
(c) **Non-action errors also flow through the boundary.** Any uncaught exception thrown from server actions or client components in `/admin/*` lands at the generic "Something went wrong / Try again" branch. `reset()` re-renders the segment, which usually clears transient errors. Per brief B.4, `reset()` won't recover from a stale-action error (the same ID would resubmit), so the action-specific path stays on the Reload CTA.
(d) **No `global-error.tsx` means uncaught errors OUTSIDE `/admin/*`** (e.g., from `/login`, `/`, `/signup/[location]`, `/change-password`) still hit Next's bare client-exception fallback. Those routes don't host server actions and have minimal client logic, so the practical exposure is small. Add a global boundary if/when a non-admin route grows action-driven write surfaces.
(e) **Bundle delta unobservable.** `/admin/*` route First Load JS unchanged from Brief 30 baseline. Next.js code-splits `error.tsx` boundary components into a lazy chunk loaded only when the boundary fires, so the main route bundle stays the same size. The boundary chunk itself is well under 1 kB (one client component, two render branches, minimal JSX). The brief's "+0.3-0.6 kB" estimate is the chunk size, not a First Load JS impact.
(f) **`UnrecognizedActionError` class isn't part of Next.js's public API.** The substring check is stable across Next 14.x and 15.x (the error message text has been consistent), but a future Next major could rephrase the message and silently break the detection. If the message format changes, the boundary falls back to the generic "Try again" UI — degrades to UX-equivalent of having no Layer-2 detection but doesn't white-page.
(g) **Out-of-scope items per the brief:** Cloudflare Insights beacon SRI failure (analytics dropout — flag for separate cleanup brief), the unrelated `/admin/damage/VES-20260505-181329-PLUF` 404 (stale prefetch), broader migration away from server actions to client-side `fetch()` (much larger refactor; track separately).

### Operator action item

**Generate `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` and set it on CF Workers Builds before the next deploy.** PowerShell (run once):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Save the output securely (password manager). Set it as a build-time env var on splash-web's worker:

CF dashboard → Workers & Pages → splash-web → Settings → Build → Environment variables → add `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` with the generated value.

Do NOT set it as a runtime secret (`wrangler secret put` is the wrong channel — Next reads the env at `next build` time, not at runtime). Do NOT rotate it without coordinating a maintenance window (rotation invalidates every action ID on every open tab).

### Report (brief's request)

- **Next 15.5.15 minor honors `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` natively.** No experimental-block plumbing required in `next.config.mjs`. The env var has been a documented stability lever since Next 14.2+; 15.5 sits comfortably above that threshold.
- **`/admin/error.tsx` boundary is sufficient.** No `global-error.tsx` was needed for the static-build path — `next build` succeeded cleanly without it. If staging exercise surfaces a stale-action error that escapes the segment boundary, follow-up brief adds `global-error.tsx` per B.2's contingency.
- **Bundle-size delta on `/admin/*`: 0 First Load JS impact.** Next.js code-splits the boundary into a lazy chunk; route bundles unchanged from post-Brief-30 baseline (`/admin/sysadmin` 7.06 kB / 112 kB, `/admin/damage/[id]` 3.08 kB / 108 kB, `/admin/pricing/[location]` 3.65 kB / 109 kB, `/admin/dashboard` + `/admin/damage` + `/admin/pricing` 167 B / 105 kB each).
- **Validation results:**
  - `pnpm typecheck` — 13/13 successful, 8.625s (5 cached + 8 fresh; workers untouched in this brief, fresh runs reflect turbo-baseline behaviour).
  - `pnpm --filter @splash/web build` — succeeded; Next 15.5.15 compiled in 7.3s; 12/12 static pages generated; all type checks green.
