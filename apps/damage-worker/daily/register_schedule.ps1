<#
    register_schedule.ps1

    Registers (or re-registers) a Windows Task Scheduler entry that runs
    run_daily.ps1 once a day for the previous day's car counts.

    USAGE
      .\register_schedule.ps1                 # 10:00 local, runs as you
      .\register_schedule.ps1 -At 10:30
      .\register_schedule.ps1 -Unregister

    WHY 10:00
      The previous day's sales have settled by mid-morning. Volume itself is
      weather-driven and swings hard day to day, so do NOT add a value-based
      "that looks low" alarm -- it would fire constantly. The gate in
      run_daily.ps1 is structural on purpose: right sources, right site counts,
      every expected store present.

    NOTES
      - Runs only when you are logged on (S4U would break the pgpass /
        wrangler credential lookups, which live in your user profile).
      - -WakeToRun is NOT set. If the machine is asleep the run is skipped,
        and the day is simply picked up by a manual run. That is deliberate:
        a missed day is visible, a half-run day is not.
      - The task calls run_daily.ps1 with no -Day, so it always does
        "yesterday". Backfills stay manual.
#>

[CmdletBinding()]
param(
    [string]$At = '10:00',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$taskName  = 'Splash daily car counts'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$target    = Join-Path $scriptDir 'run_daily.ps1'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Yellow
    return
}

if (-not (Test-Path $target)) { throw "Cannot find run_daily.ps1 at $target" }
if ($At -notmatch '^\d{1,2}:\d{2}$') { throw "-At must be HH:mm, got '$At'" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$target`"" `
    -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Description 'Redshift -> CSV -> SQL -> Cloudflare D1 car counts for the previous day.' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host "Registered '$taskName' to run daily at $At." -ForegroundColor Green
Write-Host "Run it now with:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Logs land in:     $(Join-Path $scriptDir 'logs')"
