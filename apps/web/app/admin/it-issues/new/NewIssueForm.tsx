"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { createIssueAction } from "../actions";
import { OccurrenceFields } from "../_components/OccurrenceFields";
import { PhotoInput } from "../_components/PhotoInput";
import { ProviderQuestion } from "../_components/ProviderFields";
import {
  IMPACT_OPTIONS,
  PRIORITY_OPTIONS,
  deviceLabel,
  formatEt,
  type Impact,
  type Issue,
  type Priority,
  type SiteOption
} from "../_lib/types";

const input = "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm";
const label = "mb-1 block text-sm font-semibold text-splash-navy";
const hint = "mt-1 text-xs text-splash-navy/60";

export default function NewIssueForm({
  sites,
  devices,
  openIssues
}: {
  sites: SiteOption[];
  devices: string[];
  openIssues: Issue[];
}) {
  // Site lookup by the 3-digit site number, like every other form. A few
  // numbers belong to two washes (an express and a hand wash share 019, 040,
  // 068), so a number can match more than one site and the person picks.
  const only = sites.length === 1 ? sites[0]! : null;
  const [siteNum, setSiteNum] = useState(only?.site_number != null ? String(only.site_number).padStart(3, "0") : "");
  const [picked, setPicked] = useState<string>(only ? String(only.id) : "");
  const typed = Number.parseInt(siteNum, 10);
  const matches = Number.isFinite(typed) ? sites.filter((s) => s.site_number === typed) : [];
  const siteId = matches.length === 1 ? String(matches[0]!.id) : matches.some((m) => String(m.id) === picked) ? picked : "";
  const [device, setDevice] = useState("");
  const [impact, setImpact] = useState<Impact | "">("");
  const [priority, setPriority] = useState<Priority | "">("");
  // Impact SUGGESTS a priority; once the person picks one themselves, stop
  // overwriting it.
  const [priorityTouched, setPriorityTouched] = useState(false);

  const possibleDupes = openIssues.filter((i) => String(i.location_id) === siteId && i.device === device);

  return (
    <ActionForm action={createIssueAction} resetOnSuccess={false} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="site_number">Site number</label>
          <input
            id="site_number"
            inputMode="numeric"
            maxLength={3}
            required
            placeholder="e.g. 122"
            value={siteNum}
            onChange={(e) => setSiteNum(e.target.value.replace(/\D/g, ""))}
            className={input}
          />
          <input type="hidden" name="location_id" value={siteId} />
          {siteNum.length > 0 && matches.length === 0 && (
            <p className="mt-1 text-xs text-racecar-red">
              {siteNum.length < 3 ? "Enter all 3 digits." : `Site ${siteNum} isn't one of your sites.`}
            </p>
          )}
          {matches.length === 1 && (
            <p className="mt-1 text-sm font-semibold text-splash-success">{matches[0]!.name || matches[0]!.label}</p>
          )}
          {matches.length > 1 && (
            <div className="mt-1 space-y-1 text-sm">
              <p className="text-xs text-splash-navy/60">Two washes share this number - which one?</p>
              {matches.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input type="radio" checked={picked === String(m.id)} onChange={() => setPicked(String(m.id))} />
                  {m.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <div>
            <label className={label} htmlFor="device">Device or system</label>
            <select id="device" name="device" required value={device} onChange={(e) => setDevice(e.target.value)} className={input}>
              <option value="">Pick one…</option>
              {devices.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="device_unit">Unit #</label>
            <input id="device_unit" name="device_unit" maxLength={20} placeholder="e.g. 2" className={input} />
          </div>
        </div>
      </div>

      {possibleDupes.length > 0 && (
        <div className="rounded-splash-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Is this the same problem as one that&apos;s already open?</p>
          <p className="mb-2">If so, open it and log another occurrence instead of reporting it again.</p>
          <ul className="space-y-1">
            {possibleDupes.map((i) => (
              <li key={i.id}>
                <Link href={`/admin/it-issues/${i.id}#happened-again`} className="font-semibold text-splash-blue hover:underline">
                  IT-{i.ref_no}: {deviceLabel(i)} - {i.problem}
                </Link>{" "}
                <span className="text-amber-900/70">(since {formatEt(i.first_reported_at)}, {i.occurrence_count}×)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <label className={label} htmlFor="problem">What is happening?</label>
        <input id="problem" name="problem" required maxLength={300} className={input}
          placeholder='Be specific - not just "it isn&apos;t working". e.g. "Scanner won&apos;t read, no light"' />
      </div>

      <div>
        <label className={label} htmlFor="error_text">Error message (if any)</label>
        <textarea id="error_text" name="error_text" rows={2} maxLength={1000} className={input}
          placeholder="Copy it exactly as it appears on screen" />
      </div>

      <OccurrenceFields inputClass={input} labelClass={label} />

      <PhotoInput hint="A photo of the error on screen, or of the equipment, helps IT more than a description." />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="customer_impact">Customer impact</label>
          <select
            id="customer_impact"
            name="customer_impact"
            required
            value={impact}
            onChange={(e) => {
              const v = e.target.value as Impact | "";
              setImpact(v);
              const suggested = IMPACT_OPTIONS.find((o) => o.value === v)?.suggests;
              if (suggested && !priorityTouched) setPriority(suggested);
            }}
            className={input}
          >
            <option value="">Pick one…</option>
            {IMPACT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="priority">Priority</label>
          <select
            id="priority"
            name="priority"
            required
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value as Priority | "");
              setPriorityTouched(true);
            }}
            className={input}
          >
            <option value="">Pick one…</option>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className={hint}>
            {priority
              ? PRIORITY_OPTIONS.find((o) => o.value === priority)?.hint
              : "Filled in from the customer impact - change it if needed."}
          </p>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="troubleshooting">What have you already tried?</label>
        <textarea id="troubleshooting" name="troubleshooting" rows={3} maxLength={4000} className={input}
          placeholder="e.g. Restarted the kiosk, checked the cable" />
        <p className={hint}>Only approved troubleshooting - don&apos;t attempt repairs you&apos;re not authorized to do.</p>
      </div>

      <ProviderQuestion inputClass={input} labelClass={label} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="reporter_name">Your name</label>
          <input id="reporter_name" name="reporter_name" required maxLength={80} className={input} />
        </div>
        <div>
          <label className={label} htmlFor="reporter_phone">Phone IT can reach you on</label>
          <input id="reporter_phone" name="reporter_phone" type="tel" required maxLength={30} className={input} />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="it_ticket_no">IT ticket # (if you already have one)</label>
        <input id="it_ticket_no" name="it_ticket_no" maxLength={60} className={input} />
      </div>

      <SubmitButton
        pendingText="Saving…"
        className="rounded-splash-sm bg-splash-blue px-5 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:opacity-60"
      >
        Save issue
      </SubmitButton>
    </ActionForm>
  );
}
