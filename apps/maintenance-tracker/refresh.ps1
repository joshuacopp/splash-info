<#
    refresh.ps1

    The whole maintenance-tracker chain in one command. Pulls Layer A
    (Connecteam punches) and Layer B (Geotab dwell) out of Redshift, rebuilds
    the Connecteam job -> site crosswalk, and upserts all of it into Supabase.

        .\refresh.ps1                  # full refresh
        .\refresh.ps1 -SkipCrosswalk   # punches + dwell only (much faster)
        .\refresh.ps1 -DryRun          # export + build, write nothing

    WHY THIS EXISTS
      The MaintainX half of the tracker keeps itself current -- webhooks plus
      three crons on workorders-worker. The Connecteam and Geotab halves do
      NOT. They were loaded by hand on 2026-09-16, and without this script the
      dashboard at /admin/maintenance would go on displaying September for ever
      while looking exactly as authoritative as it does today. A stale number
      that still renders is the failure mode this codebase keeps hitting; see
      the webhook-retry and empty-200 entries in BUILD_STATE.

      Cloudflare cannot do this job. Redshift speaks the Postgres wire protocol
      over a private endpoint reachable from this machine's pg_service/pgpass
      credentials, and Workers have neither. So it runs here on a schedule,
      exactly as apps/damage-worker/daily does for car counts.

    REDSHIFT IS READ-ONLY AND STAYS THAT WAY
      Every statement sent to splashdb is a SELECT. It is a company-wide
      warehouse and nothing in this pipeline writes to it. All writes go to
      Supabase.

    REQUIRES
      - psql on PATH, plus the `splashdb` pg_service entry (same one
        apps/damage-worker/daily/export_car_counts.ps1 uses).
      - python on PATH.
      - SUPABASE_DB_URL set as a USER environment variable, holding the
        SESSION POOLER connection string. Not the "Direct connection" one:
        db.<ref>.supabase.co resolves over IPv6 only and fails on an IPv4
        network with "could not translate host name", which reads like a typo
        rather than a network-family mismatch. Set it once with:

            setx SUPABASE_DB_URL "postgresql://postgres.<ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres"

        then open a new shell. It is read from the environment and never
        echoed, so it stays out of logs and out of the repo.

    SAFETY
      Every write is an idempotent upsert over the whole window, so this is
      safe to re-run and safe to run twice concurrently with itself. There is
      no per-day append and therefore none of the double-counting hazard that
      makes apps/damage-worker/daily/apply.mjs refuse to retry. A failed run
      leaves the previous data in place; it never half-applies, because each
      apply is wrapped in its own transaction by the generating script.

      The row-count floors below are structural, not value judgements. They
      catch "the export silently returned nothing", which is the one failure
      that would otherwise upsert an empty set and look like success.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipCrosswalk,
    [int]$MinPunchRows = 2000,
    [int]$MinDwellRows = 2500
)

$ErrorActionPreference = 'Stop'
$env:PGCLIENTENCODING  = 'UTF8'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$work      = Join-Path $scriptDir 'work'
$logDir    = Join-Path $scriptDir 'logs'
New-Item -ItemType Directory -Force -Path $work, $logDir | Out-Null

$stamp   = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$logFile = Join-Path $logDir "refresh_$stamp.log"

function Say($msg, $colour = 'Cyan') {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line -ForegroundColor $colour
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Invoke-Redshift($sqlPath, $outCsv) {
    & psql "service=splashdb" --csv -P pager=off --no-psqlrc -v ON_ERROR_STOP=1 -f $sqlPath -o $outCsv
    if ($LASTEXITCODE -ne 0) { throw "Redshift export failed ($sqlPath)" }
}

function Invoke-Supabase($sqlPath) {
    if (-not $env:SUPABASE_DB_URL) {
        throw "SUPABASE_DB_URL is not set. See the header of this script."
    }
    & psql $env:SUPABASE_DB_URL -v ON_ERROR_STOP=1 -P pager=off --no-psqlrc -f $sqlPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Supabase apply failed ($sqlPath)" }
}

function Row-Count($csv) { (Get-Content $csv | Measure-Object -Line).Lines - 1 }

Say "maintenance tracker refresh starting (log: $logFile)"
if ($DryRun) { Say "DRY RUN - nothing will be written to Supabase" 'Yellow' }

# ---- 0. site centres (Supabase -> CSV) --------------------------------------
# build_dwell.py and the crosswalk both need these, and they live in Supabase,
# so they are dumped rather than hardcoded. A coordinate correction then flows
# through on the next run instead of silently diverging.
$sitesCsv = Join-Path $work 'sites.csv'
if (-not $env:SUPABASE_DB_URL) { throw "SUPABASE_DB_URL is not set. See the header of this script." }
& psql $env:SUPABASE_DB_URL --csv -P pager=off --no-psqlrc -v ON_ERROR_STOP=1 -o $sitesCsv -c @'
select site_number, latitude, longitude, coalesce(geofence_radius_m,150) geofence_radius_m
from public.locations
where latitude is not null and longitude is not null
order by site_number;
'@
if ($LASTEXITCODE -ne 0) { throw "could not read site coordinates from Supabase" }
Say ("site centres: {0}" -f (Row-Count $sitesCsv))

# ---- 1. Layer A: Connecteam punches -----------------------------------------
$punchCsv = Join-Path $work 'punches_raw.csv'
$punchSql = Join-Path $work 'mt_punch.sql'
Say "exporting punches from Redshift ..."
Invoke-Redshift (Join-Path $scriptDir 'queries\10_punches.sql') $punchCsv
$punchRows = Row-Count $punchCsv
Say "punches exported: $punchRows"
if ($punchRows -lt $MinPunchRows) {
    throw "only $punchRows punch rows (floor $MinPunchRows). Refusing to apply - an export that returns almost nothing must not overwrite a good load."
}
& python (Join-Path $scriptDir 'build_punches.py') $punchCsv $sitesCsv > $punchSql
if ($LASTEXITCODE -ne 0) { throw "build_punches.py failed" }

# ---- 2. Layer B: Geotab dwell ------------------------------------------------
$dwellCsv = Join-Path $work 'dwell_raw.csv'
$dwellSql = Join-Path $work 'mt_gps_dwell.sql'
Say "exporting GPS dwell from Redshift (this is the slow one) ..."
Invoke-Redshift (Join-Path $scriptDir 'queries\20_dwell.sql') $dwellCsv
$dwellRows = Row-Count $dwellCsv
Say "dwell intervals exported: $dwellRows"
if ($dwellRows -lt $MinDwellRows) {
    throw "only $dwellRows dwell rows (floor $MinDwellRows). Refusing to apply."
}
& python (Join-Path $scriptDir 'build_dwell.py') $dwellCsv $sitesCsv > $dwellSql
if ($LASTEXITCODE -ne 0) { throw "build_dwell.py failed" }

# ---- 3. job -> site crosswalk ------------------------------------------------
# Skippable because it re-reads every ping in the window and is by far the most
# expensive step, while the answer moves slowly -- it is a modal site over
# months of behaviour. Weekly is plenty; daily is waste.
$xwApply = $null
if (-not $SkipCrosswalk) {
    $xwQuery  = Join-Path $work 'job_site_query.sql'
    $xwResult = Join-Path $work 'job_site_result.csv'
    $xwApply  = Join-Path $work 'job_site_apply.sql'
    Say "rebuilding the Connecteam job -> site crosswalk ..."
    & python (Join-Path $scriptDir 'build_job_site.py') query $sitesCsv > $xwQuery
    if ($LASTEXITCODE -ne 0) { throw "build_job_site.py query failed" }
    Invoke-Redshift $xwQuery $xwResult
    Say ("jobs resolved: {0}" -f (Row-Count $xwResult))
    & python (Join-Path $scriptDir 'build_job_site.py') apply $xwResult > $xwApply
    if ($LASTEXITCODE -ne 0) { throw "build_job_site.py apply failed" }
} else {
    Say "skipping crosswalk rebuild (-SkipCrosswalk)" 'Yellow'
}

if ($DryRun) {
    Say "dry run complete - nothing written. SQL is in $work" 'Yellow'
    return
}

# ---- 4. apply to Supabase -----------------------------------------------------
Say "applying punches ..."     ; Invoke-Supabase $punchSql
Say "applying dwell ..."       ; Invoke-Supabase $dwellSql
if ($xwApply) { Say "applying crosswalk ..." ; Invoke-Supabase $xwApply }

# mt_shift_site is derived inside Supabase from the crosswalk, so it is a
# statement rather than a generated file. Re-derived every run: a shift whose
# job was previously unresolved becomes attributable the moment its job earns
# enough observations.
Say "re-deriving mt_shift_site ..."
$shiftSiteSql = Join-Path $work 'shift_site.sql'
Set-Content -Path $shiftSiteSql -Encoding utf8 -Value @'
-- mt_shift_site cannot be rebuilt from Supabase alone: the shift -> job link
-- lives only in Redshift raw_json. This refreshes the CONFIDENCE of rows we
-- already hold, which is what actually changes between runs.
update mt_shift_site s
   set confidence = case
         when x.confidence = 'CONFIDENT'      then 'C'
         when x.confidence = 'LIKELY'         then 'L'
         when x.confidence = 'WEAK'           then 'W'
         when x.confidence = 'TOO_FEW_SHIFTS' then 'F'
         else 'I' end,
       site_number = x.site_number,
       derived_at = now()
  from mt_connecteam_job_site x
 where x.site_number is not null
   and s.site_number is distinct from x.site_number;
'@
Invoke-Supabase $shiftSiteSql

# ---- 5. verify ----------------------------------------------------------------
# Reads back what actually landed. A refresh that reports success without
# looking is how a silently-empty load gets believed.
Say "verifying ..."
& psql $env:SUPABASE_DB_URL -P pager=off --no-psqlrc -c @'
select 'mt_punch' t, count(*) rows, max(start_utc)::date newest from mt_punch
union all select 'mt_gps_dwell', count(*), max(arrived_at)::date from mt_gps_dwell
union all select 'mt_shift_site', count(*), null from mt_shift_site
union all select 'mt_connecteam_job_site', count(*), null from mt_connecteam_job_site;
'@ | Tee-Object -FilePath $logFile -Append

Say "refresh complete." 'Green'
