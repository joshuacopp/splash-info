# mx-closed-status-probe3.ps1
#
# Rounds 1-2 narrowed it to one rule. Every status value is valid on its own
# (garbage and CANCELLED-with-two-Ls both 400, so the enum IS validated), and
# OR works normally across most pairs:
#
#   DONE                    25      CANCELED               25
#   SKIPPED                 18      OPEN+DONE              25  (mixed: 17/8)
#   DONE+CANCELED           25      DONE+SKIPPED           25
#   OPEN+IN_PROGRESS+ON_HOLD 25
#
# But every set containing BOTH CANCELED and SKIPPED comes back empty:
#
#   CANCELED+SKIPPED         0      DONE+CANCELED+SKIPPED   0      all six  0
#
# No 4xx, no error -- HTTP 200 with an empty collection and a null cursor,
# which our pass logic correctly reads as "complete". That is the whole bug.
#
# This round does two jobs.
#
# S-U test the rule itself: if it is really the CANCELED+SKIPPED conjunction
# then order should not matter, adding OPEN should not rescue it, and a
# four-value set that omits SKIPPED should be fine.
#
# V-Y validate the intended fix before any code changes. The fix is to stop
# sending `statuses` on the history and incremental passes and filter
# client-side -- round one's test A already proved an unfiltered call returns
# DONE rows happily. V and W confirm that holds at the real page size, and
# X confirms `updatedAt[gte]` actually works, which the incremental sweep
# depends on and which nothing in this repo has ever verified.
#
# Read-only. Writes mx-closed-status-probe3.out.txt beside this file.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\mx-closed-status-probe3.ps1

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

$created = (Get-Date).AddDays(-183).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$updated = '2025-12-21T02:00:07.024Z'   # the incremental sweep's actual stuck watermark

Say "base    : $base"
Say "created : $created"
Say "updated : $updated"
Say ''

function Probe {
  param([string]$Label, [string]$Query)

  $url = "$base/workorders?$Query"
  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 90
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Say ("{0,-32} ERROR {1}" -f $Label, $code)
    Say ("  ? {0}" -f $Query)
    Say ''
    return
  }
  $sw.Stop()

  $rows = @($r.workOrders)
  $stat = ($rows | Group-Object status | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
  Say ("{0,-32} rows={1,-4} cursor={2,-4} {3}ms" -f $Label, $rows.Count, $(if ($r.nextCursor) { 'yes' } else { 'NULL' }), $sw.ElapsedMilliseconds)
  if ($stat) { Say ("  {0}" -f $stat) }
  Say ("  ? {0}" -f $Query)
  Say ''
}

# --- is the rule really "CANCELED and SKIPPED together"? -----------------

Probe 'S SKIPPED+CANCELED (reversed)' 'limit=25&statuses=SKIPPED&statuses=CANCELED'
Probe 'T OPEN+CANCELED+SKIPPED'       'limit=25&statuses=OPEN&statuses=CANCELED&statuses=SKIPPED'
Probe 'U four, no SKIPPED'            'limit=25&statuses=OPEN&statuses=IN_PROGRESS&statuses=ON_HOLD&statuses=DONE&statuses=CANCELED'

# --- validate the fix: no statuses param at all --------------------------

Probe 'V unfiltered + createdAt bound' "limit=200&createdAt%5Bgte%5D=$created"
Probe 'W unfiltered, no bound'         'limit=200'

# --- does updatedAt[gte] work at all? ------------------------------------
#
# The incremental sweep is built on it and it has never been verified. If X
# returns rows, the sweep's only problem is the status filter. If X is empty
# or ignores the bound, there is a second bug underneath the first.

Probe 'X unfiltered + updatedAt bound' "limit=200&updatedAt%5Bgte%5D=$updated"
Probe 'Y updatedAt bound, sorted'      "limit=25&sort=-updatedAt&updatedAt%5Bgte%5D=$updated"

$path = Join-Path $PSScriptRoot 'mx-closed-status-probe3.out.txt'
$out | Out-File -FilePath $path -Encoding utf8
Write-Host "wrote $path" -ForegroundColor Cyan
