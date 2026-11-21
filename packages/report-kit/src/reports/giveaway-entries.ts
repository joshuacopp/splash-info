// Giveaway entries (giveaway_entries, supabase/giveaways-01.sql). One table +
// CSV per giveaway on /admin/giveaways/{id}. Not date-ranged: a giveaway's
// entries are the whole list, so the range fields below are unused defaults.
//
// Every entry column is listed even when a giveaway turned that field off, so
// a CSV's columns are the same for every giveaway (empty where not collected).

import { defineReport } from "../define";

/** As the worker returns it. Phone is 10 digits, plate upper-case [A-Z0-9]. */
export interface GiveawayEntryRow {
  id: string;
  created_at: string;
  site_number: number | null;
  site_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  plate: string | null;
  barcode: string | null;
  sms_consent: boolean;
}

export const giveawayEntriesReport = defineReport<GiveawayEntryRow>({
  id: "giveaway-entries",
  title: "Giveaway Entries",
  defaultRange: "ytd",
  presets: [],
  filters: [],
  rowKey: (r) => r.id,
  columns: [
    { id: "created_at", label: "Entered", kind: "datetime" },
    { id: "site_name", label: "Site", kind: "text" },
    { id: "site_number", label: "Site #", kind: "number", in: ["export"] },
    { id: "name", label: "Name", kind: "text" },
    { id: "email", label: "Email", kind: "email" },
    { id: "phone", label: "Phone", kind: "phone" },
    { id: "plate", label: "Plate", kind: "text" },
    { id: "barcode", label: "Barcode", kind: "text" },
    { id: "sms_consent", label: "Texts OK", kind: "boolean", csvLabel: "sms_opt_in" }
  ]
});

/** "giveaway-entries-bills-tickets-2026-11-20.csv" */
export function giveawayEntriesFilename(title: string, todayYmd: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "giveaway";
  return `giveaway-entries-${slug}-${todayYmd}.csv`;
}
