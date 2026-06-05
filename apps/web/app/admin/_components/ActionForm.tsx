// Shared client wrapper for server actions that return an ActionResult
// instead of redirecting. Brief 19.
//
// Why this exists: Next 15 server actions invoked from a server-rendered
// <form action={fn}> can call redirect() on success/failure to drive the
// browser to a new URL. Under OpenNext on Cloudflare Workers (apps/web's
// runtime) the redirect response runs through the framework but does not
// trigger a visible client-side navigation in staging — actions complete,
// the DB updates, but the page sits unchanged until the operator hard-
// reloads. (Pricing admin works because it uses client-side fetch +
// useState — no server-action redirect involved.)
//
// Pattern: every server action returns
//   { ok: true; message?: string } | { ok: false; error: string }
// instead of redirecting. <ActionForm> wraps each <form>, dispatches via
// React 19's useActionState, and on a fresh `ok` result calls
// router.refresh() to re-fetch the route's server-component data. The
// action's revalidatePath() call inside the action invalidates Next's
// route cache so the refresh sees the new state. Errors render inline
// under the form via role=alert; successes render a brief role=status
// confirmation.
//
// Use this on every new server-action write surface in apps/web. Don't
// reach for redirect()-based feedback — same OpenNext/CF edge case will
// bite again.

"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export type ActionResult =
  | { ok: true; message?: string; data?: unknown }
  | { ok: false; error: string; fields?: Record<string, string> };

interface ActionFormProps {
  action: (
    prevState: ActionResult | null,
    formData: FormData
  ) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  /**
   * Reset uncontrolled form fields when the action returns ok=true. Default
   * true. Implemented by remounting the <form> on success via the React key
   * trick (key changes -> React unmounts and remounts the subtree, which
   * clears <textarea>, <input type=text>, etc.).
   */
  resetOnSuccess?: boolean;
  /** Optional encType passthrough (e.g., multipart/form-data for uploads). */
  encType?: string;
  /**
   * Brief 20 — optional callback invoked whenever the action's result
   * transitions to a fresh value. Lets a parent react to success/failure
   * without owning the action state. The callback is stored in a ref so
   * its identity doesn't have to be stable (no need to memoize it). Used
   * by the document-edit details to close itself on save.
   */
  onResult?: (result: ActionResult) => void;
}

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = true,
  encType,
  onResult
}: ActionFormProps) {
  const [result, formAction, isPending] = useActionState(action, null);
  const router = useRouter();

  // Stash the latest onResult in a ref so the callback effect doesn't have
  // to re-fire when the parent re-renders with a new function identity.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Refresh server-component data on every fresh ok result. Pairs with the
  // action's revalidatePath() call: revalidate invalidates the cache,
  // refresh re-fetches and re-renders.
  useEffect(() => {
    if (result?.ok) {
      router.refresh();
    }
  }, [result, router]);

  // Fire the optional onResult callback on any fresh result (ok or not).
  useEffect(() => {
    if (result) {
      onResultRef.current?.(result);
    }
  }, [result]);

  // Remount the form on success so uncontrolled inputs (the common case
  // for these forms — name + textarea + select with defaultValue) clear.
  // Keying off the message keeps consecutive successes distinguishable.
  const formKey =
    resetOnSuccess && result?.ok ? `ok:${result.message ?? ""}` : "form";

  return (
    <form
      key={formKey}
      action={formAction}
      className={className}
      encType={encType}
      data-pending={isPending ? "true" : "false"}
    >
      {children}
      {result?.ok ? (
        <p
          role="status"
          className="mt-2 text-sm font-semibold text-splash-success"
        >
          {result.message ?? "Saved."}
        </p>
      ) : null}
      {result && !result.ok ? (
        <p
          role="alert"
          className="mt-2 rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
        >
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
