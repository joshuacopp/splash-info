// Secret link + "Save and continue later" (2026-11-15).
//
// SECRET LINK: a link-only form's URL is normally /forms/{slug}, which anyone
// can guess from the form's name. Turning the secret link on replaces the slug
// with a random key; "Change link" makes a new key and every old link and QR
// code stops working at once (the fix when a link has gone somewhere it
// shouldn't). Saved immediately -- it is not part of "Save settings", because
// changing it breaks links people are using and deserves its own button.
//
// SAVE AND CONTINUE LATER: the filler can save their answers and get a private
// link by email (Splash addresses only, 14 days). It also turns off the
// browser's own autosave for the form, so nothing is left on a shared tablet.

"use client";

import { useEffect, useState, useTransition } from "react";

import { saveLinkSettingsAction } from "../actions";

interface Props {
  formId: string;
  slug: string;
  audience: "public" | "internal" | "link-only";
  linkKey: string | null;
  onLinkKeyChange: (key: string | null) => void;
  initialEmailDrafts: boolean;
}

export default function SecretLinkCard({ formId, slug, audience, linkKey, onLinkKeyChange, initialEmailDrafts }: Props) {
  const [emailDrafts, setEmailDrafts] = useState(initialEmailDrafts);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const linkOnly = audience === "link-only";
  const active = linkOnly && !!linkKey;
  const url = `${origin}/forms/${active ? linkKey : slug}`;

  function link(action: "on" | "rotate" | "off") {
    if (action === "rotate" && !window.confirm("Make a new link? The current link and any printed QR codes stop working right away. You'll need to share the new link.")) return;
    if (action === "off" && !window.confirm("Turn off the secret link? The form goes back to its plain address, which anyone could guess from its name.")) return;
    if (action === "on" && !window.confirm("Turn on a secret link? The current address and any printed QR codes for this form stop working. You'll need to share the new link.")) return;
    setStatus(null);
    start(async () => {
      const r = await saveLinkSettingsAction(formId, { secret_link: action });
      if (!r.ok) {
        setStatus({ kind: "error", text: r.error });
        return;
      }
      onLinkKeyChange(r.link_key ?? null);
      setStatus({
        kind: "ok",
        text: action === "off" ? "Secret link turned off." : "New link is live. Share it with the people who use this form."
      });
    });
  }

  function toggleDrafts(on: boolean) {
    setStatus(null);
    start(async () => {
      const r = await saveLinkSettingsAction(formId, { email_drafts: on });
      if (!r.ok) {
        setStatus({ kind: "error", text: r.error });
        return;
      }
      setEmailDrafts(on);
      setStatus({ kind: "ok", text: on ? "Save and continue later is on." : "Save and continue later is off." });
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  return (
    <section className="space-y-4 rounded-splash-md border border-gray-light bg-white p-5">
      <header className="border-b border-gray-light pb-2">
        <h2 className="text-lg font-bold text-splash-navy">Link and saving</h2>
        <p className="mt-1 text-xs text-splash-navy/60">These save as soon as you click.</p>
      </header>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-splash-navy">Secret link</h3>
        {!linkOnly ? (
          <p className="text-xs text-splash-navy/60">
            Only link-only forms can have a secret link. This form is {audience}.
          </p>
        ) : (
          <>
            <p className="text-xs text-splash-navy/60">
              {active
                ? "This form opens only from the link below. Its plain address no longer works."
                : "This form's address is made from its name, so anyone could guess it. A secret link replaces it with a random one you can change at any time."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="max-w-full break-all rounded-splash-sm bg-gray-light/50 px-2 py-1 text-xs text-splash-navy">{url}</code>
              <button
                type="button"
                onClick={copy}
                className="rounded-full border border-splash-blue px-3 py-1 text-xs font-bold text-splash-blue hover:bg-splash-blue/5"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {active ? (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => link("rotate")}
                    className="rounded-full bg-splash-navy px-4 py-1.5 text-sm font-bold text-white hover:bg-splash-navy/90 disabled:opacity-60"
                  >
                    Change link
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => link("off")}
                    className="rounded-full border border-gray-light px-4 py-1.5 text-sm font-semibold text-splash-navy hover:bg-gray-light/40 disabled:opacity-60"
                  >
                    Turn off
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => link("on")}
                  className="rounded-full bg-splash-navy px-4 py-1.5 text-sm font-bold text-white hover:bg-splash-navy/90 disabled:opacity-60"
                >
                  Turn on secret link
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <label className="flex items-start gap-2 border-t border-gray-light pt-3 text-sm text-splash-navy">
        <input
          type="checkbox"
          checked={emailDrafts}
          disabled={pending || audience === "public"}
          onChange={(e) => toggleDrafts(e.currentTarget.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span className="flex-1 font-semibold">
          Save and continue later
          <span className="mt-0.5 block text-xs font-normal text-splash-navy/60">
            Adds a button that saves the answers and emails a private link to pick up where they left off. Splash
            email addresses only; the link lasts 14 days after the last save and stops working once the form is
            submitted. While on, the browser doesn&apos;t keep its own copy of the answers, so nothing is left behind
            on a shared tablet. {audience === "public" ? "Not available on public forms." : ""}
          </span>
        </span>
      </label>

      {status ? (
        <p role={status.kind === "error" ? "alert" : "status"} className={`text-sm ${status.kind === "error" ? "text-red-700" : "text-emerald-700"}`}>
          {status.text}
        </p>
      ) : null}
    </section>
  );
}
