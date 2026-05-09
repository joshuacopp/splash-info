# Brief 87: Fleet detail page — `splash_notes` editable textarea at top of `/admin/fleet/[id]`

**Status:** Completed (2026-05-09)
**Drafted:** 2026-05-09
**Blocks:** Operator added a `splash_notes` (text) column to
`fleet_submissions` on 2026-05-09 for sales-follow-up annotations
("called, left voicemail, will follow up Friday", "qualified — needs
demo", etc.). This brief surfaces that column as an editable
textarea at the top of the per-submission detail page so the
contacting Splash rep can write/update notes inline. Notes persist
back to Supabase via a new admin-gated PATCH endpoint on
`splash-fleet-inquiry`.

**Dependencies:**
- Brief 83 (the apps/web detail page + worker admin module this
  brief extends).
- Brief 86 (the `submitted_at` column fix — must land first; the
  detail page won't render at all without 86 because the list
  feeding it is broken). Already completed.
- Brief 19 (the `<ActionForm>` server-action pattern this brief
  uses — `useActionState` + `router.refresh()`, not `redirect()`).

## Read first

- CLAUDE.md (server-action pattern from Brief 19; admin gate
  conventions).
- BRIEFS/brief-019-action-result-refresh.md (reference
  implementation for the form wrapper used here).
- BRIEFS/brief-083-fleet-submissions-admin-viewer.md (the brief
  this extends — detail page + worker admin module).
- apps/fleet-inquiry-worker/src/admin.js (the file gaining the
  new PATCH endpoint and `splash_notes` column in CSV inventory).
- apps/web/app/admin/fleet/[id]/page.tsx (the page gaining the
  textarea form at the top).
- apps/web/app/admin/_components/ActionForm.tsx (the shared
  client island for server-action UX).
- Existing `<ActionForm>` consumers under `apps/web/app/admin/`
  for examples of how the wrapper threads through.

## Context

### Where the textarea goes

User explicitly asked for it "right at the top" of the detail
page, above the existing key/value grid that renders the rest of
the submission. UX intent: when a Splash rep opens a submission
to call the prospect, the notes field is the first thing they
see and the first thing they can edit while on the phone.

Placement order on the detail page after this brief:
1. "← Back to list" link (existing).
2. Page header / submitted-at + customer name (existing).
3. **NEW** — Splash Notes section: large textarea pre-filled
   with current `splash_notes` value, "Save Notes" button
   beneath, success/error banner via `<ActionForm>`.
4. Existing 2-column key/value grid showing every other column
   on `fleet_submissions`.

The `splash_notes` value also continues to be displayed in the
existing key/value grid (read-only there) so a future reader
glancing past the editor sees the full record state. The grid
row is redundant with the textarea while editing but adds zero
ambiguity for read-only viewing.

### Auth + write path

Same `authenticateAdmin()` gate as the existing GET endpoints
(admin / super_admin per Brief 83). Write is a PostgREST PATCH
against `fleet_submissions?id=eq.{id}` with body
`{ splash_notes: "..." }`. Service-key binding required (already
in place from earlier in this 2026-05-09 session).

### Validation

Server-side cap on `splash_notes` length to prevent abuse —
10000 chars (well above any realistic free-text note; database
is `text` so no DB-level cap, but the worker guards it). Empty
string is allowed (operator can clear notes). Trim leading /
trailing whitespace before write so a stray newline doesn't
get persisted.

### Audit posture

v1 doesn't add `splash_notes_updated_at` / `splash_notes_updated_by`
columns. Operator only added `splash_notes` — keeping the schema
minimal. If "who wrote this" becomes operationally important
later, a future brief can add audit columns + display them. For
now the rep writing the note knows it's their note; if multiple
reps share access, they'll coordinate in the note text itself
("- josh 2026-05-09").

### Why a server action via `<ActionForm>`, not direct fetch

Per CLAUDE.md's "Server actions: useActionState + router.refresh()
pattern" (Brief 19): apps/web write surfaces use the
`<ActionForm>` wrapper that drives a server action via
`useActionState`, renders inline success/error banners, and
calls `router.refresh()` on success so the page re-renders with
the new value. Same pattern as damage-detail and sysadmin write
forms. Don't use `redirect()` from the server action; don't
fall back to a client-side `fetch()` either.

### CSV column inclusion

`splash_notes` is also valuable in CSV exports (sales reports,
follow-up tracking outside Splash tooling). Brief 87 extends
`CSV_COLUMNS` in `admin.js` to include the new column. PostgREST
`select=*` already returns it, so no SELECT projection change
needed — only the column inventory at the top of `admin.js`.

## Scope

### Phase 1 — Worker PATCH endpoint

**File:** `apps/fleet-inquiry-worker/src/admin.js`

1. Extend `handleAdminApi` (the router) to accept PATCH for the
   single-submission detail path. Currently:
   ```js
   if (request.method !== "GET") {
     return jsonError(405, "method not allowed");
   }
   ```
   Becomes:
   ```js
   if (request.method !== "GET" && request.method !== "PATCH") {
     return jsonError(405, "method not allowed");
   }
   ```
   Then in the path-match block, when the detail-path regex
   matches AND method is PATCH, dispatch to a new
   `handleUpdateSubmission` instead of `handleGetSubmission`:
   ```js
   const detailMatch = path.match(/^\/admin\/api\/submissions\/([A-Za-z0-9_-]+)$/);
   if (detailMatch) {
     if (request.method === "PATCH") {
       return handleUpdateSubmission(request, env, detailMatch[1]);
     }
     return handleGetSubmission(request, env, detailMatch[1]);
   }
   ```

2. Update the OPTIONS preflight allowed methods to include PATCH:
   ```js
   "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
   ```
   And include `Content-Type` (already there).

3. New handler `handleUpdateSubmission(request, env, id)`:
   - Calls `authenticateAdmin(request, env)` — same gate as the
     existing handlers.
   - Reads JSON body. Validates `body.splash_notes` is a string
     (or empty). Reject non-string with 400.
   - Trims whitespace. Caps at 10000 chars; reject longer with
     400.
   - PATCHes Supabase:
     ```js
     const u = new URL(`${env.SUPABASE_URL}/rest/v1/fleet_submissions`);
     u.searchParams.set("id", `eq.${id}`);
     await fetch(u, {
       method: "PATCH",
       headers: {
         apikey: env.SUPABASE_SERVICE_KEY,
         Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
         "Content-Type": "application/json",
         Prefer: "return=representation"
       },
       body: JSON.stringify({ splash_notes: trimmedNotes })
     });
     ```
   - Returns 404 if PostgREST returns empty array (no row matched
     the id).
   - Returns 200 `{ ok: true, row: <updated_row> }` on success.
   - Same error logging posture as the existing handlers
     (`console.error("fleet admin update non-2xx:", ...)`).

4. Add `splash_notes` to `CSV_COLUMNS` near the other text-content
   columns (place between `notes` and `created_at` slot, or at
   the end — wherever fits the existing visual grouping):
   ```js
   { key: "splash_notes", label: "splash_notes" }
   ```

### Phase 2 — Apps/web detail page form

**File:** `apps/web/app/admin/fleet/[id]/page.tsx`

1. Add a new server action at the top of the file (above the
   page component):
   ```ts
   "use server";
   // imports stay client/server appropriate per Next 15 conventions
   async function updateSplashNotesAction(
     id: string,
     prevState: ActionResult | null,
     formData: FormData
   ): Promise<ActionResult> {
     const notes = formData.get("splash_notes");
     if (typeof notes !== "string") {
       return { ok: false, error: "Invalid notes payload" };
     }
     try {
       await updateFleetSubmissionNotes(id, notes);
       revalidatePath(`/admin/fleet/${id}`);
       return { ok: true, message: "Notes saved." };
     } catch (err) {
       const message = err instanceof Error ? err.message : "Save failed";
       return { ok: false, error: message };
     }
   }
   ```
   The `id` comes from the page's params; bind via
   `.bind(null, params.id)` when passing the action to the form.
   Pattern matches existing damage/sysadmin write actions.

2. Add the textarea form at the top of the page component, above
   the existing key/value grid:
   ```tsx
   <section className="mb-6 rounded-md border border-gray-light bg-white p-5">
     <h2 className="mb-2 text-lg font-semibold text-splash-navy">Splash Notes</h2>
     <p className="mb-3 text-xs text-splash-navy/60">
       Internal notes from whoever contacts this lead. Visible to
       all admin / super_admin users.
     </p>
     <ActionForm action={updateSplashNotesAction.bind(null, params.id)} resetOnSuccess={false}>
       <textarea
         name="splash_notes"
         defaultValue={submission.splash_notes ?? ""}
         rows={6}
         maxLength={10000}
         className="block w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
       />
       <button type="submit" className="mt-2 rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white hover:bg-splash-blue-dark">
         Save Notes
       </button>
     </ActionForm>
   </section>
   ```
   `resetOnSuccess={false}` keeps the textarea contents after a
   successful save (matches Brief 19's pattern for forms where
   you might want to keep editing after a save).

3. The existing key/value grid below this section remains
   untouched — it'll continue to display every column on the
   submission INCLUDING `splash_notes` (read-only there). To
   avoid showing stale data immediately after a save, the
   `revalidatePath` + `router.refresh()` pair from Brief 19
   handles the re-fetch.

**File:** `apps/web/app/admin/fleet/_lib/worker-fetch.ts`

Add a new helper `updateFleetSubmissionNotes(id, notes)` that
calls the worker via service binding:

```ts
export async function updateFleetSubmissionNotes(
  id: string,
  notes: string
): Promise<void> {
  const cookieHeader = (await cookies()).toString();
  const tryBinding = async () => {
    const ctx = await getCloudflareContext({ async: true });
    const binding = ctx?.env?.FLEET_INQUIRY_WORKER;
    if (!binding) throw new Error("FLEET_INQUIRY_WORKER binding unavailable");
    const req = new Request(`https://internal/admin/api/submissions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookieHeader,
        "Origin": "https://internal"
      },
      body: JSON.stringify({ splash_notes: notes })
    });
    const r = await binding.fetch(req);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Fleet worker PATCH failed: ${r.status}${txt ? ` — ${txt}` : ""}`);
    }
  };
  try {
    await tryBinding();
  } catch (e) {
    // URL fallback for next dev — same pattern as the existing GET helpers
    const baseUrl = process.env.NEXT_PUBLIC_FLEET_INQUIRY_WORKER_URL;
    if (!baseUrl) throw e;
    const url = `${baseUrl}/admin/api/submissions/${encodeURIComponent(id)}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookieHeader,
        "Origin": new URL(baseUrl).origin
      },
      body: JSON.stringify({ splash_notes: notes })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Fleet worker PATCH failed: ${r.status}${txt ? ` — ${txt}` : ""}`);
    }
  }
}
```

Mirrors the existing `getFleetSubmission(id)` helper's
binding-first / URL-fallback pattern. Cookie + Origin headers
forwarded so the worker's auth gate + isOriginAllowed pass.

### Phase 3 — Validation

```sh
pnpm --filter @splash/fleet-inquiry-worker typecheck
pnpm --filter @splash/fleet-inquiry-worker build
pnpm --filter @splash/web typecheck
pnpm --filter @splash/web build
pnpm typecheck
```

Smoke test (after operator deploys both fleet worker and apps/web):
1. Open `/admin/fleet`, click any submission → detail page loads
   with new "Splash Notes" section at the top.
2. Type a note ("called, voicemail left"), click "Save Notes".
3. Inline success banner ("Notes saved.") renders under the
   textarea via `<ActionForm>`.
4. Page refreshes via `router.refresh()`; key/value grid below
   now shows the same `splash_notes` value (proves the
   round-trip worked).
5. Reload the page from scratch — note still there.
6. Click "Export CSV" on the list page — opens a CSV with a new
   `splash_notes` column populated for the row you edited.
7. Try as a non-admin user — no edit access (would 401/403 from
   the worker; UI may show error).

### Phase 4 — Documentation

1. **CLAUDE.md** — under the existing "Fleet inquiries admin"
   glossary entry, add a one-line note:
   > Detail page (`/admin/fleet/[id]`) includes an editable
   > Splash Notes textarea at the top (Brief 87) that
   > round-trips to `fleet_submissions.splash_notes` via
   > `PATCH /admin/api/submissions/{id}`. Cap 10000 chars.
   > Same admin/super_admin gate as the read endpoints.

2. **PRE_DEPLOY_FLEET.md** — extend the admin-endpoints section
   with the new PATCH endpoint shape.

3. **BUILD_STATE.md** — bump "Last updated" + Findings entry.

4. **BRIEFS/INDEX.md** — append Brief 87 row.

5. **BRIEFS/QUEUE.md** — entry already appended.

## Definition of Done

- `apps/fleet-inquiry-worker/src/admin.js` exposes a new
  `PATCH /admin/api/submissions/{id}` endpoint with the same
  auth gate as the GET endpoints; rejects non-string /
  too-long `splash_notes` payloads with 400; PATCHes Supabase
  via service-key client.
- `CSV_COLUMNS` in `admin.js` includes `splash_notes`.
- `apps/web/app/admin/fleet/[id]/page.tsx` renders an
  `<ActionForm>`-wrapped textarea + Save button at the top of
  the page, above the existing key/value grid.
- `apps/web/app/admin/fleet/_lib/worker-fetch.ts` exposes a new
  `updateFleetSubmissionNotes(id, notes)` helper following the
  existing binding-first / URL-fallback pattern.
- `pnpm typecheck` passes; `pnpm --filter @splash/fleet-inquiry-worker
  build` and `pnpm --filter @splash/web build` succeed.
- CLAUDE.md, PRE_DEPLOY_FLEET.md, BUILD_STATE.md updated per
  Phase 4.
- BRIEFS/INDEX.md row added.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Out of scope

- Adding `splash_notes_updated_at` / `splash_notes_updated_by`
  audit columns. Operator only added `splash_notes`; audit
  columns are a future-brief candidate if multiple reps need
  attribution.
- Showing notes column inline on the list page
  (`/admin/fleet`). v1 surfaces only on the detail page.
  Future brief candidate if operator wants to scan notes
  without clicking through.
- Server-side rich-text / markdown rendering. Plain text only.
- Optimistic UI (textarea updates immediately, re-renders only
  on confirmation). Brief 19's pattern uses `router.refresh()`
  which is good-enough latency for a sales-notes use case.
- Locking / collision detection if two reps edit the same
  submission's notes simultaneously. Last-write-wins. If
  this becomes a real conflict source, future brief adds a
  `version` column or shows a "modified by another user" banner.

## Outcome

**Completed 2026-05-09.**

### Files created

- `apps/web/app/admin/fleet/[id]/actions.ts` — server action `updateSplashNotesAction(id, prevState, formData)` matching React 19's `useActionState` contract. Reads the `splash_notes` form field, defends against non-string payloads, forwards via `updateFleetSubmissionNotes()`, calls `revalidatePath('/admin/fleet/${id}')`, and returns a typed `ActionResult`. `"use server"` at top.

### Files modified

1. **`apps/fleet-inquiry-worker/src/admin.js`** — Phase 1.
   - File-top docblock bumped from "Three routes" to "Four routes" with the new PATCH endpoint described.
   - New module-level constant `SPLASH_NOTES_MAX_LEN = 10_000`.
   - `CSV_COLUMNS` array gained `{ key: "splash_notes", label: "splash_notes" }` at the end.
   - OPTIONS preflight `Access-Control-Allow-Methods` extended to `"GET, PATCH, OPTIONS"`.
   - Top-level method gate widened to `request.method !== "GET" && request.method !== "PATCH"`.
   - Per-path method validation re-applied inline (so `PATCH /admin/api/submissions` and `PATCH /admin/api/submissions.csv` still 405 — only the `/admin/api/submissions/{id}` detail path accepts PATCH).
   - Detail-path regex match dispatches PATCH → new `handleUpdateSubmission`, otherwise → existing `handleGetSubmission`.
   - New `handleUpdateSubmission(request, env, id)` handler: reuses `authenticateAdmin`; parses JSON body; rejects non-string `splash_notes` with 400; trims whitespace; rejects over-cap with 400; PATCHes Supabase via `Prefer: return=representation`; 404 on empty representation array; 500 on non-2xx with `console.error("fleet admin update non-2xx:", ...)` posture; 200 `{ ok: true, row: <updated_row> }` on success.

2. **`apps/web/app/admin/fleet/[id]/page.tsx`** — Phase 2.
   - New imports: `<ActionForm>` from `../../_components/ActionForm`, `updateSplashNotesAction` from `./actions`.
   - New `<section className="mb-6 rounded-md border border-gray-light bg-white p-5">` rendered above the existing key/value grid: title "Splash Notes" + helper copy + an `<ActionForm action={saveNotes} resetOnSuccess={false}>`-wrapped `<textarea name="splash_notes" defaultValue={row.splash_notes ?? ""} rows={6} maxLength={10000}>` + Save Notes submit button.
   - `const saveNotes = updateSplashNotesAction.bind(null, id)` partial-applies the page's id param so it captures server-side; the form's FormData carries only the textarea value.
   - Existing key/value grid gained a "Splash notes" row that renders the value via `<pre className="whitespace-pre-wrap font-sans text-sm text-splash-navy">` so multi-line operator notes preserve their newlines (the only column on the page that needs that treatment).

3. **`apps/web/app/admin/fleet/_lib/worker-fetch.ts`** — Phase 2.
   - `FleetSubmissionRow` interface gained `splash_notes: string | null`.
   - New exported helper `updateFleetSubmissionNotes(id: string, notes: string): Promise<void>` mirroring the existing GET helpers' binding-first / URL-fallback shape: tries `getCloudflareContext({ async: true })` → `env.FLEET_INQUIRY_WORKER.fetch(req)` with `https://internal/admin/api/submissions/{id}`, Cookie + Origin forwarded, body `JSON.stringify({ splash_notes: notes })`, `Content-Type: application/json`. Catch falls through to a URL-based `fetch` against `workerUrl(path)` with the same headers/body. Throws on non-2xx with the worker's response text appended.

4. **`CLAUDE.md`** — Phase 4.
   - "Fleet inquiries admin" glossary entry rewritten: header `(Brief 83)` → `(Brief 83 / Brief 87)`; endpoint inventory grew from "Three new endpoints" to four (PATCH described inline); CSV column inventory note (`splash_notes` per Brief 87) and detail-page editable-textarea sentence appended.

5. **`PRE_DEPLOY_FLEET.md`** — Phase 4.
   - Section 4.6 title bumped to `(Brief 83 / Brief 87)`; intro paragraph notes Brief 87's PATCH addition.
   - Endpoint table grew a fourth row covering the PATCH (request body shape, validation rules, return shape, error codes, CSRF posture).
   - CSV row updated to mention `splash_notes` is in the column inventory.
   - CSRF paragraph updated to call out PATCH alongside the GET endpoints.
   - Smoke-test list grew step 7 covering the new editor end-to-end (open detail → textarea at top → save → inline banner → grid below renders new value → reload preserves → CSV export includes column).

6. **`BUILD_STATE.md`** — Phase 4.
   - "Last updated" bumped from Brief 86's narrative to Brief 87's.
   - New Findings & decisions log entry summarizing the worker + apps/web edits, decisions made on operator's behalf, latent issues, validation results.

7. **`BRIEFS/INDEX.md`** — Phase 4.
   - Brief 87's row's Status flipped from `Ready for Claude Code` to `Completed (2026-05-09)`.

8. **`BRIEFS/QUEUE.md`** — moved automatically by the orchestrator from the active queue line to the completed-tombstone block during the Brief 87 run.

9. **`BRIEFS/brief-087-fleet-detail-splash-notes-editor.md`** — Status flipped to `Completed (2026-05-09)`; this Outcome section filled in.

### Decisions on operator's behalf

(a) **Worker-side trim only.** `splash_notes` is trimmed when persisted but the textarea preserves what the operator typed visually. Avoids the "I added a trailing newline and the textarea jumped" UX surprise; the persisted DB value is what's normalized.

(b) **`<pre>` + `whitespace-pre-wrap` + `font-sans` for the read-only render.** Preserves multi-line operator formatting without monospace text styling that would clash with the rest of the key/value grid. The only column on the detail page that needs multi-line treatment.

(c) **Server action in a separate `actions.ts` file** rather than inline in `page.tsx`. Mirrors the `/admin/damage/[id]` reference implementation and keeps `"use server"` cleanly bounded.

(d) **PATCH returns `{ ok: true, row: <updated_row> }`.** Costs nothing more than 204 No Content and lets future callers consume the row without a follow-up GET. Today the apps/web caller ignores the body and relies on `router.refresh()` to re-fetch.

(e) **Per-path method validation re-applied inline** after the top-level method gate widened to PATCH. Without it, `PATCH /admin/api/submissions` (the list path) would have fallen through to `handleListSubmissions` which would issue a Supabase GET. Defense in depth.

(f) **No CORS `Access-Control-Allow-Origin: *` extension for PATCH.** Service-binding callers don't issue preflights and the existing GET-shaped wildcard is sufficient for cross-origin curl/console traffic.

(g) **No `splash_notes` allow-list on the public form's submit handler.** The column is admin-write only — the public `POST /api/fleet-submit` doesn't accept user-supplied `splash_notes` and Brief 87 didn't extend it. The 10000-char cap is enforced only at the admin PATCH boundary.

### Latent issues / forward flags

(i) **No audit columns.** v1 has no `splash_notes_updated_at` / `splash_notes_updated_by` — last-write-wins for concurrent edits; reps coordinate in note text. Future brief if attribution matters.

(ii) **No optimistic UI.** `<ActionForm>`'s `useActionState` + `router.refresh()` pattern has visible round-trip latency. Brief explicitly cites this as out of scope.

(iii) **Notes column not on the list page.** Operators must click into a detail page to read or edit. Brief lists this as out of scope.

(iv) **No collision detection.** Concurrent edits silently overwrite. Acceptable until it actually causes a conflict.

(v) **Stale `created_at` line in CLAUDE.md.** The pre-existing "Filtering is on `fleet_submissions.created_at`" sentence under the existing fleet-admin glossary entry is stale post-Brief-86 (filter is on `submitted_at`) but left untouched here — it's outside Brief 87's scope.

(vi) **Service-key direct-write surface unchanged.** `splash_notes` is also writable via Supabase admin SQL or PostgREST directly with the service key — that's the service-key surface working as designed; only worker-routed writes get the auth gate + length cap.

### Validation

| Command | Result |
|---|---|
| `pnpm --filter @splash/fleet-inquiry-worker typecheck` | ✅ green |
| `pnpm --filter @splash/web typecheck` | ✅ green |
| `pnpm typecheck` (root) | ✅ 15/15 packages green |
| `pnpm --filter @splash/web build` | ✅ green — Next.js 15.5.15 compiled, 14 routes generated, `/admin/fleet/[id]` 739 B / 106 kB First Load JS (~575 B growth from the new server action + textarea client-island weight) |
| `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy --dry-run` | ✅ 784.01 KiB / 149.16 KiB gzipped (small growth from new PATCH handler; well within CF's 3 MiB compressed free-tier limit) |
| `pnpm --filter @splash/fleet-inquiry-worker build` | ⚠️ unrunnable — no `build` script in package.json (CF workers don't bundle ahead of `wrangler deploy`; same posture as Briefs 79 / 83 / 84 / 85 / 86). The wrangler dry-run substitutes. |

### Smoke test (deferred to operator post-deploy)

1. Open `/admin/fleet`, click any submission → detail page loads with new "Splash Notes" section at top.
2. Type a note ("called, voicemail left"), click Save Notes.
3. Inline success banner ("Notes saved.") renders under the textarea via `<ActionForm>`.
4. Page refreshes via `router.refresh()`; key/value grid below now shows the same value (proves round-trip).
5. Reload from scratch — note still there.
6. Export CSV from `/admin/fleet` — new `splash_notes` column populated for the row edited.
7. Try as `location_admin` / `gm` — no edit access (worker 401/403; apps/web's outer auth gate already redirects to login).

### Operator follow-ups before usable

1. Confirm the recently-added `splash_notes` column is in place on `fleet_submissions` (worker PATCH 500s with PostgREST "column does not exist" if it isn't).
2. Deploy `splash-fleet-inquiry` (push-to-GH if CF Builds is wired, or `pnpm --filter @splash/fleet-inquiry-worker exec wrangler deploy`).
3. Deploy apps/web.
4. Run the smoke test above.
5. Optional: inspect persisted `splash_notes` values in Supabase Studio to confirm trim posture (no leading/trailing whitespace).
