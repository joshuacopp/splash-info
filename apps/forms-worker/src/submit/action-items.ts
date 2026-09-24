// Brief 176 — turn ticked questions into action_items rows.
//
// Runs once per fresh submission, after the row lands and `location_code` is
// resolved. Reads `payload._action_items` (written by parse.ts from the
// schema, not from the form data) and inserts one row per ticked question.
//
// FAIL-SOFT ON PURPOSE. A failure here must not reverse the submission: losing
// a 73-question site visit is far worse than losing rows that can be rebuilt,
// and they can ALWAYS be rebuilt, because the ticks live in the payload. This
// table is a materialization of the submission, not the source of truth.
//
// DEFAULTS, because fill-time is tick-only (Brief 176 operator decision). The
// RM taps a box while walking a property; describing, prioritising and dating
// the item happens afterwards on the action items page, where there is a
// keyboard.

import {
  ACTION_ITEM_PAYLOAD_KEY,
  type Field,
  type FormSchema
} from "@splash/forms-schema";
import type { Env } from "../index.js";

/** Days from submission to the default due date. Deliberately generous: it is
 *  a placeholder the RM adjusts, and a default that is already overdue trains
 *  people to ignore the due date entirely. */
const DEFAULT_DUE_DAYS = 14;

/** Matches the DB check constraint. Worker-side too so an over-long label
 *  truncates rather than 400-ing the whole batch. */
const DESCRIPTION_MAX = 5000;

export interface ActionItemInsertResult {
  attempted: number;
  inserted: number;
  error: string | null;
}

/**
 * Due date in EASTERN, not UTC. `due_date` is a DATE — a calendar day at the
 * site — so deriving it from a UTC instant shifts it a day for anything
 * submitted after 8pm ET. Mirrors the two-pass offset resolution in
 * workorders-worker's eastern-time.ts, kept local because forms-worker has no
 * dependency on that package and one date helper does not justify one.
 */
export function easternDuePlusDays(at: Date, days: number): string {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  const y = Number(parts.get("year"));
  const m = Number(parts.get("month"));
  const d = Number(parts.get("day"));
  // Arithmetic on a UTC-midnight anchor of the Eastern calendar date: adding
  // days to a date has no DST hazard once the date itself is correct.
  const anchor = new Date(Date.UTC(y, m - 1, d));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** One line of context for the item, from whatever the question was answered
 *  with. Objects (file / signature refs) have no useful one-line form, so they
 *  contribute nothing rather than "[object Object]".
 *
 *  Choice fields store the option VALUE ("fail"); this renders the LABEL
 *  ("Fail"), because the snapshot is denormalized and permanent -- it is read
 *  by a site weeks later with no access to the option table, and every other
 *  surface in the codebase maps value to label before showing it. */
function snapshotOf(value: unknown, field?: Field): string | null {
  const labelFor = (v: string): string => {
    if (
      field &&
      (field.type === "radio" || field.type === "dropdown" || field.type === "multi")
    ) {
      return field.options.find((o) => o.value === v)?.label ?? v;
    }
    return v;
  };
  if (value == null || value === "") return null;
  if (typeof value === "string") return labelFor(value).slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const flat = (value.filter((v) => typeof v === "string") as string[]).map(labelFor);
    return flat.length > 0 ? flat.join(", ").slice(0, 500) : null;
  }
  return null;
}

export async function createActionItemsForSubmission(
  env: Env,
  args: {
    submissionId: string;
    locationCode: string | null;
    schema: FormSchema;
    payload: Record<string, unknown>;
    submittedAt: Date;
    createdBy: string | null;
  }
): Promise<ActionItemInsertResult> {
  const raw = args.payload[ACTION_ITEM_PAYLOAD_KEY];
  const ticked = Array.isArray(raw)
    ? (raw.filter((k) => typeof k === "string") as string[])
    : [];
  if (ticked.length === 0) return { attempted: 0, inserted: 0, error: null };

  // An action item with no site is unreachable: every read path filters by
  // location. Better to refuse loudly than to write orphans nobody can see.
  if (!args.locationCode) {
    const error = "submission has no location_code; action items need a site";
    console.error(`[forms.action-items] ${error} (submission=${args.submissionId})`);
    return { attempted: ticked.length, inserted: 0, error };
  }

  const dueDate = easternDuePlusDays(args.submittedAt, DEFAULT_DUE_DAYS);
  const byKey = new Map(args.schema.fields.map((f) => [f.key, f]));

  const rows = ticked.flatMap((key) => {
    const field = byKey.get(key);
    // The tick came from the schema, so this should not miss. If it somehow
    // does, skip rather than inventing a label for a question nobody asked.
    if (!field) {
      console.error(`[forms.action-items] ticked key "${key}" not in schema`);
      return [];
    }
    const label = (field.label || key).slice(0, DESCRIPTION_MAX);
    return [
      {
        submission_id: args.submissionId,
        location_code: args.locationCode,
        field_key: key,
        question_label: label,
        answer_snapshot: snapshotOf(args.payload[key], field),
        // Seeded from the question. The RM renames it on the page if the
        // question label is not the right description of the work.
        description: label,
        priority: "Medium",
        due_date: dueDate,
        status: "open",
        created_by: args.createdBy
      }
    ];
  });

  if (rows.length === 0) return { attempted: ticked.length, inserted: 0, error: null };

  try {
    const url = new URL("/rest/v1/action_items", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `${resp.status}: ${text.slice(0, 200)}`;
      console.error(`[forms.action-items] insert failed ${error}`);
      return { attempted: ticked.length, inserted: 0, error };
    }
    console.log(
      `[forms.action-items] created ${rows.length} for submission=${args.submissionId} location=${args.locationCode}`
    );
    return { attempted: ticked.length, inserted: rows.length, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[forms.action-items] insert threw", err);
    return { attempted: ticked.length, inserted: 0, error };
  }
}
