// Form digests (2026-11-14) -- scheduled summary emails configured per form
// from the "Digests" tab on /admin/forms/{id}, instead of a custom build per
// form. One row in `public.form_digests` per digest; the forms-worker cron
// sends each one when it is due (src/digests/).
//
// SELF-CONTAINED ON PURPOSE: this module imports nothing relative, so apps/web
// can import its runtime values (labels, defaults, the validator) through the
// `@splash/forms-schema/digest` subpath. The package root uses `.js`
// specifiers that Next's webpack cannot resolve -- see CLAUDE.md, "Price
// change approval form".

import { z } from "zod";

// --- schedule ----------------------------------------------------------------

export type DigestFrequency = "daily" | "weekly" | "monthly";

/**
 * When a digest goes out, in EASTERN wall-clock time (every site is Eastern).
 *
 * The period it covers is the one that just ENDED:
 *   daily   -- yesterday
 *   weekly  -- the 7 days ending yesterday (sent Monday = last Mon-Sun)
 *   monthly -- last calendar month
 */
export interface DigestSchedule {
  frequency: DigestFrequency;
  /** 0-23, Eastern. */
  hour: number;
  /** Weekly only. 1 = Monday ... 7 = Sunday (ISO). */
  weekday?: number;
  /** Monthly only. 1-28, so every month has the day. */
  monthday?: number;
}

// --- recipients ----------------------------------------------------------------

/** Per-site contact roles, read from pricing_simple (and locations for HRT). */
export type DigestSiteRole = "site_email" | "rm_email" | "am_email" | "hrt_email";

export const DIGEST_SITE_ROLE_LABELS: Record<DigestSiteRole, string> = {
  site_email: "Each site (site email)",
  rm_email: "Regional managers",
  am_email: "Regional directors",
  hrt_email: "HRTs"
};

/**
 * Who receives it.
 *
 * site_role -- each person holding that role at any site, and EACH ONE SEES
 *   ONLY THE SITES THEY HOLD IT FOR: a site sees itself, an RM their sites,
 *   an RD their region. The scoping is the point; it is why this is not just
 *   a mailing list.
 * static    -- named people, who see EVERY site.
 *
 * Someone matched more than once (an RM who is also on the static list) gets
 * one email covering the union of their sites.
 */
export type DigestRecipient =
  | { type: "site_role"; role: DigestSiteRole }
  | { type: "static"; emails: string[] };

// --- content ---------------------------------------------------------------------

/** A number to report. `field_key` names a numeric short-text field. */
export interface DigestMetric {
  agg: "count" | "sum" | "avg";
  field_key?: string;
}

/**
 * The x axis / grouping of a chart.
 *   day | week | month -- time buckets over the period, Eastern
 *   site               -- one bucket per site
 *   field:{key}        -- one bucket per answer of a choice field
 *                         (radio / dropdown / multi; a multi answer counts
 *                         in each bucket it ticks)
 */
export type DigestDimension = "day" | "week" | "month" | "site" | `field:${string}`;

export type DigestChartType = "bar" | "line" | "pie";

export interface DigestChart {
  type: DigestChartType;
  title?: string;
  x: DigestDimension;
  y: DigestMetric;
  /** Optional series split (stacked bars / one line per value). Not for pie. */
  split?: DigestDimension | null;
}

/**
 * The table under the charts.
 *   none    -- charts only
 *   summary -- one row per group with a column per metric
 *   rows    -- every submission, with the chosen fields, grouped by site
 */
export interface DigestTable {
  kind: "none" | "summary" | "rows";
  /** summary: how rows are grouped. */
  group?: "site" | "site_day" | "day";
  /** summary: the columns. */
  metrics?: DigestMetric[];
  /** rows: field keys shown as columns, in order. */
  fields?: string[];
}

export interface DigestConfig {
  schedule: DigestSchedule;
  recipients: DigestRecipient[];
  charts: DigestChart[];
  table: DigestTable;
  /** Don't send a recipient an email with nothing in it. Default true. */
  skip_if_empty: boolean;
}

/** A row of public.form_digests as the admin API returns it. */
export interface FormDigest {
  id: string;
  form_id: string;
  name: string;
  enabled: boolean;
  config: DigestConfig;
  last_sent_at: string | null;
  last_period: string | null;
  created_at: string;
  updated_at: string;
}

export const DIGEST_LIMITS = { charts: 4, metrics: 4, rowFields: 8, staticEmails: 25 } as const;

export function defaultDigestConfig(): DigestConfig {
  return {
    schedule: { frequency: "weekly", hour: 7, weekday: 1 },
    recipients: [{ type: "site_role", role: "rm_email" }],
    charts: [],
    table: { kind: "summary", group: "site", metrics: [{ agg: "count" }] },
    skip_if_empty: true
  };
}

// --- validation ---------------------------------------------------------------------

const metricSchema = z
  .object({
    agg: z.enum(["count", "sum", "avg"]),
    field_key: z.string().min(1).optional()
  })
  .strict()
  .refine((m) => m.agg === "count" || !!m.field_key, {
    message: "Sum and average need a number field"
  });

const dimensionSchema = z
  .string()
  .refine((d) => ["day", "week", "month", "site"].includes(d) || /^field:[a-z][a-z0-9_]*$/.test(d), {
    message: "Unknown grouping"
  }) as z.ZodType<DigestDimension>;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const digestConfigSchema = z
  .object({
    schedule: z
      .object({
        frequency: z.enum(["daily", "weekly", "monthly"]),
        hour: z.number().int().min(0).max(23),
        weekday: z.number().int().min(1).max(7).optional(),
        monthday: z.number().int().min(1).max(28).optional()
      })
      .strict()
      .refine((s) => s.frequency !== "weekly" || s.weekday != null, { message: "Pick a day of the week" })
      .refine((s) => s.frequency !== "monthly" || s.monthday != null, { message: "Pick a day of the month" }),
    recipients: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("site_role"), role: z.enum(["site_email", "rm_email", "am_email", "hrt_email"]) }).strict(),
          z
            .object({
              type: z.literal("static"),
              emails: z.array(z.string().trim().regex(EMAIL_RE, "Invalid email")).max(DIGEST_LIMITS.staticEmails)
            })
            .strict()
        ])
      )
      .min(1, "Add at least one recipient"),
    charts: z
      .array(
        z
          .object({
            type: z.enum(["bar", "line", "pie"]),
            title: z.string().max(120).optional(),
            x: dimensionSchema,
            y: metricSchema,
            split: dimensionSchema.nullable().optional()
          })
          .strict()
          .refine((c) => !(c.type === "pie" && c.split), { message: "A pie chart can't be split" })
          .refine((c) => !c.split || c.split !== c.x, { message: "Split by something other than the x axis" })
      )
      .max(DIGEST_LIMITS.charts),
    table: z
      .object({
        kind: z.enum(["none", "summary", "rows"]),
        group: z.enum(["site", "site_day", "day"]).optional(),
        metrics: z.array(metricSchema).max(DIGEST_LIMITS.metrics).optional(),
        fields: z.array(z.string().min(1)).max(DIGEST_LIMITS.rowFields).optional()
      })
      .strict(),
    skip_if_empty: z.boolean()
  })
  .strict()
  .refine((c) => c.charts.length > 0 || c.table.kind !== "none", {
    message: "Add a chart or a table -- otherwise the email is empty"
  });

// --- shared display helpers ---------------------------------------------------------

export const WEEKDAY_LABELS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function hourLabel(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm}`;
}

/** "Weekly, Monday 7:00 AM" */
export function describeSchedule(s: DigestSchedule): string {
  if (s.frequency === "daily") return `Daily, ${hourLabel(s.hour)}`;
  if (s.frequency === "weekly") return `Weekly, ${WEEKDAY_LABELS[s.weekday ?? 1]} ${hourLabel(s.hour)}`;
  return `Monthly, day ${s.monthday ?? 1} ${hourLabel(s.hour)}`;
}
