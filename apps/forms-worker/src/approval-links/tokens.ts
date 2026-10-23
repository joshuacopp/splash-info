// Emailed no-sign-in approval links — token storage.
//
// A link lets ONE recipient act on ONE submission at ONE workflow stage
// without signing in. The raw token exists only in the email; the table holds
// its SHA-256, so a database read (or a leaked backup) cannot be replayed as a
// link.
//
// What makes a link stop working, each checked at use time:
//   - expiry (LINK_TTL_DAYS)
//   - used: the recipient approved or denied through it
//   - stale: the submission is no longer at the stage the link was minted for
//     (someone acted from the dashboard, or a later stage was reached)
//   - the recipient is no longer on the stage's approver list
//
// OPENING THE LINK DOES NOT USE IT UP. Only a decision does. An approver who
// opens it, gets pulled away and comes back must not find it dead -- that is
// the failure the operator asked to avoid. Opens are counted for the audit
// trail; MAX_LINK_OPENS caps them if that is ever wanted.
//
// Table: public.form_approval_links (supabase/form-approval-links.sql).

import type { Env } from "../index.js";

export const LINK_TTL_DAYS = 7;
/** null = opens are unlimited until the link is used or expires. Set a number
 *  to lock the link after that many page loads. */
export const MAX_LINK_OPENS: number | null = null;

const APP_BASE = "https://splashcarwashes.info";

export interface ApprovalLinkRow {
  id: string;
  form_id: string;
  submission_id: string;
  stage_id: string;
  recipient_email: string;
  expires_at: string;
  open_count: number;
  used_at: string | null;
}

function headers(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    Accept: "application/json"
  };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function approvalLinkUrl(token: string): string {
  return `${APP_BASE}/forms/approve/${token}`;
}

/**
 * Create a link and return its URL, or null when the insert failed. Callers
 * treat null as "send the email without a link" -- the approver can still act
 * by signing in, so a storage hiccup must not cost them the notification.
 */
export async function mintApprovalLink(
  env: Env,
  args: { formId: string; submissionId: string; stageId: string; recipient: string }
): Promise<string | null> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const expires = new Date(Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);

  const url = new URL("/rest/v1/form_approval_links", env.SUPABASE_URL);
  try {
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        token_hash: await hashToken(token),
        form_id: args.formId,
        submission_id: args.submissionId,
        stage_id: args.stageId,
        recipient_email: args.recipient.trim().toLowerCase(),
        expires_at: expires.toISOString()
      })
    });
    if (!resp.ok) {
      console.error(
        "[forms.approval-link] mint failed",
        resp.status,
        await resp.text().catch(() => "")
      );
      return null;
    }
  } catch (err) {
    console.error("[forms.approval-link] mint threw", err);
    return null;
  }
  return approvalLinkUrl(token);
}

export async function findApprovalLink(
  env: Env,
  token: string
): Promise<ApprovalLinkRow | null> {
  const url = new URL("/rest/v1/form_approval_links", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "id,form_id,submission_id,stage_id,recipient_email,expires_at,open_count,used_at"
  );
  url.searchParams.set("token_hash", `eq.${await hashToken(token)}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: headers(env) });
  if (!resp.ok) throw new Error(`findApprovalLink: ${resp.status}`);
  const rows = (await resp.json().catch(() => [])) as ApprovalLinkRow[];
  return rows[0] ?? null;
}

/** Best-effort audit counter; a failure here never blocks the page. */
export async function recordApprovalLinkOpen(env: Env, link: ApprovalLinkRow): Promise<void> {
  const url = new URL("/rest/v1/form_approval_links", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${link.id}`);
  try {
    await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        open_count: link.open_count + 1,
        last_opened_at: new Date().toISOString()
      })
    });
  } catch (err) {
    console.warn("[forms.approval-link] open count failed", err);
  }
}

/**
 * Atomically mark the link used. Returns false when another request got there
 * first -- the `used_at=is.null` filter makes this a compare-and-set, so a
 * double-clicked Approve cannot transition the submission twice.
 */
export async function claimApprovalLink(
  env: Env,
  linkId: string,
  transitionTo: string
): Promise<boolean> {
  const url = new URL("/rest/v1/form_approval_links", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${linkId}`);
  url.searchParams.set("used_at", "is.null");
  url.searchParams.set("select", "id");
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...headers(env),
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      used_at: new Date().toISOString(),
      used_transition_to: transitionTo
    })
  });
  if (!resp.ok) throw new Error(`claimApprovalLink: ${resp.status}`);
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return rows.length === 1;
}

/** Undo a claim when the transition behind it failed, so the approver can
 *  retry instead of holding a dead link for a decision that never landed. */
export async function releaseApprovalLink(env: Env, linkId: string): Promise<void> {
  const url = new URL("/rest/v1/form_approval_links", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${linkId}`);
  try {
    await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...headers(env), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ used_at: null, used_transition_to: null })
    });
  } catch (err) {
    console.error("[forms.approval-link] release failed — link stays spent", err);
  }
}
