// Digest sending: who gets what, the cron entry point, "send me a test", and
// the builder's live preview. All three build from the same functions so the
// preview cannot disagree with what is mailed.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import type { DigestConfig, FormDigest } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { chartData, tableData, type AggregateContext, type ChartData, type DigestSubmission, type TableData } from "./aggregate.js";
import {
  claimRun,
  finishRun,
  listDigests,
  loadDigestForm,
  loadSites,
  loadSubmissions,
  updateDigest,
  type DigestForm,
  type SiteContacts
} from "./data.js";
import { duePeriod, easternNow, periodFor, type DigestPeriod } from "./period.js";
import { bytesToBase64, renderDigestEmail } from "./render-email.js";
import { resolveAudiences, scopeLabel, scopeSubs, type Audience } from "./audience.js";

const SOURCE_WORKER = "forms";

// --- one digest, one period ------------------------------------------------------

interface Prepared {
  form: DigestForm;
  period: DigestPeriod;
  subs: DigestSubmission[];
  capped: boolean;
  sites: Map<string, SiteContacts>;
  ctx: AggregateContext;
}

async function prepare(env: Env, formId: string, period: DigestPeriod): Promise<Prepared | null> {
  const [form, sites] = await Promise.all([loadDigestForm(env, formId), loadSites(env)]);
  if (!form) return null;
  const { subs, capped } = await loadSubmissions(env, formId, period.fromUtc, period.toUtcExclusive);
  return { form, period, subs, capped, sites, ctx: { fields: form.fields, sites, period } };
}

function submissionsUrl(formId: string): string {
  return `https://splashcarwashes.info/admin/forms/${encodeURIComponent(formId)}/submissions`;
}

async function buildEmail(p: Prepared, digest: { name: string; config: DigestConfig }, aud: Audience["sites"]) {
  const subs = scopeSubs(p.subs, aud);
  return {
    count: subs.length,
    email: await renderDigestEmail({
      formTitle: p.form.title,
      digestName: digest.name,
      periodLabel: p.period.label,
      scopeLabel: scopeLabel(aud, p.sites),
      total: subs.length,
      charts: digest.config.charts.map((c) => chartData(p.ctx, subs, c)),
      table: tableData(p.ctx, subs, digest.config.table),
      capped: p.capped,
      submissionsUrl: submissionsUrl(p.form.id)
    })
  };
}

async function enqueue(
  env: Env,
  sourceKind: string,
  sourceId: string,
  recipient: string,
  e: Awaited<ReturnType<typeof renderDigestEmail>>
) {
  await enqueueOutboundEmail(env, {
    source_worker: SOURCE_WORKER,
    source_kind: sourceKind,
    source_id: sourceId,
    recipient,
    subject: e.subject,
    body_html: e.html,
    body_text: e.text,
    attachments: e.images.map((img) => ({
      filename: img.filename,
      mime: "image/png",
      size_bytes: img.png.byteLength,
      base64: bytesToBase64(img.png),
      is_inline: true,
      content_id: img.contentId
    }))
  });
}

/** Send one digest for one period to everyone it reaches. */
export async function sendDigest(env: Env, digest: FormDigest, period: DigestPeriod): Promise<{ sent: number; skipped: number }> {
  const p = await prepare(env, digest.form_id, period);
  if (!p) return { sent: 0, skipped: 0 };
  let sent = 0;
  let skipped = 0;
  for (const aud of resolveAudiences(digest.config, p.sites)) {
    try {
      // Check before drawing: most sites have nothing on most days, and a
      // chart render is the expensive part.
      if (digest.config.skip_if_empty && scopeSubs(p.subs, aud.sites).length === 0) {
        skipped += 1;
        continue;
      }
      const { email } = await buildEmail(p, digest, aud.sites);
      // source_id per (digest, period): the outbound_emails dedup index is a
      // second guard behind the run lock against mailing anyone twice.
      await enqueue(env, "form-digest", `${digest.id}:${period.key}`, aud.email, email);
      sent += 1;
    } catch (err) {
      // One recipient's failure never stops the rest.
      console.error("[forms.digest] recipient failed", { digest: digest.id, recipient: aud.email, err: String(err) });
    }
  }
  return { sent, skipped };
}

// --- cron --------------------------------------------------------------------------

/** Called from the every-minute cron (every 5th minute). Sends whatever is due. */
export async function runDueDigests(env: Env, at: Date = new Date()): Promise<{ checked: number; sent: string[] }> {
  const now = easternNow(at);
  const digests = await listDigests(env, { enabledOnly: true });
  const sent: string[] = [];
  for (const d of digests) {
    const period = duePeriod(d.config.schedule, now);
    if (!period || d.last_period === period.key) continue;
    const runId = await claimRun(env, d.id, period.key);
    if (!runId) continue; // another tick has it
    try {
      const r = await sendDigest(env, d, period);
      await finishRun(env, runId, { recipients_sent: r.sent, recipients_skipped: r.skipped });
      await updateDigest(env, d.id, { last_sent_at: new Date().toISOString(), last_period: period.key });
      sent.push(`${d.id}:${period.key}:${r.sent}`);
    } catch (err) {
      // The run row stays claimed: a digest that failed half-way is NOT
      // re-sent automatically (some recipients may already have it). The
      // error is on the run row and in the logs.
      console.error("[forms.digest] run failed", { digest: d.id, period: period.key, err: String(err) });
      await finishRun(env, runId, { recipients_sent: 0, recipients_skipped: 0, error: String(err).slice(0, 500) });
    }
  }
  return { checked: digests.length, sent };
}

// --- test send + preview -----------------------------------------------------------

/** The most recently COMPLETED period, which is what a test or preview shows. */
export function previewPeriod(config: DigestConfig, at: Date = new Date()): DigestPeriod {
  return periodFor(config.schedule.frequency, easternNow(at).ymd);
}

/** Mail the caller the all-sites version of the last completed period. */
export async function sendTestDigest(
  env: Env,
  formId: string,
  digest: { name: string; config: DigestConfig },
  to: string
): Promise<{ submissions: number }> {
  const period = previewPeriod(digest.config);
  const p = await prepare(env, formId, period);
  if (!p) throw new Error("form_not_found");
  const { count, email } = await buildEmail(p, digest, "all");
  await enqueue(env, "form-digest-test", `${formId}:test:${crypto.randomUUID()}`, to, {
    ...email,
    subject: `[TEST] ${email.subject}`
  });
  return { submissions: count };
}

export interface DigestPreview {
  period: { key: string; label: string; from: string; to: string };
  total: number;
  capped: boolean;
  charts: ChartData[];
  table: TableData | null;
  recipients: { email: string; roles: string[]; scope: string; submissions: number; skipped: boolean }[];
}

/** Everything the builder shows: all-sites data plus who would get what. */
export async function previewDigest(env: Env, formId: string, config: DigestConfig): Promise<DigestPreview | null> {
  const period = previewPeriod(config);
  const p = await prepare(env, formId, period);
  if (!p) return null;
  const recipients = resolveAudiences(config, p.sites).map((a) => {
    const n = scopeSubs(p.subs, a.sites).length;
    return {
      email: a.email,
      roles: [...a.roles],
      scope: scopeLabel(a.sites, p.sites),
      submissions: n,
      skipped: n === 0 && config.skip_if_empty
    };
  });
  return {
    period: { key: period.key, label: period.label, from: period.from, to: period.to },
    total: p.subs.length,
    capped: p.capped,
    charts: config.charts.map((c) => chartData(p.ctx, p.subs, c)),
    table: tableData(p.ctx, p.subs, config.table),
    recipients
  };
}
