# Brief 97: Forms — webhook on submit + daily R2 cleanup cron

**Status:** Completed (2026-05-10)
**Started:** 2026-05-10
**Completed:** 2026-05-10
**Blocks:** Brief 98 (polish — final smoke pass should include webhook + cron observability).
**Dependencies:** Brief 89 (foundation — `FORMS_SUBMISSION_WEBHOOK_URL` declared, R2 binding), Brief 91 (submit handler — webhook fires on success), Brief 92 (R2 path conventions for cleanup), Brief 94 (assets in R2 — cleanup pass for orphaned assets).

## Read first

- BUILD_STATE.md.
- CLAUDE.md.
- BRIEFS/brief-032-claim-summary-pdf-and-customer-email.md (precedent — `CUSTOMER_CLAIM_WEBHOOK_URL` posture, fail-soft, 15s timeout).
- BRIEFS/brief-048-customer-webhook-add-site-email.md (precedent — extending webhook payload).
- BRIEFS/brief-065-daily-open-claims-summary-cron.md (precedent — scheduled handler, observability logs cover cron invocations automatically).
- BRIEFS/brief-091-forms-public-submit.md (the submit handler this brief extends with the webhook fire).

## Architecture context

Per planning Decision 6:

**Webhook posture (B):** worker-level secret `FORMS_SUBMISSION_WEBHOOK_URL`. Single endpoint, payload includes form metadata, Power Automate routes by `form.id` / `form.slug`. Per-form `notify_webhook` flag in form metadata for opt-out. v1 doesn't support per-form URLs (security: a compromised admin could pipe submissions to attacker if URLs were operator-typed).

**Files-by-URL** (NOT base64-when-small per Decision 6 confirmation): each file/signature payload entry in the webhook's `files` array carries a `download_url` pointing at `/forms/admin/api/files/{r2_key}` — the auth-gated serve route from Brief 92. PA fetches via the URL when needed. Saves us from the >3MB base64 cap pain that hit damage-worker; PA flows authenticate as a service account and have read access.

**Webhook timeout & failure handling:** 15s `AbortController` timeout. Fail-soft — submission already persisted by the time webhook fires; webhook failure is logged with `[forms.webhook]` prefix but does NOT roll back the submission. Same posture as `CUSTOMER_CLAIM_WEBHOOK_URL` per CLAUDE.md.

Per planning Decision 4 + 6, **daily cleanup cron** runs at **11:00 UTC** (picked to not collide with damage-worker 13:00 UTC daily summary or workorders-worker 11:30 UTC MaintainX sync). Two passes:

1. **Orphan submission files**: list R2 under `form-submission-files/`, age > 24h, no matching `form_submissions.id` (the `pending_submission_id` in the path) → delete.
2. **Orphan form assets**: list R2 under `form-assets/`, no matching `form_assets.r2_key` row → delete. (Triggered when an operator deletes an asset from the builder; the Brief 94 DELETE handler does the R2 delete inline, but the cron is the safety net for any failures.)

Logged to console + optionally to a `DAILY_SUMMARY_WEBHOOK_URL`-style hook if you want Power Automate visibility. Per CLAUDE.md, the worker's existing `[observability.logs]` block (Brief 89) covers scheduled invocations automatically — they show up with `eventType: scheduled` in CF dashboard.

## Context

Ninth of 10 briefs. After this brief, the worker has its complete runtime — Power Automate gets pinged on every submission (when bound), and orphan R2 cleanup happens daily without operator intervention. Brief 98 wraps with polish (dashboard tile, error boundary, PRE_DEPLOY_FORMS.md final pass).

## Scope

### Phase 1 — Webhook fire on submit success

**File:** `apps/forms-worker/src/submit/webhook.ts` (NEW).

```ts
import type { FormMeta } from "@splash/forms-schema";
import type { Env } from "../index";
import type { SubmissionRow } from "../db/forms";
import type { FormVersion } from "@splash/forms-schema";

interface WebhookFile {
  field_key: string;
  r2_key: string;
  mime: string;
  size_bytes: number;
  download_url: string;
}

export async function fireSubmissionWebhook(args: {
  env: Env;
  reqOrigin: string;          // browser's hostname for building admin URLs
  form: FormMeta;
  version: FormVersion;
  submission: SubmissionRow;
  files: WebhookFile[];
}): Promise<void> {
  const { env, reqOrigin, form, version, submission, files } = args;

  if (!env.FORMS_SUBMISSION_WEBHOOK_URL) {
    // Unbound — fail-soft, skip.
    return;
  }
  if (!form.notifyWebhook) {
    // Per-form opt-out — skip.
    return;
  }

  const adminBase = inferAdminBase(reqOrigin);

  const payload = {
    form: {
      id: form.id,
      slug: form.slug,
      title: form.title,
      version_number: version.versionNumber
    },
    submission: {
      id: submission.id,
      submitted_at: submission.submittedAt,
      submitter_kind: submission.submitterKind,
      submitter_email: submission.submitterEmail,
      submitter_user_id: submission.submitterUserId,
      submitter_ip: submission.submitterIp,
      splash_admin_url: `${adminBase}/admin/forms/${form.id}/submissions/${submission.id}`
    },
    payload: submission.payload,
    files
  };

  try {
    const res = await fetch(env.FORMS_SUBMISSION_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      console.warn(`[forms.webhook] non-2xx response: ${res.status}`, { formId: form.id, submissionId: submission.id });
    }
  } catch (e) {
    console.warn("[forms.webhook] fire failed (fail-soft)", { formId: form.id, submissionId: submission.id, error: String(e) });
  }
}

function inferAdminBase(reqOrigin: string): string {
  // For staging.splashcarwashes.info → use as-is.
  // For workers.dev URLs (dev/test) → fall back to splashcarwashes.info production URL,
  // which is fine because PA flows live in production and the link target should work
  // when the operator clicks it post-cutover. Acceptable tradeoff for v1.
  if (reqOrigin.includes("workers.dev")) return "https://splashcarwashes.info";
  return reqOrigin;
}
```

### Phase 2 — Wire into submit handler

**File:** `apps/forms-worker/src/submit/index.ts` (MODIFY — add webhook fire after the successful insert).

```ts
import { fireSubmissionWebhook } from "./webhook";

// ...inside handleSubmit, after the successful insertSubmissionIdempotent + form_submission_files insert:

// Build webhook file refs from the inserted file rows
const reqUrl = new URL(req.url);
const reqOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
const webhookFiles = fileRowsToInsert.map((row) => ({
  field_key: row.field_key,
  r2_key: row.r2_key,
  mime: row.mime,
  size_bytes: row.size_bytes,
  download_url: `${reqOrigin}/forms/admin/api/files/${encodeURIComponent(row.r2_key)}`
}));

// Fire and forget — don't block the response on webhook completion (use ctx.waitUntil)
ctx.waitUntil(fireSubmissionWebhook({
  env, reqOrigin, form, version, submission: inserted.row, files: webhookFiles
}));
```

(`ctx.waitUntil` keeps the worker alive long enough to complete the webhook POST after the response has been returned to the browser. Standard CF Workers pattern.)

The handler signature now needs `ctx: ExecutionContext` — already present in the `default export`'s fetch handler signature; pass it through to handleSubmit.

### Phase 3 — Daily cleanup cron handler

**File:** `apps/forms-worker/src/cron/cleanup.ts` (NEW).

```ts
import type { Env } from "../index";
import { createServiceClient } from "../db/forms";

const ORPHAN_TTL_HOURS = 24;

export async function runDailyCleanup(env: Env): Promise<{
  submissionFilesDeleted: number;
  assetsDeleted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const cutoff = new Date(Date.now() - ORPHAN_TTL_HOURS * 60 * 60 * 1000);

  let submissionFilesDeleted = 0;
  let assetsDeleted = 0;

  // PASS 1 — orphan submission files
  // Strategy: list R2 under form-submission-files/, batch-extract pending_submission_id
  // from each path, query Supabase for matching form_submissions.id, delete R2 objects
  // whose id has no row AND age > cutoff.
  try {
    const client = createServiceClient(env);
    let cursor: string | undefined;
    let pageCount = 0;
    const HARD_PAGE_CAP = 50;   // 50 pages × 1000 objects = 50K — defensive

    do {
      const list = await env.FORMS_FILES.list({
        prefix: "form-submission-files/",
        cursor,
        limit: 1000
      });
      pageCount++;

      // Group objects by pending_submission_id (extracted from path)
      const idToObjects: Map<string, Array<{ key: string; uploaded: Date }>> = new Map();
      for (const obj of list.objects) {
        if (obj.uploaded > cutoff) continue;   // too recent to be orphan
        const parts = obj.key.split("/");
        if (parts.length < 3) continue;        // malformed path
        const pendingId = parts[2];
        if (!idToObjects.has(pendingId)) idToObjects.set(pendingId, []);
        idToObjects.get(pendingId)!.push({ key: obj.key, uploaded: obj.uploaded });
      }

      if (idToObjects.size > 0) {
        // Query Supabase: which of these IDs have actual submission rows?
        const ids = Array.from(idToObjects.keys());
        const { data, error } = await client
          .from("form_submissions")
          .select("id")
          .in("id", ids);
        if (error) {
          errors.push(`Supabase query failed: ${error.message}`);
          break;
        }
        const knownIds = new Set((data ?? []).map((r) => r.id));

        // Delete orphans
        for (const [pendingId, objects] of idToObjects.entries()) {
          if (knownIds.has(pendingId)) continue;
          for (const obj of objects) {
            try {
              await env.FORMS_FILES.delete(obj.key);
              submissionFilesDeleted++;
            } catch (e) {
              errors.push(`R2 delete ${obj.key} failed: ${String(e)}`);
            }
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && pageCount < HARD_PAGE_CAP);

    if (pageCount >= HARD_PAGE_CAP) {
      errors.push(`Pagination cap hit (${HARD_PAGE_CAP} pages); some orphans may remain. Cron will catch them next run.`);
    }
  } catch (e) {
    errors.push(`Pass 1 (submission files) crashed: ${String(e)}`);
  }

  // PASS 2 — orphan form assets
  try {
    const client = createServiceClient(env);
    let cursor: string | undefined;
    let pageCount = 0;
    const HARD_PAGE_CAP = 20;

    do {
      const list = await env.FORMS_FILES.list({
        prefix: "form-assets/",
        cursor,
        limit: 1000
      });
      pageCount++;

      if (list.objects.length > 0) {
        const r2Keys = list.objects.map((o) => o.key);
        const { data, error } = await client
          .from("form_assets")
          .select("r2_key")
          .in("r2_key", r2Keys);
        if (error) {
          errors.push(`Supabase asset query failed: ${error.message}`);
          break;
        }
        const knownKeys = new Set((data ?? []).map((r) => r.r2_key as string));

        for (const obj of list.objects) {
          if (knownKeys.has(obj.key)) continue;
          // Conservative: only delete if uploaded > 1 hour ago (avoid race with new asset upload)
          if (Date.now() - obj.uploaded.getTime() < 60 * 60 * 1000) continue;
          try {
            await env.FORMS_FILES.delete(obj.key);
            assetsDeleted++;
          } catch (e) {
            errors.push(`R2 delete asset ${obj.key} failed: ${String(e)}`);
          }
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor && pageCount < HARD_PAGE_CAP);
  } catch (e) {
    errors.push(`Pass 2 (assets) crashed: ${String(e)}`);
  }

  console.log("[forms.cleanup] complete", { submissionFilesDeleted, assetsDeleted, errorCount: errors.length });
  if (errors.length > 0) {
    console.warn("[forms.cleanup] errors", errors);
  }
  return { submissionFilesDeleted, assetsDeleted, errors };
}
```

### Phase 4 — Wire scheduled handler

**File:** `apps/forms-worker/src/index.ts` (MODIFY).

```ts
import { runDailyCleanup } from "./cron/cleanup";

// Replace the default export with:
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... existing fetch handler ...
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyCleanup(env).then((result) => {
      console.log("[forms.cleanup.cron] result", result);
    }));
  }
};
```

### Phase 5 — wrangler.toml cron trigger

**File:** `apps/forms-worker/wrangler.toml` (MODIFY). Add the cron trigger:

```toml
# Brief 97 — daily R2 cleanup cron. 11:00 UTC chosen to avoid colliding with:
#   - damage-worker daily summary at 13:00 UTC (Brief 65)
#   - workorders-worker MaintainX sync at 11:30 UTC (Brief 71)
# Two passes: orphan submission files (>24h, no matching form_submissions.id)
# and orphan form assets (>1h, no matching form_assets.r2_key row).
[triggers]
crons = ["0 11 * * *"]
```

### Phase 6 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 entries:

> ### Brief 97 — webhook + cron
>
> 1. Bind `FORMS_SUBMISSION_WEBHOOK_URL`: `pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_SUBMISSION_WEBHOOK_URL`.
> 2. Submit a public form. Verify Power Automate flow receives the JSON payload with the expected shape (form / submission / payload / files arrays).
> 3. Disable webhook on a form: PATCH `notify_webhook = false`. Submit again — verify PA does NOT receive the payload.
> 4. Submit a form with a file. Verify webhook payload includes `files: [{r2_key, download_url, ...}]`. Click the download_url from PA — file downloads (gated by admin auth on the serve route).
> 5. Trigger cron manually: in CF dashboard, Workers & Pages → splash-forms → Triggers → Cron Triggers → "0 11 * * *" → Trigger. Watch logs for `[forms.cleanup] complete` line.
> 6. Pre-create an orphan: upload a file via the upload endpoint with a fake `pending_submission_id`. Don't submit. Wait 24h+ (or shorten the TTL temporarily for testing). Trigger cron. Verify the R2 object is deleted.
> 7. Verify Workers Logs in CF dashboard: scheduled invocations show with `eventType: scheduled` (Brief 63's `[observability.logs]` block from Brief 89 covers them automatically).

**File:** `CLAUDE.md`. Append to forms-worker glossary:

> Brief 97 wired the submission webhook + daily cleanup cron. Webhook secret: `FORMS_SUBMISSION_WEBHOOK_URL` (optional, fail-soft when unbound). Per-form opt-out via `forms.notify_webhook = false`. Files-by-URL in payload (NOT base64) — PA fetches via auth-gated `/forms/admin/api/files/{r2_key}` route from Brief 92. 15s timeout, fail-soft on non-2xx. Fired via `ctx.waitUntil` after submission insert succeeds (doesn't block response). Daily cleanup cron at 11:00 UTC (picked to not collide with damage 13:00 / workorders 11:30). Two passes: orphan submission files (>24h, no matching `form_submissions.id`) and orphan form assets (>1h, no matching `form_assets.r2_key` row). Hard pagination caps (50 pages × 1000 = 50K submission files; 20 pages × 1000 = 20K assets) prevent runaway. Logs `[forms.cleanup] complete` with counts on every run.

**File:** `BUILD_STATE.md` + `BRIEFS/INDEX.md` — update entries.

### Phase 7 — Validation

```sh
pnpm --filter @splash/forms-worker typecheck
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run
pnpm typecheck
```

## Configuration

```sh
pnpm --filter @splash/forms-worker exec wrangler secret put FORMS_SUBMISSION_WEBHOOK_URL
# (Optional — worker fails soft when unbound. Recommended for production.)
```

## Out of scope

- Per-form custom webhook URLs (operator-typed) — explicit security deferral per Decision 6.
- Webhook payload base64-when-small flavor — Decision 6 picked URL-only.
- Webhook retry / dead-letter queue — fail-soft per damage-worker precedent.
- Cron frequency tuning — daily is the agreed cadence; if R2 storage grows fast, frequency can be increased without code change (just edit `[triggers] crons`).
- Emailing operators on cleanup errors — surfaced to logs only v1; alerting is operator-side.
- Don't deploy to Cloudflare automatically.
- Don't bind production routes — staging only.
- Don't add to QUEUE.md until operator decides.
- Don't commit to git or push.

## Definition of done

- `apps/forms-worker/src/submit/webhook.ts` exists.
- `apps/forms-worker/src/submit/index.ts` fires webhook via `ctx.waitUntil`.
- `apps/forms-worker/src/cron/cleanup.ts` exists with `runDailyCleanup`.
- `apps/forms-worker/src/index.ts` default export exposes `{ fetch, scheduled }`.
- `apps/forms-worker/wrangler.toml` has the `[triggers] crons` block.
- Smoke tests pass at the operator level.
- `pnpm typecheck` green.
- `wrangler deploy --dry-run` green.
- Brief Status flips to Completed.

## Report

- **`ctx.waitUntil` propagation.** Confirm the submit handler's signature was extended end-to-end (the `ExecutionContext` parameter must reach `fireSubmissionWebhook`).
- **Cron testing.** If the executor manually triggered the cron, surface the actual deletion counts. Otherwise document that smoke is operator-deferred.
- **R2 list pagination cost.** Each `env.FORMS_FILES.list({limit:1000})` is one R2 op. Surface the typical page count for current bucket size.
- **Validation results.**

## Outcome

### Files created

- `apps/forms-worker/src/submit/webhook.ts` — `fireSubmissionWebhook` + `inferAdminBase` helper. Same fail-soft posture as damage-worker's `CUSTOMER_CLAIM_WEBHOOK_URL` (Brief 32 / 48): 15s `AbortController` timeout, structured logs `[forms.webhook] non-2xx response: <status>` on non-2xx and `[forms.webhook] fire failed (fail-soft)` on a thrown exception. Per-form opt-out via `forms.notify_webhook = false`. Files-by-URL in payload (NOT base64 per planning Decision 6) — each entry carries `download_url` pointing at `/forms/admin/api/files/{r2_key}` (Brief 92 admin-gated serve route).
- `apps/forms-worker/src/cron/cleanup.ts` — `runDailyCleanup(env)` with two passes (orphan submission files >24h with no matching `form_submissions.id`; orphan form assets >1h grace with no matching `form_assets.r2_key`). Returns `{submissionFilesDeleted, assetsDeleted, submissionPagesScanned, assetPagesScanned, errors}` and logs `[forms.cleanup] complete` with all five fields on every run. Hard pagination caps 50 pages × 1000 = 50K submission files; 20 pages × 1000 = 20K assets per run.

### Files modified

- `apps/forms-worker/src/submit/index.ts` — `handleSubmit` signature gains `ctx: ExecutionContext` parameter (plumbed through end-to-end from the worker fetch handler). Webhook fire wrapped in `ctx.waitUntil` after the canonical submission insert + file rows insert lands; **skipped on idempotent re-submits** (only `inserted.wasNew === true` fires, preventing duplicate PA notifications on network retries) and skipped when `FORMS_SUBMISSION_WEBHOOK_URL` is unbound or `form.notifyWebhook` is false. Type fix on the local `inserted` declaration (was `{row: {id: string}}`, now `{row: SubmissionRow}` to match the helper's actual return type — required for the webhook payload's `submitterKind` / `submitterEmail` / `submittedAt` field reads). Added `SubmissionRow` to the import from `../db/forms.js`.
- `apps/forms-worker/src/index.ts` — default export now `{fetch, scheduled}`. `scheduled(_event: ScheduledController, env, ctx)` runs `runDailyCleanup` via `ctx.waitUntil` and logs `[forms.cleanup.cron] result`. Submit route plumbs `ctx` through (was `_ctx`). Added `runDailyCleanup` import + comment block at the top describing the new cron behavior.
- `apps/forms-worker/wrangler.toml` — added `[triggers] crons = ["0 11 * * *"]` block (replaces the placeholder comment Brief 89 left for this brief). 11:00 UTC slot picked to NOT collide with damage-worker's daily summary at 13:00 UTC (Brief 65) or workorders-worker's MaintainX sync at 11:30 UTC (Brief 71).
- `PRE_DEPLOY_FORMS.md` — Section 5 gains 10 Brief-97 smoke tests covering: webhook bind + fire, per-form opt-out, file-bearing webhook with `download_url` click-through, idempotent re-submit no-double-fire, cron manual trigger, pre-create-orphan submission file, pre-create-orphan asset, Workers Logs scheduled-eventType verification, and webhook 5xx fail-soft (user still sees success page).
- `CLAUDE.md` — forms-worker glossary extended with the Brief 97 paragraph (webhook posture, files-by-URL, idempotency-no-double-fire, daily cron at 11:00 UTC, two passes, hard pagination caps, observability log convention).
- `BUILD_STATE.md` — bumped "Last updated" to Brief 97; added Findings entry; appended Brief 97 row to the prioritized work list.
- `BRIEFS/INDEX.md` — appended Brief 97 row.
- `BRIEFS/QUEUE.md` — moved `brief-097-forms-webhook-cron-cleanup.md` to the completed list.

### Decisions made on operator's behalf

1. **Import path correction.** The brief's sample code imported `createServiceClient` from `../db/forms`, but `db/forms.ts` does NOT export it — that module uses direct PostgREST `fetch()` (the Brief 89 / 94 pattern matching `@splash/db-supabase/maintainx-users.ts`). I imported `createServiceClient` from `@splash/db-supabase` instead, matching the existing import pattern in `submit/index.ts`'s lookup re-resolve path.
2. **Skipped firing the webhook on idempotent re-submits.** The brief's sample wires `ctx.waitUntil` unconditionally after the file rows insert, but `inserted.wasNew === false` means the canonical row already exists from an earlier successful POST that DID fire the webhook. Re-firing would deliver duplicate PA notifications. The Brief 91 docblock on `insertSubmissionIdempotent` flagged this as a "Brief 97 may use this to gate webhook fires" intention, so I followed through.
3. **Used `ScheduledController` (not `ScheduledEvent`)** in the scheduled handler signature, matching the existing pattern in damage-worker and workorders-worker. The brief's sample used the older `ScheduledEvent` type name.
4. **Returned page-count metrics** from `runDailyCleanup` (`submissionPagesScanned` + `assetPagesScanned`) so the operator can observe per-run R2 list pagination cost without grepping logs — minor extension over the brief's `{submissionFilesDeleted, assetsDeleted, errors}` shape. Backward-compatible (additive).
5. **`inferAdminBase` extended** to make staging hostname pass-through explicit alongside the workers.dev rewrite. The brief's sample only handled `workers.dev`; my version adds an explicit `staging.splashcarwashes.info` branch (resulting behavior identical, but the intent is clearer to readers).

### Latent issues

- **R2 list pagination cost.** Each `env.FORMS_FILES.list({limit:1000})` is one R2 op. At current bucket size (effectively empty pre-deploy), the cron will be 1 page per pass = 2 R2 list ops + 0 deletes per run; cost is negligible. Will scale linearly with bucket size; if either pagination cap (50 pages submission / 20 pages assets) starts getting hit regularly, frequency can be increased without code change (just edit `[triggers] crons`) or the per-run cap can be raised.
- **Webhook payload size.** PA flow with files-by-URL keeps the payload bounded — submission row + file refs only, no embedded bytes. No size cap needed at v1. If a future field type embeds large derived data in the payload JSONB (e.g., signature SVG strings expanded into the payload), a size cap on the webhook body would become prudent.
- **Webhook does not surface DLQ / retry.** Per CLAUDE.md / damage-worker precedent, fail-soft means a transient PA outage drops notifications. PA itself can replay from a queue if it builds one; the v1 worker does not.
- **`splash_admin_url` link landing on production base from workers.dev.** The `inferAdminBase` rewrite means a webhook fired from `splash-forms.<account>.workers.dev` (dev / pre-cutover) sends a payload whose `splash_admin_url` points at `https://splashcarwashes.info/admin/forms/...` — that production URL won't exist until apps/web's `/admin/forms` lands in production. Acceptable v1 tradeoff because PA flows (consuming the payload) live in production; if dev-environment PA flows are added later, this should become per-flow configurable.

### Validation results

- `pnpm --filter @splash/forms-worker typecheck` — green on second attempt. First attempt surfaced `TS2740: Type '{ id: string; }' is missing the following properties from type 'SubmissionRow'` on the webhook payload's `inserted.row` consumer; fixed by widening the local declaration's row type from `{id: string}` to `SubmissionRow` (the helper's actual return type was already richer).
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` — green. Bundle size 1043.10 KiB uncompressed / 199.91 KiB gzip — no significant size delta vs Brief 96 (the new modules are small; `@splash/db-supabase` and `@supabase/supabase-js` were already pulled in by the submit handler's lookup path). Bindings reported correctly: `FORMS_FILES`, `SUPABASE_URL`, `TURNSTILE_SITE_KEY` (secrets like `SUPABASE_SERVICE_KEY` / `SUPABASE_ANON_KEY` / `FORMS_SUBMISSION_WEBHOOK_URL` don't appear in dry-run output).
- Root `pnpm typecheck` — green across all 17 packages (Tasks: 17 successful, 17 total / 0 cached / 9.323s).
- **Cron testing deferred to operator** — the executor cannot trigger the scheduled handler from a workers.dev preview without `wrangler triggers deploy` (out of scope per CLAUDE.md "don't deploy to Cloudflare without explicit instruction"). First scheduled run will fire at the next 11:00 UTC after operator deploys; orphan-creation smoke tests in PRE_DEPLOY_FORMS.md Section 5 cover the verification path.

### Report (per brief's "Report" section)

- **`ctx.waitUntil` propagation.** Confirmed end-to-end. `apps/forms-worker/src/index.ts` fetch handler's parameter renamed `_ctx` → `ctx` and passed to `handleSubmit(env, req, ctx, slug)`. `apps/forms-worker/src/submit/index.ts:50` `handleSubmit` signature accepts `ctx: ExecutionContext` and uses it on line ~397 for `ctx.waitUntil(fireSubmissionWebhook({...}))`. The scheduled handler in `apps/forms-worker/src/index.ts:264` also uses `ctx.waitUntil` to keep the worker alive past the cron tick for the cleanup pass.
- **Cron testing.** Deferred to operator (smoke tests in PRE_DEPLOY_FORMS.md Section 5 #6–#9 cover both manual-trigger verification and orphan deletion verification with concrete pre-create instructions). The executor did not trigger the cron from the dev environment because that requires deploying.
- **R2 list pagination cost.** Bucket is currently empty at execution time (no R2 list call has been made by the cron yet). Each `list({limit:1000})` call is one R2 op; with a clean bucket the cron does 1 list per pass = 2 list ops total + 0 deletes per run. As the bucket grows, the cost scales linearly until the hard caps (50 pages submission / 20 pages assets); the caps surface a soft error in `runDailyCleanup`'s return value but do not abort, so surviving orphans get swept on the next day's run.
- **Validation results.** See "Validation results" section above.
