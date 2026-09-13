# mx-closed-status-probe2.ps1
#
# Round one established:
#   statuses=DONE                          -> 25 rows
#   statuses=DONE|CANCELED|SKIPPED         -> 0 rows, no date bound involved
#   statuses=OPEN|IN_PROGRESS|ON_HOLD      -> 25 rows
#
# So repeated `statuses` params work in general, DONE is a valid value, and the
# date bound is innocent. Adding CANCELED and/or SKIPPED does not WIDEN the
# result set -- it ZEROES it. That is not OR semantics, which means one of those
# two values is being rejected in a way that silently empties the response
# instead of returning 4xx.
#
# This round answers three things:
#   - which of the two values is the poison (or both)
#   - whether ANY unrecognized value zeroes the query, by sending a deliberate
#     garbage value alongside a known-good one (test I -- the key diagnostic)
#   - whether CANCELLED with two Ls is the real spelling
#
# It also tests the exact six-value set the incremental sweep sends, which is
# the bigger problem: that pass is poisoned the same way and has been silently
# returning zero rows.
#
# Read-only. Writes results to mx-closed-status-probe2.out.txt beside this file.
# The key is never printed.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\mx-closed-status-probe2.ps1

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
  param([string]$Label, [string]$Query)

  $url = "$base/workorders?$Query"
  try {
    $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 60
  } catch {
    $code = $null
    $body = ''
    if ($_.Exception.Response) {
      $code = [int]$_.Exception.Response.StatusCode
      try {
        $rd = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $rd.ReadToEnd()
      } catch { }
    }
    Say ("{0,-30} ERROR {1}  {2}" -f $Label, $code, $body)
    Say ("  ? {0}" -f $Query)
    Say ''
    return
  }

  $rows = @($r.workOrders)
  $stat = ($rows | Group-Object status | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' '
  Say ("{0,-30} rows={1,-4} cursor={2}  {3}" -f $Label, $rows.Count, $(if ($r.nextCursor) { 'yes' } else { 'NULL' }), $stat)
  Say ("  ? {0}" -f $Query)
  Say ''
}

# --- which value is the poison -------------------------------------------

Probe 'G CANCELED alone'      'limit=25&statuses=CANCELED'
Probe 'H SKIPPED alone'       'limit=25&statuses=SKIPPED'
Probe 'I DONE + CANCELED'     'limit=25&statuses=DONE&statuses=CANCELED'
Probe 'J DONE + SKIPPED'      'limit=25&statuses=DONE&statuses=SKIPPED'
Probe 'K CANCELED + SKIPPED'  'limit=25&statuses=CANCELED&statuses=SKIPPED'

# --- is ANY unrecognized value fatal? THE key diagnostic -----------------
#
# DONE is known good. If pairing it with obvious garbage also returns zero
# rather than just ignoring the garbage, then the API silently empties the
# response on any value it does not recognize -- which would mean CANCELED
# and/or SKIPPED simply are not work-order statuses, whatever the OpenAPI
# document claims.

Probe 'L DONE + garbage'      'limit=25&statuses=DONE&statuses=NOT_A_REAL_STATUS'
Probe 'M garbage alone'       'limit=25&statuses=NOT_A_REAL_STATUS'

# --- spelling ------------------------------------------------------------

Probe 'N CANCELLED (two Ls)'  'limit=25&statuses=CANCELLED'
Probe 'O DONE + CANCELLED'    'limit=25&statuses=DONE&statuses=CANCELLED'

# --- mixed live + closed, and the incremental sweep's real payload -------

Probe 'P OPEN + DONE'         'limit=25&statuses=OPEN&statuses=DONE'
Probe 'Q all six (incremental)' 'limit=25&statuses=OPEN&statuses=IN_PROGRESS&statuses=ON_HOLD&statuses=DONE&statuses=CANCELED&statuses=SKIPPED'

# --- comma-separated form, in case repetition is not the intended syntax --

Probe 'R comma-joined closed' 'limit=25&statuses=DONE,CANCELED,SKIPPED'

$path = Join-Path $PSScriptRoot 'mx-closed-status-probe2.out.txt'
$out | Out-File -FilePath $path -Encoding utf8
Write-Host "wrote $path" -ForegroundColor Cyan
