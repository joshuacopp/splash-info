<#
    register_schedule.ps1

    Registers (or re-registers) the Windows Task Scheduler entries that keep
    the maintenance tracker current.

        .\register_schedule.ps1              # daily 06:30, weekly Sun 05:30
        .\register_schedule.ps1 -DailyAt 07:00 -WeeklyAt 05:00
        .\register_schedule.ps1 -Unregister

    TWO TASKS, NOT ONE
      Daily  -- punches and dwell only (-SkipCrosswalk). This is what keeps the
                dashboard honest, and it is the cheap half.
      Weekly -- the full refresh including the job -> site crosswalk, which
                re-reads every GPS ping in the window. The crosswalk is a modal
                site over months of behaviour, so it barely moves day to day;
                running it nightly would be most of the cost for almost none of
                the change.

    WHY 06:30
      Ahead of the working day, so anyone opening /admin/maintenance in the
      morning sees yesterday included. There is deliberately no value-based
      alarm ("hours look low") -- maintenance volume swings hard with weather
      and breakdowns and such a check would cry wolf constantly. The gates in
      refresh.ps1 are structural instead: right sources, row-count floors, and
      a read-back at the end.

    NOTES
      - Runs only when you are logged on. S4U would break the pgpass and
        SUPABASE_DB_URL lookups, which live in your user profile -- the same
        constraint apps/damage-worker/daily/register_schedule.ps1 documents.
      - -WakeToRun is NOT set. A missed run is visible in the table dates on
        the dashboard; a half-run is not. Every write is an idempotent upsert
        over the whole window, so simply running it again catches up fully --
        there is no backfill to sequence.
#>
[CmdletBinding()]
param(
    [string]$DailyAt  = '06:30',
    [string]$WeeklyAt = '05:30',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$dailyName  = 'Splash maintenance tracker (daily)'
$weeklyName = 'Splash maintenance tracker (weekly full)'
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$target     = Join-Path $scriptDir 'refresh.ps1'

if ($Unregister) {
    foreach ($n in @($dailyName, $weeklyName)) {
        try {
            Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop
            Write-Host "Removed scheduled task '$n'." -ForegroundColor Yellow
        } catch {
            Write-Host "No task named '$n'." -ForegroundColor DarkGray
        }
    }
    return
}

if (-not (Test-Path $target)) { throw "cannot find refresh.ps1 at $target" }
if (-not $env:SUPABASE_DB_URL) {
    Write-Host "WARNING: SUPABASE_DB_URL is not set in this session." -ForegroundColor Yellow
    Write-Host "         The task will fail until it is set as a USER variable:" -ForegroundColor Yellow
    Write-Host '         setx SUPABASE_DB_URL "<session pooler connection string>"' -ForegroundColor Yellow
}

function Register-One($name, $trigger, $argSuffix) {
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"{1}" -f $target, $argSuffix) `
        -WorkingDirectory $scriptDir
    # Logged-on only, highest available: the credentials this needs live in the
    # user profile and are not reachable from a service account.
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $settings  = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Registered '$name'." -ForegroundColor Green
}

Register-One $dailyName  (New-ScheduledTaskTrigger -Daily -At $DailyAt) ' -SkipCrosswalk'
Register-One $weeklyName (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $WeeklyAt) ''

Write-Host ""
Write-Host "Daily  $DailyAt  - punches + dwell"      -ForegroundColor Cyan
Write-Host "Weekly Sun $WeeklyAt - full, incl. crosswalk" -ForegroundColor Cyan
Write-Host "Logs land in $scriptDir\logs." -ForegroundColor DarkGray
