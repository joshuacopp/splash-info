// Inventory export — builds a multi-sheet .xlsx from the snapshot the page is
// already showing.
//
// Runs in the BROWSER, not the worker. The numbers come from
// inventorySnapshot() in ./calc.js, which is client-side JS; a worker route
// would have to re-implement that math in TypeScript and the two copies would
// drift the first time a rule changed. @splash/xlsx has no dependencies and no
// Node built-ins, so it runs unmodified in either place — the choice is purely
// about where the source of truth for the numbers lives.
//
// Consequence worth knowing: the export reflects the CURRENT FILTERS. Exporting
// with a manager filter applied gives you that manager's sites, not the network.
// The Summary sheet records the active filters so a file can't be misread later.

import { buildXlsxWorkbookMultiSheet } from '@splash/xlsx'

/**
 * @param {object}   args
 * @param {object}   args.snap        inventorySnapshot() result (unfiltered totals)
 * @param {Array}    args.rows        the rows as filtered/sorted on screen
 * @param {string}   args.monthLabel  e.g. "August 2026"
 * @param {boolean}  args.isCurrent   viewing the current month
 * @param {string}   args.asOfIso     cutoff date the snapshot used
 * @param {string}   args.manager     active manager filter ("All" when none)
 * @param {string}   args.query       active search text ("" when none)
 * @returns {Uint8Array}
 */
export function buildInventoryWorkbook({
  snap,
  rows,
  monthLabel,
  isCurrent,
  asOfIso,
  manager,
  query,
}) {
  const reporting = rows.filter((r) => r.onHandValue != null)
  const shownValue = reporting.reduce((n, r) => n + (r.onHandValue || 0), 0)

  return buildXlsxWorkbookMultiSheet([
    summarySheet({ snap, rows, reporting, shownValue, monthLabel, isCurrent, asOfIso, manager, query }),
    sitesSheet(rows),
    byManagerSheet(rows),
  ])
}

function summarySheet({
  snap,
  rows,
  reporting,
  shownValue,
  monthLabel,
  isCurrent,
  asOfIso,
  manager,
  query,
}) {
  const columns = [
    { header: 'Metric', width: 34, kind: 'text' },
    { header: 'Value', width: 18, kind: 'number' },
    { header: 'Detail', width: 46, kind: 'text' },
  ]

  // Numeric metrics put their number in Value so Excel can sum/chart it;
  // context-only rows leave it blank and speak in Detail.
  const body = [
    ['Report month', '', monthLabel],
    [
      'As of',
      '',
      isCurrent
        ? `${asOfIso} (today — latest recorded visit per site)`
        : `${asOfIso} (end of ${monthLabel})`,
    ],
    ['Generated', '', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
    ['', '', ''],
    ['Total inventory value (network)', snap.totalValue, 'All sites in your scope'],
    ['Sites reporting (network)', snap.reportingCount, `of ${snap.totalCount} sites`],
    ['Sites with no data (network)', snap.totalCount - snap.reportingCount, isCurrent ? 'never visited' : 'no visit by this date'],
    ['', '', ''],
    ['Manager filter', '', manager === 'All' ? 'All managers' : manager],
    ['Search filter', '', query ? `"${query}"` : 'none'],
    ['Sites in this export', rows.length, rows.length === snap.totalCount ? 'unfiltered' : 'FILTERED — not the whole network'],
    ['Value in this export', shownValue, `across ${reporting.length} reporting sites`],
  ]

  return { name: 'Summary', columns, rows: body }
}

function sitesSheet(rows) {
  const columns = [
    { header: 'Site', width: 30, kind: 'text' },
    { header: 'Manager', width: 22, kind: 'text' },
    { header: 'Region', width: 22, kind: 'text' },
    { header: 'Most recent visit', width: 18, kind: 'date' },
    { header: 'Inventory value', width: 18, kind: 'number' },
    { header: 'Status', width: 26, kind: 'text' },
  ]

  const body = rows.map((r) => [
    r.location.name,
    r.location.manager || 'Unassigned',
    r.location.region || '',
    r.visit ? r.visit.visit_date : '',
    // Blank, not 0 — a site with no visit has an UNKNOWN value, and a zero
    // would drag any average computed in Excel down as though it were real.
    r.onHandValue != null ? r.onHandValue : '',
    !r.visit ? 'No visit yet' : r.hasNewerVisit ? 'Historical (newer visit exists)' : 'Current',
  ])

  return { name: 'Sites', columns, rows: body }
}

function byManagerSheet(rows) {
  const columns = [
    { header: 'Manager', width: 24, kind: 'text' },
    { header: 'Sites', width: 10, kind: 'number' },
    { header: 'Reporting', width: 12, kind: 'number' },
    { header: 'Total value', width: 18, kind: 'number' },
    { header: 'Avg per reporting site', width: 22, kind: 'number' },
  ]

  const byManager = new Map()
  for (const r of rows) {
    const key = r.location.manager || 'Unassigned'
    if (!byManager.has(key)) byManager.set(key, { sites: 0, reporting: 0, total: 0 })
    const g = byManager.get(key)
    g.sites += 1
    if (r.onHandValue != null) {
      g.reporting += 1
      g.total += r.onHandValue
    }
  }

  const body = [...byManager.entries()]
    .sort((a, b) =>
      a[0] === 'Unassigned' ? 1 : b[0] === 'Unassigned' ? -1 : b[1].total - a[1].total
    )
    .map(([name, g]) => [
      name,
      g.sites,
      g.reporting,
      g.total,
      // Blank rather than 0 when nothing reported — same reasoning as above.
      g.reporting ? Math.round((g.total / g.reporting) * 100) / 100 : '',
    ])

  return { name: 'By manager', columns, rows: body }
}

/** Hand the bytes to the browser as a download. */
export function downloadBytes(bytes, filename, mime) {
  // Copy into a fresh ArrayBuffer: Blob will not accept a Uint8Array backed by
  // a SharedArrayBuffer, and slicing guarantees a plain one.
  const blob = new Blob([bytes.slice().buffer], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function inventoryExportFilename(month, ext) {
  return `splash-inventory-${month}.${ext}`
}
