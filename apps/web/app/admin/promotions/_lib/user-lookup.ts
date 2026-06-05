// Brief 158a — Phase 7 stub for user_id → {email, fullName} resolution.
//
// **Intentional deviation from the brief's prescribed implementation:**
// The brief's Phase 7 prescribes a direct `@supabase/supabase-js` client
// powered by `process.env.SUPABASE_URL` + `process.env.SUPABASE_SERVICE_KEY`
// to read from `auth_unified`. apps/web today carries NEITHER:
//   - `@supabase/supabase-js` is NOT in `apps/web/package.json` (the only
//     direct-Supabase consumers are the workers; apps/web SSR-fetches
//     through service bindings).
//   - `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are NOT bindings on
//     `splash-web`'s wrangler.toml — adding them is a scope expansion
//     touching secrets management + CF Workers deploy plumbing.
//
// The brief also acknowledges (Phase 7 epilogue): "auth_unified doesn't
// surface full_name yet (per CLAUDE.md Brief 125 note about future
// widening); for now, render email as the display name."
//
// The simplest minimum-disruption read-time fix is to either:
//   (a) extend the promo-worker with a `GET /promo/api/users?ids=...`
//       endpoint that resolves a list of user_ids → {email, fullName},
//   (b) widen the promo-worker detail response to embed resolved user
//       info per assignee + per activity actor, or
//   (c) widen the `auth_unified` view to expose `full_name`.
//
// All three are out of scope for 158a (read pages only). 158b's write
// affordances will require a `users/search` endpoint on the promo-worker
// anyway (assignee picker autosuggest), so the natural home is there.
//
// Until then, this helper returns an empty map and the UI falls back to
// rendering a truncated user_id snippet (`shortenUserId(...)`). The page
// chrome includes a "view in Database Admin" link for super_admins who
// need to map a UUID back to an actual user.

export interface UserInfo {
  email: string;
  fullName: string | null;
}

/**
 * Returns an empty map at 158a — see file-level comment for rationale.
 * Callers should handle missing entries gracefully (render the short
 * user_id via `shortenUserId`).
 */
export async function lookupUserNames(
  _userIds: readonly string[]
): Promise<Record<string, UserInfo>> {
  return {};
}

/**
 * UI fallback for a missing user_id resolution — show "abc12345…" so
 * operators can at least eyeball a recognizable UUID prefix. Used by
 * the live-view + IT ticket pages when `lookupUserNames` returns no
 * entry for a given user_id (currently always).
 */
export function shortenUserId(userId: string): string {
  if (!userId) return "(unknown)";
  return userId.length > 12 ? `${userId.slice(0, 8)}…` : userId;
}

/**
 * Compose a display label for an assignee row: prefer fullName, fall
 * back to email, fall back to a shortened user_id. Stable signature for
 * the day the resolver is wired in.
 */
export function displayUserLabel(
  userId: string,
  info: UserInfo | undefined
): string {
  if (info?.fullName) return info.fullName;
  if (info?.email) return info.email;
  return shortenUserId(userId);
}
