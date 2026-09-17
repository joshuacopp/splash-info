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
      - SUPABASE_DB_URL set as a USER environment variable. EITHER string the
        Supabase dashboard gives you works -- paste whichever it shows:

            setx SUPABASE_DB_URL "<Project Settings -> Database -> Connection string>"

        then open a new shell. If you paste the "Direct connection" one,
        Resolve-SupabaseUrl converts it: that host is IPv6-only and fails on an
        IPv4 network with "could not translate host name", which reads like a
        typo rather than a network-family mismatch, so the script probes it and
        falls back to the session pooler rather than making anyone remember.

        It is read from the environment and never echoed -- only the host shape
        is logged, with the credentials masked.

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
    # Skip entirely if a run already succeeded within this many hours. 0 = always
    # run. The scheduled tasks pass a value so that the catch-up triggers (boot,
    # and the second DST-straddling daily slot) cost nothing when the day's real
    # run has already happened. Manual runs default to 0 and always do the work.
    [int]$IfStale = 0,
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

<#
    WRITING FILES THAT psql CAN ACTUALLY READ

    PowerShell 5.1's `>` redirection writes UTF-16 LE, and its
    `Set-Content -Encoding utf8` writes UTF-8 WITH a BOM. psql chokes on both:
    a UTF-16 file fails at line 1 with `syntax error at or near "yb"` (the BOM
    bytes rendered as text), and a UTF-8 BOM turns the first statement into
    nonsense the same way.

    This bit on the first live run -- the generated crosswalk query was UTF-16
    and Redshift rejected it. Every generated .sql therefore goes through here,
    which writes UTF-8 with NO BOM explicitly. Do not "simplify" any of these
    call sites back to `>` or `Set-Content -Encoding utf8`; both look correct
    and neither is.
#>
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Sql($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

<#
    Runs a generator and captures its stdout to a file psql can read.

    THE STDERR TRAP. In PowerShell 5.1, assigning a native command's output to
    a variable turns anything it writes to STDERR into an ErrorRecord, and with
    $ErrorActionPreference = 'Stop' that is TERMINATING -- even when the process
    exits 0. The build scripts deliberately report their stats on stderr
    ("read 3332, dropped 7 for spread >300m, wrote 3325..."), so a completely
    successful build was killed by its own progress message the moment output
    started being captured instead of redirected.

    So stderr is merged, split back out by object type, logged rather than
    thrown, and SUCCESS IS DECIDED BY THE EXIT CODE ALONE -- which is the only
    thing that actually means failure. The stats lines are worth keeping: they
    are how anyone notices the spread filter suddenly dropping hundreds of rows.

    Also fails on empty output: an empty .sql file applies cleanly and does
    nothing at all, which is the worst outcome available here.
#>
function Invoke-Generator($py, $argsList, $outPath, $label) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $all  = & python $py @argsList 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }

    $stdout = @(); $stderr = @()
    foreach ($line in $all) {
        if ($line -is [System.Management.Automation.ErrorRecord]) { $stderr += $line.ToString() }
        else { $stdout += $line }
    }
    foreach ($e in $stderr) { if ($e.Trim()) { Say "  $e" 'DarkGray' } }

    if ($code -ne 0) { throw "$label failed (exit $code)" }
    $text = ($stdout -join "`n")
    if ($text.Trim().Length -eq 0) { throw "$label produced no output" }
    Write-Sql $outPath $text
}

function Invoke-Redshift($sqlPath, $outCsv) {
    & psql "service=splashdb" --csv -P pager=off --no-psqlrc -v ON_ERROR_STOP=1 -f $sqlPath -o $outCsv
    if ($LASTEXITCODE -ne 0) { throw "Redshift export failed ($sqlPath)" }
}

# Accepts EITHER connection string the Supabase dashboard offers, because the
# one it shows first ("Direct connection") is the one that does not work here:
# db.<ref>.supabase.co resolves over IPv6 only, so on an IPv4 network psql dies
# with "could not translate host name ... to address" -- a message that reads
# like a typo or a dead project rather than a network-family mismatch. Rather
# than require the operator to know that, this probes the direct host first and
# falls back to the session-pooler spelling of the same credentials.
#
# The pooler prefix is NOT always aws-0; this project is aws-1-us-east-2. Both
# are tried because the prefix cannot be derived from the direct URI, and
# guessing one and failing would look identical to a bad password.
#
# Resolved once per run and reused. Never logged: the password is in it.
$script:ResolvedDbUrl = $null

function Resolve-SupabaseUrl {
    if ($script:ResolvedDbUrl) { return $script:ResolvedDbUrl }
    $raw = $env:SUPABASE_DB_URL
    if (-not $raw) { throw "SUPABASE_DB_URL is not set. See the header of this script." }

    $candidates = @()

    # Supabase's dashboard offers the pooler on 6543 (TRANSACTION mode) and
    # 5432 (SESSION mode) on the same host, and shows 6543 first. Both were
    # measured to run an explicit BEGIN/COMMIT correctly, so 6543 is not
    # broken -- but this pipeline feeds psql whole FILES containing several
    # transactions, and session mode is the one that holds a single backend
    # for the life of that connection. Prefer it, fall back to whatever was
    # given. Nobody should have to know this to set the variable.
    if ($raw -match '^(postgres(?:ql)?://[^@]+@[^:/]*pooler\.supabase\.com):6543/(.+)$') {
        $candidates += "$($Matches[1]):5432/$($Matches[2])"
    }

    $candidates += $raw

    # A "Direct connection" string: db.<ref>.supabase.co is IPv6-only, so on an
    # IPv4 network it fails with "could not translate host name" -- which reads
    # like a typo rather than a network-family mismatch. Rewrite to the pooler.
    # The region prefix cannot be derived from the direct URI (this project is
    # aws-1-us-east-2), and guessing one and failing would be indistinguishable
    # from a bad password, so both are tried.
    if ($raw -match '^postgres(?:ql)?://([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co(?::\d+)?/(.+)$') {
        $pw = $Matches[2]; $ref = $Matches[3]; $db = $Matches[4]
        foreach ($p in @('aws-1-us-east-2', 'aws-0-us-east-2')) {
            $candidates += "postgresql://postgres.$ref`:$pw@$p.pooler.supabase.com:5432/$db"
        }
    }

    foreach ($c in $candidates) {
        & psql $c -t -A -P pager=off --no-psqlrc -c 'select 1' *> $null
        if ($LASTEXITCODE -eq 0) {
            $shape = ($c -replace '://[^@]+@', '://<credentials>@')
            Say "Supabase reachable at $shape"
            $script:ResolvedDbUrl = $c
            return $c
        }
    }
    throw ("Could not reach Supabase on any of $($candidates.Count) candidate host(s). " +
           "If you pasted the 'Direct connection' string, that host is IPv6-only; " +
           "copy the 'Session pooler' string from Project Settings -> Database instead.")
}

function Invoke-Supabase($sqlPath) {
    & psql (Resolve-SupabaseUrl) -v ON_ERROR_STOP=1 -P pager=off --no-psqlrc -f $sqlPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Supabase apply failed ($sqlPath)" }
}

function Row-Count($csv) { (Get-Content $csv | Measure-Object -Line).Lines - 1 }

<#
    THE HEARTBEAT, AND WHY IT IS IN mx_sync_state
      This job runs on a machine in an office. It can lose power, be
      restarted by a patch cycle, or simply be left logged out, and in every
      one of those cases it reports nothing at all -- no error, no log line,
      no failed run. The absence IS the whole signal, and nothing on this
      machine can raise it, because the machine is the thing that is missing.

      So the heartbeat is written to Supabase, where Cloudflare can see it:
      workorders-worker's 05:00 UTC health check (src/mx-health.ts) reads
      mx_sync_state every morning and emails when a row looks wrong. Putting
      the row in that same table means the existing watchdog covers this job
      with one rule rather than a second alerting path nobody maintains.

      Failures are recorded too, not just successes. A run that fails every
      night is a different fault from a machine that is off, and the health
      check can only tell them apart if the failing case leaves a row saying
      ERROR rather than leaving the timestamp untouched.
#>
function Write-Heartbeat($status, $errText, $statsJson) {
    try {
        $f = Join-Path $work 'heartbeat.sql'
        $e = if ($errText) { "'" + ($errText -replace "'", "''") + "'" } else { 'null' }
        Write-Sql $f @"
insert into mx_sync_state (key, last_run_at, last_success_at, last_status, last_error, stats)
values ('maintenance_refresh', now(),
        $(if ($status -eq 'OK') { 'now()' } else { 'null' }),
        '$status', $e, '$statsJson'::jsonb)
on conflict (key) do update set
  last_run_at = excluded.last_run_at,
  last_success_at = coalesce(excluded.last_success_at, mx_sync_state.last_success_at),
  last_status = excluded.last_status,
  last_error = excluded.last_error,
  stats = excluded.stats,
  updated_at = now();
"@
        & psql (Resolve-SupabaseUrl) -v ON_ERROR_STOP=1 -P pager=off --no-psqlrc -f $f | Out-Null
    } catch {
        # Never let the heartbeat take the run down. A refresh that worked and
        # failed to say so is far better than one rolled back for bookkeeping.
        Say "WARNING: could not write heartbeat: $($_.Exception.Message)" 'Yellow'
    }
}

Say "maintenance tracker refresh starting (log: $logFile)"
if ($DryRun) { Say "DRY RUN - nothing will be written to Supabase" 'Yellow' }

# ---- stale check -------------------------------------------------------------
# Lets the catch-up triggers fire freely. They exist to cover a missed run, and
# on a normal day they should cost one cheap query and stop.
if ($IfStale -gt 0 -and -not $DryRun) {
    $age = (& psql (Resolve-SupabaseUrl) -t -A -P pager=off --no-psqlrc -c @'
select coalesce(round(extract(epoch from (now() - last_success_at))/3600)::int, 99999)
from mx_sync_state where key = 'maintenance_refresh';
'@) 2>$null
    if ($LASTEXITCODE -eq 0 -and $age -and ([int]$age) -lt $IfStale) {
        Say "last success was ${age}h ago (under -IfStale $IfStale) - nothing to do." 'DarkGray'
        return
    }
    Say ("no successful run in the last {0}h - proceeding" -f $IfStale)
}

# A script-scope trap rather than wrapping every step in try/catch: it covers
# everything below without re-indenting the whole file, and $ErrorActionPreference
# is Stop so every failure here is terminating and reaches it. `break` re-throws
# after recording, so the task still exits non-zero and Task Scheduler still
# shows a failed run -- the heartbeat is in addition to that, not instead of it.
trap {
    $msg = $_.Exception.Message
    Say "FAILED: $msg" 'Red'
    Write-Heartbeat 'ERROR' $msg '{}'
    break
}

# ---- 0. site centres (Supabase -> CSV) --------------------------------------
# build_dwell.py and the crosswalk both need these, and they live in Supabase,
# so they are dumped rather than hardcoded. A coordinate correction then flows
# through on the next run instead of silently diverging.
$sitesCsv = Join-Path $work 'sites.csv'
& psql (Resolve-SupabaseUrl) --csv -P pager=off --no-psqlrc -v ON_ERROR_STOP=1 -o $sitesCsv -c @'
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
Invoke-Generator (Join-Path $scriptDir 'build_punches.py') @($punchCsv, $sitesCsv) $punchSql 'build_punches.py'

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
Invoke-Generator (Join-Path $scriptDir 'build_dwell.py') @($dwellCsv, $sitesCsv) $dwellSql 'build_dwell.py'

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
    Invoke-Generator (Join-Path $scriptDir 'build_job_site.py') @('query', $sitesCsv) $xwQuery 'build_job_site.py query'
    Invoke-Redshift $xwQuery $xwResult
    Say ("jobs resolved: {0}" -f (Row-Count $xwResult))
    Invoke-Generator (Join-Path $scriptDir 'build_job_site.py') @('apply', $xwResult) $xwApply 'build_job_site.py apply'
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
Write-Sql $shiftSiteSql @'
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
& psql (Resolve-SupabaseUrl) -P pager=off --no-psqlrc -c @'
select 'mt_punch' t, count(*) rows, max(start_utc)::date newest from mt_punch
union all select 'mt_gps_dwell', count(*), max(arrived_at)::date from mt_gps_dwell
union all select 'mt_shift_site', count(*), null from mt_shift_site
union all select 'mt_connecteam_job_site', count(*), null from mt_connecteam_job_site;
'@ | Tee-Object -FilePath $logFile -Append

# OVERLAP ASSERTION. A dwell interval overlapping the previous one for the same
# device is impossible by construction -- they are disjoint sessions -- so any
# overlap means stale rows survived a reload and mt_punch_allocation is now
# counting the same minutes twice. That happened on the first scheduled run
# (3,325 exported, 3,799 in the table, 476 overlapping) and NOTHING reported it:
# the rows were individually valid and the load said success. Checked here so
# the failure can never be silent again.
$overlaps = (& psql (Resolve-SupabaseUrl) -t -A -P pager=off --no-psqlrc -c @'
with o as (select device_id, arrived_at,
                  lag(departed_at) over (partition by device_id order by arrived_at) pe
           from mt_gps_dwell)
select count(*) from o where pe is not null and arrived_at < pe;
'@)
if ($LASTEXITCODE -eq 0 -and [int]$overlaps -gt 0) {
    throw ("$overlaps overlapping dwell intervals after load -- on-site hours are " +
           "being double counted. build_dwell.py must DELETE before inserting; " +
           "an upsert cannot replace a row whose derived arrived_at moved.")
}
Say "dwell overlap check: 0"

$stats = '{{"punch_rows":{0},"dwell_rows":{1},"crosswalk":{2}}}' -f `
         $punchRows, $dwellRows, $(if ($xwApply) { 'true' } else { 'false' })
Write-Heartbeat 'OK' $null $stats

Say "refresh complete." 'Green'
