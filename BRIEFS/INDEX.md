# Brief index

Mirrors the prioritized work list in BUILD_STATE.md. Source of truth for
status is BUILD_STATE.md and the individual brief files; this is a
navigation aid.

| # | Brief | Status | Blocks | File |
|---|---|---|---|---|
| 1 | Login page + auth middleware | Completed (2026-05-04) | Both | (archive pending) |
| 2 | URL alignment + redirects + global Header + logout flow | Completed (2026-05-04) | Admin-facing | (archive pending) |
| 4 | Admin landing card grid (/admin/dashboard) + Sysadmin placeholder | Completed (2026-05-04) | Admin-facing | (archive pending) |
| 5 | Damage manager UI at /admin/damage (split into 5a/5b/5c/5d) | Completed (2026-05-04) — all four sub-briefs landed | Admin-facing | see sub-rows |
| 5a | Damage claim list page at /admin/damage | Completed (2026-05-04) | Admin-facing | [brief-005a-damage-claim-list.md](brief-005a-damage-claim-list.md) |
| 5b | Damage claim detail at /admin/damage/[id] (read-only) | Completed (2026-05-04) | Admin-facing | [brief-005b-damage-claim-detail.md](brief-005b-damage-claim-detail.md) |
| 5c | Damage write actions on detail (transitions, notes, check-request PDF preview) | Completed (2026-05-04) | Admin-facing | [brief-005c-damage-write-actions.md](brief-005c-damage-write-actions.md) |
| 5d | Damage documents (Quote/Receipt upload, edit, delete, photo lightbox) | Completed (2026-05-04) | Admin-facing | [brief-005d-damage-documents.md](brief-005d-damage-documents.md) |
| 6 | Performance tracker UI at /admin/performance | Completed (2026-05-04) | Admin-facing | [brief-006-performance-tracker.md](brief-006-performance-tracker.md) |
| 7 | Sysadmin UI at /admin/sysadmin (5 endpoints) | Completed (2026-05-04) | Admin-facing | [brief-007-sysadmin-ui.md](brief-007-sysadmin-ui.md) |
| 11 | Sign In links from auth-failed states | Completed (2026-05-04) | Admin-facing UX | [brief-011-signin-links.md](brief-011-signin-links.md) |
| 11a | User-info endpoint (header email/role display) + damage transition dc_role retrofit | Completed (2026-05-04) | Admin-facing UX (cosmetic) + 5d unblocker | [brief-011a-user-info-endpoint.md](brief-011a-user-info-endpoint.md) |
| 11b | Auth fixes from first end-to-end smoke test (remove isOriginAllowed gate from /api/me + sweep + dcRole diagnostic) | Completed (2026-05-04) | End-to-end damage manager + Header user-row verification | [brief-011b-auth-smoke-fixes.md](brief-011b-auth-smoke-fixes.md) |
| 12 | Fill in /  page (verify route ownership first) | Not started | Admin-facing UX | (not drafted) |
| 13 | apps/web wrangler routes block | Not started | Both (cutover-time) | (not drafted) |
| 15 | PRE_DEPLOY_WEB.md | Not started | Both (cutover prep) | (not drafted) |
| 16 | Staging subdomain end-to-end testing (`staging.splashcarwashes.info`) | Completed (2026-05-04) | End-to-end UI verification | [brief-016-staging-subdomain.md](brief-016-staging-subdomain.md) |
| 17 | Service bindings for apps/web -> worker subrequests (workaround CF same-zone 522 gotcha) | Completed (2026-05-04) | End-to-end UI testing on staging + production cutover | [brief-017-service-bindings.md](brief-017-service-bindings.md) |
| 18 | Damage actions debug + sysadmin email-based UserPicker (drop dcRole filter while Brief 11b mystery is being chased; new `/sysadmin/api/users` GET endpoint + UserPicker; `location_admin` location_code guards) | Completed (2026-05-04) | Day-to-day usability of damage manager + sysadmin UI | [brief-018-damage-and-sysadmin-fixes.md](brief-018-damage-and-sysadmin-fixes.md) |
| 19 | Server-action ActionResult + router.refresh() pattern (replace redirect-based UX on damage detail + sysadmin; shared `<ActionForm>` client wrapper; CLAUDE.md doc of the pattern) | Completed (2026-05-04) | Day-to-day usability of damage manager + sysadmin write surfaces (visible refresh after action) | [brief-019-action-result-refresh.md](brief-019-action-result-refresh.md) |
| 20 | Staging-test bug batch — sysadmin idempotency (changed flag + no-op audit), damage transition clearApprovalDetails, ApprovalDetails null gate, no-quotes hint with #upload-document anchor, Quote-row required field validation (worker + UI), edit `<details>` close-on-save, defensive try/catch on editDocumentAction | Completed (2026-05-05) | Day-to-day usability of damage manager + sysadmin (8 bugs surfaced by first end-to-end staging smoke test) | [brief-020-staging-bug-batch.md](brief-020-staging-bug-batch.md) |
| 21 | dcRole gating restored (show-disabled pattern with per-role hint copy) + Brief 18 diagnostic cleanup (DcRoleDebugLine + log helpers removed) + contact_status "Not Started" pill suppressed | Completed (2026-05-05) | Damage detail UX correctness + production-ready polish | [brief-021-dcrole-gating-cleanup.md](brief-021-dcrole-gating-cleanup.md) |
| 22 | Recent notes sub-box on damage detail + jump-to-add-note anchor button + smooth scroll | Completed (2026-05-05) | Damage detail UX polish | [brief-022-recent-notes-card.md](brief-022-recent-notes-card.md) |

**Folded items** (work absorbed into earlier briefs):
- Item 3 (URL drift /admin/{loc} <-> /admin/pricing/{loc}) - folded into Brief 2.
- Item 10 (Logout flow) - folded into Brief 2.
- Item 14 (Auth middleware) - folded into Brief 1.

**Decisions** (no code, but tracked here for visibility):
- Item 8: Signup customer flow ownership - **Decided 2026-05-04: signup-worker owns** (option B). Revisit post-cutover if React port becomes worth the effort.
- Item 9: Public claim form ownership - **Decided 2026-05-04: damage-worker owns** (option B). Same reasoning as 8.

---

## Archive backfill

Briefs 1, 2, and 4 were completed before this BRIEFS/ system was set up.
Their full text + outcomes live in BUILD_STATE.md's Findings & decisions
log. Backfilling them as standalone files in this directory is a small
follow-up task (not blocking - the source of truth is BUILD_STATE.md).
