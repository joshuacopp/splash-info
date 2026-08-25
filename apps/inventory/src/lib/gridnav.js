// ---------------------------------------------------------------------------
// Enter walks DOWN a column; Tab walks ACROSS a row.
//
// Two problems solved at once. First, a <form> with a submit button submits on
// Enter from any single-line input — on a page whose whole job is typing a few
// dozen numbers, someone reaching for Tab and hitting Enter instead files a
// half-finished form. Second, the natural way to fill a sheet like this is one
// column at a time. Tab already does the row direction for free, because DOM
// order inside a <tbody> is row-major; Enter is the one that needed code.
//
// The lookup is a DOM query taken at keypress time, deliberately not a cached
// array of refs. Rows get added, removed, filtered and reordered, and a cached
// grid goes stale SILENTLY — it still has an entry at that index, it just
// points at the wrong row. Querying live cannot be stale, and it handles
// conditionally-rendered cells without special casing: a cell that isn't
// rendered simply isn't in the list.
//
// At the bottom of a column, Enter jumps to the top of the next column in the
// same grid — the order you'd actually work in. Column order is read off the
// DOM too (first appearance wins), so it tracks the table rather than a list
// here that someone has to remember to update. At the very last cell it stops.
//
// Enter still behaves normally everywhere it should: textareas take a newline
// (the browser never implicit-submits from one), and buttons and links fire on
// Enter through the click path, not this one.
//
// Usage: put `data-grid="<gridName>" data-col="<colName>"` on each participating
// input and hand this to the container's onKeyDown. `container` is the element
// the handler is bound to (e.currentTarget) — the query is scoped to it, so two
// independent grids on one page can't reach into each other unless they share a
// container AND a grid name.
// ---------------------------------------------------------------------------
export function handleGridEnter(e, container) {
  if (e.key !== 'Enter') return
  const el = e.target
  const tag = el?.tagName
  if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
  // A <select> uses Enter to commit an open dropdown; leave it alone.
  if (tag === 'SELECT') return

  // Suppress the implicit submit first, for EVERY Enter that lands on an input,
  // modified or not. Shift+Enter and Ctrl+Enter submit a form just as readily as
  // a bare Enter does, so testing modifiers before this line would leave exactly
  // the hole this handler exists to close. Everything below is a best-effort
  // convenience and is not allowed to be the reason a form submits by accident.
  e.preventDefault()

  // Only an unmodified Enter navigates. A modified one is suppressed and
  // otherwise ignored — it isn't a request to move.
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return

  const grid = el?.dataset?.grid
  const col = el?.dataset?.col
  if (!grid || !col) return

  const root = container || e.currentTarget
  if (!root) return

  const cells = Array.from(root.querySelectorAll(`[data-grid="${grid}"]`)).filter((n) => !n.disabled)
  const inCol = cells.filter((n) => n.dataset.col === col)
  const i = inCol.indexOf(el)
  if (i === -1) return

  let next = inCol[i + 1]
  if (!next) {
    const order = []
    for (const n of cells) if (!order.includes(n.dataset.col)) order.push(n.dataset.col)
    const nextCol = order[order.indexOf(col) + 1]
    next = nextCol ? cells.find((n) => n.dataset.col === nextCol) : undefined
  }
  if (!next) return

  next.focus()
  // Select rather than just focus: these cells are prefilled, and typing over a
  // selection is what the user means. Focusing alone would append to the old
  // number.
  if (typeof next.select === 'function') next.select()
}
