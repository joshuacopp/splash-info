// The one implementation of "you can't see this page" in apps/web.
//
// Five features each grew their own NoAccessCard with byte-identical shells and
// slightly divergent behaviour. That cost real time: the MFA rescue had to be
// added five times, /admin/approvals spent a night telling locked-out users
// "Form builder access is restricted" because it borrowed the forms copy, and
// nobody noticed because a failure path is the one screen you never look at
// until somebody is stuck on it.
//
// Those five files still exist and still own their own copy and prop shapes --
// they now map onto this. Deliberately: rewriting 43 call sites to a new prop
// shape is a lot of mechanical edits on exactly the screens that are hardest to
// notice getting wrong, and the duplication that actually mattered was the
// markup and the behaviour, not each feature's wording.
//
// THE RESCUE BELONGS HERE, not at the call sites. A caller stranded by a
// half-finished MFA login needs the code step, and this card was the dead end
// they hit instead -- see FinishSignInRedirect. Putting it in the shared shell
// means the next feature to add a card inherits it rather than rediscovering it.

import Link from "next/link";

import FinishSignInRedirect from "./FinishSignInRedirect";

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";

export type AccessCardAction =
  /** Offers Sign In, and rescues a half-finished MFA login on mount. */
  | { kind: "signin"; returnPath: string }
  /** For a caller who IS authenticated and simply lacks the role. Signing in
   *  again would change nothing, so it offers the way out instead. */
  | { kind: "dashboard" }
  /** Somewhere else worth going -- promotions' IT-only view sends the caller
   *  back to the promotions dashboard, not the main one. */
  | { kind: "link"; href: string; label: string }
  /** No action at all -- for states where neither signing in nor leaving is the
   *  answer, and the copy has to carry it. */
  | { kind: "none" };

export interface AccessCardProps {
  /** Small caps line above the page name. */
  eyebrow?: string;
  /** The page the caller was trying to reach, in their words. */
  title: string;
  /** One short sentence: "Sign in required.", "Access denied." */
  heading: string;
  /** What to do about it. */
  message: string;
  action: AccessCardAction;
}

export default function AccessCard({
  eyebrow = "Internal Tools",
  title,
  heading,
  message,
  action
}: AccessCardProps) {
  return (
    <section className="mx-auto w-full max-w-[720px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{title}</h1>
      </div>

      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-7 shadow-splash-card">
        <p className="mb-3 text-base font-semibold text-splash-navy">{heading}</p>
        <p className="mb-5 text-[0.9375rem] leading-relaxed text-splash-navy/80">
          {message}
        </p>
        {action.kind === "signin" ? (
          <>
            <FinishSignInRedirect returnPath={action.returnPath} />
            <Link
              href={`/login?return=${encodeURIComponent(action.returnPath)}`}
              className={BUTTON_CLASS}
            >
              Sign In
            </Link>
          </>
        ) : null}
        {action.kind === "dashboard" ? (
          <Link href="/admin/dashboard" className={BUTTON_CLASS}>
            Back to Dashboard
          </Link>
        ) : null}
        {action.kind === "link" ? (
          <Link href={action.href} className={BUTTON_CLASS}>
            {action.label}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
