# mx-closed-status-probe4.ps1
#
# Round 3 settled the status bug: CANCELED and SKIPPED in the same `statuses`
# list return HTTP 200 with an empty collection, in either order, and adding
# OPEN does not rescue it. Dropping SKIPPED from a five-value set works fine.
#
# Round 3 did NOT settle the date bounds, because the test was bad. V/W/X came
# back byte-identical, which looked like "bounds ignored" but is exactly what a
# newest-first default sort produces: `createdAt[gte]` and `updatedAt[gte]`
# constrain the OLD end of the list, so page one is the same with or without
# them. That test could not have distinguished the two outcomes.
#
# This round only asks questions where a working bound MUST give a different
# answer than a broken one:
#
#   - a [gte] bound in the FUTURE must return zero rows
#   - a [lte] bound in the PAST must return only old rows
#
# and it prints the actual createdAt/updatedAt range of every page so the
# filtering can be checked against the data rather than inferred from counts.
#
# This matters more than the status bug. The incremental sweep is built
# entirely on updatedAt[gte]. If that bound is silently ignored, the sweep is
# not incremental at all -- it re-walks from the newest row every tick and can
# never reach older changes, which no amount of status-filter fixing repairs.
#
# Both bracket encodings are tested (literal `[` and percent-encoded `%5B`)
# because .NET's Uri class normalizes these inconsistently and round 1 sent one
# form while round 3 sent the other.
#
# Read-only. Writes mx-closed-status-probe4.out.txt beside this file.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\mx-closed-status-probe4.ps1

$ErrorActionPreference = 'Stop'

$varsPath = Join-Path $PSScriptRoot '..\apps\workorders-worker\.dev.vars'
if (-not (Test-Path $varsPath)) { throw "not found: $varsPath" }

$vars = @{}
foreach ($line in Get-Content $varsPath) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    $vars[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}

$key  = $vars['MAINTAINX_API_KEY']
$base = $vars['MAINTAINX_BASE_URL']
if (-not $key)  { throw 'MAINTAINX_API_KEY not in .dev.vars' }
if (-not $base) { $base = 'https://api.getmaintainx.com/v1' }
$base = $base.TrimEnd('/')

$headers = @{ Authorization = "Bearer $key"; Accept = 'application/json' }
$out     = New-Object System.Collections.Generic.List[string]

function Say { param([string]$s) $out.Add($s); Write-Host $s }

Say "base : $base"
Say ''

function Probe {
  param([string]$Label, [string]$Query, [string]$Expect)

  $url = "$base/workorders?$Query"
  try {
    $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 90
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Say ("{0,-30} ERROR {1}" -f $Label, $code)
    Say ("  ? {0}" -f $Query)
    Say ''
    return
  }

  $rows = @($r.workOrders)
  Say ("{0,-30} rows={1,-4} cursor={2}" -f $Label, $rows.Count, $(if ($r.nextCursor) { 'yes' } else { 'NULL' }))
  Say ("  expect: {0}" -f $Expect)

  if ($rows.Count -gt 0) {
    $c = $rows | ForEach-Object { $_.createdAt } | Where-Object { $_ } | Sort-Object
    $u = $rows | ForEach-Object { $_.updatedAt } | Where-Object { $_ } | Sort-Object
    if ($c) { Say ("  createdAt {0}  ..  {1}" -f $c[0], $c[-1]) }
    if ($u) { Say ("  updatedAt {0}  ..  {1}" -f $u[0], $u[-1]) }
  }
  Say ("  ? {0}" -f $Query)
  Say ''
}

# --- baseline: what does an unfiltered page actually span? ---------------

Probe 'AA baseline' 'limit=100' 'a full page; note the date range for comparison'

# --- [gte] in the future: a working bound MUST return zero ---------------

Probe 'AB createdAt gte 2030 (raw)' 'limit=100&createdAt[gte]=2030-01-01T00:00:00.000Z' 'ZERO rows if the bound works'
Probe 'AC createdAt gte 2030 (enc)' 'limit=100&createdAt%5Bgte%5D=2030-01-01T00:00:00.000Z' 'ZERO rows if the bound works'
Probe 'AD updatedAt gte 2030 (raw)' 'limit=100&updatedAt[gte]=2030-01-01T00:00:00.000Z' 'ZERO rows if the bound works'
Probe 'AE updatedAt gte 2030 (enc)' 'limit=100&updatedAt%5Bgte%5D=2030-01-01T00:00:00.000Z' 'ZERO rows if the bound works'

# --- [lte] in the past: a working bound MUST return only old rows --------
#
# This is the sharper test. AB-AE returning zero could in principle mean the
# API errors soft on a weird date. AF must return ROWS, and every one of them
# must be older than the bound -- so it proves the filter is applied, not just
# that something emptied the response.

Probe 'AF createdAt lte 2024-01-01' 'limit=100&createdAt[lte]=2024-01-01T00:00:00.000Z' 'rows, ALL createdAt before 2024-01-01'
Probe 'AG updatedAt lte 2024-01-01' 'limit=100&updatedAt[lte]=2024-01-01T00:00:00.000Z' 'rows, ALL updatedAt before 2024-01-01'

# --- the fix, end to end -------------------------------------------------
#
# No `statuses` param, real page size, sorted the way the incremental sweep
# sorts. If AH returns a healthy mix including DONE and the dates respect the
# bound, the fix is confirmed: drop the status filter, keep the date bound,
# filter status client-side.

Probe 'AH fix: no statuses + bound' 'limit=200&sort=-updatedAt&updatedAt[gte]=2026-09-01T00:00:00.000Z' 'rows, ALL updatedAt on/after 2026-09-01'

$path = Join-Path $PSScriptRoot 'mx-closed-status-probe4.out.txt'
$out | Out-File -FilePath $path -Encoding utf8
Write-Host "wrote $path" -ForegroundColor Cyan
