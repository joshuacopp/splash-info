import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { latestVisitForLocation, computeVisit, GAL_TO_ML } from '../lib/calc'
import { createVisit, updateVisit, sendVisitReport } from '../lib/data'
import { draftKey, loadDraft, saveDraft, clearDraft, formatAge, SAVE_DEBOUNCE_MS } from '../lib/draft'
import { Banner, EmptyState, SectionTitle, Toast, Pill } from '../components/ui'
import { LocationHeader } from './LocationDashboard'
import { fmtCurrency, fmtGal, fmtNumber, fmtDate, todayIso, num } from '../lib/format'

// Doubles as the edit form: mounted at .../visit/:visitId/edit it pre-fills
// from that visit's own stored values and calls updateVisit instead of
// createVisit. Mounted at .../new, visitId is simply undefined.
export default function NewVisit() {
  const { locationId, visitId: editVisitId } = useParams()
  const isEdit = !!editVisitId
  const { dataset, idx, refresh } = useData()
  const { canSubmit, isAdmin, visibleLocationIds, email } = useAuth()
  const navigate = useNavigate()

  const location = idx.locationById[locationId]
  const canAccess = isEdit
    ? isAdmin
    : canSubmit && (!visibleLocationIds || visibleLocationIds.has(locationId))

  const editingVisit = isEdit ? computeVisit(dataset, idx, editVisitId) : null

  const { productRows, packages, washPackages, addonPackages, lastVisit } = useMemo(() => {
    const lps = (dataset.location_products || []).filter((lp) => lp.location_id === locationId)
    const lastVisit = isEdit ? null : latestVisitForLocation(idx, locationId)
    const lastEnding = {}
    const lastMlPerCar = {}
    const lastEquipment = {}
    const source = isEdit ? editingVisit : lastVisit ? computeVisit(dataset, idx, lastVisit.id) : null
    if (source) {
      for (const e of source.entries) {
        lastEnding[e.productId] = isEdit ? e.startingQtyGal : e.endingQtyGal
        lastMlPerCar[e.productId] = e.actualMlPerCar
      }
    }

    // Equipment carries forward from the most recent visit that actually
    // RECORDED it, per product — not simply from the previous visit. Metering
    // and injector config describes the physical hardware, so it persists
    // until somebody changes it; reading only the last visit means one tech
    // leaving the section blank erases the setting for everyone after them.
    // Walking back also lets the imported history (which has no equipment
    // columns at all — they are new in this schema) fill in from the first
    // real visit that records them, rather than staying blank forever.
    // visitsByLocation is sorted newest-first, and a key is only written when
    // still unset, so the most recent recorded value always wins.
    const equipSource = isEdit ? [editVisitId] : (idx.visitsByLocation[locationId] || []).map((v) => v.id)
    const EQUIP_KEYS = ['meteringType', 'tipColor', 'versadialNumber', 'injectorColor', 'injectorGpm']
    // A versadial site never has a tip colour and vice versa, so "complete"
    // means the metering pair plus the injector pair, not all five keys.
    const isComplete = (eq) =>
      eq &&
      ((eq.meteringType === 'tip' && eq.tipColor != null) ||
        (eq.meteringType === 'versadial' && eq.versadialNumber != null)) &&
      eq.injectorColor != null &&
      eq.injectorGpm != null
    for (const vid of equipSource) {
      if (lps.every((lp) => isComplete(lastEquipment[lp.product_id]))) break
      const c = computeVisit(dataset, idx, vid)
      if (!c) continue
      for (const e of c.entries) {
        const into = (lastEquipment[e.productId] ||= {})
        for (const k of EQUIP_KEYS) {
          if (into[k] == null && e[k] != null && e[k] !== '') into[k] = e[k]
        }
      }
    }
    const productRows = lps
      .map((lp) => {
        const p = idx.productById[lp.product_id]
        return {
          productId: lp.product_id,
          name: p ? p.name : '(unknown)',
          description: p ? p.description : null,
          pricePerMl: p ? num(p.price_per_ml) : 0,
          discount: num(lp.discount),
          targetMlPerCar: lp.target_ml_per_car != null ? num(lp.target_ml_per_car) : null,
          starting: lastEnding[lp.product_id] ?? 0,
          lastMlPerCar: isEdit ? null : lastMlPerCar[lp.product_id] ?? null,
          equipment: lastEquipment[lp.product_id] || {},
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    // Washes first, add-ons last — not one alphabetical run. Add-ons are à la
    // carte (Hot Wax, Cer. Ala, Tire Shine…) and calc.js excludes them from
    // total_wash_count and from every CPC denominator, so they are a different
    // kind of number that happens to share a unit. Interleaving them
    // alphabetically invites entering a wash figure in an add-on box.
    const mine = (dataset.packages || []).filter((p) => p.location_id === locationId)
    const byName = (a, b) => a.name.localeCompare(b.name)
    const washPackages = mine.filter((p) => p.package_type !== 'addon').sort(byName)
    const addonPackages = mine.filter((p) => p.package_type === 'addon').sort(byName)
    const packages = [...washPackages, ...addonPackages]
    return { productRows, packages, washPackages, addonPackages, lastVisit }
  }, [dataset, idx, locationId, isEdit, editVisitId, editingVisit])

  const [visitDate, setVisitDate] = useState(() => (isEdit ? editingVisit?.visit.visit_date : todayIso()))
  // Prefilled with the signed-in email, editable. The session carries no
  // display name — only the email — and that is the point: the 1,628 imported
  // visits are signed "Nate", "nh", "Mike Grubka" for the same person across
  // different periods, which cannot be grouped or joined on. An email is one
  // stable identifier per human. Editing an old visit keeps whatever it
  // already said rather than rewriting history to the current user.
  const [submitter, setSubmitter] = useState(() =>
    isEdit ? editingVisit?.visit.submitter || '' : email || ''
  )
  const [notes, setNotes] = useState(() => (isEdit ? editingVisit?.visit.notes || '' : ''))
  const [hardness, setHardness] = useState(() =>
    isEdit && editingVisit?.visit.water_hardness_gpg != null
      ? String(editingVisit.visit.water_hardness_gpg)
      : ''
  )
  const [tds, setTds] = useState(() =>
    isEdit && editingVisit?.visit.tds_ppm != null ? String(editingVisit.visit.tds_ppm) : ''
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [toast, setToast] = useState(null)

  const [rows, setRows] = useState(() => {
    if (isEdit && editingVisit) {
      return Object.fromEntries(
        editingVisit.entries.map((e) => [
          e.productId,
          {
            delivered: String(e.qtyDeliveredGal),
            reservoir: String(e.reservoirCountGal ?? 0),
            floor: String(e.floorCountGal ?? 0),
            meteringType: e.meteringType || '',
            tipColor: e.tipColor || '',
            versadialNumber: e.versadialNumber != null ? String(e.versadialNumber) : '',
            injectorColor: e.injectorColor || '',
            injectorGpm: e.injectorGpm != null ? String(e.injectorGpm) : '',
          },
        ])
      )
    }
    return Object.fromEntries(
      productRows.map((r) => [
        r.productId,
        {
          delivered: '',
          reservoir: '',
          floor: '',
          meteringType: r.equipment.meteringType || '',
          tipColor: r.equipment.tipColor || '',
          versadialNumber: r.equipment.versadialNumber != null ? String(r.equipment.versadialNumber) : '',
          injectorColor: r.equipment.injectorColor || '',
          injectorGpm: r.equipment.injectorGpm != null ? String(r.equipment.injectorGpm) : '',
        },
      ])
    )
  })
  const [washes, setWashes] = useState(() => {
    if (isEdit && editingVisit) {
      return Object.fromEntries(editingVisit.packages.map((p) => [p.packageId, String(p.washCount)]))
    }
    return Object.fromEntries(packages.map((p) => [p.id, '']))
  })

  function setRow(pid, patch) {
    setRows((prev) => ({ ...prev, [pid]: { ...prev[pid], ...patch } }))
  }

  // ---- Local draft --------------------------------------------------------
  // New visits only. Editing a past visit already has a saved record to fall
  // back on, and a stale edit draft resurfacing weeks later would offer to
  // re-apply changes against a row that may have moved on since.
  const dKey = isEdit ? '' : draftKey(email, locationId)
  const values = { visitDate, submitter, notes, hardness, tds, rows, washes }
  const serialized = JSON.stringify(values)

  // The pristine form is not a draft. Every field here arrives pre-seeded —
  // today's date, the signed-in email, equipment and starting quantities
  // carried from the last visit — so saving on mount would leave a draft at
  // every location the user merely opened and greet them with a resume banner
  // for a form they never touched. Diffing against the initial snapshot also
  // means someone who types a number and then deletes it ends up clean again
  // rather than permanently dirty.
  const pristine = useRef(serialized)
  const dirty = serialized !== pristine.current

  // Read once, in the initialiser, so it is captured before any edit in this
  // session can overwrite the stored copy.
  const [pending, setPending] = useState(() => (isEdit ? null : loadDraft(draftKey(email, locationId))))

  useEffect(() => {
    if (!dKey) return undefined
    if (!dirty) {
      // Nothing typed yet, so there is nothing worth keeping — except a draft
      // still being offered. Clearing that one here would mean a reload while
      // the banner sits unanswered silently destroys it.
      if (!pending) clearDraft(dKey)
      return undefined
    }
    // Deliberately saves even while the banner is up. Typing with an
    // unanswered banner is the exact moment the user is unprotected, and
    // overwriting the stored copy costs nothing: Resume applies
    // `pending.values`, which was read into memory at mount and is unaffected.
    // Worst case the user abandons the page and keeps the newer work instead
    // of the older — which is the right trade.
    const t = setTimeout(() => saveDraft(dKey, values), SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
    // `serialized` stands in for `values`, a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey, pending, dirty, serialized])

  function resumeDraft() {
    const v = pending?.values || {}
    if (typeof v.visitDate === 'string') setVisitDate(v.visitDate)
    if (typeof v.submitter === 'string') setSubmitter(v.submitter)
    if (typeof v.notes === 'string') setNotes(v.notes)
    if (typeof v.hardness === 'string') setHardness(v.hardness)
    if (typeof v.tds === 'string') setTds(v.tds)
    // Merged by id, not replaced wholesale. A product or package added in
    // Admin since the draft was written has no saved value and must keep the
    // seed the form just computed for it rather than disappearing; an id that
    // no longer exists is dropped for the same reason.
    if (v.rows && typeof v.rows === 'object') {
      setRows((prev) => {
        const next = { ...prev }
        for (const id of Object.keys(prev)) {
          const saved = v.rows[id]
          if (saved && typeof saved === 'object') next[id] = { ...prev[id], ...saved }
        }
        return next
      })
    }
    if (v.washes && typeof v.washes === 'object') {
      setWashes((prev) => {
        const next = { ...prev }
        for (const id of Object.keys(prev)) {
          if (typeof v.washes[id] === 'string') next[id] = v.washes[id]
        }
        return next
      })
    }
    setPending(null)
  }

  function discardDraft() {
    clearDraft(dKey)
    setPending(null)
  }

  // Washes only — add-ons are excluded, matching calc.js totalWashCount. This
  // number is also the ml/car denominator below, so counting add-ons here
  // would make the live preview disagree with the visit once it is saved.
  const totalWashes = washPackages.reduce((s, p) => s + num(washes[p.id]), 0)
  const totalAddons = addonPackages.reduce((s, p) => s + num(washes[p.id]), 0)

  // Ending is ALWAYS reservoir + floor — never hand-typed. This makes
  // reconciliation mismatches impossible at entry time.
  function computeRow(r) {
    const st = rows[r.productId] || {}
    const reservoir = num(st.reservoir)
    const floor = num(st.floor)
    const ending = reservoir + floor
    const usage = r.starting + num(st.delivered) - ending
    const cost = usage * GAL_TO_ML * r.pricePerMl * (1 - r.discount)
    const mlPerCar = totalWashes > 0 ? (usage * GAL_TO_ML) / totalWashes : null
    const negative = usage < -0.005
    return { reservoir, floor, ending, usage, cost, mlPerCar, negative }
  }

  const totals = productRows.reduce(
    (acc, r) => {
      acc.cost += computeRow(r).cost
      return acc
    },
    { cost: 0 }
  )

  async function onSubmit(e) {
    e.preventDefault()
    setErr(null)
    if (!visitDate) return setErr('Please choose a visit date.')
    setBusy(true)
    try {
      const payload = {
        location_id: locationId,
        visit_date: visitDate,
        submitter: submitter.trim() || null,
        notes: notes.trim() || null,
        // Sent as '' when blank so the worker stores NULL. Never coerce to 0 —
        // 0 gpg is a real reading at an RO/softened site.
        water_hardness_gpg: hardness.trim(),
        tds_ppm: tds.trim(),
        entries: productRows.map((r) => {
          const cr = computeRow(r)
          const st = rows[r.productId] || {}
          return {
            product_id: r.productId,
            starting_qty_gal: r.starting,
            qty_delivered_gal: num(rows[r.productId]?.delivered),
            reservoir_count_gal: cr.reservoir,
            floor_count_gal: cr.floor,
            ending_qty_gal: cr.ending,
            discount: r.discount,
            metering_type: st.meteringType || null,
            tip_color: st.meteringType === 'tip' ? st.tipColor || null : null,
            versadial_number: st.meteringType === 'versadial' ? st.versadialNumber || null : null,
            injector_color: st.injectorColor || null,
            injector_gpm: st.injectorGpm || null,
          }
        }),
        washCounts: packages.map((p) => ({ package_id: p.id, wash_count: num(washes[p.id]) })),
      }

      if (isEdit) {
        await updateVisit(editVisitId, payload)
        await refresh()
        navigate(`/location/${locationId}/visit/${editVisitId}`)
        return
      }

      const { visitId } = await createVisit(payload)
      // Cleared the moment the visit is persisted, before the email step —
      // that step is allowed to fail, and a draft surviving a saved visit
      // would invite the user to submit the whole count a second time.
      clearDraft(dKey)
      await refresh()

      // Email the report (real in Supabase mode, simulated in demo) — new
      // visits only; editing a past visit doesn't re-notify.
      try {
        const flags = []
        for (const r of productRows) {
          const cr = computeRow(r)
          if (r.targetMlPerCar && cr.mlPerCar != null && cr.mlPerCar > r.targetMlPerCar * 1.15) {
            flags.push(`${r.name}: ${cr.mlPerCar.toFixed(1)} ml/car vs target ${r.targetMlPerCar}`)
          }
          if (cr.mismatch) flags.push(`${r.name}: reservoir+floor ≠ ending`)
        }
        const result = await sendVisitReport({
          locationId,
          locationName: location.name,
          visitDate,
          submitter: submitter.trim() || null,
          totalWashCount: totalWashes,
          blendedCpc: totalWashes > 0 ? totals.cost / totalWashes : null,
          blendedTargetCpc: null,
          chemicalCost: totals.cost,
          onHandValue: null,
          flags,
          notes: notes.trim() || null,
          appUrl: window.location.origin,
          visitPath: `/location/${locationId}/visit/${visitId}`,
        })
        if (result?.simulated) {
          setToast({
            tone: 'info',
            title: 'Report email (demo)',
            message: result.sent
              ? `Would email ${result.sent} recipient(s): ${result.recipients.join(', ')}`
              : 'No active recipients configured — add them under Admin.',
          })
        } else if (result?.sent) {
          setToast({ tone: 'success', title: 'Report emailed', message: `Sent to ${result.sent} recipient(s).` })
        }
      } catch (mailErr) {
        setToast({ tone: 'error', title: 'Visit saved, but email failed', message: String(mailErr.message || mailErr) })
      }

      setTimeout(() => navigate(`/location/${locationId}/visit/${visitId}`), 900)
    } catch (e2) {
      setErr(e2.message || String(e2))
      setBusy(false)
    }
  }

  if (!location) return <EmptyState>Location not found.</EmptyState>
  if (isEdit && !editingVisit) return <EmptyState>Visit not found.</EmptyState>
  if (!canAccess)
    return (
      <EmptyState>
        {isEdit
          ? 'Only admins can edit a past visit.'
          : "You don't have permission to submit visits for this location."}
      </EmptyState>
    )
  const isMacTrack = location.source_format === 'mactrack'
  const cancelTo = isEdit ? `/location/${locationId}/visit/${editVisitId}` : `/location/${locationId}`

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <LocationHeader
        location={location}
        sub={
          isEdit
            ? `Editing the visit from ${fmtDate(editingVisit.visit.visit_date)} — changes recompute everything, but won't re-send the report email`
            : lastVisit
              ? `Starting quantities carried from ${fmtDate(lastVisit.visit_date)}`
              : 'First visit for this location'
        }
        actions={
          <>
            <Link to={cancelTo} className="btn-ghost">
              Cancel
            </Link>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save visit'}
            </button>
          </>
        }
      />

      {err && (
        <Banner tone="rose" title="Could not save">
          {err}
        </Banner>
      )}

      {/* Offered, never applied automatically — restoring silently would
          replace the starting quantities and carried-forward equipment the
          form just seeded with numbers the user has no way to trace. */}
      {pending && (
        <Banner tone="blue" title="Unfinished visit found">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              We saved your progress from <strong>{formatAge(pending.age)}</strong>. Pick up where
              you left off?
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn-primary py-1.5 text-xs" onClick={resumeDraft}>
                Resume
              </button>
              <button type="button" className="btn-ghost py-1.5 text-xs" onClick={discardDraft}>
                Start over
              </button>
            </span>
          </div>
        </Banner>
      )}

      <div className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">Visit date</label>
          <input type="date" className="input" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} required />
        </div>
        {/* Spans 2 so the water row below starts clean on its own line rather
            than the first input flowing up into an empty third cell. */}
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-bold text-slate-500">Submitter</label>
          <input
            type="text"
            className="input"
            placeholder="you@splashcarwashes.com"
            value={submitter}
            onChange={(e) => setSubmitter(e.target.value)}
          />
        </div>

        {/* Units are in the labels, not just the placeholders, because hardness
            has two conventions in common use (gpg and ppm as CaCO3) that differ
            by ~17x — a reading of 10 is ordinary water in one and nearly
            distilled in the other, and the stored number cannot tell them
            apart. The soft range hints below warn but never block: the column
            only rejects negatives, so an unusual-but-real reading still
            submits in the field. */}
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">
            Water hardness <span className="text-slate-400">(grains per gallon)</span>
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            inputMode="decimal"
            className="input"
            placeholder="e.g. 8.5"
            value={hardness}
            onChange={(e) => setHardness(e.target.value)}
          />
          <RangeHint value={hardness} max={100} unit="gpg" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-500">
            TDS <span className="text-slate-400">(ppm)</span>
          </label>
          <input
            type="number"
            step="1"
            min="0"
            inputMode="decimal"
            className="input"
            placeholder="e.g. 320"
            value={tds}
            onChange={(e) => setTds(e.target.value)}
          />
          <RangeHint value={tds} max={5000} unit="ppm" />
        </div>

        <div className="sm:col-span-3">
          <label className="mb-1 block text-xs font-bold text-slate-500">Notes</label>
          <textarea
            className="input min-h-[70px]"
            placeholder="Deliveries, equipment issues, conversions…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <SectionTitle>Inventory count</SectionTitle>
          <div className="text-xs font-medium text-slate-500">
            Running cost: <span className="font-extrabold text-slate-900">{fmtCurrency(totals.cost)}</span>
          </div>
        </div>

        <div className="border-b border-slate-100 bg-splash-50/60 px-5 py-2.5 text-[12px] font-medium text-splash-700">
          Ending inventory = Reservoir + Floor (calculated automatically). Usage = Starting +
          Delivered − Ending, so a delivery only adds to usage if part of it was consumed before your
          count — whatever is still in the reservoirs or on the floor cancels out.
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">Product</th>
                <th className="th text-right">Starting</th>
                <th className="th text-right">Delivered</th>
                <th className="th text-right">Reservoir</th>
                <th className="th text-right">Floor</th>
                <th className="th text-right">Ending (auto)</th>
                <th className="th text-right">Usage</th>
                <th className="th text-right">ml/car</th>
                <th className="th text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {productRows.map((r) => {
                const st = rows[r.productId]
                const cr = computeRow(r)
                const overTarget =
                  r.targetMlPerCar && cr.mlPerCar != null && cr.mlPerCar > r.targetMlPerCar * 1.15
                return (
                  <tr key={r.productId} className={cr.negative ? 'bg-rose-50/70 hover:bg-rose-50' : 'hover:bg-slate-50/60'}>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">{r.name}</span>
                        {cr.negative && <Pill tone="rose">negative</Pill>}
                      </div>
                      {r.lastMlPerCar != null && (
                        <div className="text-[11px] font-medium text-slate-400">
                          last visit {fmtNumber(r.lastMlPerCar, 1)} ml/car
                        </div>
                      )}
                      {cr.negative && (
                        <div className="mt-0.5 text-[11px] font-semibold text-rose-600">
                          Ending is more than starting + delivered — check for a missed delivery or a
                          count error. You can still save this.
                        </div>
                      )}
                    </td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtGal(r.starting)}</td>
                    <td className="td text-right">
                      <NumInput value={st.delivered} onChange={(v) => setRow(r.productId, { delivered: v })} />
                    </td>
                    <td className="td text-right">
                      <NumInput value={st.reservoir} onChange={(v) => setRow(r.productId, { reservoir: v })} />
                    </td>
                    <td className="td text-right">
                      <NumInput value={st.floor} onChange={(v) => setRow(r.productId, { floor: v })} />
                    </td>
                    <td className="td text-right tabular-nums font-semibold text-slate-700">
                      {cr.ending.toFixed(2)}
                    </td>
                    <td className={`td text-right tabular-nums ${cr.negative ? 'font-bold text-rose-600' : ''}`}>
                      {cr.usage.toFixed(2)}
                    </td>
                    <td className={`td text-right tabular-nums ${overTarget ? 'font-bold text-amber-600' : 'text-slate-500'}`}>
                      {cr.mlPerCar == null ? '—' : fmtNumber(cr.mlPerCar, 1)}
                      {r.targetMlPerCar != null && (
                        <span className="ml-1 text-[10px] font-medium text-slate-400">/ {fmtNumber(r.targetMlPerCar, 0)}</span>
                      )}
                    </td>
                    <td className="td text-right font-bold tabular-nums text-slate-900">{fmtCurrency(cr.cost)}</td>
                  </tr>
                )
              })}
              {!productRows.length && (
                <tr>
                  <td className="td text-slate-400" colSpan={9}>
                    This location has no products configured — set them up in the Packages tab.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {isMacTrack && (
          <div className="border-t border-slate-100 px-5 py-2.5 text-[11px] font-medium text-slate-400">
            This site historically tracked only total quantity on site — if you don&rsquo;t split
            reservoir vs floor, enter the full count in either column.
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-4">
          <SectionTitle>Chemical equipment</SectionTitle>
          <p className="mt-1 text-sm text-slate-500">
            How each chemical is metered (a colored tip, or a versadial set 1–32) and the injector it
            runs through. Carried forward from the last visit — update if anything&rsquo;s changed.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">Product</th>
                <th className="th">Metering</th>
                <th className="th">Tip color / Versadial #</th>
                <th className="th">Injector color</th>
                <th className="th text-right">Injector GPM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {productRows.map((r) => {
                const st = rows[r.productId] || {}
                return (
                  <tr key={r.productId} className="hover:bg-slate-50/60">
                    <td className="td font-semibold text-slate-900">{r.name}</td>
                    <td className="td">
                      <div className="flex gap-1">
                        {['', 'tip', 'versadial'].map((mt) => (
                          <button
                            key={mt || 'none'}
                            type="button"
                            onClick={() => setRow(r.productId, { meteringType: mt })}
                            className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
                              (st.meteringType || '') === mt ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {mt === 'tip' ? 'Tip' : mt === 'versadial' ? 'Versadial' : '—'}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="td">
                      {st.meteringType === 'tip' && (
                        <input
                          type="text"
                          className="cell-input w-32 text-left"
                          placeholder="e.g. Blue"
                          value={st.tipColor}
                          onChange={(e) => setRow(r.productId, { tipColor: e.target.value })}
                        />
                      )}
                      {st.meteringType === 'versadial' && (
                        <input
                          type="number"
                          min="1"
                          max="32"
                          step="1"
                          className="cell-input w-20"
                          placeholder="1–32"
                          value={st.versadialNumber}
                          onChange={(e) => setRow(r.productId, { versadialNumber: e.target.value })}
                        />
                      )}
                      {!st.meteringType && <span className="text-slate-300">—</span>}
                    </td>
                    <td className="td">
                      <input
                        type="text"
                        className="cell-input w-32 text-left"
                        placeholder="e.g. Lime green"
                        value={st.injectorColor}
                        onChange={(e) => setRow(r.productId, { injectorColor: e.target.value })}
                      />
                    </td>
                    <td className="td text-right">
                      <NumInput value={st.injectorGpm} onChange={(v) => setRow(r.productId, { injectorGpm: v })} width="w-20" />
                    </td>
                  </tr>
                )
              })}
              {!productRows.length && (
                <tr>
                  <td className="td text-slate-400" colSpan={5}>
                    No products configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <SectionTitle>Wash counts</SectionTitle>
          <div className="text-xs font-medium text-slate-500">
            Washes: <span className="font-extrabold text-slate-900">{totalWashes.toLocaleString()}</span>
            {!!addonPackages.length && (
              <>
                <span className="px-2 text-slate-300">·</span>
                Add-ons: <span className="font-extrabold text-slate-900">{totalAddons.toLocaleString()}</span>
              </>
            )}
          </div>
        </div>
        {!packages.length && <p className="p-5 text-sm text-slate-400">No packages configured.</p>}
        {!!washPackages.length && (
          <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
            {washPackages.map((p) => (
              <PackageCount
                key={p.id}
                pkg={p}
                value={washes[p.id]}
                onChange={(v) => setWashes((prev) => ({ ...prev, [p.id]: v }))}
              />
            ))}
          </div>
        )}
        {!!addonPackages.length && (
          <div className="border-t border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2 px-5 pt-4">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700">
                Add-ons
              </span>
              <span className="text-xs text-slate-500">
                À la carte — not counted as washes and excluded from CPC.
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
              {addonPackages.map((p) => (
                <PackageCount
                  key={p.id}
                  pkg={p}
                  value={washes[p.id]}
                  onChange={(v) => setWashes((prev) => ({ ...prev, [p.id]: v }))}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Link to={cancelTo} className="btn-ghost">
          Cancel
        </Link>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save visit'}
        </button>
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </form>
  )
}

// A warning, not a validator. The columns only reject negatives — see
// supabase/inventory-water-readings.sql — because a CHECK that fires on a
// legitimate reading would strand a tech mid-submit with no way to proceed.
// The far more likely mistake is a unit mix-up (hardness entered as ppm as
// CaCO3 is ~17x the gpg figure) or a slipped decimal, and both show up as an
// implausibly large number. So flag it here, where it can be overridden, and
// say nothing when the box is blank.
function RangeHint({ value, max, unit }) {
  const n = Number(value)
  if (value === '' || !Number.isFinite(n) || n <= max) return null
  return (
    <p className="mt-1 text-[11px] font-medium text-amber-600">
      {`Unusually high for ${unit} — check the units. Saves as entered.`}
    </p>
  )
}

function PackageCount({ pkg, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
      <span className="truncate text-sm font-semibold text-slate-700">{pkg.name}</span>
      <NumInput value={value} onChange={onChange} width="w-24" min={0} />
    </div>
  )
}

function NumInput({ value, onChange, highlight, width = 'w-24', min }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      min={min}
      className={`cell-input ${width} ${highlight ? 'border-splash-300 bg-splash-50' : ''}`}
      value={value}
      onChange={(e) => {
        const v = e.target.value
        // belt-and-suspenders: the `min` attribute alone doesn't stop someone
        // from typing a leading "-" in a controlled input.
        onChange(min === 0 && v.startsWith('-') ? v.slice(1) : v)
      }}
      placeholder="0"
    />
  )
}
