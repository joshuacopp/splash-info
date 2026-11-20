"use client";

// Digests tab (/admin/forms/{id}?tab=digests): scheduled summary emails for a
// form, set up here instead of a custom build per form. Admin tier only (the
// page gate + the worker gate).
//
// The editor previews LIVE against the last completed period: the worker
// computes the same charts / table / recipient list it would mail, so the
// preview cannot drift from the email.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import type { Field } from "@splash/forms-schema";
import {
  DIGEST_LIMITS,
  DIGEST_SITE_ROLE_LABELS,
  WEEKDAY_LABELS,
  defaultDigestConfig,
  describeSchedule,
  hourLabel,
  type DigestChart,
  type DigestConfig,
  type DigestDimension,
  type DigestMetric,
  type DigestSiteRole,
  type FormDigest
} from "@splash/forms-schema/digest";
import type { DigestPreviewData, DigestTableData } from "../../_lib/worker-fetch";
import {
  deleteDigestAction,
  previewDigestAction,
  saveDigestAction,
  setDigestEnabledAction,
  testDigestAction
} from "./actions";

// Recharts only loads on this tab.
const DigestChartPreview = dynamic(() => import("./DigestChartPreview"), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded bg-gray-light/40" />
});

interface Props {
  formId: string;
  fields: Field[];
  initialDigests: FormDigest[];
}

const ROLES: DigestSiteRole[] = ["site_email", "rm_email", "am_email", "hrt_email"];

// --- field helpers -------------------------------------------------------------

function isNumeric(f: Field): boolean {
  return f.type === "short_text" && !!(f as { numeric?: unknown }).numeric;
}
function isChoice(f: Field): boolean {
  return f.type === "radio" || f.type === "dropdown" || f.type === "multi";
}
function isShowable(f: Field): boolean {
  return !["heading", "image", "signature", "file", "hidden", "package_price_grid", "attendance", "required_topics"].includes(f.type);
}

function metricValue(m: DigestMetric): string {
  return m.agg === "count" ? "count" : `${m.agg}:${m.field_key ?? ""}`;
}
function metricFrom(v: string): DigestMetric {
  if (v === "count") return { agg: "count" };
  const [agg, key] = v.split(":");
  return { agg: agg as "sum" | "avg", field_key: key };
}

// --- page ------------------------------------------------------------------------

export default function DigestsPanel({ formId, fields, initialDigests }: Props) {
  const [digests, setDigests] = useState<FormDigest[]>(initialDigests);
  const [editing, setEditing] = useState<{ id: string | null; name: string; enabled: boolean; config: DigestConfig } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const numeric = useMemo(() => fields.filter(isNumeric), [fields]);

  function startNew() {
    const config = defaultDigestConfig();
    // Sensible start: count + every number field, by site.
    config.table = { kind: "summary", group: "site", metrics: [{ agg: "count" }, ...numeric.map((f) => ({ agg: "sum" as const, field_key: f.key }))] };
    setEditing({ id: null, name: "", enabled: true, config });
    setNotice(null);
  }

  function toggle(d: FormDigest) {
    startTransition(async () => {
      const r = await setDigestEnabledAction(formId, d.id, !d.enabled);
      if (r.ok) setDigests((list) => list.map((x) => (x.id === d.id ? r.data : x)));
      else setNotice({ kind: "error", text: r.error });
    });
  }

  function remove(d: FormDigest) {
    if (!window.confirm(`Delete the digest "${d.name}"? Nobody will get it any more.`)) return;
    startTransition(async () => {
      const r = await deleteDigestAction(formId, d.id);
      if (r.ok) {
        setDigests((list) => list.filter((x) => x.id !== d.id));
        setNotice({ kind: "ok", text: `Deleted "${d.name}".` });
      } else setNotice({ kind: "error", text: r.error });
    });
  }

  if (editing) {
    return (
      <DigestEditor
        formId={formId}
        fields={fields}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={(d, isNew) => {
          setDigests((list) => (isNew ? [...list, d] : list.map((x) => (x.id === d.id ? d : x))));
          setEditing(null);
          setNotice({ kind: "ok", text: `Saved "${d.name}".` });
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl text-sm text-splash-navy/80">
          <p>
            A digest is a scheduled summary email of this form's submissions: charts and a table for the period that just ended.
            Site, RM, RD and HRT recipients each see only their own sites; named people see every site.
          </p>
        </div>
        <button
          type="button"
          onClick={startNew}
          className="rounded-full bg-splash-navy px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-navy/90"
        >
          + New digest
        </button>
      </div>

      {notice ? <Notice notice={notice} /> : null}

      {digests.length === 0 ? (
        <p className="rounded-splash-lg border border-dashed border-gray-light bg-white p-6 text-sm text-splash-navy/70">
          No digests yet. Nothing is emailed for this form on a schedule.
        </p>
      ) : (
        <ul className="space-y-3">
          {digests.map((d) => (
            <li key={d.id} className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-splash-navy">{d.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${d.enabled ? "bg-emerald-100 text-emerald-800" : "bg-gray-light text-splash-navy/70"}`}>
                      {d.enabled ? "On" : "Paused"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-splash-navy/80">
                    {describeSchedule(d.config.schedule)} (Eastern) &middot; {recipientSummary(d.config)}
                  </p>
                  <p className="mt-0.5 text-xs text-splash-navy/60">
                    {d.last_sent_at ? `Last sent ${new Date(d.last_sent_at).toLocaleString("en-US", { timeZone: "America/New_York" })}` : "Not sent yet"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <SmallButton onClick={() => setEditing({ id: d.id, name: d.name, enabled: d.enabled, config: d.config })}>Edit</SmallButton>
                  <SmallButton onClick={() => toggle(d)} disabled={pending}>
                    {d.enabled ? "Pause" : "Turn on"}
                  </SmallButton>
                  <SmallButton onClick={() => remove(d)} disabled={pending} danger>
                    Delete
                  </SmallButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function recipientSummary(c: DigestConfig): string {
  const parts: string[] = [];
  for (const r of c.recipients) {
    if (r.type === "site_role") parts.push(DIGEST_SITE_ROLE_LABELS[r.role].replace("Each site (site email)", "Each site"));
    else if (r.emails.length) parts.push(`${r.emails.length} named ${r.emails.length === 1 ? "person" : "people"}`);
  }
  return parts.join(", ") || "No recipients";
}

// --- editor -----------------------------------------------------------------------

function DigestEditor({
  formId,
  fields,
  initial,
  onCancel,
  onSaved
}: {
  formId: string;
  fields: Field[];
  initial: { id: string | null; name: string; enabled: boolean; config: DigestConfig };
  onCancel: () => void;
  onSaved: (d: FormDigest, isNew: boolean) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [config, setConfig] = useState<DigestConfig>(initial.config);
  const [staticText, setStaticText] = useState(
    initial.config.recipients.flatMap((r) => (r.type === "static" ? r.emails : [])).join("\n")
  );
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<DigestPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, startSaving] = useTransition();

  const numeric = fields.filter(isNumeric);
  const choice = fields.filter(isChoice);
  const showable = fields.filter(isShowable);

  // Recipients: the static list is edited as text and folded in on change.
  const effective: DigestConfig = useMemo(() => {
    const emails = staticText
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    const roles = config.recipients.filter((r) => r.type === "site_role");
    return { ...config, recipients: emails.length ? [...roles, { type: "static", emails }] : roles };
  }, [config, staticText]);

  // Live preview, debounced; a stale response never overwrites a newer one.
  const seq = useRef(0);
  const configKey = JSON.stringify(effective);
  useEffect(() => {
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(async () => {
      const r = await previewDigestAction(formId, effective);
      if (mine !== seq.current) return;
      setPreviewing(false);
      if (r.ok) {
        setPreview(r.data);
        setPreviewError(null);
      } else setPreviewError(r.error);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, formId]);

  const set = (patch: Partial<DigestConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const setSchedule = (patch: Partial<DigestConfig["schedule"]>) => setConfig((c) => ({ ...c, schedule: { ...c.schedule, ...patch } }));
  const hasRole = (role: DigestSiteRole) => config.recipients.some((r) => r.type === "site_role" && r.role === role);
  const toggleRole = (role: DigestSiteRole) =>
    setConfig((c) => ({
      ...c,
      recipients: hasRole(role)
        ? c.recipients.filter((r) => !(r.type === "site_role" && r.role === role))
        : [...c.recipients, { type: "site_role", role }]
    }));

  const setChart = (i: number, patch: Partial<DigestChart>) =>
    setConfig((c) => ({ ...c, charts: c.charts.map((ch, j) => (j === i ? { ...ch, ...patch } : ch)) }));

  function addChart() {
    const y: DigestMetric = numeric[0] ? { agg: "sum", field_key: numeric[0].key } : { agg: "count" };
    set({ charts: [...config.charts, { type: "bar", x: "day", y, split: "site" }] });
  }

  function save() {
    if (!name.trim()) {
      setNotice({ kind: "error", text: "Give the digest a name." });
      return;
    }
    startSaving(async () => {
      const r = await saveDigestAction(formId, initial.id, { name: name.trim(), enabled, config: effective });
      if (r.ok) onSaved(r.data, !initial.id);
      else setNotice({ kind: "error", text: r.error });
    });
  }

  function test() {
    startSaving(async () => {
      const r = await testDigestAction(formId, name.trim() || "Digest", effective);
      if (r.ok)
        setNotice({
          kind: "ok",
          text: `Test sent to ${r.data.to} (all sites, ${r.data.submissions} submission${r.data.submissions === 1 ? "" : "s"}). It goes out with the next email queue run, usually within a few minutes.`
        });
      else setNotice({ kind: "error", text: r.error });
    });
  }

  const dimOptions = (allowNone: boolean) => (
    <>
      {allowNone ? <option value="">None</option> : null}
      <option value="day">Day</option>
      <option value="week">Week</option>
      <option value="month">Month</option>
      <option value="site">Site</option>
      {choice.map((f) => (
        <option key={f.key} value={`field:${f.key}`}>
          {f.label}
        </option>
      ))}
    </>
  );
  const metricOptions = (
    <>
      <option value="count">Number of submissions</option>
      {numeric.map((f) => (
        <option key={`s${f.key}`} value={`sum:${f.key}`}>
          Total {f.label.toLowerCase()}
        </option>
      ))}
      {numeric.map((f) => (
        <option key={`a${f.key}`} value={`avg:${f.key}`}>
          Average {f.label.toLowerCase()}
        </option>
      ))}
    </>
  );

  const tableMetrics = config.table.metrics ?? [];
  const toggleTableMetric = (v: string) => {
    const has = tableMetrics.some((m) => metricValue(m) === v);
    set({ table: { ...config.table, metrics: has ? tableMetrics.filter((m) => metricValue(m) !== v) : [...tableMetrics, metricFrom(v)] } });
  };
  const tableFields = config.table.fields ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* ---- settings ---- */}
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-splash-navy">{initial.id ? "Edit digest" : "New digest"}</h2>
          <button type="button" onClick={onCancel} className="text-sm text-splash-blue hover:underline">
            Back to digests
          </button>
        </div>

        <Section title="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Weekly salt use for RMs"
            className="w-full rounded border border-gray-light px-3 py-2 text-sm"
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On (sends on schedule)
          </label>
        </Section>

        <Section title="When" hint="Eastern time. Each email covers the period that just ended.">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value={config.schedule.frequency}
              onChange={(e) => {
                const f = e.target.value as DigestConfig["schedule"]["frequency"];
                setSchedule({ frequency: f, weekday: f === "weekly" ? config.schedule.weekday ?? 1 : undefined, monthday: f === "monthly" ? config.schedule.monthday ?? 1 : undefined });
              }}
              className="rounded border border-gray-light px-2 py-1.5"
            >
              <option value="daily">Daily (yesterday)</option>
              <option value="weekly">Weekly (last 7 days)</option>
              <option value="monthly">Monthly (last month)</option>
            </select>
            {config.schedule.frequency === "weekly" ? (
              <select value={config.schedule.weekday ?? 1} onChange={(e) => setSchedule({ weekday: Number(e.target.value) })} className="rounded border border-gray-light px-2 py-1.5">
                {WEEKDAY_LABELS.slice(1).map((l, i) => (
                  <option key={l} value={i + 1}>
                    on {l}
                  </option>
                ))}
              </select>
            ) : null}
            {config.schedule.frequency === "monthly" ? (
              <select value={config.schedule.monthday ?? 1} onChange={(e) => setSchedule({ monthday: Number(e.target.value) })} className="rounded border border-gray-light px-2 py-1.5">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    on day {d}
                  </option>
                ))}
              </select>
            ) : null}
            <select value={config.schedule.hour} onChange={(e) => setSchedule({ hour: Number(e.target.value) })} className="rounded border border-gray-light px-2 py-1.5">
              {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                <option key={h} value={h}>
                  at {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
        </Section>

        <Section title="Who gets it" hint="Site roles see only their own sites. Named people see every site.">
          <div className="grid gap-1 text-sm sm:grid-cols-2">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2">
                <input type="checkbox" checked={hasRole(r)} onChange={() => toggleRole(r)} /> {DIGEST_SITE_ROLE_LABELS[r]}
              </label>
            ))}
          </div>
          <label className="mt-3 block text-sm font-bold text-splash-navy">Named people (all sites)</label>
          <textarea
            value={staticText}
            onChange={(e) => setStaticText(e.target.value)}
            rows={2}
            placeholder="one email per line"
            className="mt-1 w-full rounded border border-gray-light px-3 py-2 text-sm"
          />
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={config.skip_if_empty} onChange={(e) => set({ skip_if_empty: e.target.checked })} /> Don't email anyone whose sites had no submissions
          </label>
        </Section>

        <Section title="Charts" hint={numeric.length === 0 ? "This form has no number fields, so charts can count submissions only." : undefined}>
          <div className="space-y-3">
            {config.charts.map((c, i) => (
              <div key={i} className="rounded border border-gray-light p-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <LabeledSelect label="Type" value={c.type} onChange={(v) => setChart(i, { type: v as DigestChart["type"], split: v === "pie" ? null : c.split })}>
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="pie">Pie</option>
                  </LabeledSelect>
                  <LabeledSelect label="Value (Y)" value={metricValue(c.y)} onChange={(v) => setChart(i, { y: metricFrom(v) })}>
                    {metricOptions}
                  </LabeledSelect>
                  <LabeledSelect label={c.type === "pie" ? "Slices" : "X axis"} value={c.x} onChange={(v) => setChart(i, { x: v as DigestDimension })}>
                    {dimOptions(false)}
                  </LabeledSelect>
                  {c.type !== "pie" ? (
                    <LabeledSelect label="Split by" value={c.split ?? ""} onChange={(v) => setChart(i, { split: (v || null) as DigestDimension | null })}>
                      {dimOptions(true)}
                    </LabeledSelect>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={c.title ?? ""}
                    onChange={(e) => setChart(i, { title: e.target.value || undefined })}
                    placeholder="Title (optional)"
                    maxLength={120}
                    className="flex-1 rounded border border-gray-light px-2 py-1.5"
                  />
                  <button type="button" onClick={() => set({ charts: config.charts.filter((_, j) => j !== i) })} className="text-xs text-red-700 hover:underline">
                    Remove
                  </button>
                </div>
                {c.type === "pie" && ["day", "week", "month"].includes(c.x) ? (
                  <p className="mt-1 text-xs text-amber-800">A pie shows shares of a whole. Over time, bar or line reads better.</p>
                ) : null}
              </div>
            ))}
          </div>
          {config.charts.length < DIGEST_LIMITS.charts ? (
            <button type="button" onClick={addChart} className="mt-2 text-sm font-bold text-splash-blue hover:underline">
              + Add chart
            </button>
          ) : null}
        </Section>

        <Section title="Table">
          <div className="flex flex-wrap gap-3 text-sm">
            {(
              [
                ["summary", "Totals"],
                ["rows", "Every submission"],
                ["none", "No table"]
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" checked={config.table.kind === k} onChange={() => set({ table: { ...config.table, kind: k } })} /> {l}
              </label>
            ))}
          </div>
          {config.table.kind === "summary" ? (
            <div className="mt-3 space-y-2 text-sm">
              <LabeledSelect
                label="Grouped"
                value={config.table.group ?? "site"}
                onChange={(v) => set({ table: { ...config.table, group: v as "site" | "site_day" | "day" } })}
              >
                <option value="site">By site</option>
                <option value="site_day">By site, then day</option>
                <option value="day">By day</option>
              </LabeledSelect>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {["count", ...numeric.flatMap((f) => [`sum:${f.key}`, `avg:${f.key}`])].map((v) => {
                  const f = numeric.find((x) => x.key === v.split(":")[1]);
                  const label = v === "count" ? "Submissions" : v.startsWith("sum") ? `Total ${f?.label.toLowerCase()}` : `Average ${f?.label.toLowerCase()}`;
                  return (
                    <label key={v} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={tableMetrics.some((m) => metricValue(m) === v)} onChange={() => toggleTableMetric(v)} /> {label}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
          {config.table.kind === "rows" ? (
            <div className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
              {showable.map((f) => (
                <label key={f.key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={tableFields.includes(f.key)}
                    disabled={!tableFields.includes(f.key) && tableFields.length >= DIGEST_LIMITS.rowFields}
                    onChange={() =>
                      set({
                        table: {
                          ...config.table,
                          fields: tableFields.includes(f.key) ? tableFields.filter((k) => k !== f.key) : [...tableFields, f.key]
                        }
                      })
                    }
                  />{" "}
                  {f.label}
                </label>
              ))}
            </div>
          ) : null}
        </Section>

        {notice ? <Notice notice={notice} /> : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-full bg-splash-navy px-5 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-navy/90 disabled:opacity-60"
          >
            {saving ? "Working..." : "Save digest"}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={saving}
            className="rounded-full border border-splash-navy bg-white px-5 py-2 text-sm font-bold text-splash-navy hover:bg-splash-navy/5 disabled:opacity-60"
          >
            Send me a test
          </button>
          <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-splash-navy/70 hover:underline">
            Cancel
          </button>
        </div>
      </div>

      {/* ---- preview ---- */}
      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-bold text-splash-navy">Preview</h2>
            <span className="text-xs text-splash-navy/60">{previewing ? "Updating..." : preview ? `${preview.period.label}, all sites` : ""}</span>
          </div>
          {previewError ? <p className="mt-2 text-sm text-red-700">{previewError}</p> : null}
          {preview ? (
            <div className="mt-2 space-y-4">
              <p className="text-sm text-splash-navy/80">
                {preview.total.toLocaleString("en-US")} submission{preview.total === 1 ? "" : "s"} in the last {config.schedule.frequency === "daily" ? "day" : config.schedule.frequency === "weekly" ? "week" : "month"}.
                {preview.capped ? " (More than a digest can include; numbers are incomplete.)" : ""}
              </p>
              {preview.charts.map((c, i) => (
                <figure key={i}>
                  <figcaption className="mb-1 text-sm font-bold text-splash-navy">{c.title}</figcaption>
                  <DigestChartPreview chart={c} />
                </figure>
              ))}
              {preview.table ? <PreviewTable t={preview.table} /> : null}
            </div>
          ) : null}
        </div>

        {preview ? (
          <div className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
            <h2 className="text-base font-bold text-splash-navy">Who would get it</h2>
            <p className="text-xs text-splash-navy/60">For {preview.period.label}. Each person sees only the sites listed.</p>
            {preview.recipients.length === 0 ? (
              <p className="mt-2 text-sm text-amber-800">Nobody: no recipients, or no site has an email for the roles picked.</p>
            ) : (
              <ul className="mt-2 max-h-72 divide-y divide-gray-light overflow-y-auto text-sm">
                {preview.recipients.map((r) => (
                  <li key={r.email} className={`flex flex-wrap justify-between gap-2 py-1.5 ${r.skipped ? "text-splash-navy/50" : ""}`}>
                    <span>
                      {r.email} <span className="text-xs text-splash-navy/60">({r.roles.join(", ")})</span>
                    </span>
                    <span className="text-xs">
                      {r.scope} &middot; {r.skipped ? "skipped, nothing to report" : `${r.submissions} submission${r.submissions === 1 ? "" : "s"}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- bits -----------------------------------------------------------------------------

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card">
      <h3 className="text-sm font-bold uppercase tracking-wide text-splash-navy/80">{title}</h3>
      {hint ? <p className="mb-2 text-xs text-splash-navy/60">{hint}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

function LabeledSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold text-splash-navy/80">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-0.5 block w-full rounded border border-gray-light px-2 py-1.5 text-sm font-normal text-splash-navy">
        {children}
      </select>
    </label>
  );
}

function SmallButton({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-60 ${danger ? "border-red-300 text-red-700 hover:bg-red-50" : "border-splash-navy text-splash-navy hover:bg-splash-navy/5"}`}
    >
      {children}
    </button>
  );
}

function Notice({ notice }: { notice: { kind: "ok" | "error"; text: string } }) {
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={`rounded px-3 py-2 text-sm ${notice.kind === "error" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>
      {notice.text}
    </p>
  );
}

function PreviewTable({ t }: { t: DigestTableData }) {
  const num = (i: number) => i >= t.numericFrom;
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-white">
          <tr>
            {t.columns.map((c, i) => (
              <th key={c} className={`border-b border-gray-light px-2 py-1.5 text-xs text-splash-navy/70 ${num(i) ? "text-right" : "text-left"}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.sections.map((s, si) => (
            <SectionRows key={si} s={s} cols={t.columns.length} num={num} />
          ))}
          {t.grandTotal ? (
            <tr className="bg-gray-light/50 font-bold">
              {t.grandTotal.map((v, i) => (
                <td key={i} className={`px-2 py-1.5 ${num(i) ? "text-right" : ""}`}>
                  {v}
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({ s, cols, num }: { s: DigestTableData["sections"][number]; cols: number; num: (i: number) => boolean }) {
  return (
    <>
      {s.title ? (
        <tr>
          <td colSpan={cols} className="border-b-2 border-splash-navy px-2 pb-1 pt-3 font-bold text-splash-navy">
            {s.title}
          </td>
        </tr>
      ) : null}
      {s.rows.map((r, ri) => (
        <tr key={ri}>
          {r.map((v, i) => (
            <td key={i} className={`border-b border-gray-light px-2 py-1 ${num(i) ? "text-right tabular-nums" : ""}`}>
              {v}
            </td>
          ))}
        </tr>
      ))}
      {s.total ? (
        <tr className="bg-gray-light/30 font-bold">
          {s.total.map((v, i) => (
            <td key={i} className={`px-2 py-1 ${num(i) ? "text-right tabular-nums" : ""}`}>
              {v}
            </td>
          ))}
        </tr>
      ) : null}
    </>
  );
}
