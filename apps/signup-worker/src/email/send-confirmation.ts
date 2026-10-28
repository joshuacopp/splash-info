// Enqueue the MaxPass confirmation email and record it on the signup row.
//
// Runs under ctx.waitUntil after the maxpass_signups insert, so it never
// delays or fails the customer's response: the signup is already saved, and
// a confirmation email is not worth turning a saved signup into an error.
//
// GATED by MAXPASS_CONFIRMATION_EMAIL ("on" to send). Default off so the
// switch from the "Get MaxPass from Supabase" Power Automate flow is ordered:
// that flow emails EVERY unsynced signup with an address, ignoring
// email_sent, so both running at once means two emails. Turn the flow OFF
// first (the whole flow -- its SharePoint copy is no longer needed), then set
// this "on". Signups in the gap: email_sent is not true and email <> ''.
//
// Dedup: source_id is the signup's confirmation_token, so a retried enqueue
// for the same signup is a no-op at the queue's unique index.
//
// email_sent / email_sent_at now mean "queued for delivery", not "Outlook
// accepted it". Delivery status lives on the outbound_emails row
// (source_kind 'maxpass-confirmation', source_id = confirmation_token), which
// /admin/email-queue shows.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import type { Env } from "../env.js";
import { renderMaxpassConfirmation, type ConfirmationInput } from "./confirmation.js";

export function confirmationEmailEnabled(env: Env): boolean {
  return (env.MAXPASS_CONFIRMATION_EMAIL ?? "").trim().toLowerCase() === "on";
}

export async function sendMaxpassConfirmation(
  env: Env,
  confirmationToken: string,
  recipient: string,
  input: ConfirmationInput
): Promise<void> {
  try {
    const email = renderMaxpassConfirmation(input);
    const result = await enqueueOutboundEmail(env, {
      source_worker: "signup-worker",
      source_kind: "maxpass-confirmation",
      source_id: confirmationToken,
      recipient,
      subject: email.subject,
      body_html: email.html,
      body_text: email.text
    });

    const url = new URL("/rest/v1/maxpass_signups", env.SUPABASE_URL);
    url.searchParams.set("confirmation_token", `eq.${confirmationToken}`);
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ email_sent: true, email_sent_at: new Date().toISOString() })
    });
    if (!res.ok) {
      // The email is queued and will send; only the flag on the signup lags.
      console.error(
        `[signup.confirmation] queued ${result.id} but email_sent PATCH failed: ${res.status} ${await res.text()}`
      );
    }
  } catch (err) {
    // Nothing queued. The signup row keeps email_sent = false, which is the
    // grep-able backlog: select ... where email_sent is not true and email <> ''.
    console.error(
      `[signup.confirmation] enqueue failed for ${confirmationToken}:`,
      err instanceof Error ? err.message : err
    );
  }
}
