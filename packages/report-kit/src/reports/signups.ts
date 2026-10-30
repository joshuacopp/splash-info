// MaxPass signups for one location (maxpass_signups). Pilot 2 for the kit.
//
// Scoping is NOT in here: the signup worker still decides who may read which
// location (adminGate + userCanAccessLocation). The definition only says what
// the report looks like, so the same file serves admins and site staff.
//
// Export columns are the pre-kit CSV's columns, in its order, with its headers
// (the raw column names). Changes from the old export: CRLF line endings, a
// UTF-8 BOM, formula-injection guarding, and Eastern date boundaries.
//
// The old export used select=* and listed `name` and `package`, NEITHER OF
// WHICH IS A COLUMN on maxpass_signups, so both were always blank. They stay
// in place so column positions don't shift for anyone reading by position:
// `package` now carries `package_code`; `name` stays blank (no name is
// collected). `is_bogo` and `recurring_start_date` (Brief 142) are appended
// at the end.

import { defineReport } from "../define";

export interface SignupsReportRow {
  id?: number | string;
  submitted_at: string;
  email: string | null;
  phone?: string | null;
  phone_formatted: string | null;
  location_code?: string | null;
  location_pretty?: string | null;
  package_code?: string | null;
  package_pretty: string | null;
  today_price: number | null;
  monthly_price?: number | null;
  terms_text?: string | null;
  country?: string | null;
  city: string | null;
  region: string | null;
  user_agent?: string | null;
  confirmation_token?: string | null;
  is_bogo?: boolean | null;
  recurring_start_date?: string | null;
}

/** Columns the JSON list selects. */
export const SIGNUPS_LIST_SELECT =
  "id,submitted_at,phone_formatted,email,package_pretty,today_price,city,region";

/** Columns the CSV selects. Real columns only; see the note on `name` above. */
export const SIGNUPS_EXPORT_SELECT = [
  "id", "submitted_at", "email", "phone", "phone_formatted", "location_code",
  "location_pretty", "package_code", "package_pretty", "today_price", "monthly_price",
  "terms_text", "country", "city", "region", "user_agent", "confirmation_token",
  "is_bogo", "recurring_start_date"
].join(",");

const EXPORT_ONLY = ["export"] as const;

export const signupsReport = defineReport<SignupsReportRow>({
  id: "signups",
  title: "Signups",
  defaultRange: "last_30",
  presets: ["today", "yesterday", "last_7", "last_30", "mtd", "past_month", "ytd"],
  filters: [],
  legacyDays: [1, 7, 30],
  rowKey: (r) => r.id != null ? String(r.id) : `${r.submitted_at}|${r.phone_formatted ?? ""}|${r.email ?? ""}`,
  columns: [
    { id: "id", label: "ID", kind: "text", in: EXPORT_ONLY },
    { id: "submitted_at", label: "Submitted", kind: "datetime" },
    { id: "name", label: "Name", kind: "text", in: EXPORT_ONLY, get: () => null },
    { id: "email", label: "Email", kind: "email" },
    { id: "phone", label: "Phone (raw)", kind: "text", in: EXPORT_ONLY },
    { id: "phone_formatted", label: "Phone", kind: "text" },
    { id: "location_code", label: "Location code", kind: "text", in: EXPORT_ONLY },
    { id: "location_pretty", label: "Location", kind: "text", in: EXPORT_ONLY },
    { id: "package", label: "Package code", kind: "text", in: EXPORT_ONLY, get: (r) => r.package_code },
    { id: "package_pretty", label: "Package", kind: "text" },
    { id: "today_price", label: "Price today", kind: "currency" },
    { id: "monthly_price", label: "Monthly price", kind: "currency", in: EXPORT_ONLY },
    { id: "terms_text", label: "Terms", kind: "text", in: EXPORT_ONLY },
    { id: "country", label: "Country", kind: "text", in: EXPORT_ONLY },
    { id: "city", label: "City", kind: "text" },
    { id: "region", label: "Region", kind: "text" },
    { id: "user_agent", label: "User agent", kind: "text", in: EXPORT_ONLY },
    { id: "confirmation_token", label: "Confirmation token", kind: "text", in: EXPORT_ONLY },
    { id: "is_bogo", label: "BOGO", kind: "boolean", in: EXPORT_ONLY },
    { id: "recurring_start_date", label: "Recurring starts", kind: "date", in: EXPORT_ONLY }
  ]
});

/** `signups-{loc}-{from}-to-{to}.csv`, the pre-kit filename with Eastern dates. */
export function signupsCsvFilename(locationCode: string, fromYmd: string, toYmd: string): string {
  return `signups-${locationCode}-${fromYmd}-to-${toYmd}.csv`;
}
