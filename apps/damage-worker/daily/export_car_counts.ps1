<#
    export_car_counts.ps1

    Headless replacement for the manual DBeaver "Export resultset -> CSV" step.

    Runs queries/00_combined_daily_pull.sql against the Redshift `splashdb`
    connection and writes the CSV that build_car_counts.py consumes.

    USAGE
      .\export_car_counts.ps1                 # yesterday
      .\export_car_counts.ps1 -Day 2026-09-05 # explicit day (backfill)

    REQUIRES
      psql on PATH, plus a pg_service entry named `splashdb` and a matching
      pgpass line. Verify with:  psql "service=splashdb" -c "select 1"

    READ-ONLY. SELECT only. Never writes to any database.
#>

[CmdletBinding()]
param(
    [string]$Day,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

# psql on Windows announces WIN1252, which Redshift rejects outright.
$env:PGCLIENTENCODING = 'UTF8'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sqlPath   = Join-Path $scriptDir 'queries\00_combined_daily_pull.sql'

if (-not $Day) { $Day = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd') }

if ($Day -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw "Day must be YYYY-MM-DD, got '$Day'"
}
if (-not (Test-Path $sqlPath)) {
    throw "Cannot find combined query at $sqlPath"
}

if (-not $OutFile) {
    $OutFile = Join-Path $scriptDir "daily_car_counts_$Day.csv"
}

# Substitute the {DAY} placeholder into a temp file. The source SQL is never modified.
$sql     = Get-Content -Raw -Path $sqlPath
$sql     = $sql -replace '\{DAY\}', $Day
$tmpSql  = Join-Path $env:TEMP "car_counts_$Day.sql"
Set-Content -Path $tmpSql -Value $sql -Encoding UTF8

Write-Host "Pulling car counts for $Day ..." -ForegroundColor Cyan

# -P pager=off is load-bearing: without it psql opens a pager and blocks forever
# when run non-interactively. --csv gives a proper quoted header + rows.
& psql "service=splashdb" `
    --csv `
    -P pager=off `
    --no-psqlrc `
    -v ON_ERROR_STOP=1 `
    -f $tmpSql `
    -o $OutFile

if ($LASTEXITCODE -ne 0) {
    throw "psql exited with code $LASTEXITCODE - CSV not written"
}

Remove-Item $tmpSql -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Verification. A short day loads silently and looks like a real decline in
# the cost-per-car metric, so this refuses to pass quietly.
# ---------------------------------------------------------------------------
$rows = Import-Csv -Path $OutFile
Write-Host ""
Write-Host "Wrote $OutFile" -ForegroundColor Green
Write-Host ("Rows: {0}   (expected 89)" -f $rows.Count)

$rows | Group-Object source | Sort-Object Name | ForEach-Object {
    $cars = ($_.Group | Where-Object { $_.total_cars -ne '' } |
             Measure-Object -Property total_cars -Sum).Sum
    "{0,-10} {1,3} rows  {2,7} cars" -f $_.Name, $_.Count, $cars
}

$total = ($rows | Where-Object { $_.total_cars -ne '' } |
          Measure-Object -Property total_cars -Sum).Sum
Write-Host ("TOTAL      {0,3} rows  {1,7} cars" -f $rows.Count, $total)

$blanks = ($rows | Where-Object { $_.total_cars -eq '' }).Count
Write-Host "Blank total_cars: $blanks   (7 is normal - non-stores / no lube_cars)"

if ($rows.Count -ne 89) {
    Write-Warning "Row count is $($rows.Count), not 89. Something upstream may be missing."
    Write-Warning "88 with ICS at 2 rows is benign: the 'Corporate' non-store reports 0 cars"
    Write-Warning "and does not appear every day. Anything else - INVESTIGATE BEFORE LOADING."
    Write-Warning "run_daily.ps1 gates on per-source counts, not on this total."
}

# Known-good reference for the regression day.
if ($Day -eq '2026-09-05') {
    Write-Host ""
    Write-Host "Reference CSV for 2026-09-05 (commit df7c52e): 89 rows, 31,389 cars" -ForegroundColor Yellow
    Write-Host "  splashdb 27,056 | ICS 2,389 | DRB 1,272 | spot_ai 672"
    Write-Host "Note: the D1 apply recorded 77 rows / 31,224 cars for this day. That is the"
    Write-Host "POST-build_car_counts.py figure and is NOT comparable to this CSV stage."
    Write-Host "Compare the per-source lines above. Any delta must be explained, not adjusted away."
}
