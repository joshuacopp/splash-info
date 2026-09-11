// Record a delivery — chemical dropped at a site, without the visit protocol.
//
// Deliberately the short form. A site visit asks for car counts per package,
// water hardness, TDS, reservoir and floor counts and an ending level for every
// chemical; a delivery asks for a date and how much of what arrived. Conflating
// the two is what this page exists to avoid: a driver dropping four drums
// should not have to fake a set of measurements to record them, and a visit
// filed to capture a delivery puts invented levels into the usage history.
//
// The starting quantities shown are the site's last known levels, and the
// worker re-resolves them server-side when saving — what is displayed here is
// information, not input. See createDelivery() in worker/db.ts.

import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { apiPost, apiPut } from '../lib/api'
import { computeVisit, latestLedgerRowForLocation } from '../lib/calc'
import { Banner, EmptyState, PageHeader, Toast } from '../components/ui'
import { fmtCurrency, fmtDate, todayIso } from '../lib/format'

const GAL_TO_ML = 3785.41

export default function NewDelivery() {
  const { locationId, deliveryId } = useParams()
  const isEdit = !!deliveryId
  const navigate = useNavigate()
  const { dataset, idx, refresh } = useData()
  const { email, canSubmit } = useAuth()

  // On an edit these seed from the stored row; the initialisers run once, and
  // the row is already in the dataset because the page is only reachable from
  // it. No loading state, no flash of an empty form.
  const editing = isEdit ? computeVisit(dataset, idx, deliveryId) : null

  const [deliveryDate, setDeliveryDate] = useState(
    () => editing?.visit?.visit_date?.slice(0, 10) || todayIso()
  )
  const [submitter, setSubmitter] = useState(() => editing?.visit?.submitter || email || '')
  const [notes, setNotes] = useState(() => editing?.visit?.notes || '')
  const [qty, setQty] = useState(() =>
    Object.fromEntries(
      (editing?.entries || [])
        .filter((e) => e.qtyDeliveredGal > 0)
        .map((e) => [e.productId, String(e.qtyDeliveredGal)])
    )
  )
  // Editing a delivery does NOT re-send its receipt unless asked. A silent
  // re-send on a typo fix trains people to ignore the email.
  const [resend, setResend] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  const location = idx.locationById[locationId] || null

  const { rows, lastRow } = useMemo(() => {
    // Last known levels come from the LEDGER, so a second delivery stacks on
    // the first rather than resetting to the level at the last inspection.
    // On an EDIT the basis is the delivery's own stored starting quantities —
    // the level before it landed, frozen when it was filed. Using the latest
    // ledger row here would be this very delivery, so every line would show a
    // starting level that already includes itself.
    const lastRow = isEdit ? null : latestLedgerRowForLocation(idx, locationId)
    const lastEnding = {}
    if (isEdit) {
      for (const e of editing?.entries || []) lastEnding[e.productId] = e.startingQtyGal
    } else if (lastRow) {
      const computed = computeVisit(dataset, idx, lastRow.id)
      if (computed) for (const e of computed.entries) lastEnding[e.productId] = e.endingQtyGal
    }

    const rows = (dataset.location_products || [])
      .filter((lp) => lp.location_id === locationId)
      .map((lp) => {
        const p = idx.productById[lp.product_id]
        return {
          productId: lp.product_id,
          name: p ? p.name : '(unknown)',
          pricePerMl: p ? Number(p.price_per_ml) || 0 : 0,
          discount: Number(lp.discount) || 0,
          starting: lastEnding[lp.product_id] ?? 0,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    return { rows, lastRow }
  }, [dataset, idx, locationId, isEdit, editing])

  const entered = rows
    .map((r) => ({ ...r, delivered: Number(qty[r.productId]) }))
    .filter((r) => Number.isFinite(r.delivered) && r.delivered > 0)

  const deliveredValue = entered.reduce(
    (s, r) => s + r.delivered * GAL_TO_ML * r.pricePerMl * (1 - r.discount),
    0
  )

  const canSave = !busy && deliveryDate !== '' && entered.length > 0

  async function submit(e) {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const body = {
        location_id: locationId,
        visit_date: deliveryDate,
        submitter: submitter.trim() || null,
        notes: notes.trim() || null,
        entries: entered.map((r) => ({
          product_id: r.productId,
          qty_delivered_gal: r.delivered,
        })),
      }
      const res = isEdit
        ? await apiPut(`/deliveries/${encodeURIComponent(deliveryId)}`, { ...body, resend })
        : await apiPost('/deliveries', body)
      await refresh()
      // The receipt is best-effort on the worker: the delivery is saved either
      // way, so a failed email is a note on the way out, never a lost record.
      if (res?.receiptError) {
        setToast({
          tone: 'info',
          title: 'Delivery recorded',
          message: `The receipt email could not be queued: ${res.receiptError}`,
        })
      }
      navigate(`/location/${locationId}/visit/${res.deliveryId || deliveryId}`)
    } catch (err) {
      setError(err.message || 'Could not record the delivery.')
      setBusy(false)
    }
  }

  if (!location) return <EmptyState>Location not found.</EmptyState>
  if (!canSubmit) return <EmptyState>You have read-only access to this site.</EmptyState>

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={location.name}
        title={isEdit ? "Edit delivery" : "Record a delivery"}
        sub={
          isEdit
            ? 'Correcting what was delivered. The level this delivery started from stays as filed.'
            : 'Chemical delivered only — no car counts or levels. Quantities are added to the last recorded on-hand figures.'
        }
        actions={
          <Link to={`/location/${locationId}`} className="btn-ghost">
            Cancel
          </Link>
        }
      />

      {!isEdit && !lastRow && (
        <Banner tone="amber" title="No previous record for this site">
          Every chemical starts from zero, so the delivered amounts become the site&rsquo;s first
          recorded on-hand figures. If that is wrong, file a site visit instead so the real
          starting levels are captured.
        </Banner>
      )}

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="space-y-6">
        <div className="card p-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <div>
              <label htmlFor="d-date" className="mb-1 block text-sm font-bold text-slate-700">
                Delivery date <span className="text-rose-500">*</span>
              </label>
              <input
                id="d-date"
                type="date"
                required
                value={deliveryDate}
                max={todayIso()}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label htmlFor="d-by" className="mb-1 block text-sm font-bold text-slate-700">
                Recorded by
              </label>
              <input
                id="d-by"
                type="text"
                value={submitter}
                onChange={(e) => setSubmitter(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label htmlFor="d-notes" className="mb-1 block text-sm font-bold text-slate-700">
                Notes
              </label>
              <input
                id="d-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Invoice number, driver, partial drop…"
                className="input w-full"
              />
            </div>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <div className="text-sm font-extrabold text-slate-900">Chemicals delivered</div>
              <div className="text-xs text-slate-400">
                {lastRow
                  ? `On hand as of ${fmtDate(lastRow.visit_date)}${
                      lastRow.visit_kind === 'delivery' ? ' (delivery)' : ''
                    }`
                  : 'No previous record'}
              </div>
            </div>
            <div className="text-xs font-bold text-slate-400">
              Leave a chemical blank if none was delivered
            </div>
          </div>

          <div className="max-h-[560px] overflow-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr>
                  <th className="th">Chemical</th>
                  <th className="th text-right">On hand (gal)</th>
                  <th className="th text-right">Delivered (gal)</th>
                  <th className="th text-right">New on hand</th>
                  <th className="th text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const d = Number(qty[r.productId])
                  const has = Number.isFinite(d) && d > 0
                  const value = has ? d * GAL_TO_ML * r.pricePerMl * (1 - r.discount) : 0
                  return (
                    <tr key={r.productId} className={has ? 'bg-splash-50/40' : undefined}>
                      <td className="td font-semibold text-slate-900">{r.name}</td>
                      <td className="td text-right tabular-nums text-slate-500">
                        {r.starting.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="td text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          aria-label={`Gallons of ${r.name} delivered`}
                          value={qty[r.productId] ?? ''}
                          onChange={(e) =>
                            setQty((prev) => ({ ...prev, [r.productId]: e.target.value }))
                          }
                          className="input w-28 py-1.5 text-right"
                        />
                      </td>
                      <td className="td text-right tabular-nums font-semibold text-slate-900">
                        {has
                          ? (r.starting + d).toLocaleString('en-US', { maximumFractionDigits: 2 })
                          : <span className="font-normal text-slate-300">—</span>}
                      </td>
                      <td className="td text-right tabular-nums text-slate-600">
                        {has ? fmtCurrency(value, 2) : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
                {!rows.length && (
                  <tr>
                    <td className="td py-8 text-center text-slate-400" colSpan={5}>
                      No chemicals are configured for this site yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-4">
            {isEdit && (
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-600">
                <input
                  type="checkbox"
                  checked={resend}
                  onChange={(e) => setResend(e.target.checked)}
                  className="h-4 w-4"
                />
                Resend the receipt
              </label>
            )}
            <div className="text-sm text-slate-500">
              {entered.length === 0
                ? 'Nothing entered yet'
                : `${entered.length} chemical${entered.length === 1 ? '' : 's'} · ${fmtCurrency(
                    deliveredValue,
                    2
                  )}`}
            </div>
            <button type="submit" className="btn-primary" disabled={!canSave}>
              {busy
                ? 'Saving…'
                : isEdit
                  ? resend
                    ? 'Save & resend receipt'
                    : 'Save changes'
                  : 'Record delivery & send receipt'}
            </button>
          </div>
        </div>
      </form>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
