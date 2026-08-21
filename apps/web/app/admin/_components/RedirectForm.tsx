// A <form> for server actions that finish by NAVIGATING somewhere, rather than
// by returning an in-page result.
//
// WHY THIS EXISTS: calling redirect() inside a server action costs ~20 seconds
// under OpenNext on Cloudflare Workers. Measured 2026-08-21 on three unrelated
// features (/admin/expenses, /admin/greeters, /admin/forms/new): wall time
// 19.7–20.3s against 18ms of CPU, status 303, "waiting for server response"
// the whole time. The write itself is fast — the worker call is ~300–750ms and
// the row is committed long before the browser hears anything. The cost is
// entirely in whatever Next does between throwing the redirect and answering
// the POST. Actions that RETURN a value instead are instant, which is the
// bisect this component is built on.
//
// THE PATTERN: the action returns `{ redirectTo }` — for both success AND
// validation failure, since a failure redirect is still a redirect — and this
// component pushes it client-side. The URL is the same one the action used to
// pass to redirect(), so every banner, filter and query param downstream is
// untouched; only the transport changes.
//
// WHY A COMPONENT AND NOT A HOOK: most of the forms on these pages are server
// components (BudgetEditor, ExpenseEntryForm, the site-day and goal forms),
// which can't call useRouter. A client component with a children slot lets a
// server-rendered field set keep being server-rendered.
//
// WHY THE ACTION KEEPS THE PLAIN `(formData) => …` SIGNATURE and this doesn't
// use useActionState: SavingButton reads useFormStatus off the nearest <form>,
// and that only reports pending for a form's own action function. Handing React
// an async client function that awaits the server action keeps the button
// disabled and the "Saving…" overlay up for the whole round trip, exactly as
// before.
//
// RELATED BUT DIFFERENT: ActionForm in this folder is for actions that stay on
// the page and report ok/error inline. Use that one when there's nowhere to go;
// use this one when the action's whole job ends in a navigation.

"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

/** What a redirect-style server action returns instead of throwing redirect(). */
export interface RedirectResult {
  /** Absolute path, already query-string-built by the action. */
  redirectTo: string;
}

export function RedirectForm({
  action,
  children,
  className,
  id
}: {
  action: (formData: FormData) => Promise<RedirectResult>;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const router = useRouter();

  return (
    <form
      id={id}
      className={className}
      action={async (formData) => {
        const result = await action(formData);
        // Guarded rather than destructured: a deploy that leaves a page on the
        // new component and an action on the old void-returning signature would
        // otherwise throw inside the form action and hit the error boundary,
        // AFTER the write has already landed. Doing nothing is the better
        // failure — the row is saved and a manual refresh shows it.
        if (result?.redirectTo) router.push(result.redirectTo);
      }}
    >
      {children}
    </form>
  );
}
