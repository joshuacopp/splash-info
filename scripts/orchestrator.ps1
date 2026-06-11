#requires -Version 5.1
<#
.SYNOPSIS
    Brief queue daemon for the splash-info monorepo.

.DESCRIPTION
    Polls BRIEFS/QUEUE.md every $PollSeconds. When a brief is queued,
    invokes Claude Code in headless mode (claude --print) with a prompt
    that points at the brief file. On success, moves the entry from
    QUEUE.md to DONE.md. On failure, appends to FAILED.md, marks the
    brief Status as Failed, and halts processing.

    This script is the bridge between Cowork (the planner, drafts
    briefs) and Claude Code (the doer, executes them). Cowork writes to
    BRIEFS/brief-N-*.md and BRIEFS/QUEUE.md. The orchestrator dispatches
    to Claude Code, captures output, and updates QUEUE/DONE/FAILED.
    Claude Code (within an invocation) writes to brief Outcome sections
    and BUILD_STATE.md.

.PARAMETER PollSeconds
    Seconds between QUEUE.md polls when idle. Default 10.

.PARAMETER DryRun
    Print what would be invoked, but don't actually call claude. Useful
    for verifying the daemon picks up briefs correctly.

.PARAMETER SkipPermissions
    Pass --dangerously-skip-permissions to claude. Required for fully
    autonomous operation (otherwise Claude Code prompts for each tool
    use). Default $true. Set to $false if you want claude to refuse
    file edits without explicit approval (which defeats the purpose of
    headless mode but is safer for first-time testing).

.EXAMPLE
    .\scripts\orchestrator.ps1
    Start the daemon (Windows PowerShell 5.1 — this is the canonical
    command we use). Polls every 10s. Stop with Ctrl+C.

.EXAMPLE
    .\scripts\orchestrator.ps1 -DryRun
    Print what would happen without invoking claude. For testing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\orchestrator.ps1
    Use this form if the session blocks script execution.
#>

[CmdletBinding()]
param(
    [int]$PollSeconds = 10,
    [switch]$DryRun,
    [bool]$SkipPermissions = $true
)

$ErrorActionPreference = "Stop"

# Resolve repo paths from the script's own location ----------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir
$BriefsDir = Join-Path $RepoRoot "BRIEFS"
$QueueFile = Join-Path $BriefsDir "QUEUE.md"
$DoneFile  = Join-Path $BriefsDir "DONE.md"
$FailFile  = Join-Path $BriefsDir "FAILED.md"
$LogFile   = Join-Path $BriefsDir "orchestrator.log"

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
function Write-OrchLog {
    param(
        [Parameter(Mandatory=$true)][string]$Message,
        [string]$Level = "INFO"
    )
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# ----------------------------------------------------------------------
# Queue helpers
# ----------------------------------------------------------------------
function Get-QueueEntries {
    if (-not (Test-Path $QueueFile)) { return @() }
    $raw = Get-Content -Path $QueueFile -Encoding UTF8
    $entries = @()
    foreach ($line in $raw) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "")        { continue }
        if ($trimmed.StartsWith("#")) { continue }
        $entries += $trimmed
    }
    return ,$entries
}

function Remove-QueueEntry {
    param([Parameter(Mandatory=$true)][string]$Entry)
    if (-not (Test-Path $QueueFile)) { return }
    $raw = Get-Content -Path $QueueFile -Encoding UTF8
    $kept = @()
    $removed = $false
    foreach ($line in $raw) {
        if ((-not $removed) -and ($line.Trim() -eq $Entry)) {
            $removed = $true
            continue
        }
        $kept += $line
    }
    Set-Content -Path $QueueFile -Value $kept -Encoding UTF8
}

function Append-LineToFile {
    # Direct .NET append. Bypasses PowerShell 5.1's quirky cmdlet behavior
    # around Add-Content / Set-Content with -Encoding UTF8 against files
    # that lack a BOM (which heredoc-created files do). Always uses UTF-8
    # without BOM for consistency.
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Line
    )
    $sizeBefore = if (Test-Path $Path) { (Get-Item $Path).Length } else { 0 }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($Path, ($Line + [Environment]::NewLine), $utf8NoBom)
    $sizeAfter = (Get-Item $Path).Length
    Write-OrchLog "Append: $Path ($sizeBefore -> $sizeAfter bytes), line: '$Line'"
}

function Add-DoneEntry {
    param(
        [Parameter(Mandatory=$true)][string]$Entry,
        [Parameter(Mandatory=$true)][string]$Status
    )
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $newLine = "- $ts $Entry ($Status)"
    if (-not (Test-Path $DoneFile)) {
        # Create with header on first write.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $header = "# Completed briefs (chronological)" + [Environment]::NewLine +
                  [Environment]::NewLine +
                  "# Format: - YYYY-MM-DD HH:MM:SS brief-N-<slug>.md (success)" + [Environment]::NewLine +
                  "# Written by the orchestrator daemon." + [Environment]::NewLine +
                  [Environment]::NewLine
        [System.IO.File]::WriteAllText($DoneFile, $header, $utf8NoBom)
    }
    Append-LineToFile -Path $DoneFile -Line $newLine
}

function Add-FailedEntry {
    param(
        [Parameter(Mandatory=$true)][string]$Entry,
        [Parameter(Mandatory=$true)][int]$ExitCode
    )
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $newLine = "- $ts $Entry (exit=$ExitCode)"
    if (-not (Test-Path $FailFile)) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $header = "# Failed briefs (chronological)" + [Environment]::NewLine +
                  "# Restart the orchestrator after fixing the underlying issue." + [Environment]::NewLine +
                  [Environment]::NewLine +
                  "# Format: - YYYY-MM-DD HH:MM:SS brief-N-<slug>.md (exit=N)" + [Environment]::NewLine +
                  [Environment]::NewLine
        [System.IO.File]::WriteAllText($FailFile, $header, $utf8NoBom)
    }
    Append-LineToFile -Path $FailFile -Line $newLine
}

# ----------------------------------------------------------------------
# Brief invocation
# ----------------------------------------------------------------------
function Invoke-Brief {
    param([Parameter(Mandatory=$true)][string]$BriefFile)

    $briefPath = Join-Path $BriefsDir $BriefFile
    if (-not (Test-Path $briefPath)) {
        Write-OrchLog "Queue entry '$BriefFile' not found in BRIEFS/. Skipping." "WARN"
        return @{ Success = $false; ExitCode = -1; Reason = "missing-file" }
    }

    $prompt = @"
You are Claude Code running in headless mode for the splash-info monorepo.

Read these files in order, then execute the brief end-to-end:
1. CLAUDE.md (project rules, constraints, conventions, glossary)
2. BUILD_STATE.md (current state, prioritized work list, decisions log)
3. BRIEFS/$BriefFile (the brief you are executing)

Then:
- Make the file edits described in the brief's Scope.
- Run pnpm typecheck and any pnpm --filter <pkg> build called for in
  the Definition of Done. Do not skip these.
- Fill in the brief's '## Outcome' section with: files created, files
  modified, decisions you made on the operator's behalf, latent issues
  found, validation results (typecheck/build status).
- Update BUILD_STATE.md per its Conventions section: bump 'Last updated',
  add a Findings entry summarizing the work, update the prioritized work
  list status if applicable.
- Set the brief's 'Status:' field to 'Completed (YYYY-MM-DD)' with today's
  date.
- Exit normally (zero exit code).

If you encounter ambiguity that would lead you down the wrong path, or
if you cannot complete the brief, set the brief's Status to 'Failed'
with a precise explanation of what blocked you in the Outcome section,
then exit with a non-zero code. Do not guess your way through.

Do not deploy to Cloudflare, do not bind production routes, do not
commit to git or push - per CLAUDE.md.
"@

    Write-OrchLog "Invoking claude on brief: $BriefFile"

    if ($DryRun) {
        Write-OrchLog "[DryRun] Would invoke: claude --print$(if ($SkipPermissions) { ' --dangerously-skip-permissions' }) <prompt of $($prompt.Length) chars>"
        return @{ Success = $true; ExitCode = 0; Reason = "dry-run" }
    }

    Push-Location $RepoRoot
    try {
        $args = @("--print")
        if ($SkipPermissions) { $args += "--dangerously-skip-permissions" }
        $args += $prompt

        # Capture stdout + stderr inline. Tee to log so we have a record.
        $output = & claude @args 2>&1
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    Add-Content -Path $LogFile -Value "--- claude output for $BriefFile (exit=$exit) ---" -Encoding UTF8
    Add-Content -Path $LogFile -Value ($output | Out-String) -Encoding UTF8
    Add-Content -Path $LogFile -Value "--- end claude output for $BriefFile ---" -Encoding UTF8

    return @{
        Success  = ($exit -eq 0)
        ExitCode = $exit
        Reason   = if ($exit -eq 0) { "ok" } else { "non-zero-exit" }
    }
}

# ----------------------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------------------
if (-not (Test-Path $BriefsDir)) {
    throw "BRIEFS/ directory not found at $BriefsDir. Run from the repo root, or move the script to splash-info/scripts/."
}
if (-not (Test-Path $QueueFile)) {
    Write-OrchLog "QUEUE.md not found; creating empty file at $QueueFile."
    Set-Content -Path $QueueFile -Value @(
        "# Brief execution queue",
        "# One brief filename per line. Lines starting with # are comments.",
        ""
    ) -Encoding UTF8
}

if (-not $DryRun) {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    if (-not $claudeCmd) {
        throw "claude CLI not found in PATH. Install Claude Code first: https://docs.claude.com/en/docs/claude-code/setup"
    }
    Write-OrchLog "claude CLI: $($claudeCmd.Source)"
}

Write-OrchLog "Orchestrator started. Polling $QueueFile every $PollSeconds seconds."
Write-OrchLog "DryRun=$DryRun, SkipPermissions=$SkipPermissions"
Write-OrchLog "Press Ctrl+C to stop."

# ----------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------
try {
    while ($true) {
        try {
            $entries = Get-QueueEntries
            if ($entries.Count -gt 0) {
                $entry = $entries[0]
                $result = Invoke-Brief -BriefFile $entry

                if ($result.Success) {
                    Remove-QueueEntry -Entry $entry
                    Add-DoneEntry -Entry $entry -Status "success"
                    Write-OrchLog "Completed: $entry"
                } else {
                    Write-OrchLog "Brief failed: $entry (reason=$($result.Reason), exit=$($result.ExitCode))." "ERROR"
                    Remove-QueueEntry -Entry $entry
                    Add-FailedEntry -Entry $entry -ExitCode $result.ExitCode
                    Write-OrchLog "Halting on failure. Investigate, then restart the orchestrator." "ERROR"
                    break
                }
            }
        } catch {
            Write-OrchLog "Orchestrator caught exception: $_" "ERROR"
            Write-OrchLog $_.ScriptStackTrace "ERROR"
            break
        }
        Start-Sleep -Seconds $PollSeconds
    }
} finally {
    Write-OrchLog "Orchestrator stopped."
}
