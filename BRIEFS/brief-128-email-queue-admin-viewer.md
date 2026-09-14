# Brief 128: Email queue admin viewer + retry control

**Status:** Completed (2026-05-14)
**Started:** 2026-05-14
**Completed:** 2026-05-14
**Blocks:** Neither — companion to Brief 127. Once the outbound
email queue is live, operators need a way to see what's in flight,
what failed, and retry stuck rows without dropping into the
Supabase console.
**Dependencies:** Brief 127 (outbound_emails table + claim/confirm
endpoints).

## Read first

- CLAUDE.md (`forms-worker` glossary — Brief 127 entry +
  outbound_emails table doc)
- BRIEFS/brief-127-outbound-email-queue-and-workflow-email-steps.md
  (the table schema + endpoint contract this brief inspects)
- apps/forms-worker/src/email-queue/* (Brief 127 — claim/confirm
  endpoints; admin endpoints sit alongside)
- apps/web/app/admin/dashboard/_lib/tiles.tsx (Brief 117 registry —
  add the Email Queue tile)
- apps/web/middleware.ts ADMIN_KNOWN_SUBPATHS (CLAUDE.md rule —
  add `"email-queue"`)
- apps/web/app/admin/fleet/page.tsx (Brief 83 — closest
  reference implementation for an admin-gated list page with
  filters + detail drill)

## Context

Brief 127 lands the outbound email queue but has no operator-facing
inspection surface. Failed sends (5+ attempts → stuck rows),
in-flight claims, sent history, all live in Supabase. The
operator's question "did that email actually go out?" today
requires a SQL editor — not workable as the system scales.

This brief adds an admin-gated viewer at `/admin/email-queue`:
- List of recent rows with filters (status / source / date range).
- Per-row detail showing subject, body, recipient, full failure
  history.
- Retry control: reset `claimed_at` + `send_attempts` so the next
  PA poll picks it up again. Bounded to admin-tier.
- Force-fail: mark a row `sent_attempts = 99` so it drops out of
  the eligible pool permanently (admin can choose to abandon
  a row that's genuinely broken).

## Scope

### Phase 1 — Worker endpoints

Two new endpoints under `/forms/admin/api/email-queue/*` on
splash-forms (admin-tier gated via `authenticate()` + role check —
`session.role === "super_admin"` OR `session.dcRole === "admin"`
OR `session.dcRole === "super_admin"`). Service-key access to
Supabase.

**1a. `GET /forms/admin/api/email-queue/list`**

Query params:
- `status=pending|claimed|sent|stuck|all` (default `all`).
  - `pending` — `sent_at IS NULL AND claimed_at IS NULL AND send_attempts < 5`
  - `claimed` — `sent_at IS NULL AND claimed_at IS NOT NULL AND send_attempts < 5`
  - `sent` — `sent_at IS NOT NULL`
  - `stuck` — `sent_at IS NULL AND send_attempts >= 5` (gave up)
  - `all` — no status filter.
- `source_worker` — exact-match filter (e.g., "forms"). Optional.
- `source_kind` — exact-match filter (e.g., "workflow-email-step").
  Optional.
- `from` / `to` — ISO 8601 date bounds against `created_at`.
  Optional, defaults to last 7 days.
- `limit` — default 100, max 500.
- `offset` — default 0.

Response: `{items: [...], total, limit_hit}`. Per-item shape:

```ts
interface EmailQueueListItem {
  id: string;
  source_worker: string;
  source_kind: string;
  source_id: string;
  recipient: string;
  subject: string;
  status: "pending" | "claimed" | "sent" | "stuck";
  send_attempts: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
  sent_at: string | null;
}
```

Body html/text + attachments NOT in the list response — those
load only on detail. Keeps list payload small.

**1b. `GET /forms/admin/api/email-queue/{id}`**

Returns the full row including `body_html`, `body_text`,
`attachments` (with R2 keys, NOT inlined — admin viewer fetches
attachments separately if it wants previews; v1 just shows
the metadata list).

**1c. `POST /forms/admin/api/email-queue/{id}/retry`**

Admin-tier gated. Resets the row:
- `claimed_at = NULL`
- `claim_id = NULL`
- `send_attempts = 0`
- `last_error = NULL`

Row becomes eligible for the next PA poll. Returns the updated
row.

**1d. `POST /forms/admin/api/email-queue/{id}/abandon`**

Admin-tier gated. Forces the row out of the eligible pool:
- `send_attempts = 99` (well above the 5 cap)
- `last_error = "Manually abandoned by {admin_email} at {now}"`

Row stays in the table for audit but never sends. Returns the
updated row.

### Phase 2 — apps/web page

New route `apps/web/app/admin/email-queue/page.tsx`:

- Auth: admin-tier (`session.role === "super_admin"` OR `session.dcRole
  === "admin"|"super_admin"`). Worker re-validates.
- Server-rendered list.
- **Filter row**: Status dropdown / Source worker dropdown / Source
  kind dropdown / DateRangePicker (last 7 days default).
- **Table columns**:
  - Created (relative + absolute on hover, EST per `formatEst()`).
  - Source (compact: `{source_worker} / {source_kind}`).
  - Recipient (truncate at 30 chars; full on hover).
  - Subject (truncate at 60 chars; full on hover).
  - Status pill (color-coded: pending = neutral, claimed = info,
    sent = success, stuck = danger).
  - Attempts (count).
  - View → button linking to `/admin/email-queue/{id}`.
- Pagination via offset (page size 50).
- Empty state: "No emails in this filter range."

New route `apps/web/app/admin/email-queue/[id]/page.tsx`:

- Per-row detail. Metadata grid (id, source, recipient, status,
  attempts, all timestamps). Full subject. Body (rendered as
  preformatted text — escape HTML for safety). Attachments list
  (filename, mime, size). Last error (when present).
- Two action buttons (admin-tier only — page-gates and worker
  re-validates):
  - **Retry now** — POST to `/retry` endpoint via Brief 19
    `<ActionForm>` pattern. Success → row resets, redirect back to
    list with a success banner.
  - **Abandon** — POST to `/abandon` with a "Are you sure?"
    confirmation in the form payload. Stuck-only — button is
    disabled (with hover hint) if status is anything other than
    `stuck`.

### Phase 3 — Dashboard tile

Add to the Admin group in
`apps/web/app/admin/dashboard/_lib/tiles.tsx`:

```ts
{
  id: "email-queue",
  group: "admin",
  eyebrow: "INFRA",
  title: "Email Queue",
  description: "Pending, sent, and stuck outbound emails.",
  href: "/admin/email-queue",
  visibleTo: (session) =>
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
}
```

### Phase 4 — Middleware allow-list

**Per CLAUDE.md mandatory rule**: add `"email-queue"` to
`ADMIN_KNOWN_SUBPATHS` in `apps/web/middleware.ts`.

### Phase 5 — Validation

5.1 `pnpm typecheck` — must pass.
5.2 `pnpm --filter @splash/web build` — must succeed.
5.3 `pnpm --filter @splash/forms-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed.
5.4 No Supabase / R2 / wrangler.toml / secret changes (Brief 127
    landed the table + token).
5.5 Operator post-deploy smoke (deferred):
    - As super_admin, navigate to dashboard → Admin group → Email
      Queue tile visible. Click → land on /admin/email-queue.
    - Filter to Status=Pending → recent unsent rows visible.
    - Click View → detail page. Subject + body visible. Status
      pill matches list.
    - For a stuck row (or simulate by manually bumping a row's
      send_attempts to 5 via Supabase): Retry now button →
      submits → row reset, redirected to list, success banner.
      Next 5-min PA poll picks it up.
    - For a stuck row: Abandon button → submits with confirmation
      → row's send_attempts goes to 99, last_error stamped with
      admin email + timestamp.
    - As gm / rm / location_admin: dashboard tile NOT visible.
      Direct URL `/admin/email-queue` → page redirects or shows
      403 (worker re-validates).

### Phase 6 — Updates

6.1 BRIEFS/INDEX.md: Brief 128 row appended.

6.2 BUILD_STATE.md: Findings entry noting:
  - Brief 128 (YYYY-MM-DD) — admin-gated email queue viewer at
    `/admin/email-queue`. List with status / source / date filters,
    per-row detail, Retry + Abandon actions. Companion to
    Brief 127's outbound_emails infrastructure.

6.3 CLAUDE.md outbound_emails glossary entry: append a Brief 128
sentence documenting the admin viewer endpoints + the two
operator actions (Retry / Abandon).

## Out of scope

- Bulk retry / bulk abandon. v2 if operator needs.
- Editing the email body before retry (e.g., fixing a typo in
  the subject before re-sending). Operator can DELETE the row in
  SQL and re-submit the originating form / re-enqueue from the
  source worker; admin-side editing of queued emails is risky
  and rarely-needed.
- Per-row audit log of admin actions on the queue (retry by
  whom, abandon by whom). v2 — add a `claim_audit` jsonb column
  or a separate `outbound_email_admin_log` table when there's
  multi-admin contention.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `GET /forms/admin/api/email-queue/list` returns filterable rows.
- `GET /forms/admin/api/email-queue/{id}` returns full row.
- `POST /forms/admin/api/email-queue/{id}/retry` resets the row.
- `POST /forms/admin/api/email-queue/{id}/abandon` parks the row.
- `/admin/email-queue` list page renders with filters + pagination.
- `/admin/email-queue/{id}` detail page renders with Retry +
  Abandon action buttons.
- "Email Queue" tile visible to admin-tier in the Admin group.
- `"email-queue"` added to `ADMIN_KNOWN_SUBPATHS`.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/web build` succeeds.
- `pnpm --filter @splash/forms-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 6.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size estimate.
- Validation results.
- Any cases where the body_html renders unsafely in the detail
  page (should be escaped by default — confirm React's auto-escape
  is doing the job).

## Outcome

### Diff size estimate

- 5 new files: `apps/forms-worker/src/admin/email-queue.ts` (~360 LOC);
  `apps/web/app/admin/email-queue/page.tsx` (~370 LOC);
  `apps/web/app/admin/email-queue/[id]/page.tsx` (~280 LOC);
  `apps/web/app/admin/email-queue/actions.ts` (~60 LOC);
  `apps/web/app/admin/email-queue/_components/ConfirmSubmitButton.tsx`
  (~25 LOC).
- 6 files modified: `apps/forms-worker/src/index.ts` (route mounts +
  header comment); `apps/web/app/admin/forms/_lib/worker-fetch.ts`
  (Brief 128 helper block — 4 helpers + 8 types/interfaces);
  `apps/web/app/admin/dashboard/_lib/tiles.tsx` (Email Queue tile +
  mailIcon SVG); `apps/web/middleware.ts` (ADMIN_KNOWN_SUBPATHS).
- 3 documentation files updated: `CLAUDE.md` (Brief 128 follow-up
  paragraph appended to `outbound_emails table` glossary entry);
  `BUILD_STATE.md` (Last updated bumped + Findings entry prepended);
  `BRIEFS/INDEX.md` (Brief 128 row inserted above Brief 127).

### Validation results

- Root `pnpm typecheck`: **18/18 green** (17 cache hits, web +
  forms-worker ran fresh due to the new modules + types).
- `pnpm --filter @splash/web build`: **succeeded**. New route bundle
  metrics: `/admin/email-queue` 939 B / 108 kB First-Load JS;
  `/admin/email-queue/[id]` 854 B / 108 kB First-Load JS. Other
  routes unchanged.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
  --outdir=.tmp-build`: **succeeded**. Bundle 1138.91 KiB raw /
  218.64 KiB gzipped (≈ +11 KiB raw / +2 KiB gzip vs Brief 127
  baseline of 1127.87 / 216.90, all admin-viewer handler).
  `.tmp-build` removed.

### Body_html safety — React auto-escape confirmed

The detail page renders `body_html` (and `body_text`) inside
`<pre>{value}</pre>`. React's JSX rendering auto-escapes string
children — when a string like `<img src=x onerror=alert(1)>` is
passed as a child, React inserts text nodes, not HTML. The browser
displays the markup as visible characters; no DOM injection occurs.
This is the same defensive default used by the Brief 96
`PayloadRenderer` and the Brief 113 JotForm answer renderer. We do
NOT call `dangerouslySetInnerHTML` anywhere in this brief.

### Decisions made on operator's behalf

(See BUILD_STATE.md's full decisions list — 9 decisions documented
there. Highlights below.)

1. **Status derived in handler, not stored**: Brief 127's table has
   no `status` column; this brief derives pending / claimed / sent /
   stuck from row state in the handler. Keeps the schema unchanged
   and the derivation rules in one place. Future executors adjusting
   the eligibility predicates (e.g., raising the `send_attempts < 5`
   cap) must update Brief 127's `claim_outbound_emails` function AND
   `rowStatus` / `applyStatusFilter` in lockstep.
2. **Attachment metadata only — no r2_key leak**: detail returns
   filename / mime / size_bytes + booleans for "has r2_key" / "has
   base64", not the r2_key itself. Avoids leaking R2 bucket layout
   into admin payloads.
3. **Body_html as escaped text, not live HTML**: defensive default.
   "Render live HTML" toggle would be a deliberate brief, not a
   stealth XSS surface in v1.
4. **Abandon = `confirm=yes` hidden + window.confirm() prompt**:
   two-factor defense. Server action validates the hidden value as
   belt-and-suspenders against a JS-disabled browser hitting the
   form.
5. **List orders by `created_at desc`**: newest-first matches the
   "did that email send?" investigation flow. Ordering by
   `scheduled_for` (the eligible-pool index) would surface backdated
   rows ahead of just-enqueued ones.
6. **Status defaults to "All"**: operators arriving from the
   dashboard tile usually need "all statuses" visibility to answer
   "did it send?"; "Pending" as default would hide the answer.
7. **Source dropdowns via `<datalist>` from current page values**:
   Brief 127 has only one (source_worker, source_kind) tuple in
   active use today; a roster endpoint would be ceremony.
8. **Brief 19 `<ActionForm>` + dual `revalidatePath`**: both the
   list AND detail surfaces refresh post-action without manual
   reload.
9. **Per-row admin-action audit log deferred to v2**: abandon's
   `last_error` includes the admin email, which is enough for the
   current single-admin operational mode.

### Latent issues / forward flags

- (a) Bulk retry / bulk abandon deferred to v2.
- (b) Editing body before retry deferred — workflow is "delete row +
  re-trigger source worker."
- (c) Per-row admin-action audit log deferred to v2.
- (d) List payload `total` is `null` when PostgREST returns `*` as
  the Content-Range upper bound; paginator falls back to "Showing
  rows N–M" without a known total.
- (e) Status taxonomy is derived in handler code; Brief 127's
  eligibility predicates must stay in sync.

### Files created

- `apps/forms-worker/src/admin/email-queue.ts`
- `apps/web/app/admin/email-queue/page.tsx`
- `apps/web/app/admin/email-queue/[id]/page.tsx`
- `apps/web/app/admin/email-queue/actions.ts`
- `apps/web/app/admin/email-queue/_components/ConfirmSubmitButton.tsx`

### Files modified

- `apps/forms-worker/src/index.ts`
- `apps/web/app/admin/forms/_lib/worker-fetch.ts`
- `apps/web/app/admin/dashboard/_lib/tiles.tsx`
- `apps/web/middleware.ts`
- `BRIEFS/INDEX.md`
- `BUILD_STATE.md`
- `CLAUDE.md`

### Files deleted

None.

### Operator post-deploy smoke (deferred per brief Phase 5.5)

See BUILD_STATE.md Findings entry for the 6-step verification
checklist. Key requirement: Brief 127's SQL block (CREATE TABLE
outbound_emails + indexes + `claim_outbound_emails` function) must
already exist in Supabase — Brief 128 reads from that table without
adding schema.
