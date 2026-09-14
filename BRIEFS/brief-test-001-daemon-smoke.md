# Brief test-001: Daemon smoke test

**Status:** Ready for Claude Code
**Started:**
**Completed:**
**Blocks:** Neither
**Dependencies:** none

## Read first
- CLAUDE.md
- BUILD_STATE.md

## Context
Throwaway brief to verify the orchestrator daemon picks up queued entries
and dispatches them. In DryRun mode the daemon logs a "would invoke"
message and moves the entry to DONE.md without calling Claude Code.

In a real (non-DryRun) run, Claude Code would execute the no-op scope
below, fill in Outcome, and exit cleanly.

## Scope
1. No-op. Read CLAUDE.md and BUILD_STATE.md to confirm you can find them.
2. In the Outcome section below, write a single line: "Daemon smoke test
   completed. CLAUDE.md and BUILD_STATE.md readable from working directory."

## Out of scope
- Any file edits other than this brief's Outcome section
- Running typecheck or build
- Updating BUILD_STATE.md

## Definition of done
- This brief's Outcome section contains the smoke-test confirmation line
- This brief's Status is set to Completed (YYYY-MM-DD)

## Outcome
(Filled in by Claude Code. In DryRun mode this section stays empty.)
