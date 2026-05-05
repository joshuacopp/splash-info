# Brief execution queue
#
# One brief filename per line. Lines starting with # are comments. Blank
# lines ignored. The orchestrator daemon (scripts/orchestrator.ps1)
# processes entries top-to-bottom. On success, an entry is moved to
# DONE.md. On failure, the orchestrator halts and appends to FAILED.md.
#
# Cowork (the planner) appends new briefs to this file. Don't add a brief
# until its file exists in BRIEFS/ and Status is "Ready for Claude Code".

# brief-024-sysadmin-add-location.md  (completed 2026-05-05)
