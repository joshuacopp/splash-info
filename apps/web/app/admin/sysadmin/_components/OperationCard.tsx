// Shared <details>-based card primitive used by every sysadmin operation
// card. Extracted from page.tsx in Brief 30 so the card sections can live
// in their own files (_sections/UserOperations.tsx +
// _sections/TableOperations.tsx) without duplicating the wrapper markup
// or the FieldLabel / inputClass / submitClass tokens.

import type { ReactNode } from "react";

export function OperationCard({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card open:shadow-splash-card-hover">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div>
          <div className="text-base font-bold text-splash-navy">{title}</div>
          <div className="mt-0.5 text-xs text-splash-navy/60">{description}</div>
        </div>
        <span
          aria-hidden="true"
          className="text-xs font-semibold uppercase tracking-wider text-sudsy-blue group-open:hidden"
        >
          Open
        </span>
        <span
          aria-hidden="true"
          className="hidden text-xs font-semibold uppercase tracking-wider text-sudsy-blue group-open:inline"
        >
          Close
        </span>
      </summary>
      <div className="border-t border-gray-light px-5 py-5">{children}</div>
    </details>
  );
}

export function FieldLabel({
  htmlFor,
  children,
  helper
}: {
  htmlFor: string;
  children: ReactNode;
  helper?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70"
    >
      {children}
      {helper ? (
        <span className="ml-2 normal-case tracking-normal text-[0.6875rem] font-normal text-splash-navy/50">
          {helper}
        </span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";

export const submitClass =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";
