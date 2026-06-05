// Brief 158a — vertical timeline of promo_activity_log entries.
//
// Renders the latest 20 entries from `promo.activity` (worker caps via
// `activity.limit=20` per Brief 154). Per-entry-type icon + headline +
// muted relative timestamp. Free-form `details` JSONB is rendered for a
// few known activity types with structured copy; everything else falls
// through to a generic "{actor} {activityType.replace('_', ' ')}" line.
//
// Activity-type values (mirrors the table CHECK constraint enumerated
// in CLAUDE.md / Brief 154/155/156/157):
//   created                       (Brief 154)
//   ticket_updated                (Brief 155)
//   roadblocks_updated            (Brief 155)
//   internal_note_updated         (Brief 155 — IT only)
//   status_changed                (Brief 155 — incl. auto-advance)
//   assignment_changed            (Brief 155)
//   location_marked_complete      (Brief 155)
//   location_marked_incomplete    (Brief 155)
//   material_added                (Brief 156)
//   material_removed              (Brief 156)
//   ptp_updated                   (Brief 156)
//   announcement_sent             (Brief 157)

import type { PromoActivityEntry } from "../_lib/types";
import { shortenUserId } from "../_lib/user-lookup";
import { formatEst } from "../../jotform/_lib/format-est";

interface Props {
  entries: PromoActivityEntry[];
}

interface DetailsBag {
  // Common — narrow per-type below.
  fields?: string[];
  from?: string;
  to?: string;
  auto?: boolean;
  trigger?: string;
  userId?: string;
  action?: string;
  assignedByEmail?: string;
  removedByEmail?: string;
  locationCode?: string;
  name?: string;
  kind?: string;
  materialId?: string;
  sizeBytes?: number;
  announcementId?: string;
  recipientCount?: number;
  enqueuedCount?: number;
  failedRecipientCount?: number;
  materialCount?: number;
  includedPtp?: boolean;
  subject?: string;
  title?: string;
  locationCount?: number;
  promoType?: string;
  priority?: string;
}

function safeDetails(details: unknown): DetailsBag {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as DetailsBag;
  }
  return {};
}

function renderHeadline(entry: PromoActivityEntry): string {
  const d = safeDetails(entry.details);
  switch (entry.activityType) {
    case "created":
      return d.title
        ? `Created — “${d.title}”`
        : "Created";
    case "ticket_updated": {
      const fields = d.fields?.join(", ");
      return fields ? `Ticket updated (${fields})` : "Ticket updated";
    }
    case "roadblocks_updated":
      return "Roadblocks updated";
    case "internal_note_updated":
      return "Internal note updated";
    case "status_changed": {
      const auto = d.auto ? " (auto)" : "";
      const transition =
        d.from && d.to ? ` — ${d.from} → ${d.to}` : "";
      return `Status changed${transition}${auto}`;
    }
    case "assignment_changed": {
      const action = d.action ?? "changed";
      const who =
        d.assignedByEmail ?? d.removedByEmail ?? d.userId ?? "";
      return who
        ? `Assignment ${action} — ${who}`
        : `Assignment ${action}`;
    }
    case "location_marked_complete":
      return d.locationCode
        ? `Marked complete — ${d.locationCode}`
        : "Marked complete";
    case "location_marked_incomplete":
      return d.locationCode
        ? `Marked incomplete — ${d.locationCode}`
        : "Marked incomplete";
    case "material_added":
      return d.name
        ? `Material added — ${d.name}${d.kind ? ` (${d.kind})` : ""}`
        : "Material added";
    case "material_removed":
      return d.name ? `Material removed — ${d.name}` : "Material removed";
    case "ptp_updated": {
      const fields = d.fields?.join(", ");
      return fields ? `PTP updated (${fields})` : "PTP updated";
    }
    case "announcement_sent": {
      const subj = d.subject ? ` — “${d.subject}”` : "";
      const sentTo = d.recipientCount != null ? ` (${d.recipientCount})` : "";
      return `Announcement sent${subj}${sentTo}`;
    }
    default:
      return entry.activityType.replace(/_/g, " ");
  }
}

function ActivityDot({ type }: { type: string }) {
  // Single color tier per category. Tailwind classes inline so we can
  // statically extract them.
  let cls = "bg-splash-navy/30";
  if (type.startsWith("status_")) cls = "bg-splash-blue";
  else if (type.startsWith("assignment_")) cls = "bg-sudsy-blue";
  else if (type.startsWith("location_")) cls = "bg-emerald-500";
  else if (type.startsWith("material_")) cls = "bg-amber-500";
  else if (type === "ptp_updated") cls = "bg-teal-500";
  else if (type === "announcement_sent") cls = "bg-racecar-red";
  else if (type === "created") cls = "bg-splash-navy";
  return (
    <span
      aria-hidden="true"
      className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${cls}`}
    />
  );
}

export function ActivityTimeline({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <p className="text-sm italic text-splash-navy/60">
        No activity yet.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => {
        const ts = formatEst(entry.createdAt);
        const actorLabel = entry.actorUserId
          ? shortenUserId(entry.actorUserId)
          : "system";
        return (
          <li key={entry.id} className="flex items-start gap-3">
            <ActivityDot type={entry.activityType} />
            <div className="flex-1">
              <p className="text-sm text-splash-navy">
                {renderHeadline(entry)}
              </p>
              <p className="text-xs text-splash-navy/55">
                by {actorLabel} ·{" "}
                <span title={entry.createdAt}>{ts.relative || ts.absolute}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default ActivityTimeline;
