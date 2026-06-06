// Brief 127 — shared enqueue helper for the `outbound_emails` queue
// table.
//
// The queue table is owned by the splash-forms worker (it exposes the
// claim/confirm endpoints PA polls), but ANY monorepo worker can enqueue
// rows here as long as it carries `SUPABASE_SERVICE_KEY`. The brief 127
// architectural goal is a single Power Automate flow that drains this
// queue, regardless of how many workers + forms produce messages.
//
// The helper does NOT interpret subject/body/recipient — the caller is
// responsible for rendering before calling. Multi-recipient emails are
// expressed as multiple `enqueueOutboundEmail` calls (one row per
// recipient).
//
// Idempotency: the unique index on `(source_worker, source_kind,
// source_id, recipient)` + PostgREST `Prefer: resolution=ignore-
// duplicates` means re-firing the same logical email is a no-op. The
// helper returns `was_duplicate: true` when a re-fire was suppressed.

export interface OutboundEmailAttachment {
  filename: string;
  /** Either `r2_key` (worker fetches at send-prep time + base64-encodes
   *  before responding to PA) or `base64` (already inlined by the
   *  caller). `r2_key` is preferred — keeps queue rows small. */
  r2_key?: string;
  base64?: string;
  mime: string;
  size_bytes: number;
  /** Which R2 bucket the `r2_key` lives in. Optional; defaults to the
   *  forms bucket (`FORMS_FILES`) when the claim endpoint inlines the
   *  attachment. Future workers writing into the queue with attachments
   *  in a different bucket should populate this so the claim endpoint
   *  knows where to fetch. Brief 157 added `"PROMO_FILES"` for promo
   *  announcement materials — forms-worker's claim endpoint dispatches
   *  on this string to pick the right R2 binding. Adding a new bucket
   *  requires (a) widening this union, (b) binding the bucket on
   *  forms-worker's wrangler.toml, and (c) extending the dispatch in
   *  `apps/forms-worker/src/email-queue/attachments.ts`. */
  bucket?: "FORMS_FILES" | "PROMO_FILES";
  /** Brief 160 — When true, the attachment is rendered inline in the
   *  email body via CID reference (`<img src="cid:{content_id}" />`).
   *  PA's Send Email V2 connector flips `IsInline` true + `ContentId`
   *  populated for inline-flagged attachments. Defaults false (regular
   *  attachment). The forms-worker claim endpoint passes this flag
   *  through to PA verbatim. */
  is_inline?: boolean;
  /** Brief 160 — CID identifier referenced from the body HTML. Required
   *  when `is_inline` is true. Must be stable for re-fires (the same
   *  logical email re-enqueued should reference the same CID so dedup
   *  behaves). Convention used by promo-worker: `material-{materialId}`. */
  content_id?: string;
}

export interface OutboundEmailPayload {
  /** e.g. "forms", "damage", "fleet" — caller's worker name (no slashes). */
  source_worker: string;
  /** e.g. "workflow-email-step", "submission-receipt". Free-form text but
   *  should be stable across re-fires for the same logical event. */
  source_kind: string;
  /** Stable per-event id — re-firing the same `(source_worker,
   *  source_kind, source_id, recipient)` tuple is a no-op. For workflow
   *  email steps the convention is `"{submission_id}:{stage_id}"`. */
  source_id: string;
  /** Single email address. Multi-recipient sends are multiple
   *  `enqueueOutboundEmail` calls. */
  recipient: string;
  /** Optional CC list (passed through to PA, not subject to the
   *  per-recipient dedup index). */
  cc?: string[];
  reply_to?: string;
  /** Already-rendered subject (the helper does no template substitution). */
  subject: string;
  /** Already-rendered HTML body (preferred) and/or plain-text body. PA
   *  picks `body_html` when available, falls back to `body_text`. */
  body_html?: string;
  body_text?: string;
  attachments?: OutboundEmailAttachment[];
  /** ISO 8601. Defaults to `now()` at the DB layer. */
  scheduled_for?: string;
}

export interface EnqueueOutboundEmailResult {
  id: string;
  was_duplicate: boolean;
}

interface EnqueueEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

/**
 * Insert (or no-op re-insert) one row into the `outbound_emails` queue.
 *
 * Returns `{id, was_duplicate}`:
 *   - `was_duplicate: false` — fresh insert. The returned `id` is the
 *     freshly minted row id.
 *   - `was_duplicate: true` — an existing row matched on
 *     `(source_worker, source_kind, source_id, recipient)`. The returned
 *     `id` is the EXISTING row's id (PostgREST `merge-duplicates` would
 *     update the row; we use `ignore-duplicates` to leave it untouched).
 *     When the existing row was already sent (`sent_at IS NOT NULL`),
 *     PA never re-sends.
 *
 * Throws on transport / auth failures so the caller can surface them in
 * logs. Workers should wrap calls in fail-soft try/catch when the
 * transition itself should proceed even if enqueue fails.
 */
export async function enqueueOutboundEmail(
  env: EnqueueEnv,
  payload: OutboundEmailPayload
): Promise<EnqueueOutboundEmailResult> {
  const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  // Brief 133 — PostgREST honors `Prefer: resolution=ignore-duplicates`
  // only when the request URL also carries `on_conflict=<column-list>`.
  // Without it, a unique-index hit propagates as Postgres 23505 →
  // PostgREST 409 Conflict. The column list MUST match the unique
  // index on `outbound_emails`
  // (source_worker, source_kind, source_id, recipient).
  url.searchParams.set(
    "on_conflict",
    "source_worker,source_kind,source_id,recipient"
  );
  // `ignore-duplicates` makes the unique index a no-op silencer for
  // re-fires. `return=representation` so we can read the id back —
  // PostgREST returns 201 with the inserted row on success, and 201
  // with the EXISTING row data when the dedup index fires.
  const headers: Record<string, string> = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=representation"
  };
  const body = {
    source_worker: payload.source_worker,
    source_kind: payload.source_kind,
    source_id: payload.source_id,
    recipient: payload.recipient.trim().toLowerCase(),
    cc: payload.cc ?? [],
    reply_to: payload.reply_to ?? null,
    subject: payload.subject,
    body_html: payload.body_html ?? null,
    body_text: payload.body_text ?? null,
    attachments: payload.attachments ?? [],
    scheduled_for: payload.scheduled_for ?? new Date().toISOString()
  };

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `enqueueOutboundEmail: ${resp.status} ${resp.statusText} — ${text.slice(0, 200)}`
    );
  }

  // PostgREST returns an array on insert.
  const rows = (await resp.json().catch(() => [])) as Array<{
    id?: string;
    sent_at?: string | null;
    created_at?: string | null;
  }>;

  // With `ignore-duplicates`, on conflict PostgREST returns the EXISTING
  // row when `return=representation` is set. To know whether we hit the
  // index, we'd need a separate read — but for the caller's purposes,
  // returning the row's id is enough. Mark `was_duplicate: true` when
  // `created_at` is older than ~3 seconds before the request (clock skew
  // tolerance); freshly-inserted rows have `created_at` within a few
  // hundred ms.
  const row = rows[0];
  if (!row?.id) {
    // Shouldn't happen with return=representation; fall back to a
    // generic non-throwing response so the caller's enqueue path
    // doesn't 500 on a misconfigured PostgREST behaviour.
    return { id: "", was_duplicate: false };
  }
  const wasDuplicate = row.created_at
    ? Date.now() - new Date(row.created_at).getTime() > 3_000
    : false;
  return { id: row.id, was_duplicate: wasDuplicate };
}
