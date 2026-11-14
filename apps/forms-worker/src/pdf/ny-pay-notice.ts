// NY Labor Law s.195.1 pay notice -- the OFFICIAL NYS DOL form, filled in.
//
// The Pay Change form's payroll email must carry the state's own notice, not a
// summary of it (operator, 2026-11-13). The templates are the DOL's fillable
// PDFs, bundled into the worker (wrangler.toml `[[rules]] type = "Data"`):
//
//   LS 54 (12/25)  Notice for Hourly Rate Employees     -- pay type "hour"
//   LS 59 (12/25)  Notice for Exempt Employees          -- "week" / "year"
//                  (operator decision: salaried = exempt managers)
//
// SECTION 1 (EMPLOYER INFORMATION) IS LEFT BLANK on purpose (operator,
// 2026-11-13): payroll / HR completes it. Everything else comes from the
// submission:
//
//   2  Notice given          "Before a change in pay rate(s)" (always)
//   3  Rate                   new_rate (+ new_pay_type wording on LS 59)
//   4  Allowances             ny_allowances + ny_allowance_detail
//   5  Regular payday         ny_payday
//   6  Pay is                 ny_pay_frequency
//   7  Overtime (LS 54)       1.5 x new_rate, per hour
//   8  Language               ny_notice_language + ny_primary_language
//      Employee name / date   the employee-signoff history entry (typed name,
//                             its timestamp in Eastern), falling back to the
//                             Employee field
//      Signature              that entry's signature image, drawn on the line
//      Preparer               manager_name
//
// COUPLED TO FIELD KEYS of scripts/gen-pay-change.ts. Renaming one there
// blanks the matching box here -- this file is the other half of that form.
//
// The DOL field names are generic ("Generic_GenericYesNo_Yes1"); the mapping
// below was read off a render of each template with its field names overlaid.
// A new DOL edition must be re-mapped the same way before swapping the file.

import { PDFDocument, type PDFForm } from "pdf-lib";
import type { WorkflowHistoryEntry } from "@splash/forms-schema";
import { isEmployeeValue } from "@splash/forms-schema";
import ls54 from "../../templates/ny-ls54.pdf";
import ls59 from "../../templates/ny-ls59.pdf";
import { fetchAndEmbedR2Image, type R2Like } from "./layout-utils.js";

type Payload = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** True when this submission needs a NY notice at all. */
export function needsNyPayNotice(payload: Payload): boolean {
  return str(payload.ny_site) === "yes";
}

interface Layout {
  rate: string;
  overtime?: string;
  tips: string;
  meals: string;
  lodging: string;
  other: string;
  payday: string;
  payOther: string;
}

// Field names that differ between the two templates. Everything else
// (checkboxes, names, dates, language) is named the same on both.
const LS54: Layout = {
  rate: "Employment_RegularRates_PerRate1",
  overtime: "WorkHistory_JobInfo_PerTime1",
  tips: "Generic_GenericTextField_TextField3",
  meals: "Generic_GenericTextField_TextField4",
  lodging: "Generic_GenericTextField_TextField5",
  other: "Business_Complaint_Other",
  payday: "Generic_GenericTextField_TextField1",
  payOther: "Generic_GenericTextField_TextField6"
};
const LS59: Layout = {
  rate: "Generic_GenericTextField_TextField1",
  tips: "Generic_GenericTextField_TextField2",
  meals: "Generic_GenericTextField_TextField3",
  lodging: "Generic_GenericTextField_TextField4",
  other: "Business_Complaint_Other",
  payday: "Generic_GenericTextField_TextField5",
  payOther: "Generic_GenericTextField_TextField6"
};

function setText(form: PDFForm, name: string, value: string): void {
  if (!value) return;
  try {
    form.getTextField(name).setText(value);
  } catch (err) {
    console.warn(`[forms.ny-notice] text field ${name} not set`, err);
  }
}
function check(form: PDFForm, name: string): void {
  try {
    form.getCheckBox(name).check();
  } catch (err) {
    console.warn(`[forms.ny-notice] checkbox ${name} not set`, err);
  }
}

function money(raw: string): string {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : raw.replace(/^\$/, "");
}

/** The employee's acknowledgement: the sign-off transition out of the
 *  employee_signoff stage, newest first. */
function signoffEntry(history: WorkflowHistoryEntry[]): WorkflowHistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.from === "employee_signoff" && h.signature_r2_key) return h;
  }
  return null;
}

function easternParts(iso: string): { mm: string; dd: string; yy: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { mm: get("month"), dd: get("day"), yy: get("year") };
}

/**
 * Fill the right notice for this submission. Returns the PDF bytes, or null
 * when the submission is not for a NY site. Throws on a template that will not
 * load; the caller treats that as "send without it".
 */
export async function fillNyPayNotice(
  bucket: R2Like,
  payload: Payload,
  history: WorkflowHistoryEntry[]
): Promise<Uint8Array | null> {
  if (!needsNyPayNotice(payload)) return null;

  const payType = str(payload.new_pay_type);
  const hourly = payType === "hour" || payType === "";
  const doc = await PDFDocument.load(hourly ? ls54 : ls59);
  const form = doc.getForm();
  const L = hourly ? LS54 : LS59;

  // 2 -- a pay change is always given before the change.
  check(form, "Generic_GenericYesNo_No15");

  // 3 / 7 -- rate (and overtime on the hourly notice).
  const rate = money(str(payload.new_rate));
  if (hourly) {
    setText(form, L.rate, rate);
    const n = Number(rate);
    if (L.overtime && Number.isFinite(n) && n > 0) setText(form, L.overtime, (n * 1.5).toFixed(2));
  } else {
    setText(form, L.rate, `$${rate} per ${payType === "week" ? "week" : "year"} (salary)`);
  }

  // 4 -- allowances. The form asks for one free-text amount; it goes in the
  // box of the first allowance ticked.
  const allowances = Array.isArray(payload.ny_allowances)
    ? (payload.ny_allowances as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const detail = str(payload.ny_allowance_detail);
  const boxes: Record<string, [string, string]> = {
    none: ["Employment_JobBenefits_None", ""],
    tips: ["Employment_JobBenefits_Tips", L.tips],
    meals: ["Employment_JobBenefits_Meals", L.meals],
    lodging: ["Employment_JobBenefits_Lodging", L.lodging],
    other: ["Employment_JobBenefits_Other", L.other]
  };
  let detailPlaced = false;
  for (const a of allowances) {
    const b = boxes[a];
    if (!b) continue;
    check(form, b[0]);
    if (b[1] && detail && !detailPlaced) {
      setText(form, b[1], detail);
      detailPlaced = true;
    }
  }

  // 5 / 6 -- payday and frequency.
  setText(form, L.payday, str(payload.ny_payday));
  const freq = str(payload.ny_pay_frequency);
  if (freq === "weekly") check(form, "Generic_GenericYesNo_No1");
  else if (freq === "biweekly") check(form, "Generic_GenericYesNo_Yes1");
  else if (freq === "other") check(form, "Generic_GenericYesNo_Yes2");

  // 8 -- language.
  if (str(payload.ny_notice_language) === "english_primary") {
    check(form, "Employment_PrimaryLanguageEnglish");
  } else if (str(payload.ny_notice_language) === "english_only") {
    check(form, "Employment_PrimaryLanguageNotEnglish");
    setText(form, "Contact_PreferredLanguage", str(payload.ny_primary_language));
  }

  // Employee name, date, signature -- from the sign-off.
  const entry = signoffEntry(history);
  const employee = isEmployeeValue(payload.employee) ? payload.employee.name : "";
  setText(form, "Business_EmployeeName", str(entry?.typed_name) || employee);
  const when = entry ? easternParts(entry.at) : null;
  if (when) {
    setText(form, "DocumentSignature_SignatureMM", when.mm);
    setText(form, "DocumentSignature_SignatureDD", when.dd);
    setText(form, "DocumentSignature_SignatureYY", when.yy);
  }
  setText(form, "Business_PreparerName", str(payload.manager_name));

  // Flatten first, so the signature drawn below sits on the final page and
  // nothing in the notice can be edited after the employee signed it.
  const nameRect = form.getTextField("Business_EmployeeName").acroField.getWidgets()[0]?.getRectangle();
  const dateRect = form.getTextField("DocumentSignature_SignatureMM").acroField.getWidgets()[0]?.getRectangle();
  form.flatten();

  if (entry?.signature_r2_key && nameRect && dateRect) {
    try {
      const img = await fetchAndEmbedR2Image(doc, bucket, entry.signature_r2_key);
      // The signature line sits between the "Employee Signature" label (just
      // above the date boxes) and the "Print Employee Name" label (just below
      // the name box).
      const bottom = dateRect.y + dateRect.height + 16;
      const top = nameRect.y - 16;
      const boxH = Math.max(14, top - bottom);
      const boxW = nameRect.width;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      doc.getPage(0).drawImage(img, {
        x: nameRect.x,
        y: bottom,
        width: img.width * scale,
        height: img.height * scale
      });
    } catch (err) {
      console.error("[forms.ny-notice] signature draw failed", err);
    }
  }

  return doc.save();
}
