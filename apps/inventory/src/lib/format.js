// Display formatting helpers.

export function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

export function fmtCurrency(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

// Cost-per-car is small; show 3 decimals (e.g. $0.297)
export function fmtCpc(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return '$' + Number(v).toFixed(3)
}

export function fmtNumber(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtInt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Math.round(Number(v)).toLocaleString('en-US')
}

export function fmtGal(v) {
  return fmtNumber(v, 2) + ' gal'
}

export function fmtMl(v) {
  return fmtNumber(v, 1) + ' ml'
}

export function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return (Number(v) * 100).toFixed(digits) + '%'
}

// ISO 'yyyy-mm-dd' -> 'Mmm d, yyyy' without timezone shifting.
export function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return String(iso)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[m - 1]} ${d}, ${y}`
}

export function todayIso() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
