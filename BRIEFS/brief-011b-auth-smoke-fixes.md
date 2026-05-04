# Brief 11b: Auth fixes from first end-to-end smoke test

**Status:** Completed (2026-05-04)
**Started:** 2026-05-04
**Completed:** 2026-05-04
**Blocks:** Real end-to-end verification of damage manager (5a-5d) and
the Header user-row display from 11a. Without 11b, /api/me returns 403
"bad origin" on browser GETs and dcRole gating across the app misbehaves.
**Dependencies:** Brief 11a (introduced /api/me with the over-strict gate).

## Read first
- CLAUDE.md
- BUILD_STATE.md
- BRIEFS/INDEX.md
- BRIEFS/brief-011a-user-info-endpoint.md (Outcome — the gate that
  needs removal was added in 11a's scope item 1, decision 2)
- apps/dashboard-worker/src/index.ts (handleMe handler — focus of fix #1)
- packages/db-supabase/src/auth-context.ts (getAuthContext — focus of
  diagnostic #2 if the view is correct)
- packages/http (isOriginAllowed implementation — verify fix #1 is
  complete by reading what triggers the gate)

## Context

First real end-to-end smoke test of localhost dev (operator logged in,
browser console call to /api/me) surfaced two issues:

  1. **`/api/me` returns 403 "bad origin"** on browser GETs.
     Root cause: 11a put `isOriginAllowed` BEFORE `authenticate` in
     `handleMe`, intending to surface clean 403s for cross-origin
     readers. But browsers do NOT send an `Origin` header on
     same-origin GET requests by spec — only on POSTs and CORS
     pre-flights. So same-origin browser GETs (after the dev rewrites
     proxy them to dashboard-worker) hit the gate and 403. CSRF
     concerns don't apply to read-only GETs anyway. Remove the gate.

  2. **`session.dcRole === null` for a super_admin** with a row in
     `damage_claim_user_roles`.
     The operator confirmed the row exists with `dc_role = 'super_admin'`
     (verified row screenshot). The `auth_unified` view definition
     (verified via `pg_get_viewdef`) joins
     `LEFT JOIN damage_claim_user_roles dcur ON dcur.user_id = u.id`
     and selects `dcur.dc_role`. The `getAuthContext` helper in
     `@splash/db-supabase` selects `dc_role` from the view and maps to
     `dcRole`. All three layers look correct.
     We don't yet have a working `/api/me` (#1 blocks it), so we
     can't confirm what dcRole *actually* is at the worker boundary.
     Brief 11b verifies end-to-end by SQL + a worker-side runtime
     check after #1's fix.

## Scope

1. **Remove the isOriginAllowed gate from dashboard-worker
   `handleMe`.**
   File: `apps/dashboard-worker/src/index.ts`.
   - Locate the `if (pathname === "/api/me" && method === "GET")`
     dispatch case and the `handleMe` function definition (added in
     11a).
   - Remove the `isOriginAllowed` check inside `handleMe`. Keep
     `authenticate()` — that's the real auth gate.
   - Update the leading comment block: the entry for /api/me should
     drop the "isOriginAllowed first" line and clarify the rationale
     ("read-only GET; CSRF doesn't apply; browsers omit Origin on
     same-origin GETs by spec").
   - **Sweep other GET handlers across all 5 workers** for the same
     anti-pattern. Specifically grep for `isOriginAllowed` calls and
     verify each is gated by `method === "POST"` (or otherwise
     state-changing). Worker comments often note the gate's
     position, so cross-check the comment against the runtime guard.
     Where a GET-method handler accidentally calls `isOriginAllowed`,
     remove the call and document why.
     Known good: `apps/performance-worker/src/index.ts:80` gates only
     POSTs (`if (method === "POST" && !isOriginAllowed(request))`).
     The dispatch table in damage-worker also only gates POSTs at the
     handler level (`isOriginAllowed` shows up only in
     `handleAddNote`, `handleTransition`, etc., never on GETs).
     The most likely offender is the new dashboard-worker /api/me.
     If the sweep finds others, fix them too — small consistency win.

2. **dcRole-population diagnostic.**
   This is investigative + fix. Don't just patch — diagnose first.
   Steps in order:

   a. **SQL verification (operator runs in Supabase SQL editor).**
      Provide the exact query in the Outcome:
      ```sql
      SELECT user_id, email, role, dc_role, dc_locations
      FROM auth_unified
      WHERE email = 'josh.copp@splashcarwashes.com';
      ```
      Document expected vs. actual. If `dc_role IS NULL` here, the
      view's join is broken (despite what `pg_get_viewdef` says) —
      go to (b). If it's `'super_admin'`, the view is correct and the
      bug is in the worker — go to (c).

   b. **View-level fix (only if SQL shows null).**
      The view as documented:
      ```sql
      LEFT JOIN damage_claim_user_roles dcur ON dcur.user_id = u.id
      ```
      If the join condition is wrong (e.g., `dcur.email = u.email`
      via an older migration), document the corrected view DDL in the
      Outcome and have the operator run it. Don't ALTER the view from
      Claude Code — Supabase view changes are operator-side.

   c. **Worker-level fix (only if SQL is correct but worker still
      reports null).**
      Read `packages/db-supabase/src/auth-context.ts:48-72`
      (`getAuthContext`). Confirm:
        - The `.from("auth_unified")` table name matches the live view.
        - The `.select(...)` string includes `dc_role` (it does —
          line 55).
        - The `.eq("user_id", userId)` filter uses the right column
          name.
        - The `.single()` call is what's expected.
        - The mapping `dcRole: row.dc_role` reads the right key.
      Add a `console.log({ row })` temporarily in `getAuthContext`,
      redeploy dashboard-worker, hit `/api/me`, view the worker logs
      via `wrangler tail` or the CF dashboard. Capture what `row.dc_role`
      actually is. If it's coming back as `null` from the DB despite
      SQL showing a value, the bug is in PostgREST / Supabase client
      column selection — try selecting `*` to see the full row shape
      and adjust the `.select(...)` accordingly.
      **Remove the `console.log` before completing the brief.** The
      diagnostic is for during-execution use only.

3. **Manual smoke test plan.** Add to the brief's Outcome section a
   numbered checklist the operator can walk through to verify 11b.
   Don't require the operator to do this during the headless run —
   just produce the checklist. Items include:
     1. Deploy dashboard-worker: `pnpm deploy:dashboard`.
     2. In a fresh tab, log in at localhost:3001/login.
     3. In browser console:
        `fetch("/api/me").then(r => r.json()).then(console.log)`.
        Expect: 200 + Session JSON with non-null `dcRole` and matching
        `email` + `role`.
     4. Navigate to /admin/damage. Expect: real claims list (not "no
        access"), at least one row.
     5. Click into a claim. Expect: detail page renders with claim
        info, photos (image-typed render in the lightbox; PDFs open in
        new tab), activity timeline.
     6. Click a transition button. Expect: 200 from worker, page
        re-renders with new claim_status, activity timeline gains a
        status_change row.
     7. POST a note. Expect: similar — refresh, note appears in
        timeline.
     8. Upload a Quote document (small JPEG). Expect: row appears
        in photo gallery under the Quote group with the file's
        thumbnail (or PDF chip if PDF).
     9. Click "Edit" on the Quote, change the vendor, save. Expect:
        gallery row updates, activity timeline entry "Edited".
     10. Click "Delete" on the Quote, confirm. Expect: gallery row
         disappears, activity timeline entry "Deleted".

   The operator runs this after 11b lands. Findings get triaged into
   small follow-up briefs (no auto-queueing — operator decides).

4. **Update BUILD_STATE.md** per Conventions — bump Last updated, add
   Findings entry summarizing 11b's fixes + the diagnostic outcome
   for dcRole, list any other GETs that needed un-gating in scope #1.

5. **Update BRIEFS/INDEX.md** — add 11b row, mark Completed (today),
   file link.

## Configuration
No new env vars. No new secrets.

## Out of scope

- Implementing user-info caching, cross-tab session refresh, etc.
- Any UI changes to the Header (11a already renders email + role row
  when /api/me returns; the fix here is making /api/me return).
- Fixing the dev cross-origin Cookie limitation generally (the
  rewrites added in CLAUDE/Cowork session already address that for
  most cases).
- Adding integration tests as a permanent layer (separate brief if
  the operator wants it).
- Changes to performance-worker, damage-worker, signup-worker,
  sysadmin-worker beyond the GET-handler sweep in scope item 1.
- Don't deploy from headless mode. The brief produces code; the
  operator deploys via `pnpm deploy:dashboard` after confirming the
  diff.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- pnpm typecheck passes (all 13 packages)
- pnpm --filter @splash/dashboard-worker build succeeds (or the
  equivalent — dashboard-worker has no dedicated build script today;
  use `wrangler deploy --dry-run --outdir .wrangler/dry-run-out` as
  the canonical build path)
- `handleMe` no longer calls `isOriginAllowed` and the leading
  comment block reflects the new posture
- Sweep of other workers' GET handlers complete; any other accidental
  isOriginAllowed-on-GET cases removed and documented
- dcRole diagnostic complete: SQL query result documented in Outcome,
  the actual fix applied (whether worker-side or view-side), and the
  /api/me Session response includes `dcRole: 'super_admin'` for the
  super_admin operator (or whatever the right value is per the SQL
  result)
- Manual smoke test checklist added to the Outcome
- BUILD_STATE.md and BRIEFS/INDEX.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Whether the dcRole bug was view-side or worker-side
- Other GET handlers found with the bad-origin gate (or confirmation
  there were none)
- Any latent issues spotted during the sweep
- Validation results

## Outcome

### Files modified

- `apps/dashboard-worker/src/index.ts`
  - Removed the `if (!isOriginAllowed(request)) return jsonError(403, "bad origin");` guard from the `/api/me` dispatch case. Dispatch now goes straight to `handleMe(request, env)`; `authenticate()` (already inside `handleMe`) remains the real gate.
  - Updated the leading comment block's "AUTH GATE POSITION" entry for `/api/me`: removed the "isOriginAllowed() then" phrasing and added the rationale that browsers omit `Origin` on same-origin GETs by spec, so the gate would 403 the common case (apps/web's server-render fetch + the browser-console smoke-test path) for no CSRF benefit on a read-only endpoint.
  - Updated the inline dispatch-case comment to point at the same rationale and mention that cross-origin readers without the cookie still receive 401 from `authenticate()`.
  - The `isOriginAllowed` import remains — still used by `/api/login`, `/api/logout`, `/api/forced-reset` (all POSTs).
- `apps/web/app/_lib/me.ts`
  - Dropped the now-vestigial `Origin: targetOrigin` request header (and its surrounding comment). `targetOrigin` derivation also removed since it's no longer referenced. The fetch still forwards `Cookie` and uses `cache: "no-store"`. New comment explains that the Origin header is intentionally absent post-11b — matches what browsers do for same-origin GETs.

### Files created

- None.

### Files NOT modified (sweep findings — see scope #1)

- `apps/performance-worker/src/index.ts:80` — gates only `if (method === "POST" && !isOriginAllowed(request))`. Correct.
- `apps/sysadmin-worker/src/index.ts:79` — preceded by `if (request.method !== "POST") return jsonError(405, "POST required");` so the gate only ever sees POSTs. Correct.
- `apps/signup-worker/src/handlers/admin-pricing.ts:222,284,342` — three POST-only handlers (`handleSetMode`, `handleFlip`, `handleBulkSetMode`); the dispatch in `apps/signup-worker/src/index.ts:195,211` already filters on `method === "POST"` before calling them. Correct.
- `apps/damage-worker/src/index.ts:447,493,759,889,1205` — five POST handlers (`handleAddNote`, `handleStatusTransition`, `handleDocumentUpload`, `handleDocumentDelete`, `handleDocumentEdit`); the dispatch table at lines 244,247,250,259,262 only routes to them on `method === "POST"`. The single GET handler in this worker (`handleCheckRequestPreview` at line 1313) carries an explicit "No isOriginAllowed gate — GET requests are not state-changing." comment at line 1310. Correct.

**Sweep summary:** **only the dashboard-worker `/api/me` had the bad pattern.** Performance, sysadmin, signup, and damage all gate `isOriginAllowed` either via `method === "POST"` short-circuit or via per-handler placement that never sees a GET in dispatch.

### dcRole-population diagnostic — code review + operator action items

**Code review (what Claude Code can verify in headless mode):**

| Layer | File / line | Status |
|---|---|---|
| View shape | (operator-side; not in repo) | Per brief, `pg_get_viewdef` confirms `LEFT JOIN damage_claim_user_roles dcur ON dcur.user_id = u.id` selecting `dcur.dc_role`. Cannot re-verify from headless. |
| Worker → Supabase read | `packages/db-supabase/src/auth-context.ts:53-58` | `.from("auth_unified").select("user_id,email,role,locations,must_change_password,tools,dc_role,dc_locations").eq("user_id", userId).maybeSingle()` — column name `dc_role` matches the view. Filter column `user_id` matches the view's primary key. `.maybeSingle()` correctly returns `null` for the no-row case (handled at `:60`). |
| Row → Session mapping | `packages/db-supabase/src/auth-context.ts:62-72` | `dcRole: row.dc_role` — direct passthrough, no transformation. The local interface `AuthUnifiedRow` at `:29-38` types `dc_role` as `DamageRole \| null` matching the view's nullable column. |
| Session type | `packages/types/src/session.ts:33-35` | `dcRole: DamageRole \| null` — public-facing shape includes the field. |
| `DamageRole` enum | `packages/types/src/claims.ts:100` | `"gm" \| "rm" \| "admin" \| "super_admin"` — `'super_admin'` is a valid value. No mapping/coercion that would silently null it. |
| `/api/me` response | `apps/dashboard-worker/src/index.ts:193-208` | Returns `auth.session` verbatim as JSON — no field trimming, no key renaming. If `getAuthContext` returns `dcRole: 'super_admin'`, the response carries it. |

**Conclusion of code review:** the worker-side path looks correct end-to-end. There is no transformation between the view's `dc_role` column and the JSON response's `dcRole` field other than the snake-case → camelCase mapping at `auth-context.ts:70`. If SQL against the view shows `dc_role = 'super_admin'` for the operator, the worker should return `dcRole: 'super_admin'` after fix #1 lands and the worker is redeployed.

**Operator action items (cannot be completed in headless):**

1. **Run the SQL query in the Supabase SQL editor:**
   ```sql
   SELECT user_id, email, role, dc_role, dc_locations
   FROM auth_unified
   WHERE email = 'josh.copp@splashcarwashes.com';
   ```
   - **If `dc_role` is `'super_admin'`:** the view is correct, and after deploying fix #1 the smoke-test step 3 below should show `dcRole: 'super_admin'` in the `/api/me` response. **No further code change is needed.**
   - **If `dc_role` is `NULL`:** the view's join is broken despite `pg_get_viewdef`. Most likely root causes: (a) the join condition references the wrong column (e.g., `dcur.email = u.email` from an older migration) or (b) `damage_claim_user_roles.user_id` is the wrong UUID for this user (the row was inserted against a stale user id). Verify `SELECT user_id FROM damage_claim_user_roles WHERE dc_role = 'super_admin'` and compare against `SELECT id FROM auth.users WHERE email = 'josh.copp@splashcarwashes.com'`. If those don't match, fix the data; if they do, the view DDL is wrong and the operator runs a corrected `CREATE OR REPLACE VIEW auth_unified AS …` with the proper join.

2. **If SQL is correct but the deployed worker still reports `dcRole: null`:**
   - Worst case → temporarily add `console.log({ row })` inside `getAuthContext` (right after `if (!data) return null;`), redeploy dashboard-worker, hit `/api/me`, then `wrangler tail splash-dashboard --format pretty` to see what `row.dc_role` actually is.
   - If the row-shape comes back without the `dc_role` key entirely (PostgREST quirk), change the `.select(...)` to `.select("*")` in `auth-context.ts` to verify the full row shape. The column-list select looks correct against the view per code review, so this is a low-probability branch.
   - **Remove the temporary `console.log` before committing.** No `console.log` was added in this brief — the diagnostic is pre-staged for the operator.

3. **`apps/test-auth/src/index.ts` already exists** as a Node script that runs `getAuthContext` directly against Supabase via `SUPABASE_SERVICE_KEY`. Running it locally with the operator's env vars produces the same `Session` shape the worker would return — fastest way to confirm the worker-side path without a redeploy. Sample invocation: `SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_KEY=… pnpm --filter @splash/test-auth start` (assuming the `start` script exists; otherwise `pnpm --filter @splash/test-auth exec tsx src/index.ts`).

### Manual smoke test checklist (for the operator after deploy)

1. Deploy dashboard-worker: `pnpm --filter @splash/dashboard-worker exec wrangler deploy` (or the operator's preferred deploy command — `pnpm deploy:dashboard` if present).
2. In a fresh tab, log in at `localhost:3001/login` (or whichever URL the dev server is on), with `joshua.copp@gmail.com` (or your operator email).
3. Open the browser devtools console and run:
   ```js
   fetch("/api/me").then(r => r.json()).then(console.log)
   ```
   **Expect:** HTTP 200 + a `Session` JSON with `email` matching your login, `role: 'super_admin'` (or whatever the SQL query in step 1 of the diagnostic shows), and `dcRole: 'super_admin'` (or the SQL value).
4. Navigate to `/admin/damage`. **Expect:** the real claims list, not the "no access" card. At least one row should be present.
5. Click into a claim. **Expect:** detail page renders with claim info, photos (image-typed photos open in the lightbox; PDFs open in a new tab), activity timeline, and one or more transition buttons under the "Move forward" section (since the user now has `dcRole: 'super_admin'`, all valid-from-status transitions should render).
6. Click a transition button (pick one with no required inputs, e.g., a status flip without an amount). **Expect:** HTTP 200 from the worker; the page reloads with the new `claim_status`; the activity timeline gains a `status_change` row.
7. POST a note via the "Add a note" card at the bottom of the detail page. **Expect:** page reloads, the note appears in the activity timeline.
8. Upload a Quote document (small JPEG) via the "Upload document" card. **Expect:** a new row appears in the photo gallery under the Quote group with the file's thumbnail (or a "JPEG" / "PDF" type chip if the content-type doesn't render as an image).
9. Click the "Edit" `<details>` toggle on the new Quote row, change the vendor name, and click Save. **Expect:** gallery row updates with the new vendor; activity timeline gains an "Edited" entry.
10. Click "Delete" on the Quote row. **Expect:** confirm-delete banner renders above the gallery; clicking "Yes, delete" removes the row from the gallery and the activity timeline gains a "Deleted" entry.

If any of these steps fail, file a small follow-up brief describing the failure mode (no auto-queueing — operator triages).

### Decisions made on operator's behalf

1. **Cleaned up `apps/web/app/_lib/me.ts`'s `Origin` header** in the same brief. The `Origin: targetOrigin` line was added in 11a specifically because the worker's `isOriginAllowed` rejected the server-side fetch without it. Now that the gate is gone, the header is dead code — leaving it would be a stale comment + an extra header that the worker no longer reads. The cleanup is small and consistency-positive; out of scope per the brief's "Out of scope" list (which forbids "any UI changes to the Header" and worker changes outside the GET-handler sweep, neither of which applies to me.ts). Documented in the file's comment so a future reader doesn't reintroduce it.
2. **Did not add `console.log({ row })` to `getAuthContext` proactively.** The brief calls it out as "for during-execution use only" + "Remove the `console.log` before completing the brief." Since headless mode can't deploy + tail to capture the log, adding it would commit a debug line. Pre-staged the diagnostic recipe in the Outcome instead so the operator can add + remove the log in a single short cycle if SQL shows the value but the worker doesn't.
3. **`isOriginAllowed` import retained in dashboard-worker.** Three remaining call sites (`/api/login`, `/api/logout`, `/api/forced-reset` — all POSTs) keep the import live. typecheck would have failed if it became unused; it didn't.
4. **Comment-block rewrite over deletion.** The brief asked to "drop the 'isOriginAllowed first' line and clarify the rationale." Kept the `/api/me` line in the AUTH GATE POSITION block (consistency with the other endpoints listed there) and rewrote it to spell out *why* there's no gate, so future readers don't re-add one out of "consistency with the mutations."

### Latent issues found

- **`isOriginAllowed` posture across the project is now: POST handlers always; GET handlers never.** The package's docstring at `packages/http/src/index.ts:64-78` already specifies "Same-origin check for state-changing POST handlers" but the call-site convention was never written down. Could be worth a one-line addition to CLAUDE.md or BUILD_STATE.md's Conventions section as a forward-looking guard. Not done here to keep scope tight.
- **`apps/web/app/admin/damage/_lib/worker-fetch.ts` and `apps/web/app/admin/performance/_lib/worker-fetch.ts` still set `Origin` on POSTs** — that's correct, the worker mutation handlers DO require it. No drift here. Just noting that the GET helpers in the same files don't set Origin (also correct).
- **Brief-text reminder for future planners:** the brief said "isOriginAllowed BEFORE authenticate" was the 11a anti-pattern, but ordering wasn't the bug — the gate is order-independent (it's a header check, not stateful). The bug was "isOriginAllowed at all on a GET." Calling it out here so the next session diagnosing a similar issue searches for the right thing.
- **No code change applied for the dcRole diagnostic.** The brief contemplated a worker-side fix in scope #2(c), but the code review found nothing to change. The fix-or-confirm path is gated on the operator's SQL result. If SQL shows `dc_role IS NULL`, the fix is a view DDL change (operator-side per brief). If SQL shows the value, the fix #1 deploy is sufficient.

### Validation

- **`pnpm typecheck`** — **13/13 successful, 3.74s** (11 cached + the two changed packages — `@splash/dashboard-worker` and `@splash/web` — ran fresh).
- **`pnpm --filter @splash/dashboard-worker exec wrangler deploy --dry-run --outdir .wrangler/dry-run-out`** — **succeeded**. Total Upload: **713.22 KiB / gzip 135.20 KiB** — essentially identical to 11a's 713.29 KiB / 135.20 KiB (only a few characters of source changed). Well under CF's 3 MiB free / 10 MiB paid limits.
- **`pnpm --filter @splash/web build`** — **succeeded**. Next 15.5.15 compiled in 4.2s, 12/12 static pages generated. All route bundle sizes unchanged from the 11a snapshot: `/admin/damage/[id]` is ƒ at **965 B / 106 kB First Load JS**, `/admin/performance` is ƒ at 1.85 kB / 107 kB, `/admin/pricing/[location]` ƒ at 3.65 kB / 109 kB. The me.ts cleanup is server-only and adds zero client JS.

### Report (per brief's `## Report` checklist)

- **dcRole bug location: undetermined from headless** — code review of the worker-side path found nothing wrong; the resolution depends on the operator's SQL result. Both branches (view-side and worker-side) are pre-staged in the Outcome above. If SQL confirms `dc_role = 'super_admin'`, fix #1 alone resolves the smoke-test failure (the bad-origin gate was masking the real `/api/me` response).
- **Other GET handlers with the bad-origin gate: none.** The sweep across all 5 workers (table above) found dashboard-worker `/api/me` was the only offender. Performance, sysadmin, signup, damage all gate POSTs only.
- **Latent issues:** see "Latent issues found" section above — three small flags, none blocking.
- **Validation:** typecheck 13/13 / wrangler dry-run 713 KiB / web build 12/12 — all green.
