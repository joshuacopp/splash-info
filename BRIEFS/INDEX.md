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
