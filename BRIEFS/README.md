# BRIEFS/ - work-unit handoff between Cowork (planner) and Claude Code (doer)

Each file in this directory is a self-contained unit of work. The flow:

1. **Cowork drafts** a brief: writes `BRIEFS/brief-N-<slug>.md` with
   Status `Ready for Claude Code` and appends the filename to
   `QUEUE.md`.
2. **Orchestrator daemon** (`scripts/orchestrator.ps1`, started once
   per work session) polls `QUEUE.md`. When it finds a queued brief, it
   invokes `claude --print` headlessly with a prompt pointing at the
   brief file.
3. **Claude Code executes**: reads the brief, makes edits, runs
   typecheck/build, fills in the brief's `## Outcome` section, updates
   `BUILD_STATE.md`, sets Status to `Completed`, exits.
4. **Orchestrator** moves the entry from `QUEUE.md` to `DONE.md` on
   success, or appends to `FAILED.md` and halts on non-zero exit.
5. **Cowork reviews** the outcome (reads the brief file directly),
   verifies, plans the next brief.

---

## Files in this directory

- `README.md` - this file (workflow doc).
- `INDEX.md` - status table for all briefs (mirrors the prioritized
  work list in `BUILD_STATE.md`).
- `QUEUE.md` - daemon polls this. One brief filename per line. Lines
  starting with `#` are comments, blank lines ignored. Daemon processes
  top-to-bottom.
- `DONE.md` - successfully completed briefs (newest first).
- `FAILED.md` - briefs that exited non-zero (newest first). Created on
  first failure.
- `orchestrator.log` - daemon stdout/stderr capture.
- `brief-template.md` - template for new briefs.
- `brief-N-<slug>.md` - individual briefs. N matches the prioritized
  work list item number where applicable.

---

## Brief file structure

Every brief file has the following sections in order:

```markdown
# Brief N: <Short descriptive title>

**Status:** Ready for Claude Code | In Progress | Completed (YYYY-MM-DD) | Failed | Cancelled
**Started:** YYYY-MM-DD (set when first execution begins)
**Completed:** YYYY-MM-DD (set when Status -> Completed)
**Blocks:** Customer-facing cutover | Admin-facing cutover | Both | Neither
**Dependencies:** List of brief numbers or external prerequisites; "none" if independent

## Read first
- BUILD_STATE.md
- <other files Claude Code should load before acting>

## Context
<3-10 sentences. Why this brief is necessary. State going in. Architectural
decisions that matter. Reference relevant constraints from CLAUDE.md if they
apply.>

## Scope
1. <Major chunk of work>
   - <Specific file or behavior>
   - Decisions to make (and the criteria for picking)
2. <Major chunk of work>
   - ...

## Configuration
<Optional. New env vars, secrets, or runtime config. Defaults + how to set.>

## Out of scope
- <Specific things this brief must NOT touch>
- <Common scope-creep risks>
- Don't deploy to Cloudflare
- Don't bind production routes
- Don't commit to git or push

## Definition of done
- pnpm typecheck passes
- pnpm --filter @splash/<package> build succeeds (if applicable)
- <Specific behaviors that must work>
- <Specific files that must exist or be modified>
- BUILD_STATE.md updated with required entries

## Report
- <Decisions made on the operator's behalf>
- <Anything surprising in the existing codebase>
- <Latent issues addressed during the work, if any>
- <Prep work surfaced for future briefs, if relevant>
- <Known limitations or gaps for future cleanup>

## Outcome
(Filled in by Claude Code on completion. Must include: files created,
files modified, decisions, latent issues found, validation results.)
```

---

## Single-writer rules (avoid race conditions)

To prevent stomp-overs between Cowork and Claude Code on shared files,
each file has one writer:

| File | Writer |
|---|---|
| `BRIEFS/brief-N-*.md` (Status, Scope, etc.) | Cowork |
| `BRIEFS/brief-N-*.md` (Outcome section + Status -> Completed) | Claude Code |
| `BRIEFS/INDEX.md` | Cowork |
| `BRIEFS/QUEUE.md` | Cowork (appends), orchestrator (removes) |
| `BRIEFS/DONE.md` | orchestrator |
| `BRIEFS/FAILED.md` | orchestrator |
| `BRIEFS/orchestrator.log` | orchestrator |
| `BUILD_STATE.md` | Claude Code (within brief execution) + Cowork (planning updates outside brief execution) |
| `CLAUDE.md` | Cowork (rare; immutable in normal flow) |

The Outcome section of a brief is the only part Claude Code writes
inside an otherwise Cowork-owned file. Outcome should be appended to the
end of the brief; don't restructure the rest.

---

## Halting on failure

If a brief fails (non-zero exit from `claude --print`), the orchestrator
appends the entry to `FAILED.md` and stops processing further briefs.
This is intentional: better to halt and let the operator investigate
than to silently roll a queue of broken work forward.

To resume after a failure: fix the brief (or the underlying issue),
move the entry from `FAILED.md` back into `QUEUE.md`, and restart the
orchestrator.

---

## Manual brief execution (without the daemon)

If you want to run a brief without the orchestrator (e.g., one-off
testing), open Claude Code in `splash-info/` and paste:

```
Read CLAUDE.md, BUILD_STATE.md, and BRIEFS/<brief-filename>. Execute
the brief end-to-end. Fill in the Outcome section and update BUILD_STATE.md.
```

The orchestrator does the same thing programmatically.
