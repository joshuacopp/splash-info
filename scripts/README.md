# scripts/

## Orchestrator (brief queue daemon)

**The command we use** — from the repo root in Windows PowerShell (5.1):

```powershell
.\scripts\orchestrator.ps1
```

That's it. Defaults: polls `BRIEFS/QUEUE.md` every 10s, `SkipPermissions=$true`
(autonomous), `DryRun=$false`. Stop with Ctrl+C.

Notes:

- Use `.\scripts\orchestrator.ps1`, **not** `pwsh ...` — `pwsh` is
  PowerShell 7 and isn't installed here. The script declares
  `#requires -Version 5.1` and runs in the Windows PowerShell session
  you already have.
- If the session blocks script execution:
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\orchestrator.ps1
  ```
- Test queue pickup without invoking claude:
  ```powershell
  .\scripts\orchestrator.ps1 -DryRun
  ```

### How it works

Polls `BRIEFS/QUEUE.md`. Each non-comment, non-blank line is a brief
filename. For each, it invokes Claude Code headless
(`claude --print --dangerously-skip-permissions`) pointed at the brief.
On success the entry moves to `DONE.md`; on failure it appends to
`FAILED.md`, marks the brief `Failed`, and halts. Adding a brief to
`QUEUE.md` is the run trigger — the daemon dispatches it on the next poll.
