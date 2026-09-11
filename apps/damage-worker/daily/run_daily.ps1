<#
    run_daily.ps1

    The whole daily car-counts chain in one command:

        1. export   export_car_counts.ps1   Redshift -> daily_car_counts_<DAY>.csv
        2. build    build_car_counts.py     CSV      -> car_counts_<DAY>.sql
        3. apply    apply.mjs               overlap pre-flight, then D1, then verify

    USAGE
      .\run_daily.ps1                     # yesterday, full run
      .\run_daily.ps1 -Day 2026-09-05     # explicit day
      .\run_daily.ps1 -DryRun             # export + build + pre-flight, nothing written to D1
      .\run_daily.ps1 -SkipExport         # reuse an existing CSV

    SAFETY
      The overlap pre-flight lives in apply.mjs and is mandatory. If rows already
      cover the day it exits 2 and this script stops immediately and never retries
      that case -- retrying an overlap abort is how a day gets double-counted.
      Only transient failures (wrangler / Cloudflare API flakiness, which bit the
      2026-09-05 run twice) are retried.

    Everything is logged to logs\daily_<DAY>.log alongside the console output.
#>

[CmdletBinding()]
param(
    [string]$Day,
    [switch]$DryRun,
    [switch]$SkipExport,
    [int]$MaxRetries = 3,
    # Number of location_codes the build must produce. This is the real
    # invariant: it is what actually lands in D1. Bump it when a store genuinely
    # opens or closes -- not to make a failing day go away.
    [int]$ExpectedRows = 77
)

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING  = 'UTF8'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = (Resolve-Path (Join-Path $scriptDir '..\..\..')).Path

if (-not $Day) { $Day = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') }
if ($Day -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "Day must be YYYY-MM-DD, got '$Day'" }

$logDir = Join-Path $scriptDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "daily_$Day.log"

function Log {
    param([string]$Msg, [string]$Color = 'Gray')
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Msg
    Write-Host $line -ForegroundColor $Color
    Add-Content -Path $logFile -Value $line
}

function Fail {
    param([string]$Msg)
    Log "FAILED: $Msg" 'Red'
    Log "Chain stopped. Nothing further was attempted." 'Red'
    exit 1
}

$csvPath = Join-Path $scriptDir "daily_car_counts_$Day.csv"
$sqlPath = Join-Path $scriptDir "car_counts_$Day.sql"

Log "===== daily car counts: $Day =====" 'Cyan'
if ($DryRun) { Log "DRY RUN - nothing will be written to D1" 'Yellow' }

# ---- 1. export -------------------------------------------------------------
if ($SkipExport) {
    if (-not (Test-Path $csvPath)) { Fail "-SkipExport given but $csvPath does not exist" }
    Log "step 1/3 export  SKIPPED (reusing existing CSV)" 'Yellow'
} else {
    Log "step 1/3 export  Redshift -> CSV" 'Cyan'
    try {
        & (Join-Path $scriptDir 'export_car_counts.ps1') -Day $Day 2>&1 | Tee-Object -Append -FilePath $logFile
        if ($LASTEXITCODE -ne 0) { Fail "export exited $LASTEXITCODE" }
    } catch { Fail "export threw: $_" }
    if (-not (Test-Path $csvPath)) { Fail "export produced no CSV at $csvPath" }
}

# ---- CSV sanity check ------------------------------------------------------
#
# Only the small fixed-membership sources are checked here. Counting splashdb
# rows does not work and two earlier versions of this gate got it wrong:
#   * demanding exactly 89 CSV rows blocked 09-06, where the ICS 'Corporate'
#     non-store (always 0 cars, SKIPped downstream) simply did not appear;
#   * demanding exactly 82 splashdb rows blocked 09-02/03/07/08, where a new
#     site 'Splash Bayville-234' showed up with a blank count, also SKIPped.
# The splashdb roster legitimately moves: new stores open, and sites that never
# reach D1 anyway (Bronx-096, Brighton-155) flicker in and out day to day.
#
# The real completeness check is on the BUILD output further down -- the number
# of location_codes that actually land in D1.
$rows = @(Import-Csv -Path $csvPath)
Log ("         CSV has {0} rows" -f $rows.Count)

$counts = @{}
$rows | Group-Object source | ForEach-Object { $counts[$_.Name] = $_.Count }

# spot_ai and DRB are fixed two-site sources. A missing row here means a real
# gap-fill site vanished, which nothing downstream can compensate for.
$expected = [ordered]@{ spot_ai = 2; DRB = 2 }
foreach ($src in $expected.Keys) {
    $got = [int]$counts[$src]
    if ($got -ne $expected[$src]) {
        Fail "expected $($expected[$src]) $src rows, got $got. A gap-fill site is missing - investigate before loading."
    }
}

# ICS: the two WashCo stores are required. 'Corporate' is optional.
$washco = @($rows | Where-Object { $_.source -eq 'ICS' -and $_.location_name -like 'WashCo*' })
if ($washco.Count -ne 2) {
    Fail "expected 2 ICS WashCo rows, got $($washco.Count). Investigate before loading."
}
Log ("         csv OK: splashdb {0} | spot_ai {1} | DRB {2} | ICS WashCo {3}" -f `
    $counts['splashdb'], $counts['spot_ai'], $counts['DRB'], $washco.Count)

# ---- 2. build --------------------------------------------------------------
Log "step 2/3 build   CSV -> SQL" 'Cyan'
$buildOut = $null
try {
    $buildOut = & python (Join-Path $scriptDir 'build_car_counts.py') $Day 2>&1 |
                Tee-Object -Append -FilePath $logFile
    if ($LASTEXITCODE -ne 0) { Fail "build_car_counts.py exited $LASTEXITCODE" }
} catch { Fail "build threw: $_" }
if (-not (Test-Path $sqlPath)) { Fail "build produced no SQL at $sqlPath" }

# ---- completeness gate -----------------------------------------------------
#
# This is the one that matters. build_car_counts.py prints "<n> rows, <c> cars"
# and <n> is the number of location_codes that will be written to D1. A store
# genuinely dropping out of the extract shows up here as a lower count; new or
# unmapped sites appearing upstream do not, because they never survive the build.
#
# Do NOT add a cars-based threshold. Car-wash volume is weather-driven and swings
# 40% day to day, so any "that looks low" alarm fires constantly and gets ignored.
$builtRows = $null
foreach ($line in $buildOut) {
    $m = [regex]::Match([string]$line, '^\s*(\d+)\s+rows,')
    if ($m.Success) { $builtRows = [int]$m.Groups[1].Value; break }
}

if ($null -eq $builtRows) {
    Fail "could not read the row count out of build_car_counts.py output - refusing to load blind."
}
if ($builtRows -ne $ExpectedRows) {
    Fail ("build produced $builtRows location_codes, expected $ExpectedRows. A store is missing " +
          "(or a new one opened). Check the SKIP lines above, then re-run with -ExpectedRows if the change is real.")
}
Log "         build OK: $builtRows location_codes"

# ---- 3. apply --------------------------------------------------------------
# apply.mjs runs the overlap pre-flight itself and exits 2 if the day is covered.
Log "step 3/3 apply   overlap pre-flight -> D1 -> verify" 'Cyan'

$applyArgs = @((Join-Path $scriptDir 'apply.mjs'), $sqlPath)
if ($DryRun) { $applyArgs += '--dry-run' }

$attempt = 0
while ($true) {
    $attempt++
    Log ("         attempt {0}/{1}" -f $attempt, $MaxRetries)

    # Native tools write progress to stderr; with ErrorActionPreference=Stop that
    # gets promoted to a terminating error and kills the retry loop. Exit code is
    # the only reliable signal here.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & node @applyArgs 2>&1 | Tee-Object -Append -FilePath $logFile
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP

    if ($code -eq 0) { break }

    if ($code -eq 2) {
        Log "OVERLAP ABORT: rows not written by this pipeline already cover $Day." 'Red'
        Log "This is NOT retried - re-running would double-count in sumCarsInWindow()." 'Red'
        Log "Trim or delete the overlapping rows, then run again." 'Red'
        exit 2
    }

    if ($code -eq 3) {
        Log "SAFETY ABORT: the overlap check result could not be parsed, so $Day" 'Red'
        Log "could not be confirmed safe. apply.mjs failed closed and wrote nothing." 'Red'
        Log "Not retried - see the error above." 'Red'
        exit 3
    }

    if ($attempt -ge $MaxRetries) {
        Fail "apply failed $MaxRetries times (last exit code $code)"
    }

    $wait = 15 * $attempt
    Log ("         transient failure (exit {0}) - retrying in {1}s" -f $code, $wait) 'Yellow'
    Start-Sleep -Seconds $wait
}

Log "===== done: $Day =====" 'Green'
if ($DryRun) {
    Log "Dry run only - D1 was not modified." 'Yellow'
} else {
    Log "Check the verify block above: it should report the row count and car total now in D1." 'Green'
}
Log "Log written to $logFile"
