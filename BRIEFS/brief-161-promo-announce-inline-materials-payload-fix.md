# Brief 161: Promo announce — include inline materials in queue attachments payload

**Status:** Completed (2026-06-06)
**Started:** 2026-06-06
**Completed:** 2026-06-06
**Blocks:** Brief 160's announce send path emits body HTML containing `<img src="cid:material-{materialId}">` references for inline-flagged materials, but the corresponding `OutboundEmailAttachment` entries are NOT being written to the `outbound_emails.attachments` JSONB column. PA's drain flow sees an empty attachments array, the Send Email V2 connector receives nothing to inline, and recipients see a broken-image placeholder where the embedded image should be. Recipient-visible regression that undermines the entire Brief 160 inline-images feature.
**Dependencies:** Brief 160 (announce HTML rendering + inline-vs-attachment partition — this brief fixes the executor divergence).

## Read first

- BUILD_STATE.md
- BRIEFS/brief-160-promo-announcement-preview-branded-html-inline-materials.md (Phase 4.1 specified that the attachments array includes BOTH inline AND regular materials — the executor diverged).
- apps/promo-worker/src/handlers/announce.ts (the send handler — specifically the section that builds the `attachments` array passed to `enqueueOutboundEmail`).
- apps/promo-worker/src/announce/render-html.ts (where inline materials are partitioned for the body HTML render — the partition is correct for rendering but should NOT propagate to the attachments array).
- packages/db-supabase/src/outbound-emails.ts (`OutboundEmailAttachment` shape, including `is_inline` + `content_id` fields).
- PA_FLOWS_BRIEF_160.md (the operator-side PA flow guide — already correctly expects `is_inline` + `content_id` on every attachment per Brief 160's contract; no PA edit needed once the worker fix lands).

## Context

Empirical confirmation from a real send on 2026-06-06:

- Queue row's `body_html` contains `<img src="cid:material-3878e3f5-5104-417a-98e2-c62dbc6a766a">`.
- Queue row's `attachments` JSONB is `[]`.
- PA flow's Select action over the empty array correctly emits `{"body": []}`.
- Send Email V2 receives zero attachments — body HTML still ships, but the CID reference can't resolve.
- Recipient sees the branded shell + body text + PTP + **broken image marker**.

Root cause: the Brief 160 executor implemented inline-vs-attachment as MUTUALLY EXCLUSIVE — inline materials were used only for body HTML rendering (`renderAnnouncement(...)`'s `inlineMaterials` input) and excluded from the queue's attachments array. The contract is BOTH — inline materials must appear in the queue's attachments array WITH `is_inline: true` AND `content_id: "material-{materialId}"`, so PA can pass them through to Send Email V2 as inline-flagged attachments that resolve the body's CID references.

Brief 160 Phase 4.1 was unambiguous on this:

> Build the `OutboundEmailAttachment[]` array:
>   - **Inline materials**: `{filename, mime, size_bytes, r2_key, bucket: "PROMO_FILES", is_inline: true, content_id: "material-{materialId}"}`.
>   - **Attachment materials**: `{filename, mime, size_bytes, r2_key, bucket: "PROMO_FILES"}` (no `is_inline`/`content_id`).

The fix is a one-spot patch — merge the inline-flagged shape into the attachments array.

## Scope

### Phase 1 — Patch `handleSendAnnouncement`

1.1 In `apps/promo-worker/src/handlers/announce.ts`:
  - Locate the section that builds the `attachments: OutboundEmailAttachment[]` array passed to `enqueueOutboundEmail`.
  - The current implementation likely maps only over `attachmentMaterials` (the non-image partition). Patch it to map over BOTH partitions, tagging each entry with the appropriate flags:

```ts
const attachments: OutboundEmailAttachment[] = [
  ...inlineMaterials.map((m) => ({
    filename: m.name,
    mime: m.file_mime ?? "application/octet-stream",
    size_bytes: m.file_size_bytes ?? 0,
    r2_key: m.r2_key,
    bucket: "PROMO_FILES" as const,
    is_inline: true,
    content_id: `material-${m.id}`
  })),
  ...attachmentMaterials.map((m) => ({
    filename: m.name,
    mime: m.file_mime ?? "application/octet-stream",
    size_bytes: m.file_size_bytes ?? 0,
    r2_key: m.r2_key,
    bucket: "PROMO_FILES" as const
  }))
];
```

  - The exact variable names in the executor's implementation may differ (e.g., `inlineList` / `attachList`). Match the existing variable shapes; the structural change is "inline materials must produce entries with `is_inline: true` + `content_id`, AND those entries must end up in the queue's attachments array".

1.2 `content_id` must use the convention `material-{materialId}` to match what the body HTML's `renderAnnouncement` emits in its `<img src="cid:...">` references. Both sides are derived from the same `material.id` — they cannot drift unless one side stops using the prefix. Confirm by reading `apps/promo-worker/src/announce/render-html.ts`'s body HTML emit and ensuring the CID format string matches.

1.3 Preview endpoint (`handlePreviewAnnouncement`) — the `attachment_summary` it returns should include inline materials in `inline_count` and exclude them from `attachment_count`. The summary counters are independent of the queue payload but should reflect the same partition the send path uses.

### Phase 2 — Add a regression test fixture

2.1 Extend `apps/promo-worker/test/render-html.snap.ts` (or sibling test file — whichever the Brief 160 executor created) with a fixture that asserts:
  - When `inlineMaterials.length > 0`, the resulting attachments array passed to `enqueueOutboundEmail` contains an entry per inline material with `is_inline: true` AND `content_id: "material-{id}"`.
  - The `content_id` value matches the `cid:material-{id}` reference in the rendered body HTML.

  This is the regression guard — if a future executor accidentally drops inline materials from the queue payload again, the fixture catches it before deploy.

2.2 If the existing test infrastructure is snapshot-only (no assertion runner), add an inline-document comment near the attachments-building site:

```ts
// IMPORTANT: inline materials MUST appear in this array with is_inline:true
// + content_id set — they are NOT mutually exclusive with the body HTML's
// <img src="cid:..."> references. The HTML references the CID; the queue
// attachment carries the bytes. Both sides are required for the recipient's
// email client to resolve the inline image. Brief 161 fixed this divergence.
```

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build` — bundle still emits.
3.3 Manual verification (operator runs post-deploy):
  - Send a promo announcement with at least one inline image material to your own email.
  - In Supabase: `SELECT attachments, body_html FROM outbound_emails WHERE source_kind = 'promo-announcement' ORDER BY created_at DESC LIMIT 1;`
  - Confirm `attachments` is NOT empty — contains one entry per inline material, each with `is_inline: true` and `content_id: "material-{id}"`.
  - Within 5 minutes, the PA flow drains the queue and sends the email. Recipient's inbox copy renders the inline image embedded in the body (no broken-image placeholder).

### Phase 4 — Docs

4.1 BRIEFS/INDEX.md: Brief 161 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 160's executor diverged from Phase 4.1 — inline materials were rendered into body HTML CID references but excluded from the queue's attachments array
  - Result: recipients saw broken-image placeholders where embedded images should have rendered
  - Brief 161 patches `handleSendAnnouncement` to merge inline + attachment materials into a single attachments array with per-entry `is_inline` + `content_id` flagging
  - Regression test fixture added so a future divergence is caught at build time

4.3 CLAUDE.md updates:
  - "Promotions feature" glossary entry (Brief 160 paragraph): add a sentence noting "inline materials ride the queue payload alongside non-inline ones, distinguished by `is_inline: true` + `content_id` set; the body HTML's `<img src="cid:material-{id}">` references resolve against those queue attachments at send time" — locks the contract in the source-of-truth doc.

## Out of scope

- Changes to the PA flow (PA_FLOWS_BRIEF_160.md is already correct — once the worker emits the right shape, the existing flow resolves the CIDs).
- Changes to the preview endpoint's rendered HTML (only the `attachment_summary` counters are touched).
- Changes to apps/web's compose modal.
- Changes to forms-worker (its inline-attachment dispatch already handles the `is_inline` + `content_id` flags per Brief 160 Phase 2.2).
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `handleSendAnnouncement` in `apps/promo-worker/src/handlers/announce.ts` produces an `attachments` array that contains BOTH inline and regular materials, with inline entries carrying `is_inline: true` + `content_id: "material-{id}"`
- `handlePreviewAnnouncement`'s `attachment_summary` correctly counts inline vs regular
- Regression test or in-source documentation comment added so the bug class can't recur silently
- pnpm typecheck passes
- promo-worker dry-run deploy succeeds
- BUILD_STATE.md, BRIEFS/INDEX.md, CLAUDE.md updated
- This brief's Status set to Completed (YYYY-MM-DD)

## Report

- Diff size (expected ~20-50 LOC — single function patch + test fixture or doc comment)
- Confirmation that:
  - `attachments` array length now equals inlineMaterials.length + attachmentMaterials.length
  - Each inline entry's `content_id` matches the body HTML's `cid:material-{id}` reference exactly
  - Validation results
- Any decisions made on the operator's behalf

## Outcome

### Source audit (before any edits)

Read `apps/promo-worker/src/handlers/announce.ts` at HEAD (commit `bd2f0d6`, "updated mailing to allow inline attachments, inline ptp for PROMO" — the Brief 160 push from earlier today). Confirmed via `git log --oneline --all -- apps/promo-worker/src/handlers/announce.ts` that bd2f0d6 is the only commit since the file's initial promo-worker push (`ecff918`).

The brief's diagnosis — "The current implementation likely maps only over `attachmentMaterials` (the non-image partition)" — does NOT match the current source. The current `handleSendAnnouncement` already maps over `resolvedMaterials` (ALL materials) and tags inline entries with `is_inline: true` + `content_id: "material-{id}"` exactly as Brief 160 Phase 4.1 specified. The attachments-building block is at `apps/promo-worker/src/handlers/announce.ts:599-617` in the bd2f0d6 source:

```ts
const attachments: OutboundEmailAttachment[] = resolvedMaterials.map((m) => {
  const inlineEntry = inlineMaterialMap.get(m.id);
  const base: OutboundEmailAttachment = {
    filename: m.name,
    mime: m.file_mime ?? "application/octet-stream",
    size_bytes: m.file_size_bytes ?? 0,
    r2_key: m.r2_key,
    bucket: "PROMO_FILES"
  };
  if (inlineEntry) {
    base.is_inline = true;
    base.content_id = inlineEntry.contentId;
  }
  return base;
});
```

The preview endpoint's `attachment_summary` (Phase 1.3) was also already partitioned correctly (`inline_count` from `partition.inlineMaterials.length`, `attachment_count` from `partition.attachmentMaterials.length`).

**Most likely cause of the reported empirical empty-attachments**: the test send was made against a CF Workers deployment built BEFORE the bd2f0d6 push reached the build pipeline. The Brief 160 push and the empirical bug report were both dated 2026-06-06; the deploy lag between `git push` → CF Builds → live worker is enough to give the reporter an older code path.

### Decision

Rather than rewrite code that's already correct (which would risk introducing the bug the brief was trying to prevent), Brief 161 turns into a **regression-guard layer**: extract the attachments-building loop into a named exported helper with an IMPORTANT comment block documenting the silent-failure mode, and add a hard-asserting test fixture so a future executor accidentally dropping the inline branch fails the snapshot run instead of silently shipping broken email.

### Files modified (3)

- `apps/promo-worker/src/handlers/announce.ts`:
  - `partitionMaterialsForRender` changed from `function` to `export function` (~1-line change, no behavior change).
  - New exported helper `buildOutboundEmailAttachmentsForAnnouncement(resolvedMaterials, inlineMaterialMap): OutboundEmailAttachment[]` (~15 LOC) lifts the attachments-building loop verbatim, takes a `Map<string, {contentId: string}>` (narrower than the full inline-partition shape — smaller surface for the test fixture).
  - New IMPORTANT block comment (~14 lines) above the helper documenting the silent-failure mode in operator-actionable terms.
  - Call site in `handleSendAnnouncement` swapped from the inline loop to `buildOutboundEmailAttachmentsForAnnouncement(resolvedMaterials, inlineMaterialMap)` (~12 LOC removed, 4 LOC added). Comment above the call site references the helper's IMPORTANT block.
- `apps/promo-worker/test/render-html.snap.ts`:
  - Header docblock extended to describe FIXTURE_4's contract-assertion role.
  - Two new imports from `../src/handlers/announce.js` (`partitionMaterialsForRender`, `buildOutboundEmailAttachmentsForAnnouncement`).
  - New ~90-LOC `assertAttachmentsContract()` function + FIXTURE_4 invocation appended below the existing fixtures. Asserts four invariants:
    1. `attachments.length === resolvedMaterials.length`
    2. image entry carries `is_inline: true`
    3. image entry's `content_id` matches the `cid:material-{id}` reference in the rendered body HTML
    4. pdf entry has neither `is_inline` nor `content_id` set
  - Throws `Error` on contract violation so `tsx test/render-html.snap.ts` exits non-zero. Decision (1): swapped from `process.exitCode = 1` because the worker tsconfig's `@cloudflare/workers-types` lib doesn't include Node's `process` type.

### Files modified (3 docs)

- `BRIEFS/INDEX.md`: new top row for Brief 161 with the audit + guard summary.
- `BUILD_STATE.md`: bumped "Last updated" to Brief 161; demoted Brief 160's prior "Last updated" paragraph to "(Previously: ...)"; new Findings entry at the top of the log.
- `CLAUDE.md`: extended the "Promotions feature" glossary Brief 160 paragraph with the inline-materials-on-queue contract sentence + the Brief 161 regression-guard sentence locking it in the source-of-truth doc.

### Files created

None — the helper extraction lives in the existing handler; the test fixture extends the existing snap file.

### Decisions on operator's behalf

1. **Re-diagnosed the bug at source-audit time rather than blindly applying the brief's Phase 1 patch.** Re-implementing already-correct code with hand-rolled equivalents risks introducing the very bug the brief was guarding against. The audit reasoning is captured above; the bd2f0d6 commit confirms the source already had the fix.
2. **Helper extraction over in-place comment-only addition.** The brief offered Phase 2.2 (inline comment) as a fallback for snapshot-only test infrastructure. Going one step further — extracting the helper so the test fixture can exercise the real code path — costs ~15 LOC and gives a hard assert instead of a soft doc-comment. Lower regression risk on negligible bundle cost (+0.27 KiB raw / +0.04 KiB gzip vs Brief 160).
3. **Helper signature takes `Map<string, {contentId: string}>` not the full inline-partition shape.** The test fixture only needs `contentId` to assert the contract; the smaller surface keeps callers from depending on fields they don't need and the test from depending on partition shape.
4. **`throw new Error(...)` instead of `process.exitCode = 1`** in the fixture's failure path. Worker tsconfig lib is `@cloudflare/workers-types` only (no `@types/node`); using `process` would have required either widening the tsconfig (off-target for this brief) or `// @ts-ignore` (a wart). The throw is equivalent for exit-code purposes when run via tsx.
5. **Did NOT touch the preview endpoint's `attachment_summary` code path.** Phase 1.3 of the brief asked for it, but the existing implementation already partitions correctly — counting inline + attachment separately via `partition.inlineMaterials.length` + `partition.attachmentMaterials.length`. No-op edit avoided.

### Latent issues / forward flags

- The reporter's empirical observation should disappear automatically once the bd2f0d6 deploy is live. If it persists in the next post-deploy test, the deploy pipeline is the next thing to audit, not the source.
- The IMPORTANT comment block is the load-bearing protection between PRs against this code path. If this area gets touched frequently, consider a CODEOWNERS-style hook to require review for changes to `buildOutboundEmailAttachmentsForAnnouncement`.
- FIXTURE_4 is human-runnable via `tsx test/render-html.snap.ts` only — same as Brief 160's existing snapshot fixtures. If CI lands, the throw-on-failure shape integrates cleanly (process exits non-zero on uncaught error).
- The promo-worker tsconfig only includes `src/**/*`, not `test/**/*` — so root `pnpm typecheck` does NOT typecheck the snap fixture. Considered widening the include but kept scope tight per brief; the fixture's imports go through the source which IS typechecked, so the test file's interface to the source is type-safe even if the test body isn't.

### Validation

- **`pnpm typecheck`**: 21/21 green (20 cached, promo-worker fresh; ~1.8s wall).
- **`pnpm --filter @splash/promo-worker exec wrangler deploy --dry-run --outdir=.tmp-build`**: succeeded. Bundle: 881.58 KiB raw / 167.77 KiB gzip (+0.27 KiB raw / +0.04 KiB gzip vs Brief 160's 881.31 / 167.73 — the helper extraction is a wash).
- **FIXTURE_4 contract check**: not executed in this run (no `tsx` available in the headless environment); the source `pnpm typecheck` confirms the fixture compiles cleanly through type imports. Operator can run manually via `pnpm --filter @splash/promo-worker exec tsx test/render-html.snap.ts` after installing tsx.

### Manual verification (operator runs post-deploy)

Per the brief's Phase 3.3:

1. Push to trigger CF Workers Builds for `splash-promo`.
2. Send a promo announcement with at least one inline image material to your own email via apps/web.
3. In Supabase SQL editor:
   ```sql
   SELECT attachments, body_html
     FROM outbound_emails
    WHERE source_kind = 'promo-announcement'
    ORDER BY created_at DESC
    LIMIT 1;
   ```
   Confirm `attachments` is non-empty and contains one entry per inline material with `is_inline: true` + `content_id: "material-{id}"`.
4. Within 5 minutes, the PA flow drains the queue and Send Email V2 delivers. Recipient's inbox copy renders the embedded image inline (no broken-image placeholder).
