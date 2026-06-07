// Brief 158a — TypeScript shapes for the promo-worker wire responses.
//
// Mirrors the camelCase payloads emitted by apps/promo-worker handlers
// (Brief 154 list/create/detail; Brief 156 materials + PTP; Brief 157
// announcements). Keep this file in sync with the worker response shapes
// — adding a new field on the worker side requires touching this file too.
//
// `PromoRole` is re-exported from `@splash/types/promo` (Brief 153). The
// rest of the discriminated unions are local because the worker is the
// single source of truth — they aren't shared symmetrically across more
// than one consumer.

import type { PromoRole } from "@splash/types/promo";

export type { PromoRole };

export type PromoStatus =
  | "Submitted"
  | "Scoped"
  | "Building"
  | "Tested"
  | "Live"
  | "Ended";

export type PromoPriority = "High" | "Medium" | "Low";

export type PromoType = "Same" | "BOGO" | "Add-ons" | "Discount" | "Other";

export const PROMO_STATUSES: readonly PromoStatus[] = [
  "Submitted",
  "Scoped",
  "Building",
  "Tested",
  "Live",
  "Ended"
];

export const PROMO_PRIORITIES: readonly PromoPriority[] = [
  "High",
  "Medium",
  "Low"
];

// ---------------------------------------------------------------------------
// List response (Brief 154)
// ---------------------------------------------------------------------------

export interface PromoListItem {
  id: string;
  title: string;
  promoType: PromoType;
  priority: PromoPriority;
  status: PromoStatus;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  createdAt: string;
  updatedAt: string;
  readyByDate: string | null;
  locationCount: number;
  locationCodes: string[];
  assigneeCount: number;
  completedLocationCount: number;
}

export interface PromoListResponse {
  promos: PromoListItem[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Detail response (Brief 154 + 155 + 156 + 157)
// ---------------------------------------------------------------------------

export interface PromoTicketAssignee {
  userId: string;
  assignedAt: string;
  assignedBy: string | null;
}

export interface PromoTicket {
  readyByDate: string | null;
  roadblocks: string | null;
  /** Present only when caller is super_admin | it (worker strips for others). */
  internalNote?: string | null;
  createdAt: string;
  updatedAt: string;
  readyByUpdatedAt: string | null;
  readyByUpdatedBy: string | null;
  assignees: PromoTicketAssignee[];
}

export interface PromoLocation {
  locationCode: string;
  isComplete: boolean;
  completedAt: string | null;
  completedBy: string | null;
  /** Brief 164 — when the per-site "IT changes are live" email was sent.
   *  NULL = never notified. Eligible for the FAB-driven notification fire
   *  iff `isComplete === true && notifiedAt === null`. */
  notifiedAt: string | null;
  /** Brief 164 — which IT user fired the per-site notification. */
  notifiedBy: string | null;
}

export interface PromoMaterial {
  id: string;
  name: string;
  kind: string;
  r2Key: string;
  fileMime: string | null;
  fileSizeBytes: number | null;
  uploadedAt: string;
  uploadedBy: string;
}

export interface PromoPtp {
  purpose: string;
  tools: string;
  process: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface PromoActivityEntry {
  id: string;
  actorUserId: string | null;
  activityType: string;
  details: unknown;
  createdAt: string;
}

export interface PromoAnnouncement {
  id: string;
  sentAt: string;
  sentBy: string;
  subject: string;
  bodyText: string;
  recipientEmails: string[];
  includedMaterialIds: string[];
  includedPtp: boolean;
}

export interface PromoDetail {
  id: string;
  title: string;
  promoType: PromoType;
  posBehavior: string | null;
  proposedStartDate: string;
  proposedEndDate: string;
  requestedGoLiveDate: string;
  priority: PromoPriority;
  status: PromoStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  statusUpdatedAt: string | null;
  statusUpdatedBy: string | null;
  ticket: PromoTicket | null;
  locations: PromoLocation[];
  materials: PromoMaterial[];
  ptp: PromoPtp | null;
  activity: PromoActivityEntry[];
  announcements: PromoAnnouncement[];
}

export interface PromoDetailResponse {
  promo: PromoDetail;
}
