// Inventory PDF report.
//
// LOADED DYNAMICALLY. Inventory.jsx does `await import('../lib/export-pdf')`
// rather than importing at the top, because this module pulls in pdf-lib
// (~300 kB) via @splash/pdf-report. A static import would put that in the
// initial bundle for every page load, to serve a button most visits never
// press. The dynamic boundary is the whole point of this file being separate
// from export-inventory.js — do not "tidy" the two together.
//
// Same posture as the Excel export: built in the browser from the snapshot
// already on screen, so the numbers cannot drift from what the page shows.

import { PDFDocument } from 'pdf-lib'
import {
  COLORS,
  CONTENT_WIDTH,
  MARGIN,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  drawFooters,
  drawTable,
  loadFonts,
  sanitizeForWinAnsi,
} from '@splash/pdf-report'
import { fmtCurrency, fmtDate, fmtInt } from './format'

// Widths total exactly CONTENT_WIDTH (504pt at Letter with 54pt margins).
// drawTable does not negotiate widths, so this has to add up by hand.
const COLUMNS = [
  { header: 'Site', width: 168 },
  { header: 'Manager', width: 120 },
  { header: 'Most recent visit', width: 90 },
  { header: 'Inventory value', width: 126, align: 'right' },
]

export async function buildInventoryPdf({
  rows,
  monthLabel,
  isCurrent,
  asOfIso,
  manager,
  query,
  scopeLabel,
}) {
  const doc = await PDFDocument.create()
  const fonts = await loadFonts(doc)
  const cursor = { page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN }

  const reporting = rows.filter((r) => r.onHandValue != null)
  const total = reporting.reduce((n, r) => n + (r.onHandValue || 0), 0)

  // ---- Title block ----
  cursor.page.drawText('SPLASH CAR WASH', {
    x: MARGIN,
    y: cursor.y,
    size: 8,
    font: fonts.bold,
    color: COLORS.muted,
  })
  cursor.y -= 22

  cursor.page.drawText('Chemical Inventory', {
    x: MARGIN,
    y: cursor.y,
    size: 22,
    font: fonts.bold,
    color: COLORS.navy,
  })
  cursor.y -= 18

  const subtitle = isCurrent
    ? `Current on-hand value as of ${fmtDate(asOfIso)}`
    : `Snapshot as of the end of ${monthLabel}`
  cursor.page.drawText(sanitizeForWinAnsi(subtitle), {
    x: MARGIN,
    y: cursor.y,
    size: 11,
    font: fonts.regular,
    color: COLORS.text,
  })
  cursor.y -= 24

  // ---- Scope line ----
  // Printed, not implied: a PDF outlives the screen it came from, and a
  // filtered report that doesn't say so gets read as the whole network.
  const filters = []
  if (manager && manager !== 'All') filters.push(`manager: ${manager}`)
  if (query) filters.push(`search: "${query}"`)
  const scopeText =
    filters.length > 0
      ? `${scopeLabel} - ${filters.join(', ')}`
      : `${scopeLabel} - no filters applied`

  cursor.page.drawRectangle({
    x: MARGIN,
    y: cursor.y - 4,
    width: CONTENT_WIDTH,
    height: 20,
    color: COLORS.subtle,
  })
  cursor.page.drawText(sanitizeForWinAnsi(scopeText), {
    x: MARGIN + 8,
    y: cursor.y + 2,
    size: 9,
    font: fonts.bold,
    color: COLORS.text,
  })
  cursor.y -= 34

  // ---- Totals ----
  const stats = [
    ['Total value', fmtCurrency(total, 0)],
    ['Sites reporting', `${fmtInt(reporting.length)} of ${fmtInt(rows.length)}`],
    [
      'Avg per reporting site',
      fmtCurrency(reporting.length ? total / reporting.length : 0, 0),
    ],
  ]
  let statX = MARGIN
  const statW = CONTENT_WIDTH / stats.length
  for (const [label, value] of stats) {
    cursor.page.drawText(sanitizeForWinAnsi(label.toUpperCase()), {
      x: statX,
      y: cursor.y,
      size: 7,
      font: fonts.bold,
      color: COLORS.muted,
    })
    cursor.page.drawText(sanitizeForWinAnsi(value), {
      x: statX,
      y: cursor.y - 16,
      size: 15,
      font: fonts.bold,
      color: COLORS.navy,
    })
    statX += statW
  }
  cursor.y -= 38

  // ---- Table ----
  drawTable(
    doc,
    cursor,
    fonts,
    COLUMNS,
    rows.map((r) => [
      r.location.name,
      r.location.manager || 'Unassigned',
      r.visit ? fmtDate(r.visit.visit_date) : 'no visit yet',
      // Em dash would throw under WinAnsi; drawTable sanitizes, but an
      // explicit hyphen keeps the intent obvious at the call site.
      r.onHandValue != null ? fmtCurrency(r.onHandValue, 0) : '-',
    ]),
    { zebra: true }
  )

  // Footers last — "Page N of M" can't know M until every page exists.
  drawFooters(doc, fonts)

  return doc.save()
}
