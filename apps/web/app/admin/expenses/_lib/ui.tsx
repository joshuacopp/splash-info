// Shared classes and the three presentational shells used across
// /admin/expenses.
//
// WHY THIS FILE EXISTS AT ALL: /admin/greeters defines LABEL_CLS, INPUT_CLS,
// HINT_CLS, THEAD_CLS, TBODY_CLS, Card, TableWrap and EmptyNote as module-local
// constants inside page.tsx and exports none of them. The expense log is a
// sibling section under the same `pertrack` grant and has to look identical —
// two admin pages in the same nav that render a table header two different
// shades is the kind of thing people read as "one of these is broken".
//
// So the values below are COPIED VERBATIM from greeters/page.tsx rather than
// imported, because importing from a route's page.tsx is not something Next
// guarantees anything about. greeters/page.tsx remains the source of truth: if
// these ever diverge, that file wins. The right long-term fix is promoting them
// into a shared admin-ui module, which is a bigger change than this brief.
//
// Deliberately NOT copied: SavingButton, which is a real client component and is
// imported from ../../greeters/_components/SavingButton by the forms here. It
// has no greeter-specific behaviour — it reads useFormStatus off whatever <form>
// wraps it — and a second copy would be a second pending-state bug to fix.

import type { ReactNode } from "react";

export const LABEL_CLS =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
export const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
export const HINT_CLS = "text-[11px] text-splash-navy/60";
export const THEAD_CLS =
  "bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
export const TBODY_CLS = "divide-y divide-gray-light text-splash-navy";

/** Primary action button. Same classes SavingButton uses, minus the disabled
 *  variants — the plain <Link>/<button> callers here never go pending. */
export const BTN_CLS =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";

/**
 * `action` is a local addition, NOT copied from greeters — it renders
 * right-aligned in the header row and exists so the edit-expense card can carry
 * its own Cancel link without growing a second header bar above the form. It is
 * optional and unused by every other caller, so cards that don't pass it render
 * byte-identical to the greeters original.
 */
export function Card({
  title,
  subtitle,
  action,
  children
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="flex items-start justify-between gap-4 border-b border-gray-light px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-splash-navy">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-xs text-splash-navy/60">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-light text-sm">
        {children}
      </table>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-splash-navy/70">{children}</p>;
}
