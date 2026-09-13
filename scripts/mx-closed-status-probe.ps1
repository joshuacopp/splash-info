# mx-closed-status-probe.ps1
#
# Settles one question: does GET /workorders actually honor statuses=DONE?
#
# The history pass (work_orders_history) sends statuses=DONE|CANCELED|SKIPPED
# together with createdAt[gte] and gets back HTTP 200 with an empty collection
# and a null cursor -- which its logic correctly reads as "complete". Result:
# zero closed work orders in mx_work_order against an expected ~18,600.
#
# Static analysis cannot settle it. Neither probe script ever sent a closed
# status value: mx-probe.py sent no statuses at all and tallied DONE locally,
# and mx-probe-open.py sent LIVE statuses only. So CLOSED_WORK_ORDER_STATUSES
# has never once been exercised against the live API.
#
# This bisects the three variables -- statuses, the createdAt bound, and their
# combination -- with six one-page reads. Nothing is written anywhere.
#
# Reads MAINTAINX_API_KEY and MAINTAINX_BASE_URL from apps/workorders-worker/.dev.vars.
# The key is never printed.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\mx-closed-status-probe.ps1

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
$since   = (Get-Date).AddDays(-183).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

Write-Host "base   : $base"
Write-Host "since  : $since"
Write-Host ("key    : {0} chars" -f $key.Length)
Write-Host ''

function Probe {
  param([string]$Label, [string]$Query)

  $url = "$base/workorders?$Query"
  try {
    $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 60
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Write-Host ("{0,-34} ERROR {1} {2}" -f $Label, $code, $_.Exception.Message) -ForegroundColor Red
    Write-Host ("  {0}" -f $Query) -ForegroundColor DarkGray
    return
  }

  $rows   = @($r.workOrders)
  $cursor = $r.nextCursor
  $stat   = ($rows | Group-Object status | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
  $color  = if ($rows.Count -eq 0) { 'Yellow' } else { 'Green' }

  Write-Host ("{0,-34} rows={1,-4} cursor={2}" -f $Label, $rows.Count, $(if ($cursor) { 'yes' } else { 'NULL' })) -ForegroundColor $color
  if ($stat) { Write-Host ("  statuses: {0}" -f $stat) -ForegroundColor DarkGray }
  Write-Host ("  {0}" -f $Query) -ForegroundColor DarkGray
  Write-Host ''
}

$bound = "createdAt[gte]=$since"

# 1. What the probe did, and what it proved: no status filter at all. Expected
#    to return a full page including DONE rows.
Probe 'A date bound only'            "limit=25&$bound"

# 2. The live pass, minus the date bound. Known good -- 3,958 rows in prod.
Probe 'B live statuses only'         'limit=25&statuses=OPEN&statuses=IN_PROGRESS&statuses=ON_HOLD'

# 3. One closed status, nothing else. If this is empty, the list endpoint does
#    not serve closed work orders and the whole pass design is wrong.
Probe 'C DONE only'                  'limit=25&statuses=DONE'

# 4. All three closed statuses, no date bound. Isolates the bound.
Probe 'D closed statuses only'       'limit=25&statuses=DONE&statuses=CANCELED&statuses=SKIPPED'

# 5. Exactly what the history pass sends. This is the one that returns zero in
#    production -- reproducing it here confirms the harness is faithful.
Probe 'E closed + bound (the pass)'  "limit=25&statuses=DONE&statuses=CANCELED&statuses=SKIPPED&sort=-updatedAt&$bound"

# 6. Live statuses WITH the bound. If A and B pass but E and F both fail, the
#    problem is the conjunction, not either half.
Probe 'F live + bound'               "limit=25&statuses=OPEN&statuses=IN_PROGRESS&statuses=ON_HOLD&$bound"

Write-Host 'How to read this:' -ForegroundColor Cyan
Write-Host '  A has DONE rows but C is empty -> list endpoint ignores closed status values.'
Write-Host '  C and D return rows but E is empty -> closed statuses + createdAt bound conflict.'
Write-Host '  E returns rows here -> the bug is in the worker, not the API.'
