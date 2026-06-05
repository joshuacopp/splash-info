// Brief 158b — IT ticket page assignee editor.
//
// Renders current assignees as removable chips + an autocomplete input
// for adding new ones. The autocomplete fetches against the
// `/promo/api/users/search` endpoint (path-carved same-origin) — the
// path-carve means apps/web doesn't need a service binding for the
// browser-driven search call.
//
// Add / remove dispatch through hidden-form server actions wrapped in
// <ActionForm> so each fire shows the standard success/error banner.

"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import {
  addAssigneeAction,
  removeAssigneeAction
} from "../_actions/ticketActions";
import type { PromoTicketAssignee, PromoRole } from "../_lib/types";

interface UserHit {
  userId: string;
  email: string;
  promoRole: PromoRole;
}

interface Props {
  promoId: string;
  assignees: PromoTicketAssignee[];
  userLookup: Record<string, { email: string; fullName: string | null }>;
}

export default function AssigneesEditor({
  promoId,
  assignees,
  userLookup
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length === 0) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await fetch(
          `/promo/api/users/search?q=${encodeURIComponent(query.trim())}`,
          { credentials: "same-origin" }
        );
        if (resp.ok) {
          const data = (await resp.json().catch(() => ({}))) as {
            users?: UserHit[];
          };
          setResults(Array.isArray(data.users) ? data.users : []);
        } else {
          setResults([]);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleAddResult(result: ActionResult) {
    if (result.ok) {
      setQuery("");
      setResults([]);
      setFeedback(result.message ?? "Assignee added.");
    } else {
      setFeedback(result.error);
    }
  }

  function handleRemoveResult(result: ActionResult) {
    if (result.ok) {
      setFeedback(result.message ?? "Assignee removed.");
    } else {
      setFeedback(result.error);
    }
  }

  const assigneeIdSet = new Set(assignees.map((a) => a.userId));

  return (
    <div className="space-y-3">
      {assignees.length === 0 ? (
        <p className="text-sm italic text-splash-navy/55">
          Nobody assigned yet.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {assignees.map((a) => {
            const info = userLookup[a.userId];
            const label = info?.email ?? `user ${a.userId.slice(0, 8)}…`;
            return (
              <li
                key={a.userId}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-light bg-white px-3 py-1 text-xs text-splash-navy"
              >
                <span className="font-medium">{label}</span>
                <ActionForm
                  action={removeAssigneeAction}
                  onResult={handleRemoveResult}
                  resetOnSuccess={false}
                  className="inline"
                >
                  <input type="hidden" name="promoId" value={promoId} />
                  <input type="hidden" name="userId" value={a.userId} />
                  <button
                    type="submit"
                    className="text-splash-navy/55 hover:text-splash-deny"
                    aria-label={`Remove ${label}`}
                    onClick={(e) => {
                      if (!window.confirm(`Remove ${label} from this promo?`)) {
                        e.preventDefault();
                      }
                    }}
                  >
                    ×
                  </button>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add assignee — type a name or email…"
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none sm:max-w-[420px]"
        />
        {query.trim().length > 0 && (
          <div className="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-splash-sm border border-gray-light bg-white shadow-splash-card sm:max-w-[420px]">
            {searching ? (
              <p className="px-3 py-2 text-sm italic text-splash-navy/55">
                Searching…
              </p>
            ) : results.length === 0 ? (
              <p className="px-3 py-2 text-sm italic text-splash-navy/55">
                No matches. (Users need a `promo_role` set in sysadmin.)
              </p>
            ) : (
              <ul className="divide-y divide-gray-light/60">
                {results.map((r) => {
                  const alreadyAssigned = assigneeIdSet.has(r.userId);
                  return (
                    <li key={r.userId}>
                      <ActionForm
                        action={addAssigneeAction}
                        onResult={handleAddResult}
                        resetOnSuccess={false}
                      >
                        <input type="hidden" name="promoId" value={promoId} />
                        <input type="hidden" name="userId" value={r.userId} />
                        <button
                          type="submit"
                          disabled={alreadyAssigned}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="flex-1 truncate">
                            <span className="font-medium text-splash-navy">
                              {r.email}
                            </span>
                          </span>
                          <span className="text-[0.6875rem] uppercase tracking-wide text-splash-navy/55">
                            {alreadyAssigned ? "assigned" : r.promoRole}
                          </span>
                        </button>
                      </ActionForm>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {feedback && (
        <p className="text-xs italic text-splash-navy/70">{feedback}</p>
      )}
    </div>
  );
}
