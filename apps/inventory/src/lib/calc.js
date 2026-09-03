// ---------------------------------------------------------------------------
// Calculation engine. All derived values are computed on read; nothing derived
// is ever stored.
//
// THIS is what the app and the visit report email render from — the worker
// selects the raw tables and calls in here. The SQL views in
// supabase/inventory-tables.sql state the same model for anything querying the
// database directly, and are kept in step deliberately, but they are not the
// authority and they are not identical. Known divergences, so nobody "fixes"
// one to match the other by accident:
//   - OVER_TARGET_FACTOR is 1.3 here, 1.15 in inventory_entry_calc.
//   - blended_target_cpc in visit_summary reads packages.target_cpc, a column
//     savePackageConfig always writes NULL; here it is derived from package
//     composition. The view's figure is effectively dead.
//
// v2 additions: per-entry discounts, package composition (computed target CPC),
// usage trends across visits, YTD network stats, stale-site detection.
// v3: per-entry price snapshot — see computeVisit.
// ---------------------------------------------------------------------------
import { num } from './format'

export const GAL_TO_ML = 3785.411784
export const OVER_TARGET_FACTOR = 1.3 // flag usage >30% over target
export const STALE_AFTER_DAYS = 30 // vs the network's most recent visit

// Display label for how a product's chemical is metered at this visit.
export function meteringLabel(entry) {
  if (entry.meteringType === 'tip') return entry.tipColor ? `Tip: ${entry.tipColor}` : 'Tip'
  if (entry.meteringType === 'versadial') return entry.versadialNumber != null ? `Versadial: ${entry.versadialNumber}` : 'Versadial'
  return null
}

// Display label for the injector — color plus its flow rate, when known.
export function injectorLabel(entry) {
  if (!entry.injectorColor && entry.injectorGpm == null) return null
  const parts = []
  if (entry.injectorColor) parts.push(entry.injectorColor)
  if (entry.injectorGpm != null) parts.push(`${entry.injectorGpm} gpm`)
  return parts.join(' · ')
}

export function buildIndex(ds) {
  const locationById = Object.fromEntries((ds.locations || []).map((l) => [l.id, l]))
  const productById = Object.fromEntries((ds.products || []).map((p) => [p.id, p]))
  const packageById = Object.fromEntries((ds.packages || []).map((p) => [p.id, p]))
  const visitById = Object.fromEntries((ds.site_visits || []).map((v) => [v.id, v]))

  const locationProduct = {}
  for (const lp of ds.location_products || []) {
    locationProduct[`${lp.location_id}|${lp.product_id}`] = lp
  }

  // package_id -> [{product_id, uses}]
  const packageProducts = {}
  for (const pp of ds.package_products || []) {
    ;(packageProducts[pp.package_id] ||= []).push(pp)
  }

  // location_id -> visits sorted desc by date
  const visitsByLocation = {}
  for (const v of ds.site_visits || []) {
    ;(visitsByLocation[v.location_id] ||= []).push(v)
  }
  for (const arr of Object.values(visitsByLocation)) {
    arr.sort((a, b) => (a.visit_date < b.visit_date ? 1 : a.visit_date > b.visit_date ? -1 : 0))
  }

  // site_visit_id -> rows
  const entriesByVisit = {}
  for (const e of ds.inventory_entries || []) {
    ;(entriesByVisit[e.site_visit_id] ||= []).push(e)
  }
  const washByVisit = {}
  for (const w of ds.wash_counts || []) {
    ;(washByVisit[w.site_visit_id] ||= []).push(w)
  }

  return {
    locationById,
    productById,
    packageById,
    visitById,
    locationProduct,
    packageProducts,
    visitsByLocation,
    entriesByVisit,
    washByVisit,
  }
}

// Target CPC for a package, computed from its composition:
//   Σ uses × target_ml_per_car × price_per_ml × (1 − location discount)
// Falls back to the stored target_cpc when no composition rows exist.
//
// `basisByProductId` is optional: { [productId]: { price, discount } }, the
// price and discount a specific visit was actually costed at. It exists so a
// visit can hold its target and its actual on the SAME basis. Actuals read the
// per-entry snapshot of both; if targets kept reading the live product price and
// the live location discount, then repricing a chemical — or renegotiating a
// discount — would move the target line on every historical visit while the
// actual line stayed put. The gap between the two is the only number anyone acts
// on, and it would change for a reason that has nothing to do with how the site
// performed.
//
// Omit the argument and this behaves exactly as it always has, at today's price
// and today's discount, which is what a configuration screen wants.
export function packageTargetCpc(idx, pkg, basisByProductId) {
  const comp = idx.packageProducts[pkg.id]
  if (!comp || !comp.length) {
    return pkg.target_cpc != null ? num(pkg.target_cpc) : null
  }
  let total = 0
  for (const pp of comp) {
    const product = idx.productById[pp.product_id]
    const lp = idx.locationProduct[`${pkg.location_id}|${pp.product_id}`]
    if (!product) continue
    const targetMl = lp && lp.target_ml_per_car != null ? num(lp.target_ml_per_car) : 0
    // A product in the package that this visit never touched has no basis of its
    // own, so each field falls back independently to the live configuration —
    // the same fallback the entry itself would use.
    const basis = basisByProductId ? basisByProductId[pp.product_id] : undefined
    const price = basis && basis.price != null ? num(basis.price) : num(product.price_per_ml)
    const discount =
      basis && basis.discount != null ? num(basis.discount) : lp ? num(lp.discount) : 0
    total += num(pp.uses) * targetMl * price * (1 - discount)
  }
  return total
}

// Actual CPC for a package on a SPECIFIC visit, from the same composition
// model as packageTargetCpc — just substituting each product's actual
// (blended-across-the-whole-visit) ml/car for its target ml/car:
//   Σ uses × actual_ml_per_car × price_per_ml × (1 − discount)
// Returns null when the package has no composition rows (nothing to
// allocate) — same fallback shape as packageTargetCpc.
export function packageActualCpc(idx, pkg, entriesByProductId) {
  const comp = idx.packageProducts[pkg.id]
  if (!comp || !comp.length) return null
  let total = 0
  let any = false
  for (const pp of comp) {
    const e = entriesByProductId[pp.product_id]
    if (!e || e.actualMlPerCar == null) continue
    any = true
    total += num(pp.uses) * e.actualMlPerCar * e.pricePerMl * (1 - e.discount)
  }
  return any ? total : null
}

// Full computed view of a single visit.
export function computeVisit(ds, idx, visitId) {
  const visit = idx.visitById[visitId]
  if (!visit) return null
  const location = idx.locationById[visit.location_id] || null

  const washRows = idx.washByVisit[visitId] || []
  // Add-ons (à la carte — Hot Wax, Ceramic Ala, Tire Shine, Wheel Deal, Rain X…)
  // are not washes: excluded from total_wash_count, and so from blended CPC and
  // package mix, which are per-car figures and would double-count a car that
  // bought both. They ARE counted in the per-chemical applications denominator
  // below — an add-on dispenses real chemical, so it belongs there.
  const isAddon = (w) => idx.packageById[w.package_id]?.package_type === 'addon'
  const totalWashCount = washRows.filter((w) => !isAddon(w)).reduce((s, w) => s + num(w.wash_count), 0)
  const totalAddonCount = washRows.filter(isAddon).reduce((s, w) => s + num(w.wash_count), 0)

  // Per-chemical denominator, in APPLICATIONS — how many times that chemical was
  // actually dispensed, not how many cars came through the site:
  //   applications(product) = Σ over every package P whose composition contains
  //                           the product of wash_counts[P] × uses
  // Both wash AND add-on packages count here, unlike totalWashCount: an à la
  // carte Hot Wax dispenses the same wax as the package that bundles it, so its
  // consumption is already in the numerator and its applications belong in the
  // denominator. `uses` is a real multiplier (production has rows with uses = 2),
  // never a membership flag, so it must stay a multiplication.
  //
  // e.g. wax in Bubble Bath (uses 1) and in the Hot Wax add-on (uses 1), with
  // 10 bubble baths and 3 hot waxes ⇒ denominator 13.
  const applicationsByProductId = {}
  const packagesMissingBom = []
  for (const w of washRows) {
    const count = num(w.wash_count)
    const comp = idx.packageProducts[w.package_id]
    if (!comp || !comp.length) {
      // Sold, but with no bill of materials to allocate it to. Recorded rather
      // than skipped: these silently shrink every affected chemical's
      // denominator, so they have to be visible.
      if (count > 0) {
        const pkg = idx.packageById[w.package_id]
        packagesMissingBom.push({
          packageId: w.package_id,
          name: pkg ? pkg.name : '(unknown package)',
          isAddon: pkg?.package_type === 'addon',
          washCount: count,
        })
      }
      continue
    }
    for (const pp of comp) {
      applicationsByProductId[pp.product_id] =
        (applicationsByProductId[pp.product_id] || 0) + count * num(pp.uses)
    }
  }

  const entryRows = idx.entriesByVisit[visitId] || []
  const entries = entryRows.map((e) => {
    const product = idx.productById[e.product_id]
    // The snapshot taken when the visit was filed, falling back to the live
    // product price only when there isn't one (an entry predating the
    // price_per_ml migration). Reading the product row first is what made a
    // reprice retroactive: every past visit's chemical cost, blended CPC and
    // delivery value moved the moment a price changed, including visits already
    // emailed to a site manager. `!= null` and not a truthy test — 0 is a real,
    // stored price (see the 100%-discount rows), and `|| product.price` would
    // quietly un-freeze exactly those.
    const price =
      e.price_per_ml != null ? num(e.price_per_ml) : product ? num(product.price_per_ml) : 0
    const discount = num(e.discount)
    const usageGal = num(e.starting_qty_gal) + num(e.qty_delivered_gal) - num(e.ending_qty_gal)
    const usageMl = usageGal * GAL_TO_ML
    const cost = usageMl * price * (1 - discount)
    const onHandValue = num(e.ending_qty_gal) * GAL_TO_ML * price * (1 - discount)
    const deliveredValue = num(e.qty_delivered_gal) * GAL_TO_ML * price * (1 - discount)

    const lp = idx.locationProduct[`${visit.location_id}|${e.product_id}`]
    const targetMlPerCar = lp && lp.target_ml_per_car != null ? num(lp.target_ml_per_car) : null
    // Divided by the applications of THIS chemical, not by every car at the
    // location. A chemical carried by one premium package used to be spread
    // across the whole site's traffic, which understated its real dose.
    const applications = applicationsByProductId[e.product_id] || 0
    const actualMlPerCar = applications > 0 ? usageMl / applications : null
    const overTarget =
      targetMlPerCar != null &&
      targetMlPerCar > 0 &&
      applications > 0 &&
      actualMlPerCar > targetMlPerCar * OVER_TARGET_FACTOR
    const hasCounts = e.reservoir_count_gal != null && e.floor_count_gal != null
    // Usage can never physically be negative — ending can't exceed what you
    // started with plus what was delivered. Almost always a missed delivery
    // entry or a miscounted reservoir/floor. Flagged, never blocked.
    const negativeUsage = usageGal < -0.005

    return {
      id: e.id,
      productId: e.product_id,
      name: product ? product.name : '(unknown product)',
      description: product ? product.description : null,
      unitType: product ? product.unit_type : null,
      pricePerMl: price,
      discount,
      startingQtyGal: num(e.starting_qty_gal),
      qtyDeliveredGal: num(e.qty_delivered_gal),
      reservoirCountGal: e.reservoir_count_gal == null ? null : num(e.reservoir_count_gal),
      floorCountGal: e.floor_count_gal == null ? null : num(e.floor_count_gal),
      endingQtyGal: num(e.ending_qty_gal),
      hasCounts,
      usageGal,
      usageMl,
      cost,
      onHandValue,
      deliveredValue,
      targetMlPerCar,
      actualMlPerCar,
      overTarget,
      overTargetPct:
        targetMlPerCar && targetMlPerCar > 0 && actualMlPerCar != null
          ? actualMlPerCar / targetMlPerCar - 1
          : null,
      negativeUsage,
      flagKeyOverTarget: `overtarget:${visitId}:${e.product_id}`,
      flagKeyNegative: `negative:${visitId}:${e.product_id}`,
      meteringType: e.metering_type || null,
      tipColor: e.tip_color || null,
      versadialNumber: e.versadial_number == null ? null : num(e.versadial_number),
      injectorColor: e.injector_color || null,
      injectorGpm: e.injector_gpm == null ? null : num(e.injector_gpm),
    }
  })
  const entriesByProductId = Object.fromEntries(entries.map((e) => [e.productId, e]))
  // Chemical went out of the drum, but nothing sold at this visit claims to use
  // it — no package containing it has a composition row, or the packages that do
  // sold zero. actualMlPerCar is left null rather than divided by zero; this is
  // the record of what that null cost us, so a hole in the BOM shows up as a
  // question instead of as an empty cell.
  const productsMissingDenominator = entries
    .filter((e) => e.usageMl > 0 && !(applicationsByProductId[e.productId] > 0))
    .map((e) => ({ productId: e.productId, name: e.name, usageMl: e.usageMl }))
  // The basis THIS visit was costed at, for the target side to share.
  //
  // Built from the raw rows, not from `entries`, so that only a genuine stored
  // snapshot lands here. `entries[].pricePerMl` fabricates a 0 when the product
  // row is missing, and 0 is a legal price — passing that through would price
  // the chemical free on the target side instead of falling back to the live
  // product row, which is what an absent basis is supposed to mean.
  const basisByProductId = {}
  for (const e of entryRows) {
    if (e.price_per_ml == null) continue
    basisByProductId[e.product_id] = { price: num(e.price_per_ml), discount: num(e.discount) }
  }

  const packages = washRows
    .map((w) => {
      const pkg = idx.packageById[w.package_id]
      return {
        packageId: w.package_id,
        name: pkg ? pkg.name : '—',
        isAddon: pkg?.package_type === 'addon',
        targetCpc: pkg ? packageTargetCpc(idx, pkg, basisByProductId) : null,
        actualCpc: pkg ? packageActualCpc(idx, pkg, entriesByProductId) : null,
        washCount: num(w.wash_count),
        pct: totalWashCount > 0 && pkg?.package_type !== 'addon' ? num(w.wash_count) / totalWashCount : 0,
      }
    })
    .sort((a, b) => b.washCount - a.washCount)
  const washPackages = packages.filter((p) => !p.isAddon)
  const addonPackages = packages.filter((p) => p.isAddon)

  const chemicalCost = entries.reduce((s, e) => s + e.cost, 0)
  const onHandValue = entries.reduce((s, e) => s + e.onHandValue, 0)
  const deliveredValue = entries.reduce((s, e) => s + e.deliveredValue, 0)
  const blendedCpc = totalWashCount > 0 ? chemicalCost / totalWashCount : null
  const targetWeighted = washPackages.reduce((s, p) => s + (p.targetCpc || 0) * p.washCount, 0)
  const blendedTargetCpc = totalWashCount > 0 ? targetWeighted / totalWashCount : null

  // Two flag conditions, by design: usage more than 30% over goal, and
  // physically impossible negative usage. Reservoir/floor reconciliation used
  // to be a third; it was dropped because the entry form derives
  // ending = reservoir + floor, so a mismatch can only ever come from imported
  // history — it says something about the import, not about the site.
  const overTargetFlags = entries.filter((e) => e.overTarget)
  const negativeUsageFlags = entries.filter((e) => e.negativeUsage)

  return {
    visit,
    location,
    totalWashCount,
    totalAddonCount,
    packages,
    washPackages,
    addonPackages,
    entries,
    chemicalCost,
    onHandValue,
    deliveredValue,
    blendedCpc,
    blendedTargetCpc,
    overTargetFlags,
    negativeUsageFlags,
    flagCount: overTargetFlags.length + negativeUsageFlags.length,
    productsMissingDenominator,
    packagesMissingBom,
  }
}

// Attach prev-visit ml/car + cost deltas to a computed visit (for VisitView).
export function attachPrevDeltas(ds, idx, computed) {
  if (!computed) return computed
  const visits = idx.visitsByLocation[computed.visit.location_id] || []
  const i = visits.findIndex((v) => v.id === computed.visit.id)
  const prev = i >= 0 && i + 1 < visits.length ? visits[i + 1] : null
  if (!prev) return { ...computed, prevVisit: null }
  const prevComputed = computeVisit(ds, idx, prev.id)
  const prevByProduct = Object.fromEntries(prevComputed.entries.map((e) => [e.productId, e]))
  const entries = computed.entries.map((e) => {
    const p = prevByProduct[e.productId]
    return {
      ...e,
      prevMlPerCar: p ? p.actualMlPerCar : null,
      prevCost: p ? p.cost : null,
      mlPerCarDelta:
        p && p.actualMlPerCar != null && e.actualMlPerCar != null
          ? e.actualMlPerCar - p.actualMlPerCar
          : null,
    }
  })
  return { ...computed, entries, prevVisit: prev, prevComputed }
}

export function visitsForLocation(ds, locationId) {
  // kept for API compat; prefer idx.visitsByLocation
  return (ds.site_visits || [])
    .filter((v) => v.location_id === locationId)
    .slice()
    .sort((a, b) => (a.visit_date < b.visit_date ? 1 : a.visit_date > b.visit_date ? -1 : 0))
}

export function latestVisitForLocation(idx, locationId) {
  const vs = idx.visitsByLocation[locationId] || []
  return vs.length ? vs[0] : null
}

// Usage trends: per-product ml/car (+cost/car) across the last N visits.
// Mirrors the spreadsheet "Usage Report" (latest visit in the FIRST column).
export function usageTrends(ds, idx, locationId, lastN = 8) {
  const visits = (idx.visitsByLocation[locationId] || []).slice(0, lastN)
  const computed = visits.map((v) => computeVisit(ds, idx, v.id))

  const productIds = new Set()
  for (const c of computed) for (const e of c.entries) productIds.add(e.productId)

  const rows = [...productIds].map((pid) => {
    const product = idx.productById[pid]
    const lp = idx.locationProduct[`${locationId}|${pid}`]
    const cells = computed.map((c) => {
      const e = c.entries.find((x) => x.productId === pid)
      return e
        ? { mlPerCar: e.actualMlPerCar, costPerCar: c.totalWashCount > 0 ? e.cost / c.totalWashCount : null, overTarget: e.overTarget }
        : null
    })
    return {
      productId: pid,
      name: product ? product.name : '(unknown)',
      description: product ? product.description : null,
      targetMlPerCar: lp && lp.target_ml_per_car != null ? num(lp.target_ml_per_car) : null,
      cells,
    }
  })

  rows.sort((a, b) => a.name.localeCompare(b.name))
  return { visits, computed, rows }
}

function yearOf(iso) {
  return String(iso || '').slice(0, 4)
}

function daysBetween(isoA, isoB) {
  const [ya, ma, da] = String(isoA).slice(0, 10).split('-').map(Number)
  const [yb, mb, db] = String(isoB).slice(0, 10).split('-').map(Number)
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86400000)
}

// Adjustable date windows for trend charts.
export const DATE_WINDOWS = [
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 90 },
  { key: '6m', label: '6M', days: 180 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: null },
]

// Keep only series points within `days` of the most recent point (or all).
export function filterByWindow(series, days) {
  if (!days || !series.length) return series
  const maxIso = series.reduce((m, p) => (p.isoDate > m ? p.isoDate : m), series[0].isoDate)
  return series.filter((p) => daysBetween(maxIso, p.isoDate) <= days)
}

// True when a visit_date is more than `months` calendar months before today.
export function isOlderThanMonths(isoDate, months, todayIso) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = String(todayIso).slice(0, 10).split('-').map(Number)
  const cutoff = Date.UTC(ty, tm - 1 - months, td)
  return Date.UTC(y, m - 1, d) < cutoff
}

// Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD".
export function monthEndIso(yyyyMm) {
  const [y, m] = String(yyyyMm).split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
}

// Inventory value per location AS OF a given date — the most recent visit
// at or before asOfIso, not the network's overall latest visit. Lets the
// Inventory page show "what was on the shelf at the end of June" etc.
export function inventorySnapshot(ds, idx, asOfIso, visibleIds) {
  let locations = (ds.locations || []).filter((l) => l.active !== false)
  if (visibleIds) locations = locations.filter((l) => visibleIds.has(l.id))

  const rows = locations.map((loc) => {
    const visits = idx.visitsByLocation[loc.id] || []
    const asOfVisit = visits.find((v) => v.visit_date <= asOfIso) || null
    const computed = asOfVisit ? computeVisit(ds, idx, asOfVisit.id) : null
    return {
      location: loc,
      visit: asOfVisit,
      onHandValue: computed ? computed.onHandValue : null,
      hasNewerVisit: !!asOfVisit && visits[0]?.id !== asOfVisit.id, // viewing history, not the current value
    }
  })

  const withData = rows.filter((r) => r.onHandValue != null)
  const totalValue = withData.reduce((s, r) => s + r.onHandValue, 0)

  return { rows, totalValue, reportingCount: withData.length, totalCount: rows.length }
}

// Network dashboard: latest-visit + YTD rollup per location.
// visibleIds: optional Set of location ids — restricts the rollup to a
// non-admin, non-all-locations user's assigned sites.
export function networkSummary(ds, idx, visibleIds) {
  let locations = (ds.locations || []).filter((l) => l.active !== false)
  if (visibleIds) locations = locations.filter((l) => visibleIds.has(l.id))

  // network's most recent visit date, and the YTD year it defines
  let maxDate = null
  for (const v of ds.site_visits || []) {
    if (!maxDate || v.visit_date > maxDate) maxDate = v.visit_date
  }
  const ytdYear = maxDate ? yearOf(maxDate) : null

  const rows = locations.map((loc) => {
    const visits = idx.visitsByLocation[loc.id] || []
    const latest = visits[0] || null
    const computed = latest ? computeVisit(ds, idx, latest.id) : null

    // YTD across this location's visits in the current year
    let ytdCars = 0
    let ytdCost = 0
    for (const v of visits) {
      if (ytdYear && yearOf(v.visit_date) !== ytdYear) continue
      const c = computeVisit(ds, idx, v.id)
      ytdCars += c.totalWashCount
      ytdCost += c.chemicalCost
    }

    const staleDays = latest && maxDate ? daysBetween(maxDate, latest.visit_date) : null
    const stale = latest ? staleDays > STALE_AFTER_DAYS : true

    return {
      location: loc,
      latest,
      computed,
      ytdCars,
      ytdCost,
      ytdCpc: ytdCars > 0 ? ytdCost / ytdCars : null,
      stale,
      staleDays,
    }
  })

  const withData = rows.filter((r) => r.computed)
  const totalWashCount = withData.reduce((s, r) => s + r.computed.totalWashCount, 0)
  const totalChemicalCost = withData.reduce((s, r) => s + r.computed.chemicalCost, 0)
  const totalOnHandValue = withData.reduce((s, r) => s + r.computed.onHandValue, 0)
  const totalFlags = withData.reduce((s, r) => s + r.computed.flagCount, 0)
  const networkBlendedCpc = totalWashCount > 0 ? totalChemicalCost / totalWashCount : null
  const targetWeighted = withData.reduce(
    (s, r) => s + (r.computed.blendedTargetCpc || 0) * r.computed.totalWashCount,
    0
  )
  const networkTargetCpc = totalWashCount > 0 ? targetWeighted / totalWashCount : null

  const ytdCars = rows.reduce((s, r) => s + r.ytdCars, 0)
  const ytdCost = rows.reduce((s, r) => s + r.ytdCost, 0)

  return {
    rows,
    maxDate,
    ytdYear,
    ytdCars,
    ytdCost,
    ytdCpc: ytdCars > 0 ? ytdCost / ytdCars : null,
    staleCount: rows.filter((r) => r.stale).length,
    totalWashCount,
    totalChemicalCost,
    totalOnHandValue,
    totalFlags,
    networkBlendedCpc,
    networkTargetCpc,
  }
}
