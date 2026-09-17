<#
    register_schedule.ps1

    Registers (or re-registers) the Windows Task Scheduler entries that keep
    the maintenance tracker current.

        .\register_schedule.ps1              # daily 06:00 UTC, weekly Sun 05:30
        .\register_schedule.ps1 -WeeklyAt 05:00
        .\register_schedule.ps1 -Unregister

    TWO TASKS, NOT ONE
      Daily  -- punches and dwell only (-SkipCrosswalk). This is what keeps the
                dashboard honest, and it is the cheap half.
      Weekly -- the full refresh including the job -> site crosswalk, which
                re-reads every GPS ping in the window. The crosswalk is a modal
                site over months of behaviour, so it barely moves day to day;
                running it nightly would be most of the cost for almost none of
                the change.

    06:00 UTC, AND WHY THAT TAKES TWO TRIGGERS
      Task Scheduler triggers are local time with no UTC option, so one daily
      trigger is wrong for half the year. Both local hours that can equal
      06:00 UTC here are registered -- 01:00 EST and 02:00 EDT -- and
      -IfStale 20 makes the second one a no-op. Correct across both DST
      transitions, with no calendar reminder to miss.

      There is deliberately no value-based alarm ("hours look low"):
      maintenance volume swings hard with weather and breakdowns and such a
      check would cry wolf. The gates in refresh.ps1 are structural instead --
      right sources, row-count floors, and a read-back at the end.

    WHAT HAPPENS WHEN THE MACHINE IS NOT THERE
      This runs on a desk, so it will miss runs. Three local mechanisms cover
      the recoverable cases -- StartWhenAvailable for a trigger that fired
      while the machine was off, an at-startup trigger for power loss and
      patch reboots, and a midday slot for a morning run that failed -- and
      every one of them is safe to fire because the work is a full-window
      idempotent upsert with a staleness guard in front of it.

      None of that helps if the machine is simply off for days, and nothing
      running ON the machine ever could. That case is covered from outside:
      refresh.ps1 writes a `maintenance_refresh` heartbeat into mx_sync_state,
      and workorders-worker's 05:00 UTC health check emails when it goes
      stale. The local half does the work; the cloud half notices when it
      stops.

    NOTES
      - Runs only when you are logged on. S4U would break the pgpass and
        SUPABASE_DB_URL lookups, which live in your user profile -- the same
        constraint apps/damage-worker/daily/register_schedule.ps1 documents.
        It is also why "logged out overnight" is a real failure mode here and
        why the heartbeat exists.
      - -WakeToRun is NOT set. Waking a machine to run a job that will be
        superseded by the next idempotent run buys nothing; the catch-up
        triggers handle it once someone is back.
#>
[CmdletBinding()]
param(
    # The daily slots are NOT a parameter. They are pinned to the two local
    # hours that can equal 06:00 UTC, and making them adjustable would invite
    # someone to set one hour and silently lose DST correctness.
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

# ---- 06:00 UTC, honestly ------------------------------------------------------
# Task Scheduler triggers are LOCAL time with no UTC option, so a single daily
# trigger drifts an hour twice a year. Rather than pick one and be wrong half
# the year, the task carries BOTH local hours that can equal 06:00 UTC here
# (01:00 EST and 02:00 EDT) and lets -IfStale decide. Exactly one of them does
# work on any given day; the other finds a fresh heartbeat and stops in about a
# second. That is correct across both DST transitions with nothing to maintain
# and no calendar reminder to miss.
$utcSlots = @('01:00', '02:00')

# ---- catch-up -----------------------------------------------------------------
# The whole point of the -IfStale guard. Between them these cover the ways a
# machine in an office misses its slot:
#   AtStartup + 10 min   power loss, a patch reboot, or an overnight shutdown.
#                        Ten minutes so the network and any VPN are up first.
#   StartWhenAvailable   (in Register-One) Task Scheduler's own catch-up for a
#                        trigger that fired while the machine was off.
#   Midday sweep         the case neither of those covers: machine awake and
#                        logged in but the run failed, or it was logged out at
#                        01:00 and nobody rebooted. Costs one query when the
#                        morning run already worked.
$dailyTriggers = @()
foreach ($s in $utcSlots) { $dailyTriggers += New-ScheduledTaskTrigger -Daily -At $s }
$dailyTriggers += New-ScheduledTaskTrigger -Daily -At '13:00'
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT10M'
$dailyTriggers += $boot

# -IfStale 20, not 24: a run that slips slightly must not be treated as fresh
# by the next morning's trigger and skipped into a two-day gap.
Register-One $dailyName  $dailyTriggers ' -SkipCrosswalk -IfStale 20'
Register-One $weeklyName (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $WeeklyAt) ' -IfStale 20'

$nowOffset = [TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalHours
Write-Host ""
Write-Host ("Daily  01:00 + 02:00 local  -> 06:00 UTC across DST (currently UTC{0:+#;-#;+0})" -f $nowOffset) -ForegroundColor Cyan
Write-Host  "       13:00 local          -> midday catch-up if the morning failed" -ForegroundColor Cyan
Write-Host  "       at startup +10 min   -> catch-up after power loss or reboot" -ForegroundColor Cyan
Write-Host  "       all four pass -IfStale 20, so only the first one each day does work" -ForegroundColor DarkGray
Write-Host ("Weekly Sun {0} - full run including the job -> site crosswalk" -f $WeeklyAt) -ForegroundColor Cyan
Write-Host ""
Write-Host "If the machine is off for days, nothing here can help -- that is what the" -ForegroundColor DarkGray
Write-Host "Cloudflare-side watchdog is for: workorders-worker's 05:00 UTC health check" -ForegroundColor DarkGray
Write-Host "emails when the maintenance_refresh heartbeat goes stale." -ForegroundColor DarkGray
Write-Host "Logs land in $scriptDir\logs." -ForegroundColor DarkGray
