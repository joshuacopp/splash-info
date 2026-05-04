# Brief N: <Short descriptive title>

**Status:** Ready for Claude Code
**Started:**
**Completed:**
**Blocks:** Customer-facing cutover | Admin-facing cutover | Both | Neither
**Dependencies:** none

## Read first
- BUILD_STATE.md
- CLAUDE.md
- <other files Claude Code should load before acting>

## Context
<3-10 sentences. Why this brief is necessary. State going in. Architectural
decisions that matter. Reference relevant constraints from CLAUDE.md if they
apply (e.g., "this touches signup-worker but must not change /signup/{loc}
URLs per the load-bearing constraint").>

## Scope

1. <Major chunk of work>
   - <Specific file or behavior>
   - Decisions to make (and the criteria for picking)
2. <Major chunk of work>
   - ...

## Configuration
<Optional. New env vars, secrets, or runtime config. Include defaults
and how to set them.>

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
