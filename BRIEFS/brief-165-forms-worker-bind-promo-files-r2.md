# Brief 165: forms-worker — bind PROMO_FILES R2 bucket

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Brief 160's queue-claim dispatch (`apps/forms-worker/src/email-queue/attachments.ts`) correctly routes attachments with `bucket: "PROMO_FILES"` to `env.PROMO_FILES`, but forms-worker's `wrangler.toml` only binds `FORMS_FILES`. Result: `env.PROMO_FILES` is `undefined`, the dispatch's `if (!bucket)` branch fires, every promo material is silently dropped from the PA claim response with log line `[forms.email-queue] attachment ... references unsupported or unbound bucket PROMO_FILES; skipping`. Body HTML still references `cid:material-{id}` but no attachment carries the bytes — recipients see broken-image placeholders even with Brief 161's worker-side queue payload correctly populated.
**Dependencies:** Brief 157 (promo-worker writes `bucket: "PROMO_FILES"` on attachments — the writer side is correct), Brief 160 (`OutboundEmailAttachment.bucket` union widening + the dispatch code that needs the binding), Brief 161 (the queue payload fix that made the binding gap visible — pre-161, the attachments array was empty so the dispatch never even tried to fetch).

## Read first

- BUILD_STATE.md
- CLAUDE.md — "outbound_emails table" glossary entry, specifically: "Adding a new bucket requires (a) widening this union, (b) **binding the bucket on forms-worker's wrangler.toml**, and (c) extending the dispatch in `apps/forms-worker/src/email-queue/attachments.ts`." Brief 160 documented (a) and (c) but (b) was never executed.
- BRIEFS/brief-160-promo-announcement-preview-branded-html-inline-materials.md (Phase 2.2 described the forms-worker claim handler dispatch but didn't include the wrangler.toml binding step).
- BRIEFS/brief-161-promo-announce-inline-materials-payload-fix.md (the worker-side fix that exposed this gap).
- apps/forms-worker/wrangler.toml (needs the new `[[r2_buckets]]` block).
- apps/forms-worker/src/index.ts (the `Env` interface — needs `PROMO_FILES?: R2Bucket`).
- apps/forms-worker/src/email-queue/attachments.ts (the dispatch is already correct — no code change here).

## Context

Empirical confirmation from a real send on 2026-06-07:

- promo-worker writes the queue row correctly: both inline-flagged materials present with `bucket: "PROMO_FILES"`, `is_inline: true`, `content_id: "material-{id}"`.
- PA's claim call to `/forms/internal/api/email-queue/claim` returns the row with `attachments: []` because the forms-worker dispatch dropped them.
- PA's Select action over `items('Apply_to_each')?['attachments']` correctly emits `{body: []}`.
- Send Email V2 receives zero attachments; body HTML's `<img src="cid:material-...">` references can't resolve.
- Recipient sees the branded shell + body + PTP but the inline images render as broken-image markers.

Brief 160 Phase 2.2 wrote the dispatch correctly but assumed the operator (or a follow-up brief) would add the binding. Brief 161 fixed the WORKER side correctly. Brief 165 closes the deployment-config gap.

Same posture as the forms-worker's own `FORMS_FILES` binding — this is a per-worker R2 binding declaration. No new R2 bucket, no new code, just a wrangler.toml entry + matching `Env` type widening.

## Scope

### Phase 1 — Add the binding

1.1 In `apps/forms-worker/wrangler.toml`, add a sibling `[[r2_buckets]]` block right after the existing `FORMS_FILES` block:

```toml
[[r2_buckets]]
binding     = "PROMO_FILES"
bucket_name = "splash-promo-files"
```

  - Same bucket name as promo-worker's binding (`apps/promo-worker/wrangler.toml`) — both workers hit the same `splash-promo-files` R2 bucket. Promo-worker writes (uploads via `handleUploadMaterial`); forms-worker reads (inlines at claim time via `inlineAttachments`).
  - The bucket itself already exists (created during Brief 153 setup). No `wrangler r2 bucket create` needed.
  - Brief 160 referenced this requirement in the "outbound_emails table" CLAUDE.md glossary entry — the wrangler.toml binding was supposed to land alongside the dispatch code, but the Brief 160 executor only patched the dispatch.

1.2 Add a comment above the new block explaining why two workers share the bucket:

```toml
# Brief 165 — read-side binding for promo-worker's announcement materials.
# Same bucket as promo-worker's writer-side binding (apps/promo-worker/
# wrangler.toml). Two-worker pattern: promo-worker uploads; forms-worker
# reads at email-queue claim time to inline materials into outbound emails
# (Brief 127 + 160). Adding a third bucket-sharing worker would follow the
# same shape — bind here AND on the writer's wrangler.toml, extend the
# OutboundEmailAttachment.bucket union, extend attachments.ts dispatch.
[[r2_buckets]]
binding     = "PROMO_FILES"
bucket_name = "splash-promo-files"
```

### Phase 2 — Widen the `Env` interface

2.1 In `apps/forms-worker/src/index.ts` (or wherever forms-worker's `Env` interface is declared), add the optional binding:

```ts
export interface Env {
  // ... existing bindings ...
  FORMS_FILES: R2Bucket;
  /** Brief 165 — read-only access to promo-worker's R2 bucket for
   *  inlining announcement materials at claim time. Optional in code
   *  (the dispatch in email-queue/attachments.ts fails soft when the
   *  binding is missing — logs and skips the attachment) so a pre-165
   *  forms-worker deploy without the binding doesn't crash; it just
   *  drops promo attachments with a log line. */
  PROMO_FILES?: R2Bucket;
}
```

  - Optional (`?`) so the existing fail-soft dispatch in `attachments.ts` continues to type-check.
  - The dispatch in `inlineAttachments` reads `env.PROMO_FILES ?? null` already — once bound at deploy, the null fallback never fires.

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle must succeed; clean up. The new binding shouldn't materially change bundle size (it's a TOML-only entry; the runtime binding is provided by CF, not bundled).
3.3 Operator manual verification post-deploy:
  - Re-send the test promo announcement with at least one inline image material.
  - Within 5 minutes the PA flow drains the queue.
  - Inbox copy renders the inline image embedded in the body (NO broken-image placeholder).
  - Re-run the diagnostic SQL:
    ```sql
    SELECT
      jsonb_array_length(attachments) AS attachment_count,
      body_html LIKE '%cid:material-%' AS has_inline_refs
    FROM outbound_emails
    WHERE source_kind = 'promo-announcement'
    ORDER BY created_at DESC LIMIT 1;
    ```
    Attachment count + inline refs unchanged from current state (the worker side is correct). The change is on the WIRE between forms-worker and PA.
  - Check splash-forms Workers Logs for the `[forms.email-queue] attachment ... references unsupported or unbound bucket PROMO_FILES; skipping` line — it should NO LONGER appear on subsequent runs after the deploy.

### Phase 4 — Docs

4.1 BRIEFS/INDEX.md: Brief 165 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 160/161 left the forms-worker `PROMO_FILES` R2 binding unbound — dispatch in attachments.ts was correct but the wrangler.toml binding was never added
  - Result: claim endpoint silently dropped every promo material from the PA response, recipients saw broken-image placeholders
  - Brief 165 closes the gap with one `[[r2_buckets]]` entry + matching `Env` type widening
  - Two-worker R2 bucket sharing pattern (promo-worker writes; forms-worker reads) now documented inline in both wrangler.toml files

4.3 CLAUDE.md updates:
  - "outbound_emails table" glossary entry: tighten the "Adding a new bucket requires..." paragraph to note that step (b) MUST land alongside steps (a) and (c) — Brief 165 documents the bug class so future bucket additions don't repeat it.
  - "forms-worker" glossary entry: brief mention of the dual-bucket binding (`FORMS_FILES` + `PROMO_FILES`) and why both are needed.

## Out of scope

- Adding a third bucket sharing path. The pattern is documented; future workers follow the same shape.
- Programmatic verification that all enqueued bucket names match a bound R2 binding (a "drift check"). Could be a future hardening brief.
- Moving `inlineAttachments` to a shared package. The dispatch is forms-worker-specific because it's the queue-claim endpoint.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/forms-worker/wrangler.toml` has a second `[[r2_buckets]]` block binding `PROMO_FILES` → `splash-promo-files`
- `apps/forms-worker/src/index.ts` `Env` interface gains optional `PROMO_FILES?: R2Bucket`
- pnpm typecheck passes
- forms-worker dry-run deploy succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected ~15 LOC: wrangler.toml entry + Env widening + comments)
- Confirmation that:
  - Dispatch's `if (!bucket)` branch in `attachments.ts` is now ONLY hit for genuinely unknown bucket strings (not for the bound PROMO_FILES case)
  - Validation results
- Any decisions made on the operator's behalf

## Outcome

### Files modified (4)

1. **`apps/forms-worker/wrangler.toml`** — added a sibling `[[r2_buckets]]` block right after the existing `FORMS_FILES` block, with a 6-line block comment above documenting the two-worker R2-sharing pattern. Block contents per the brief spec:
   ```toml
   [[r2_buckets]]
   binding     = "PROMO_FILES"
   bucket_name = "splash-promo-files"
   ```
   Same bucket name as `apps/promo-worker/wrangler.toml`'s writer-side binding.

2. **`BRIEFS/INDEX.md`** — new Brief 165 row prepended to the table.

3. **`BUILD_STATE.md`** — "Last updated" header bumped to 2026-06-06 with the Brief 165 summary; new Findings entry prepended to the log.

4. **`CLAUDE.md`** — two glossary entry updates:
   - **forms-worker glossary entry** widened to list `PROMO_FILES` alongside `FORMS_FILES` as a bound R2 bucket, with cross-reference to Brief 156 / 165.
   - **outbound_emails table glossary entry** tightened with an "Adding a new bucket to this queue's attachment surface is a STRICTLY three-step change" paragraph documenting the bug class Brief 165 closed (Briefs 160/161 did steps (a) and (c) but never executed step (b), causing every promo material to silently drop from PA claim responses).

### Files created

None — Brief 165 is purely a deployment-config + docs change.

### Decisions made on operator's behalf

1. **`Env` interface unchanged.** Phase 2 of the brief specced adding `PROMO_FILES?: R2Bucket` to the `Env` interface in `apps/forms-worker/src/index.ts`. Verified on read that the field is **already present** at `apps/forms-worker/src/index.ts:143` (added in Brief 157 alongside the dispatch). No code change needed. Documented in the Brief 165 findings entry.

2. **Bucket pre-exists.** Phase 1.1 noted that the `splash-promo-files` bucket was created during Brief 153 setup; no `wrangler r2 bucket create` step needed. Verified via the wrangler dry-run output which now lists `env.PROMO_FILES (splash-promo-files)` as a bound resource without complaint.

3. **Optional binding kept optional.** The `Env.PROMO_FILES?: R2Bucket` declaration uses `?` per Brief 157's defensive pattern. The dispatch in `attachments.ts` reads `env.PROMO_FILES ?? null` and fails soft. If a future brief temporarily unbinds the bucket, the dispatch still type-checks and degrades gracefully.

4. **Inline TOML comment documents the cross-worker pattern.** The 6-line block comment above the new `[[r2_buckets]]` entry explains the two-worker R2-sharing pattern in operator-actionable terms ("Adding a third bucket-sharing worker would follow the same shape — bind here AND on the writer's wrangler.toml, extend the OutboundEmailAttachment.bucket union, extend attachments.ts dispatch."). Mirrors the CLAUDE.md glossary entry's tightened wording so the requirement is documented in three load-bearing places: the wrangler.toml itself, the CLAUDE.md outbound_emails glossary entry, and the BRIEFS/INDEX.md row for this brief.

### Latent issues found

1. **Operator post-deploy verification required.** Per Phase 3.3 of the brief: re-send a test promo announcement with at least one inline image material; within 5 minutes the PA flow drains the queue; the inbox copy should render the inline image embedded in the body (no broken-image placeholder); the `[forms.email-queue] ... unbound bucket PROMO_FILES; skipping` log line should NO LONGER appear on subsequent runs after the splash-forms deploy. Headless cannot verify the runtime behavior.

2. **Drift-check hardening.** The brief flagged a future hardening candidate — "Programmatic verification that all enqueued bucket names match a bound R2 binding (a 'drift check')". Out of scope at this brief; candidate for a follow-up if a third bucket-sharing worker lands.

3. **Two locations of `OutboundEmailAttachment.bucket` union allow-list.** The contract is declared in two places — `packages/db-supabase/src/outbound-emails.ts` (`OutboundEmailAttachment` type) and `apps/forms-worker/src/email-queue/attachments.ts` (`QueueAttachment` interface in the dispatch handler). Both currently agree on `"FORMS_FILES" | "PROMO_FILES"` but a future bucket addition needs both updated in lockstep. Type system doesn't enforce this directly because `QueueAttachment` is structurally re-declared in the worker. Acceptable v1; flag for a future refactor that imports the union from `@splash/db-supabase` directly.

### Validation results

- **`pnpm typecheck`** — 21/21 packages typecheck green (11.247s, all cache misses but all green). Output trimmed; no errors or warnings.

- **`pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run --outdir=.tmp-build`** — succeeded. Bundle unchanged at **2024.58 KiB raw / 445.49 KiB gzip** (TOML-only change; runtime binding is provided by CF at startup, not bundled). Wrangler bindings output:
  ```
  Binding                                                       Resource
  env.FORMS_FILES (splash-forms-files)                          R2 Bucket
  env.PROMO_FILES (splash-promo-files)                          R2 Bucket
  env.SUPABASE_URL ("https://rewokyofschtvqgxrxwl.supabase...") Environment Variable
  env.TURNSTILE_SITE_KEY ("0x4AAAAAADBV7fdfR67Jt-ab")           Environment Variable
  ```
  The new `env.PROMO_FILES (splash-promo-files)` line confirms the binding is live in the build output. The `.tmp-build` directory was cleaned up post-validation.

- **Manual verification of dispatch correctness.** Re-read `apps/forms-worker/src/email-queue/attachments.ts:115-131` to confirm the `if (!bucket)` branch is now ONLY hit when `att.bucket` is a genuinely-unknown string (e.g., a hypothetical `"DAMAGE_FILES"` that hasn't been wired). For `att.bucket === "PROMO_FILES"`, the binding resolves to the bound `R2Bucket` and the dispatch proceeds to `bucket.get(att.r2_key)`. For `att.bucket === "FORMS_FILES"` or absent, the existing behavior is unchanged.

### Report — confirmations

- **Diff size:** 11 LOC (TOML block + 6-line block comment in `apps/forms-worker/wrangler.toml`). Matches the brief's "~15 LOC" expectation.

- **Dispatch's `if (!bucket)` branch in `attachments.ts`** is now ONLY hit for genuinely unknown bucket strings (a future bucket name that hasn't been wired). The bound `PROMO_FILES` case correctly resolves to `env.PROMO_FILES` and the R2 fetch proceeds.

- **`Env` interface widening** was NOT needed at this brief — Brief 157 had already added `PROMO_FILES?: R2Bucket` to the interface in lockstep with the dispatch code. Verified by `Grep` and direct read.

- **No CF deploys, no production-route bindings, no git commits or pushes** per CLAUDE.md.
