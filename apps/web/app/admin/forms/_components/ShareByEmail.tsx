"use client";

// "Send by email" section of the form share dialog (FormQrButton).
//
// Recipients are picked from the org directory via PersonAutosuggest (the
// same picker the workflow builder uses) or typed free-hand for people with
// no account: type the address and press Enter, or paste a list separated by
// commas, semicolons or new lines. POSTs straight to the forms worker
// (same-origin, path-carved), which validates every address, builds the link
// and queues one email per recipient on outbound_emails. Replies go to the
// sender.

import { useState } from "react";
import PersonAutosuggest from "../[id]/_workflow/PersonAutosuggest";

interface Props {
  formId: string;
  audience: string;
}

const LOOSE_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; count: number; failed: string[] }
  | { kind: "error"; message: string };

export default function ShareByEmail({ formId, audience }: Props) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [paste, setPaste] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });

  function add(emails: string[]) {
    setRecipients((prev) => {
      const seen = new Set(prev.map((e) => e.toLowerCase()));
      const next = [...prev];
      for (const raw of emails) {
        const e = raw.trim().toLowerCase();
        if (!e || seen.has(e)) continue;
        seen.add(e);
        next.push(e);
      }
      return next;
    });
    if (state.kind !== "sending") setState({ kind: "idle" });
  }

  function addPasted() {
    const parts = paste.split(/[\s,;]+/).filter(Boolean);
    const good = parts.filter((p) => LOOSE_EMAIL.test(p));
    add(good);
    const bad = parts.filter((p) => !LOOSE_EMAIL.test(p));
    setPaste(bad.join(", "));
  }

  async function send() {
    if (recipients.length === 0) return;
    setState({ kind: "sending" });
    try {
      const resp = await fetch(
        `/forms/admin/api/forms/${encodeURIComponent(formId)}/share-email`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipients, message })
        }
      );
      const data = (await resp.json().catch(() => ({}))) as {
        sent?: number;
        failed?: string[];
        error?: string;
        invalid?: string[];
        max?: number;
      };
      if (!resp.ok && !data.sent) {
        setState({ kind: "error", message: describeError(resp.status, data) });
        return;
      }
      setState({ kind: "sent", count: data.sent ?? 0, failed: data.failed ?? [] });
      setRecipients(data.failed ?? []);
      if (!data.failed?.length) setMessage("");
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="mt-5 border-t border-gray-light pt-4 text-left">
      <h3 className="text-sm font-bold text-splash-navy">Send by email</h3>
      <p className="mt-0.5 text-xs text-splash-navy/60">
        Search for someone in the system, or type any email address and press Enter.
      </p>
      {audience === "internal" && (
        <p className="mt-2 rounded-splash-sm border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          This form requires signing in. People without an account will not be able to fill it out.
        </p>
      )}

      <div className="mt-2">
        <PersonAutosuggest placeholder="Name or email…" onPick={(e) => add([e])} />
      </div>

      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-splash-blue">Paste a list of addresses</summary>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.currentTarget.value)}
          rows={3}
          placeholder="one@example.com, two@example.com"
          className="mt-1 w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm text-splash-navy"
        />
        <button
          type="button"
          onClick={addPasted}
          disabled={!paste.trim()}
          className="mt-1 inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-2 py-0.5 text-xs font-semibold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-50"
        >
          Add addresses
        </button>
        {paste.trim() && (
          <p className="mt-1 text-[0.7rem] text-splash-navy/60">
            Anything left in the box after adding is not a valid address.
          </p>
        )}
      </details>

      {recipients.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {recipients.map((r) => (
            <li
              key={r}
              className="inline-flex items-center gap-1 rounded-full bg-splash-blue/10 px-2 py-0.5 text-xs text-splash-navy"
            >
              {r}
              <button
                type="button"
                onClick={() => setRecipients((prev) => prev.filter((x) => x !== r))}
                className="text-splash-navy/60 hover:text-racecar-red"
                aria-label={`Remove ${r}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        rows={3}
        maxLength={2000}
        placeholder="Optional message"
        className="mt-2 w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm text-splash-navy"
      />

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-splash-navy/60">
          {recipients.length === 0
            ? "No recipients yet"
            : `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={send}
          disabled={recipients.length === 0 || state.kind === "sending"}
          className="inline-flex items-center rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white hover:bg-splash-blue-dark disabled:opacity-50"
        >
          {state.kind === "sending" ? "Sending…" : "Send"}
        </button>
      </div>

      {state.kind === "sent" && (
        <p role="status" className="mt-2 text-xs text-splash-success">
          Sent to {state.count} {state.count === 1 ? "person" : "people"}. Emails go out within a few minutes.
          {state.failed.length > 0 && (
            <span className="block text-racecar-red">
              Could not queue: {state.failed.join(", ")} (left in the list to retry).
            </span>
          )}
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="mt-2 text-xs text-racecar-red">
          {state.message}
        </p>
      )}
    </div>
  );
}

function describeError(
  status: number,
  data: { error?: string; invalid?: string[]; max?: number }
): string {
  switch (data.error) {
    case "invalid_recipients":
      return `Not a valid email address: ${(data.invalid ?? []).join(", ")}`;
    case "too_many_recipients":
      return `Too many recipients — send to at most ${data.max ?? 50} at a time.`;
    case "message_too_long":
      return "The message is too long.";
    case "form_not_published":
      return "This form isn't published, so its link won't work.";
    case "no_recipients":
      return "Add at least one recipient.";
    default:
      return status === 401 || status === 403
        ? "You don't have permission to send this form."
        : `Sending failed (HTTP ${status}).`;
  }
}
