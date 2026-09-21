// Access tag for a form. Admin-tier only, and the worker re-checks.
//
// WHAT TAGGING A FORM DOES
//
//   Anyone holding a matching grant (sysadmin → Access → Form access) reads
//   EVERY submission of this form org-wide, closed ones included. That is
//   deliberately broader than the `form_submissions` tool grant, which is
//   limited to a user's own locations and therefore cannot describe somebody
//   working a queue across every site.
//
// SAVES IMMEDIATELY, unlike every other control on this tab.
//
//   The rest of Settings is client-only state that persists on Save Draft
//   (Brief 95/125 -- PATCH /draft accepts schema only). This one writes
//   straight through, because it is an access control and "I ticked it but
//   forgot to publish" is a bad failure mode for one. It is visually separated
//   and says so, rather than sitting silently among fields that behave
//   differently.
//
// Self-contained on purpose: takes formId + the current value, holds its own
// state, never touches the builder reducer or its dirty flag.

"use client";

import { useEffect, useState, useTransition } from "react";

import { setAccessTagAction } from "../actions";

interface Props {
  formId: string;
  initialTag: string | null;
}

const TAG_RE = /^[a-z][a-z0-9_]*$/;

export default function AccessTagCard({ formId, initialTag }: Props) {
  const [tag, setTag] = useState(initialTag ?? "");
  const [saved, setSaved] = useState(initialTag ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Existing tags, so the operator joins an established group instead of
  // inventing "crd_team" next to "crd" and wondering why nobody can see it.
  useEffect(() => {
    let live = true;
    fetch("/forms/admin/api/access-tags", {
      credentials: "include",
      cache: "no-store"
    })
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => {
        const tags = (d as { tags?: unknown }).tags;
        if (live && Array.isArray(tags)) setSuggestions(tags as string[]);
      })
      .catch(() => {
        /* suggestions are a convenience; the input works without them */
      });
    return () => {
      live = false;
    };
  }, []);

  const trimmed = tag.trim();
  const invalid = trimmed !== "" && !TAG_RE.test(trimmed);
  const dirty = trimmed !== saved;

  function save() {
    if (invalid || pending || !dirty) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setAccessTagAction(formId, trimmed === "" ? null : trimmed);
      if (res.ok) {
        setSaved(trimmed);
        setMsg({
          ok: true,
          text:
            trimmed === ""
              ? "Tag cleared. Anyone who held it loses access to this form — their grant stays, it just stops matching."
              : `Saved. Grant "${trimmed}" in sysadmin → Access to give someone org-wide access to this form.`
        });
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  return (
    <section className="space-y-3 rounded-splash-md border border-amber-300 bg-amber-50/40 p-5">
      <header>
        <h2 className="text-lg font-bold text-splash-navy">Access tag</h2>
        <p className="mt-1 text-xs text-splash-navy/70">
          Anyone granted this tag can read <strong>every</strong> submission of
          this form, across all locations, including closed ones. Leave it empty
          unless a team works this form as a queue.
        </p>
        <p className="mt-1 text-[0.6875rem] font-semibold text-amber-800">
          Saves immediately — not on Save Draft, unlike the fields above.
        </p>
      </header>

      <div className="flex flex-wrap items-start gap-2">
        <div>
          <input
            type="text"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setMsg(null);
            }}
            list="access-tag-suggestions"
            placeholder="crd"
            aria-invalid={invalid}
            className="w-56 rounded-splash-sm border border-gray-light bg-white px-3 py-2 font-mono text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
          />
          <datalist id="access-tag-suggestions">
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          {invalid && (
            <p className="mt-1 text-xs text-racecar-red">
              Lowercase letters, numbers and underscores; must start with a
              letter.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={save}
          disabled={invalid || pending || !dirty}
          className="rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-bold text-white hover:bg-splash-blue-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Saving…" : dirty ? "Save tag" : "Saved"}
        </button>
      </div>

      {msg && (
        <p
          role="status"
          className={
            msg.ok ? "text-xs text-splash-navy/80" : "text-xs text-racecar-red"
          }
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
