// Signup-flow types — covers maxpass_signups, suspicious_phones, phone_usage_log.
// Column names extracted directly from legacy/signupworker.js.

/**
 * Row inserted into `maxpass_signups` on a successful signup.
 *
 * Source: legacy/signupworker.js:392-420 (handleSignupSubmission insert body).
 *
 * `email_sent` and `email_sent_at` exist per gotcha #267 but are written by
 * Power Automate, not by the worker — included as optional readbacks.
 */
export interface MaxpassSignupRow {
  /** UUID generated client-side via crypto.randomUUID — also primary correlation token for SharePoint. */
  confirmation_token: string;
  location_code: string;
  location_pretty: string;
  package_code: string;
  package_pretty: string;
  /** Today's price at the moment of signup (already-resolved number). */
  today_price: number;
  /** Monthly recurring price. */
  monthly_price: number;
  /** 10-digit phone, no formatting. */
  phone: string;
  /** Display-formatted phone, e.g. "607-768-5674". */
  phone_formatted: string;
  /** Full terms text snapshot at signup time. */
  terms_text: string;
  /** Whether the user clicked the agree checkbox. */
  terms_agreed: boolean;
  /** ISO timestamp client-supplied. */
  submitted_at: string;
  ip_address: string;
  user_agent: string;
  country: string;
  city: string;
  region: string;
  email: string | null;
  /** Set by Power Automate after the confirmation email goes out. */
  email_sent?: boolean | null;
  email_sent_at?: string | null;
}

/**
 * Insert payload — distinguishes columns the worker writes (everything above
 * minus the email_sent_* pair) from full row reads.
 */
export type MaxpassSignupInsert = Omit<MaxpassSignupRow, "email_sent" | "email_sent_at">;

/* ============================================================
 * Fraud detection — suspicious_phones + phone_usage_log
 * ============================================================ */

/**
 * Tier values written by the worker. Source: legacy/signupworker.js:268-371.
 *
 *   - "Deny"    : manually flagged, blocks all signup attempts immediately
 *   - "Warn"    : 3rd-9th use of a phone, shows warning modal but allows confirm
 *   - "Monitor" : 10th+ use, shows stronger modal but still allows confirm
 */
export type SuspiciousPhoneTier = "Deny" | "Warn" | "Monitor";

/**
 * Row shape of `suspicious_phones`.
 *
 * Source: live Supabase schema (authoritative — communicated 2026-05-02).
 * Legacy/signupworker.js:461-466 only reads/writes a subset (phone, tier,
 * usage_count, last_seen, updated_at) — the additional columns below are
 * real and used by admin tooling / seed rows.
 *
 * SECURITY: `manually_flagged = true` rows are admin entries (hardcoded
 * Deny patterns: '0000000000', '0987654321', '1111111111', '1234567890', etc.).
 * Auto-detection / tier escalation should ONLY mutate rows where
 * `manually_flagged = false`. Worker port must preserve this distinction.
 *
 * KNOWN LEGACY BUG (do not silently fix during port — flag separately):
 * legacy createOrUpdateSuspicious does NOT filter on manually_flagged
 * before its PATCH, so an auto-tier-escalation against a manually-flagged
 * Deny row could overwrite admin-set tier/count. See @splash/db-supabase
 * createOrUpdateSuspicious — preserves legacy behavior.
 */
export interface SuspiciousPhoneRow {
  id: number;
  phone: string;
  tier: SuspiciousPhoneTier;
  usage_count: number;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  /** Freeform note describing the deny pattern (admin rows only). */
  notes: string | null;
  /** True for admin / seed rows; false for auto-detected rows. */
  manually_flagged: boolean;
}

/**
 * Action recorded in phone_usage_log.action_taken.
 * Source: legacy/signupworker.js usage of logUsage(...).
 */
export type PhoneUsageAction = "blocked" | "warned" | "flagged" | "allowed";

/**
 * What the user did when shown a Warn or Monitor modal.
 * Source: legacy/signupworker.js:432.
 */
export type PhoneUsageUserResponse =
  | "blocked"
  | "warn_confirmed"
  | "monitor_confirmed"
  | "submitted"
  | null;

/**
 * Row shape of phone_usage_log.
 *
 * Source: live Supabase schema (authoritative — communicated 2026-05-02).
 * Legacy/signupworker.js:564-575 logUsage payload covers all columns except
 * `id` (auto PK) and `user_agent` (null in legacy writes).
 *
 * Production typos preserved: `location_code` may carry "rensselear"
 * (sic) — Power Automate / JotForm location lookups depend on the typo'd
 * spelling. Do NOT normalize.
 *
 * `user_agent` is null in legacy-written rows because legacy doesn't pass
 * the User-Agent header through to the log. The new worker SHOULD populate
 * it going forward — useful for fraud forensics. See worker code.
 */
export interface PhoneUsageLogRow {
  id: number;
  phone: string;
  phone_formatted: string;
  /** What the count would be after this submission (1-indexed). */
  usage_count_at_time: number;
  location_code: string | null;
  location_pretty: string | null;
  /** null when the user wasn't in a tier (allowed first-time signup). */
  tier: SuspiciousPhoneTier | null;
  action_taken: PhoneUsageAction;
  user_response: PhoneUsageUserResponse;
  ip_address: string;
  /** User-Agent header at signup time. Null in legacy rows; new worker
   *  populates for forensics. */
  user_agent: string | null;
  timestamp: string;
}
