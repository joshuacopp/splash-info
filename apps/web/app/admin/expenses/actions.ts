// Server actions for /admin/expenses.
//
// Same shape as greeters/actions.ts (FormData -> JSON body -> performancePostJson
// -> redirect with ?action_error= or ?success=), because the two pages talk to
// the same worker over the same transport and should fail the same way.
//
// NUMERICS ARE FORWARDED AS STRINGS. performance-worker re-coerces every field
// on the way in and the database has the actual constraints, so parsing here
// would just be a second place for the rules to drift. This matters more on
// this page than on the greeter one: `amount` is signed numeric(12,2) and a
// JS Number round-trip is exactly how "-0.01" becomes something else.
//
// WHAT IS VALIDATED HERE AND WHY: only the checks that save a ten-second round
// trip to produce a message the user could have had instantly, or that turn an
// opaque database error into a sentence. Everything checked here is ALSO
// enforced downstream — the initials shape by a CHECK constraint, the budget
// sign by another, the month-must-differ by a RAISE in
// copy_expense_budget_month(). Nothing here is the only line of defence.
//
// FILTER CONTEXT SURVIVES EVERY ACTION. Each form carries a hidden `return_qs`
// holding the page's current query string and every redirect rebuilds it. The
// greeter page redirects to a bare path, which it gets away with because its
// filters are optional; here the month IS the view. Saving a budget for July
// and landing back on August with no visible change is indistinguishable from
// the save having failed.

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  performancePostJson,
  transportTag
} from "../performance/_lib/worker-fetch";

const LIST_PATH = "/admin/expenses";

function strField(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function strOrNull(formData: FormData, name: string): string | null {
  const s = strField(formData, name);
  return s ? s : null;
}

/** Banner params. Stripped from `return_qs` on every redirect so a stale error
 *  from the previous attempt can't ride along beside a fresh success. */
const BANNER_PARAMS = [
  "action_error",
  "success",
  "po",
  "created",
  "corrected",
  // DIAGNOSTIC (2026-08-20, temporary) — `t=<transport>-<ms>` for the ~20s
  // save. Listed here so it's stripped from `return_qs` like the rest and a
  // reading from the previous save can't ride along beside a fresh one.
  "t"
];

/**
 * Rebuild the page URL the form was submitted from, with `extra` layered on.
 *
 * Reads the hidden `return_qs` field rather than referer: referer is absent
 * under some privacy settings and is not something an action should trust for
 * building a redirect target. `return_qs` is rendered by the page itself and
 * only ever contains this page's own filters.
 */
function backTo(formData: FormData, extra: Record<string, string>): string {
  const raw = strField(formData, "return_qs");
  const qs = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  for (const p of BANNER_PARAMS) qs.delete(p);
  for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  const s = qs.toString();
  return s ? `${LIST_PATH}?${s}` : LIST_PATH;
}

function fail(formData: FormData, message: string): never {
  redirect(backTo(formData, { action_error: message }));
}

/**
 * Pull the assigned PO number out of a successful insert response.
 *
 * Worth the narrowing ceremony: the PO is allocated by the database under an
 * advisory lock and the submitter has no way to know it until it is saved, so
 * echoing it in the success banner is the only moment they ever see it tied to
 * what they just typed. Returns null rather than throwing if the shape is
 * unexpected — a missing banner detail must not turn a successful save into an
 * error the user will retry.
 */
function poNumberOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const entry = (body as { entry?: unknown }).entry;
  if (!entry || typeof entry !== "object") return null;
  const po = (entry as { po_number?: unknown }).po_number;
  return typeof po === "string" && po ? po : null;
}

/** `{ created }` off the copy response, as a string for the query param. */
function createdCountOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const created = (body as { created?: unknown }).created;
  return typeof created === "number" ? String(created) : null;
}

/** `{ corrected }` off the budget response — TRUE when an existing budget for
 *  this (location, month, category) was UPDATED rather than created. It says
 *  nothing about the request being normalised; the worker 400s a month that
 *  isn't already YYYY-MM-01. Worth a word in the banner because an update
 *  replaces a number somebody may have set deliberately. */
function wasCorrected(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return Boolean((body as { corrected?: unknown }).corrected);
}

/**
 * Log one purchase.
 *
 * ONE ROW IS ONE CATEGORY AND ONE AMOUNT. A purchase that genuinely splits
 * across two categories is submitted twice; the two rows share a PO number,
 * which is why po_number is not unique in the schema. Do not add a
 * multi-category mode here without reading the uniqueness note in
 * supabase/expense-log-tables.sql first.
 *
 * NO po_number FIELD, AND THERE MUST NEVER BE ONE. The form collects initials;
 * the database assembles `{site_number}-YYYYMMDD{initials}{seq}` inside
 * insert_expense_entry() under pg_advisory_xact_lock. A client-supplied PO is
 * ignored by the worker, and site_number is resolved from the location against
 * the caller's scope so a hand-typed one could otherwise claim another site.
 */
export async function submitExpenseAction(formData: FormData): Promise<void> {
  const businessDate = strField(formData, "business_date");
  if (!businessDate) fail(formData, "Pick a purchase date before saving.");

  const locationId = strField(formData, "location_id");
  if (!locationId) fail(formData, "Pick a location before saving.");

  // The PO can't be built without these, so a blank here fails at the database
  // with SQLSTATE 22023 rather than anything a user could act on.
  const initials = strField(formData, "po_initials");
  if (!initials) {
    fail(
      formData,
      "Enter your initials — the PO number is built from them and can't be assigned without them."
    );
  }
  if (!/^[A-Za-z]{1,4}$/.test(initials)) {
    fail(
      formData,
      "Initials must be 1–4 letters: no spaces, digits or punctuation."
    );
  }
  // NOT uppercased here. insert_expense_entry() does it on the way in, and
  // normalising in two places is how the stored value and the displayed one
  // eventually disagree.

  const categoryKey = strField(formData, "category_key");
  if (!categoryKey) fail(formData, "Pick a category before saving.");

  // Presence only. The sign is deliberately not checked — a refund or credit
  // memo is negative and the schema has no >= 0 constraint on `amount`. Blank
  // is rejected because a coerced blank would land as a real 0.00 entry and
  // silently take a PO number with it.
  const amount = strField(formData, "amount");
  if (!amount) {
    fail(
      formData,
      "Enter an amount. Refunds and credits go in as a negative number."
    );
  }

  const result = await performancePostJson("/pertrack/api/expenses/entries", {
    business_date: businessDate,
    location_id: locationId,
    po_initials: initials,
    // Free text by design — the workbook's METHOD column has no fixed
    // vocabulary. The form offers a datalist, not a closed select.
    method: strOrNull(formData, "method"),
    description: strOrNull(formData, "description"),
    category_key: categoryKey,
    amount
  });

  if (!result.ok) fail(formData, result.error);

  const po = poNumberOf(result.body);

  revalidatePath(LIST_PATH);
  redirect(
    backTo(formData, {
      success: "entry",
      ...(po ? { po } : {}),
      t: transportTag(result)
    })
  );
}

/**
 * Void an entry. THIS IS THE ONLY DELETE, AND IT IS NOT A DELETE.
 *
 * The row stays, `voided_at` is stamped, and every read filters it out. A money
 * log reconciles against paper invoices: a row that vanishes leaves a hole in
 * the PO sequence with nothing to explain it, and the sequence keeps the gap
 * either way because next_expense_po() counts voided rows too.
 *
 * THE REASON IS REQUIRED HERE BUT NULLABLE IN THE DATABASE. That is not an
 * oversight in either place — the column is nullable because history predates
 * the rule and because a backfill shouldn't be forced to invent one, and the UI
 * requires it because a void with no explanation is exactly the hole that soft
 * delete exists to avoid.
 */
export async function voidExpenseAction(formData: FormData): Promise<void> {
  const id = strField(formData, "id");
  if (!id) fail(formData, "Nothing to void — no entry was identified.");

  const reason = strField(formData, "reason");
  if (!reason) {
    fail(
      formData,
      "A void needs a reason. It stays on the record next to the PO number, which is not reissued."
    );
  }

  const result = await performancePostJson(
    "/pertrack/api/expenses/entries/void",
    { id, reason }
  );

  if (!result.ok) fail(formData, result.error);

  revalidatePath(LIST_PATH);
  redirect(backTo(formData, { success: "void" }));
}

/**
 * Set (or re-set) one category's budget for one site for one month.
 *
 * ONE CATEGORY PER SUBMIT, matching the worker's endpoint. The editor therefore
 * renders one small form per category rather than one form with thirteen
 * inputs — a single form would have to fan out into thirteen POSTs and report a
 * partial failure, which is a worse thing to build and a worse thing to read.
 *
 * THERE IS NO WAY TO UNSET A BUDGET. The contract has no delete, and blank is
 * rejected below rather than being sent as 0 — "no budget" and "a budget of
 * zero" are different states on the grid and posting one as the other would
 * erase the distinction the whole rollup is careful to preserve.
 */
export async function saveBudgetAction(formData: FormData): Promise<void> {
  const periodMonth = strField(formData, "period_month");
  if (!periodMonth) fail(formData, "No month was submitted with the budget.");

  const locationId = strField(formData, "location_id");
  if (!locationId) fail(formData, "Pick a location before setting a budget.");

  const categoryKey = strField(formData, "category_key");
  if (!categoryKey) fail(formData, "No category was submitted with the budget.");

  const budgetAmount = strField(formData, "budget_amount");
  if (!budgetAmount) {
    fail(
      formData,
      "Enter a budget amount. Leaving it blank does not clear an existing budget — there is no way to unset one."
    );
  }
  // Caught here because the same page accepts negative ENTRY amounts two cards
  // up, so "negative is fine" is a live assumption for the user. A budget is a
  // ceiling; a negative ceiling makes the variance arithmetic meaningless, and
  // the database CHECK would otherwise reject this with a constraint name.
  if (budgetAmount.startsWith("-")) {
    fail(
      formData,
      "A budget is a ceiling and can't be negative. (Entry amounts can be — a refund is negative — but budgets can't.)"
    );
  }

  const result = await performancePostJson("/pertrack/api/expenses/budgets", {
    period_month: periodMonth,
    location_id: locationId,
    category_key: categoryKey,
    budget_amount: budgetAmount,
    note: strOrNull(formData, "note")
  });

  if (!result.ok) fail(formData, result.error);

  revalidatePath(LIST_PATH);
  redirect(
    backTo(
      formData,
      wasCorrected(result.body)
        ? { success: "budget", corrected: "1" }
        : { success: "budget" }
    )
  );
}

/**
 * Carry a site's budget forward from one month to another.
 *
 * DOES NOT OVERWRITE. copy_expense_budget_month() is ON CONFLICT DO NOTHING, so
 * a category already budgeted in the target month keeps its own number whatever
 * order the copy and the edit happen in. Re-running is safe, which is why the
 * button has no confirmation step. The response's `created` count is the number
 * ACTUALLY inserted, not the number in the source month — surfaced in the
 * banner so a copy that did nothing says so instead of claiming success.
 */
export async function copyBudgetMonthAction(formData: FormData): Promise<void> {
  const locationId = strField(formData, "location_id");
  if (!locationId) fail(formData, "Pick a location before copying a budget.");

  const fromMonth = strField(formData, "from_month");
  const toMonth = strField(formData, "to_month");
  if (!fromMonth || !toMonth) {
    fail(formData, "A copy needs both a source month and a target month.");
  }
  // The function raises 22023 for this, but the message it produces reads like
  // a database error rather than the plain mistake it is.
  if (fromMonth === toMonth) {
    fail(formData, "Source and target month are the same — nothing to copy.");
  }

  const result = await performancePostJson(
    "/pertrack/api/expenses/budgets/copy",
    { location_id: locationId, from_month: fromMonth, to_month: toMonth }
  );

  if (!result.ok) fail(formData, result.error);

  const created = createdCountOf(result.body);

  revalidatePath(LIST_PATH);
  redirect(
    backTo(
      formData,
      created === null
        ? { success: "copy" }
        : { success: "copy", created }
    )
  );
}
