// Fleet inquiries (fleet_submissions). Pilot report for the kit.
//
// Export columns are the pre-kit CSV's columns, in its order, with its
// headers (the raw column names), so anyone with a spreadsheet built on the
// old export keeps working. Changes from the old export: CRLF line endings,
// a UTF-8 BOM, formula-injection guarding, and Eastern date boundaries.

import { defineReport } from "../define";

export interface FleetReportRow {
  id: string | number;
  submitted_at: string;
  company: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  location_code: string | null;
  location_pretty: string | null;
  service_type: string | null;
  packages: string | null;
  packages_detail: unknown;
  detailing_requested: boolean | null;
  detailing_location_code: string | null;
  detailing_location_pretty: string | null;
  number_of_vehicles: number | null;
  anticipated_washes_per_month: number | null;
  ip_address: string | null;
  user_agent: string | null;
  status: string | null;
  splash_notes: string | null;
}

const EXPORT_ONLY = ["export"] as const;

export const fleetReport = defineReport<FleetReportRow>({
  id: "fleet-submissions",
  title: "Fleet Inquiries",
  defaultRange: "last_30",
  presets: ["last_7", "last_30", "mtd", "past_month", "ytd"],
  filters: [],
  rowKey: (r) => String(r.id),
  columns: [
    { id: "id", label: "ID", kind: "text", in: EXPORT_ONLY },
    { id: "submitted_at", label: "Submitted", kind: "datetime" },
    { id: "company", label: "Company", kind: "text", in: EXPORT_ONLY },
    { id: "name", label: "Contact", kind: "text" },
    { id: "phone", label: "Phone", kind: "phone" },
    { id: "email", label: "Email", kind: "email" },
    { id: "address", label: "Address", kind: "text", in: EXPORT_ONLY },
    { id: "location_code", label: "Location code", kind: "text", in: EXPORT_ONLY },
    {
      id: "location_pretty",
      label: "Location",
      kind: "text",
      get: (r) => r.location_pretty ?? r.location_code
    },
    { id: "service_type", label: "Service type", kind: "text", in: EXPORT_ONLY },
    { id: "packages", label: "Packages", kind: "text", in: EXPORT_ONLY },
    { id: "packages_detail", label: "Packages detail", kind: "json", in: EXPORT_ONLY },
    { id: "detailing_requested", label: "Detailing", kind: "boolean", in: EXPORT_ONLY },
    { id: "detailing_location_code", label: "Detailing location code", kind: "text", in: EXPORT_ONLY },
    { id: "detailing_location_pretty", label: "Detailing location", kind: "text", in: EXPORT_ONLY },
    { id: "number_of_vehicles", label: "Vehicles", kind: "number" },
    { id: "anticipated_washes_per_month", label: "Washes / month", kind: "number", in: EXPORT_ONLY },
    { id: "ip_address", label: "IP address", kind: "text", in: EXPORT_ONLY },
    { id: "user_agent", label: "User agent", kind: "text", in: EXPORT_ONLY },
    { id: "status", label: "Status", kind: "enum" },
    { id: "splash_notes", label: "Splash notes", kind: "text", in: EXPORT_ONLY }
  ]
});
