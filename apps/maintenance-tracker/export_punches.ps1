<#
    export_punches.ps1

    Pulls queries/10_punches.sql from Redshift into a CSV that
    build_punches.py consumes. Layer A, Phase 1.

    USAGE
      .\export_punches.ps1

    REQUIRES
      psql on PATH plus the `splashdb` pg_service entry that
      apps/damage-worker/daily/export_car_counts.ps1 already uses. The
      collector data is a SCHEMA inside splashdb (razayya_agent_collector),
      not a separate database -- there is no second connection to set up.
      Verify with:  psql "service=splashdb" -c "select 1"

    READ-ONLY. SELECT only.
#>
[CmdletBinding()]
param([string]$OutFile)

$ErrorActionPreference = 'Stop'

# psql on Windows announces WIN1252, which Redshift rejects outright.
$env:PGCLIENTENCODING = 'UTF8'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sqlPath   = Join-Path $scriptDir 'queries\10_punches.sql'
if (-not $OutFile) { $OutFile = Join-Path $scriptDir 'punches_raw.csv' }

Write-Host "Pulling Connecteam punches ..." -ForegroundColor Cyan

# -P pager=off is load-bearing: without it psql opens a pager and blocks
# forever when run non-interactively.
& psql "service=splashdb" --csv -P pager=off --no-psqlrc -v ON_ERROR_STOP=1 -f $sqlPath -o $OutFile
if ($LASTEXITCODE -ne 0) { throw "psql exited with code $LASTEXITCODE - CSV not written" }

$rows = Import-Csv -Path $OutFile
Write-Host "Wrote $OutFile  ($($rows.Count) shifts)" -ForegroundColor Green
$rows | Group-Object source_type | Sort-Object Name | ForEach-Object {
    "{0,-8} {1,5}" -f $_.Name, $_.Count
}
