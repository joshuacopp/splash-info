# Launches the maintenance-tracker Claude Code session with Remote Control.
#
# Run this from a real terminal -- it starts an INTERACTIVE session, so it
# cannot be launched from inside another Claude Code session (no TTY).
#
# Why it cd's to the repo root rather than to apps/maintenance-tracker:
# HANDOFF.md points at apps/workorders-worker/src/* with repo-root-relative
# paths and tells the session not to rebuild the MaintainX mirror. It cannot
# honour that if it cannot read it. Launching from the subdirectory would also
# skip the root CLAUDE.md, which carries the MaintainX constraints (money is
# CENTS), the deploy-from-push rule, and the don't-push-without-asking rule.

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

Write-Host ""
Write-Host "  Repo root : $repoRoot"
Write-Host "  Session   : maintenance-tracker (Remote Control enabled)"
Write-Host "  Start with: Read apps/maintenance-tracker/HANDOFF.md, then PLAN.md rev 8."
Write-Host ""

claude --remote-control maintenance-tracker
