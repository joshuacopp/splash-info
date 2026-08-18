"use client";

// Brief 173 phase 2 — the writable access editor.
//
// Onboarding a regional manager used to be seven submits across five cards
// (Create user → Set role → Set DC Role → Set Promo Role → Grant tool ×3),
// re-picking the same person and the same thirty locations three or four
// times, because the console was organised around the four tables that hold
// permissions rather than around the job. This card is the job: pick the
// person once, see everything they can touch, change any of it, submit once.
//
// The four tables stay exactly as they are — public.user_permissions,
// public.user_tool_access, damage_claim_user_roles(+_locations), and
// promo_user_roles. The split is a UI problem, not a schema problem, and it
// gets hidden here rather than migrated away.
//
// Reads:  GET /sysadmin/api/users?q=...                (typeahead, via UserPicker)
//         GET /sysadmin/api/users/{userId}/permissions (the auth_unified row)
// Writes: setUserAccessAction → POST /sysadmin/api/users/{userId}/access
//
// Desired-state, not deltas: the form sends all six keys every time, so an
// unticked box means "remove" rather than "unspecified". The snapshot the
// form was rendered from rides along as `expect`; if live state has drifted
// since load — the pricing_simple → user_permissions email trigger being the
// realistic culprit — the worker 409s and writes nothing, and we reload the
// panel instead of clobbering someone else's change.
//
// Note the write is not transactional (Supabase JS exposes none), so the
// worker validates everything before its first write. Client-side validation
// here is a courtesy that saves a round-trip; the worker re-checks regardless.

import { useEffect, useRef, useState } from "react";
import { FieldLabel, inputClass, submitClass } from "./OperationCard";
import { LocationCodeMultiPicker } from "./LocationCodeMultiPicker";
import { UserPicker, type SelectedUser } from "./UserPicker";
import { ALL_TOOLS, TOOL_HELP, sortTools } from "./tools";
import { setUserAccessAction } from "../actions";

/** The six fields this form owns. Mirrors the worker's desired-state body. */
interface AccessState {
  role: string | null;
  locations: string[];
  tools: string[];
  dc_role: string | null;
  dc_locations: string[];
  promo_role: string | null;
}

/** Structural copy of the server action's return shape — a "use server"
 *  module can't export non-function values (see ../actions.ts). */
interface AccessActionResult {
  ok: boolean;
  error?: string;
  status?: number;
  message?: string;
  changed?: boolean;
}

/** auth_unified array columns arrive as a real array or as text-encoded
 *  JSON depending on the driver, so parse defensively. */
function parseArr(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalize(raw: Record<string, unknown>): AccessState {
  return {
    role: str(raw.role),
    locations: parseArr(raw.locations).slice().sort(),
    tools: sortTools(parseArr(raw.tools)),
    dc_role: str(raw.dc_role),
    dc_locations: parseArr(raw.dc_locations).slice().sort(),
    promo_role: str(raw.promo_role)
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((v) => seen.has(v));
}

export function AccessEditor() {
  const [user, setUser] = useState<SelectedUser | null>(null);
  const [baseline, setBaseline] = useState<AccessState | null>(null);
  const [draft, setDraft] = useState<AccessState | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AccessActionResult | null>(null);

  // Decision (Josh, 2026-08-18): DC locations mirror the pricing locations by
  // default, because in practice they are the same list — a GM scoped to a
  // site handles that site's claims. Unlinking is the exception, so it's a
  // toggle rather than the default. Starts linked when the two already agree,
  // which includes the empty/empty case on a fresh user.
  const [mirrorDc, setMirrorDc] = useState(true);

  const loadSeqRef = useRef(0);

  async function load(userId: string) {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetch(
        `/sysadmin/api/users/${encodeURIComponent(userId)}/permissions`,
        { method: "GET", credentials: "include", cache: "no-store" }
      );
      if (seq !== loadSeqRef.current) return;
      if (!resp.ok) {
        setBaseline(null);
        setDraft(null);
        setLoadError(
          resp.status === 404
            ? "No permissions row for this user yet — create one with Set role first."
            : `Load failed (${resp.status}).`
        );
        return;
      }
      const raw = (await resp.json()) as Record<string, unknown>;
      if (seq !== loadSeqRef.current) return;
      const next = normalize(raw);
      setBaseline(next);
      setDraft(next);
      setMirrorDc(sameSet(next.dc_locations, next.locations));
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : "Load failed.");
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }

  function onSelectUser(picked: SelectedUser | null) {
    setUser(picked);
    setResult(null);
    setBaseline(null);
    setDraft(null);
    setLoadError(null);
    if (picked) void load(picked.user_id);
    else loadSeqRef.current++;
  }

  function patch(fields: Partial<AccessState>) {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...fields }));
    setResult(null);
  }

  // Keep dc_locations honest. One effect rather than logic in every setter,
  // so the region bulk-add, the per-chip ✕ and a role change all converge
  // through the same path. Two rules:
  //   - a DC role that bypasses scoping (none / admin / super_admin) can't
  //     carry locations — the worker drops them, so drop them here too or
  //     the diff line promises a change that never happens
  //   - while the mirror is on, gm/rm DC locations track the pricing list
  useEffect(() => {
    if (draft === null || baseline === null) return;
    const scoped = draft.dc_role === "gm" || draft.dc_role === "rm";
    let want: string[];
    if (scoped) {
      want = mirrorDc ? draft.locations : draft.dc_locations;
    } else if (draft.dc_role !== baseline.dc_role) {
      want = [];
    } else {
      // Non-scoped role that nobody touched. Orphan dc_locations rows can
      // exist under a null DC role; leave them be rather than opening the
      // form already dirty with a removal the operator didn't ask for.
      return;
    }
    if (sameSet(want, draft.dc_locations)) return;
    setDraft((prev) =>
      prev === null ? prev : { ...prev, dc_locations: [...want] }
    );
  }, [mirrorDc, draft, baseline]);

  const dirty =
    baseline !== null &&
    draft !== null &&
    (draft.role !== baseline.role ||
      draft.dc_role !== baseline.dc_role ||
      draft.promo_role !== baseline.promo_role ||
      !sameSet(draft.tools, baseline.tools) ||
      !sameSet(draft.locations, baseline.locations) ||
      !sameSet(draft.dc_locations, baseline.dc_locations));

  // Mirrors the worker's pre-write validation so the operator gets the
  // message without a round-trip. The worker re-checks either way.
  const blocker: string | null =
    draft === null
      ? null
      : draft.role === "location_admin" && draft.locations.length === 0
        ? "A location_admin needs at least one location. To take all of their access away, set the role to none instead."
        : (draft.dc_role === "gm" || draft.dc_role === "rm") &&
            draft.dc_locations.length === 0
          ? "A gm or rm DC role needs at least one DC location."
          : null;

  const showLocations = draft?.role === "location_admin";
  const showDcLocations = draft?.dc_role === "gm" || draft?.dc_role === "rm";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (user === null || draft === null || baseline === null) return;
    if (blocker !== null || !dirty || saving) return;

    setSaving(true);
    setResult(null);
    try {
      const res = await setUserAccessAction(user.user_id, draft, baseline);
      setResult(res);
      // Reload on success (trigger side effects, e.g. the pricing_simple
      // email trigger re-adding a row, only show up on a re-read) and on 409
      // (the whole point of the conflict is that our snapshot was wrong).
      if (res.ok || res.status === 409) await load(user.user_id);
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Save failed."
      });
    } finally {
      setSaving(false);
    }
  }

  const claimsWithoutDcRole =
    draft !== null && draft.tools.includes("claims") && draft.dc_role === null;
  const formSubmissionsWithoutLocations =
    draft !== null &&
    draft.tools.includes("form_submissions") &&
    draft.locations.length === 0 &&
    draft.role !== "super_admin";

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <FieldLabel htmlFor="access-editor-user" helper="Search by email">
          User
        </FieldLabel>
        <UserPicker
          name="access_editor_user_id"
          inputId="access-editor-user"
          onSelect={onSelectUser}
        />
      </div>

      {loading ? (
        <p className="text-sm text-splash-navy/60">Loading current access…</p>
      ) : null}

      {loadError ? (
        <p className="text-sm text-splash-deny">{loadError}</p>
      ) : null}

      {draft !== null && baseline !== null ? (
        <>
          {/* ---- Pricing / schedule role + locations (user_permissions) ---- */}
          <Section title="Role and locations">
            <div>
              <FieldLabel htmlFor="access-editor-role">Role</FieldLabel>
              <select
                id="access-editor-role"
                value={draft.role ?? ""}
                onChange={(e) =>
                  patch({ role: e.target.value === "" ? null : e.target.value })
                }
                className={inputClass}
              >
                <option value="">— No role —</option>
                <option value="location_admin">location_admin</option>
                <option value="super_admin">super_admin</option>
              </select>
              {draft.role === "super_admin" ? (
                <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
                  super_admin sees every location — the picker is hidden
                  because the row carries no location_code.
                </p>
              ) : null}
              {draft.role === null && baseline.role !== null ? (
                <p className="mt-1 text-[0.6875rem] text-splash-deny">
                  Saving will remove their role and all{" "}
                  {baseline.locations.length} location
                  {baseline.locations.length === 1 ? "" : "s"}.
                </p>
              ) : null}
            </div>

            {showLocations ? (
              <div>
                <FieldLabel
                  htmlFor="access-editor-locations"
                  helper="Add a whole region, or search by site #, name, or code"
                >
                  Locations
                </FieldLabel>
                <LocationCodeMultiPicker
                  name="access_editor_locations"
                  inputId="access-editor-locations"
                  enableRegionAdd
                  value={draft.locations}
                  onChange={(codes) => patch({ locations: codes })}
                />
              </div>
            ) : null}
          </Section>

          {/* ---- Tools (user_tool_access) ---- */}
          <Section title="Tools">
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {ALL_TOOLS.map((tool) => (
                <label
                  key={tool}
                  className="inline-flex items-start gap-2 text-sm text-splash-navy"
                >
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={(e) =>
                      patch({
                        tools: sortTools(
                          e.target.checked
                            ? [...draft.tools, tool]
                            : draft.tools.filter((t) => t !== tool)
                        )
                      })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    {tool}
                    <span className="block text-[0.6875rem] text-splash-navy/60">
                      {TOOL_HELP[tool]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {claimsWithoutDcRole ? (
              <p className="text-xs text-splash-navy/70">
                Claims is ticked but there&rsquo;s no DC role — they&rsquo;ll
                sign in fine and then hit &ldquo;no access&rdquo; on
                /admin/damage. Set one below.
              </p>
            ) : null}
            {formSubmissionsWithoutLocations ? (
              <p className="text-xs text-splash-navy/70">
                Form submissions is scoped by location — with no locations
                they&rsquo;ll see an empty list.
              </p>
            ) : null}
          </Section>

          {/* ---- Damage claims (damage_claim_user_roles + _locations) ---- */}
          <Section title="Damage claims">
            <div>
              <FieldLabel htmlFor="access-editor-dc-role">DC role</FieldLabel>
              <select
                id="access-editor-dc-role"
                value={draft.dc_role ?? ""}
                onChange={(e) =>
                  patch({
                    dc_role: e.target.value === "" ? null : e.target.value
                  })
                }
                className={inputClass}
              >
                <option value="">— No DC role —</option>
                <option value="gm">gm</option>
                <option value="rm">rm</option>
                <option value="admin">admin</option>
                <option value="super_admin">super_admin</option>
              </select>
              {draft.dc_role === "admin" || draft.dc_role === "super_admin" ? (
                <p className="mt-1 text-[0.6875rem] text-splash-navy/60">
                  admin and super_admin bypass location scoping — no DC
                  locations needed.
                </p>
              ) : null}
            </div>

            {showDcLocations ? (
              <div>
                <FieldLabel
                  htmlFor="access-editor-dc-locations"
                  helper={
                    mirrorDc
                      ? "Mirroring the locations above"
                      : "Set independently of the locations above"
                  }
                >
                  DC locations
                </FieldLabel>

                <label className="mb-2 inline-flex items-center gap-2 text-xs text-splash-navy">
                  <input
                    type="checkbox"
                    checked={mirrorDc}
                    onChange={(e) => setMirrorDc(e.target.checked)}
                  />
                  <span>Same as their locations above</span>
                </label>

                {mirrorDc ? (
                  <p className="text-xs text-splash-navy/60">
                    {draft.locations.length === 0
                      ? "No locations set above — untick to pick DC locations separately."
                      : `${draft.locations.length} location${
                          draft.locations.length === 1 ? "" : "s"
                        }, matching the list above.`}
                  </p>
                ) : (
                  <LocationCodeMultiPicker
                    name="access_editor_dc_locations"
                    inputId="access-editor-dc-locations"
                    enableRegionAdd
                    value={draft.dc_locations}
                    onChange={(codes) => patch({ dc_locations: codes })}
                  />
                )}
              </div>
            ) : null}
          </Section>

          {/* ---- Promo (promo_user_roles) ---- */}
          <Section title="Promo">
            <div>
              <FieldLabel htmlFor="access-editor-promo-role">
                Promo role
              </FieldLabel>
              <select
                id="access-editor-promo-role"
                value={draft.promo_role ?? ""}
                onChange={(e) =>
                  patch({
                    promo_role: e.target.value === "" ? null : e.target.value
                  })
                }
                className={inputClass}
              >
                <option value="">— No promo role —</option>
                <option value="super_admin">super_admin</option>
                <option value="it">it</option>
                <option value="marketing">marketing</option>
                <option value="ops">ops</option>
              </select>
            </div>
          </Section>

          <ChangeSummary baseline={baseline} draft={draft} dirty={dirty} />

          {blocker !== null ? (
            <p className="text-sm text-splash-deny">{blocker}</p>
          ) : null}

          {result !== null ? (
            <p
              className={`text-sm ${
                result.ok ? "text-splash-navy" : "text-splash-deny"
              }`}
            >
              {result.ok
                ? (result.message ?? "Access saved")
                : (result.error ?? "Save failed.")}
            </p>
          ) : null}

          <div className="pt-1">
            <button
              type="submit"
              className={submitClass}
              disabled={!dirty || blocker !== null || saving || loading}
            >
              {saving ? "Saving…" : "Save access"}
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3 rounded-splash-sm border border-gray-light p-3">
      <legend className="px-1 text-xs font-bold uppercase tracking-wide text-splash-navy/60">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** Everything that will be written, in one place, before you commit to it.
 *  Deliberately explicit about removals — this is the first card in the
 *  console where a submit can take access away. */
function ChangeSummary({
  baseline,
  draft,
  dirty
}: {
  baseline: AccessState;
  draft: AccessState;
  dirty: boolean;
}) {
  if (!dirty) {
    return (
      <p className="text-xs text-splash-navy/70">
        No changes — this matches what they have now.
      </p>
    );
  }

  const lines: string[] = [];
  const label = (v: string | null) => v ?? "none";

  if (draft.role !== baseline.role) {
    lines.push(`Role: ${label(baseline.role)} → ${label(draft.role)}`);
  }
  if (draft.dc_role !== baseline.dc_role) {
    lines.push(`DC role: ${label(baseline.dc_role)} → ${label(draft.dc_role)}`);
  }
  if (draft.promo_role !== baseline.promo_role) {
    lines.push(
      `Promo role: ${label(baseline.promo_role)} → ${label(draft.promo_role)}`
    );
  }

  const diff = (before: string[], after: string[]) => ({
    added: after.filter((v) => !before.includes(v)),
    removed: before.filter((v) => !after.includes(v))
  });

  const tools = diff(baseline.tools, draft.tools);
  if (tools.added.length > 0) lines.push(`Grant ${tools.added.join(", ")}`);
  if (tools.removed.length > 0) lines.push(`Revoke ${tools.removed.join(", ")}`);

  const locs = diff(baseline.locations, draft.locations);
  if (locs.added.length > 0) {
    lines.push(`Add ${locs.added.length} location(s): ${locs.added.join(", ")}`);
  }
  if (locs.removed.length > 0) {
    lines.push(
      `Remove ${locs.removed.length} location(s): ${locs.removed.join(", ")}`
    );
  }

  const dcLocs = diff(baseline.dc_locations, draft.dc_locations);
  if (dcLocs.added.length > 0) {
    lines.push(`Add ${dcLocs.added.length} DC location(s)`);
  }
  if (dcLocs.removed.length > 0) {
    lines.push(`Remove ${dcLocs.removed.length} DC location(s)`);
  }

  return (
    <div className="rounded-splash-sm border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-3 py-2 text-xs text-splash-navy">
      <div className="mb-1 font-semibold">On save:</div>
      <ul className="list-disc space-y-0.5 pl-4">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
