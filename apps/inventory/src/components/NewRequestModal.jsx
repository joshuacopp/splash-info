// "File a MaintainX request" modal.
//
// Posts multipart/form-data to /inventory/api/maintainx/requests, which files
// the request straight into MaintainX and attaches the photos. Nothing is
// stored on the Splash side, so there is no draft to recover — a failed submit
// leaves the form filled in and lets the operator retry.
//
// DOUBLE-SUBMIT: the MaintainX create endpoint has no idempotency key, so two
// POSTs make two work requests. `busy` disabling the submit button is the only
// guard that exists; do not remove it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { apiPostForm } from '../lib/api'
import { todayIso } from '../lib/format'

const TITLE_MAX = 160
const DETAIL_MIN = 50
const MAX_PHOTOS = 6
// Mirrors REQUEST_PHOTO_MAX_BYTES in worker/maintainx.ts. Checked here purely
// so an oversized photo fails instantly instead of after a long upload; the
// worker's check is the one that counts.
const PHOTO_MAX_BYTES = 15 * 1024 * 1024

const PRIORITIES = [
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
]

export default function NewRequestModal({ open, locations, defaultName, onClose, onFiled }) {
  const [locationId, setLocationId] = useState('')
  const [submittedOn, setSubmittedOn] = useState(todayIso())
  const [requesterName, setRequesterName] = useState(defaultName || '')
  const [priority, setPriority] = useState('MEDIUM')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [photos, setPhotos] = useState([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  // Reset on each open so a previous submission's text never reappears.
  useEffect(() => {
    if (!open) return
    setLocationId('')
    setSubmittedOn(todayIso())
    setRequesterName(defaultName || '')
    setPriority('MEDIUM')
    setTitle('')
    setDetail('')
    setPhotos([])
    setDragging(false)
    setBusy(false)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [open, defaultName])

  // Escape closes, but never mid-flight: the request may already have reached
  // MaintainX, and closing would leave the operator unsure whether it landed.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const detailShort = detail.trim().length < DETAIL_MIN
  const canSubmit =
    !busy &&
    locationId !== '' &&
    requesterName.trim() !== '' &&
    title.trim() !== '' &&
    title.length <= TITLE_MAX &&
    !detailShort

  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) => a.name.localeCompare(b.name)),
    [locations]
  )

  function addFiles(list) {
    const incoming = Array.from(list || [])
    if (!incoming.length) return
    const oversized = incoming.find((f) => f.size > PHOTO_MAX_BYTES)
    if (oversized) {
      setError(`"${oversized.name}" is larger than 15 MB.`)
      return
    }
    setError(null)
    setPhotos((prev) => [...prev, ...incoming].slice(0, MAX_PHOTOS))
    // Clear the input so re-picking the same file still fires onChange.
    if (fileRef.current) fileRef.current.value = ''
  }

  async function submit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)

    const fd = new FormData()
    fd.set('location_id', locationId)
    fd.set('title', title.trim())
    fd.set('description', detail.trim())
    fd.set('priority', priority)
    fd.set('requester_name', requesterName.trim())
    fd.set('submitted_on', submittedOn)
    for (const p of photos) fd.append('photo', p)

    try {
      const res = await apiPostForm('/maintainx/requests', fd)
      onFiled(res)
    } catch (err) {
      setError(err.message || 'Could not file the request.')
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 bg-slate-900/50" onClick={() => !busy && onClose()} />
      <form
        onSubmit={submit}
        className="card fade-in relative my-auto w-full max-w-3xl overflow-hidden"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              New maintenance issue
            </div>
            <h2 className="mt-0.5 text-xl font-extrabold text-slate-900">
              File a MaintainX request
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Include clear photos and enough detail for the maintenance team to act.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="shrink-0 rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 disabled:opacity-40"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.3 5.3a1 1 0 011.4 0L10 7.6l2.3-2.3a1 1 0 111.4 1.4L11.4 9l2.3 2.3a1 1 0 01-1.4 1.4L10 10.4l-2.3 2.3a1 1 0 01-1.4-1.4L8.6 9 6.3 6.7a1 1 0 010-1.4z" />
            </svg>
          </button>
        </div>

        {/* Taller than the 60vh this started at. The body scrolls between a
            fixed header and a sticky footer, which reads as the end of the
            form — so anything below the fold is easy to miss entirely. Worth
            the extra height to keep the photo control near it. */}
        <div className="max-h-[72vh] space-y-5 overflow-y-auto px-6 py-5">
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Location name" required htmlFor="nr-location">
              <select
                id="nr-location"
                required
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="input w-full"
              >
                <option value="">Choose a location…</option>
                {sortedLocations.map((l) => (
                  <option key={l.id} value={String(l.maintainx_id)}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date of submission" required htmlFor="nr-date">
              <input
                id="nr-date"
                type="date"
                required
                value={submittedOn}
                max={todayIso()}
                onChange={(e) => setSubmittedOn(e.target.value)}
                className="input w-full"
              />
            </Field>
          </div>

          <Field label="Name of person submitting" required htmlFor="nr-name">
            <input
              id="nr-name"
              type="text"
              required
              maxLength={80}
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              className="input w-full"
            />
            <p className="mt-1 text-xs text-slate-400">
              Enter the actual person, even when signed in on a shared site account.
            </p>
          </Field>

          {/* Not in the original mockup. MaintainX requires a priority on every
              work request, so the choice is either this control or defaulting
              every inventory-filed request to MEDIUM. */}
          <Field label="Priority" required htmlFor="nr-priority-medium">
            <div className="flex flex-wrap gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  id={`nr-priority-${p.value.toLowerCase()}`}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  aria-pressed={priority === p.value}
                  className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
                    priority === p.value
                      ? 'bg-splash-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Description of the problem"
            required
            htmlFor="nr-title"
            hint={`${title.length}/${TITLE_MAX}`}
            hintTone={title.length > TITLE_MAX ? 'bad' : 'muted'}
          >
            <input
              id="nr-title"
              type="text"
              required
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Example: Water leaking near the entrance to bay 3"
              className="input w-full"
            />
          </Field>

          <Field
            label="Detailed description of the problem"
            required
            htmlFor="nr-detail"
            hint={
              detailShort
                ? `${detail.trim().length}/${DETAIL_MIN} minimum`
                : `${detail.trim().length} characters`
            }
            hintTone={detailShort ? 'bad' : 'muted'}
          >
            <textarea
              id="nr-detail"
              required
              rows={5}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Explain exactly where the issue is, what you observed, when it happens, and any safety or operating impact."
              className="input w-full resize-y"
            />
          </Field>

          <Field
            label="Pictures of the problem"
            htmlFor="nr-photos"
            hint={`${photos.length}/${MAX_PHOTOS} photos`}
            hintTone={photos.length >= MAX_PHOTOS ? 'bad' : 'muted'}
          >
            {/* A drop zone rather than a bare <input type="file">. The native
                control is a small grey button that reads as page furniture —
                it was present but nobody found it, sitting under a tall
                textarea inside a scrolling body with a sticky footer below.
                A full-width target is hard to miss and gives drag-and-drop
                for free. The input itself stays in the DOM (sr-only, not
                display:none) so the label, keyboard focus and form
                association all still work. */}
            <label
              htmlFor="nr-photos"
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                if (photos.length < MAX_PHOTOS) addFiles(e.dataTransfer.files)
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed px-4 py-7 text-center transition ${
                photos.length >= MAX_PHOTOS
                  ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                  : dragging
                    ? 'border-splash-600 bg-splash-50'
                    : 'border-slate-300 bg-slate-50/60 hover:border-splash-300 hover:bg-splash-50/50'
              }`}
            >
              <svg className="h-7 w-7 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm5 5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm-4 7l3.5-4.5 2.5 3 2-2.5L16 15H5z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-sm font-bold text-slate-700">
                {photos.length >= MAX_PHOTOS
                  ? `Maximum of ${MAX_PHOTOS} photos added`
                  : 'Add photos'}
              </span>
              <span className="text-xs text-slate-400">
                {photos.length >= MAX_PHOTOS
                  ? 'Remove one to add another'
                  : 'Click to choose, or drag images here'}
              </span>
            </label>
            <input
              ref={fileRef}
              id="nr-photos"
              type="file"
              accept="image/*"
              multiple
              disabled={photos.length >= MAX_PHOTOS}
              onChange={(e) => addFiles(e.target.files)}
              className="sr-only"
            />
            <p className="mt-1.5 text-xs text-slate-400">
              The first photo becomes the request thumbnail in MaintainX; the rest attach to it.
            </p>
            {photos.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {photos.map((p, i) => (
                  <li
                    key={`${p.name}-${i}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs"
                  >
                    <span className="min-w-0 truncate font-semibold text-slate-700">
                      {i === 0 && (
                        <span className="mr-1.5 rounded bg-splash-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-splash-700">
                          Thumbnail
                        </span>
                      )}
                      {p.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPhotos((prev) => prev.filter((_, n) => n !== i))}
                      className="shrink-0 font-bold text-slate-400 hover:text-rose-500"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-6 py-4">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? 'Filing…' : 'Submit request'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, required, htmlFor, hint, hintTone = 'muted', children }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-bold text-slate-700">
          {label}
          {required && <span className="ml-1 text-rose-500">*</span>}
        </label>
        {hint && (
          <span
            className={`shrink-0 text-xs font-semibold ${
              hintTone === 'bad' ? 'text-rose-500' : 'text-slate-400'
            }`}
          >
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}
