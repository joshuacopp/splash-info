"use client";

// Interactive week-grid calendar for a single location's Beekeeper shifts.
//
// Seven Mon–Sun day columns; shifts render as chips bucketed by their ET
// `startDate` (the worker already hands back ET calendar/clock parts, so the
// grid needs no UTC math). Clicking a chip opens the editor; each column's
// "+ Add" prefills that day's date. Create/update/delete post same-origin to
// /schedule/api/loc/{code}/... — Cloudflare routes /schedule/api/* to
// beekeeper-worker, which enforces auth, overlap validation, and audit.

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  RosterMember,
  ShiftView,
  UnavailabilityMarker,
  WeekBudget
} from "../_lib/worker-fetch";

/* ============================================================
 * Pure date helpers (no server imports — safe in a client island).
 * ============================================================ */

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function queryWindow(monday: string): { startIso: string; endIso: string } {
  return {
    startIso: `${addDays(monday, -1)}T00:00:00Z`,
    endIso: `${addDays(monday, 8)}T00:00:00Z`
  };
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayHeader(dateStr: string): { weekday: string; label: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun
  const weekday = WEEKDAY[(dow + 6) % 7]!;
  return { weekday, label: `${m}/${d}` };
}

function weekRangeLabel(monday: string): string {
  const [, sm, sd] = monday.split("-").map(Number);
  const sunday = addDays(monday, 6);
  const [, em, ed] = sunday.split("-").map(Number);
  return `${sm}/${sd} – ${em}/${ed}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function fmt12(h: number, m: number): string {
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "AM" : "PM";
  return m === 0 ? `${h12} ${ap}` : `${h12}:${pad(m)} ${ap}`;
}

/** Compact hour label for shift titles: no AM/PM (implied by the shift), minutes
 *  glued on when non-zero. 8:00 -> "8", 7:30 -> "730", 20:30 -> "830". */
function fmtCompact(h: number, m: number): string {
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}` : `${h12}${pad(m)}`;
}

const MINUTE_STEPS = [0, 15, 30, 45];

/** Snap an arbitrary minute to the nearest quarter for the dropdowns. */
function snapMinute(m: number): number {
  if (MINUTE_STEPS.includes(m)) return m;
  return m < 8 ? 0 : m < 23 ? 15 : m < 38 ? 30 : m < 53 ? 45 : 0;
}

/** Whole-day delta between two YYYY-MM-DD strings (b - a). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86400000
  );
}

/** Duration of a shift in minutes, spanning midnight via endDate.
 *
 *  CAVEAT (pre-existing, deliberately not fixed here): this is WALL-CLOCK
 *  minutes. An overnight that crosses a DST boundary is off by an hour in
 *  whichever direction the clock moved, so it is mispriced. Every consumer
 *  below inherits that, including the meal-break threshold. */
function shiftDurationMinutes(s: ShiftView): number {
  const startMin = s.startHour * 60 + s.startMinute;
  const endMin = s.endHour * 60 + s.endMinute;
  return daysBetween(s.startDate, s.endDate) * 1440 + endMin - startMin;
}

/** Unpaid meal break deducted from a long shift, in minutes. */
const MEAL_BREAK_MINUTES = 30;

/** The break applies to a shift running STRICTLY longer than this. An exactly
 *  6h shift keeps all 360 of its minutes; 361 drops to 331. */
const MEAL_BREAK_THRESHOLD_MINUTES = 360;

/** PAID minutes for one shift: scheduled clock time less the unpaid meal break
 *  a shift over 6h has to take. 7:30a-4:00p is 510 clock minutes and 480 paid.
 *
 *  This is the number every hours label AND every dollar figure on the grid is
 *  built from, so the day column, the per-employee table and the cost math can
 *  never disagree about how long a shift was.
 *
 *  It is a separate function rather than a redefinition of
 *  shiftDurationMinutes because "how long is this person on the property" is a
 *  real and different question — coverage, overlap, the chip's own time label —
 *  and a future caller asking it should not silently be handed payroll's
 *  answer. The break is deducted once per SHIFT, not per day: two 4h shifts on
 *  one day are two short shifts, and neither earns a break.
 *
 *  Inherits the DST caveat above: the threshold is tested against wall-clock
 *  minutes, exactly as the pricing already was, so this neither fixes nor
 *  worsens that case. */
function paidMinutes(s: ShiftView): number {
  const raw = shiftDurationMinutes(s);
  return raw > MEAL_BREAK_THRESHOLD_MINUTES ? raw - MEAL_BREAK_MINUTES : raw;
}

/** Compact hours label: 480 -> "8", 510 -> "8.5", 495 -> "8.25". */
function fmtHours(min: number): string {
  return `${Math.round((min / 60) * 100) / 100}`;
}

/* ============================================================
 * Payroll cost model.
 *
 * This grid exists to help keep a week inside a MONTHLY payroll budget, so the
 * numbers below are split into the part scheduling moves and the part it does
 * not:
 *
 *   variable = sum over HOURLY shifts of (hours x rate) — the lever the writer
 *              actually pulls when dragging shifts around.
 *   salaried = roster members on salary, priced at their hourly-equivalent
 *              rate x SALARY_WEEK_HOURS — a flat weekly baseline that does NOT
 *              move when a salaried person is given more or fewer shifts.
 *
 * Pricing salaried staff per shift would be actively harmful: it would teach
 * the schedule writer that under-scheduling a GM makes the day look cheaper,
 * when in truth their hours are the one free lever on the board. So salaried
 * shifts contribute $0 to the day and their cost is carried exactly once, in
 * the week baseline.
 *
 * Beekeeper's `rate` custom field is an HOURLY-EQUIVALENT figure for salaried
 * staff too (confirmed against the tenant: 42.00 ~ $87k/yr for a GM), which is
 * why the same number is multiplied by hours in both branches.
 *
 * PAID TIME, NOT CLOCK TIME. A single shift running over 6h (strictly more
 * than 360 minutes — an exact 6h keeps all of it) loses 30 minutes of paid
 * time to an unpaid meal break. That deduction lives in paidMinutes(), one
 * layer above the raw shiftDurationMinutes(), and EVERY consumer on this grid
 * goes through it: the day column's "Nh scheduled", the per-employee table,
 * and the dollar math. Deducting in the money path only would have been the
 * cheap fix and the wrong one — the writer would read 8.5h next to 8h of pay
 * and reasonably conclude one of the two was lying. The break is per SHIFT,
 * not per day: two 4h shifts in a day are two short shifts and neither earns
 * one. shiftDurationMinutes() is deliberately left alone so that a caller who
 * genuinely wants clock presence (coverage, overlap) can still ask for it.
 *
 * AGAINST THE BUDGET, THE SPLIT DOES NOT CLOSE BACK UP — IT MOVES SIDES.
 * site_monthly_targets.labor_budget is all-in labor dollars: it was set with
 * the salaried managers already in it. The old form honoured that by ADDING a
 * day's share of the baseline to spend and comparing the sum to the raw
 * allowance ("$909 of $774"). Arithmetically fine, behaviourally bad: it
 * buried a cost the schedule writer cannot influence inside the one number
 * they are being asked to steer, so a day read as over budget because of a
 * manager's salary and no amount of dragging shifts would fix it.
 *
 * So the baseline is now SUBTRACTED from the allowance instead: the same day
 * reads "$669 of $534". Both sides of that comparison are now hourly, and an
 * allowance means "dollars left for hourly labor" — something the writer can
 * actually act on. The variance is untouched (669 - 534 == 909 - 774 == 135);
 * only which side of the subtraction the salaried term sits on has changed.
 * The week card is netted identically so the two framings cannot drift.
 *
 * A day's share of the baseline is still salaried.weekly / 7, matching the
 * worker's even-by-calendar-day proration of the budget itself; dividing by 5
 * or by "open days" on one side of that comparison and not the other is how
 * the two halves silently stop meaning the same thing.
 *
 * A NET ALLOWANCE MAY GO NEGATIVE, and it is left negative rather than clamped
 * at $0. If the managers alone outspend the day's slice, the day is over
 * before a single hourly shift exists, and that is the true statement; a
 * clamp to zero would both hide it and break the variance identity above.
 * It renders as "-$66" in amber with a tooltip saying so.
 *
 * NULL IS NOT ZERO, still and always. An unbudgeted month yields a null
 * allowance and renders NOTHING — netting a baseline out of "no budget set"
 * would manufacture a negative allowance out of thin air, so the null check
 * happens first and short-circuits. unbudgetedDays keeps flagging partial
 * weeks, where the week figure is a floor.
 * ============================================================ */

/** Hours a salaried employee's weekly baseline is priced at. */
const SALARY_WEEK_HOURS = 40;

/** True for a salaried pay type. Beekeeper returns "Salary" | "Hourly"; the
 *  compare is case-insensitive because the value is typed by an admin. */
function isSalaried(payType: string | null | undefined): boolean {
  return (payType ?? "").trim().toLowerCase() === "salary";
}

/** Whole-dollar money label. Cents are noise at this scale and would wrap the
 *  narrow day columns. Negatives render "-$66", not "$-66": a net allowance can
 *  legitimately go below zero once the salaried baseline is taken out of it,
 *  and that has to read as a deficit rather than as a typo. */
function fmtMoney(dollars: number): string {
  const n = Math.round(dollars);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US")}`;
}

/** Dollars a day may run past its net hourly allowance before the line stops
 *  being a nudge and becomes a problem. Inclusive on both ends of the amber
 *  band: a day landing EXACTLY on its allowance is already amber, not green —
 *  spending the last dollar means there is no room left for the shift that
 *  gets added tomorrow, and the operator asked to see that coming. */
const BUDGET_OVER_TOLERANCE = 20;

type BudgetBand = "under" | "at" | "over";

/** Which band a day's hourly spend falls in against its net hourly allowance.
 *
 *  A null allowance has NO band. An unbudgeted month is not "under budget", it
 *  is unknown, and the day line renders nothing at all rather than a reassuring
 *  green — same contract the rest of the budget path holds to.
 *
 *  The test is on the VARIANCE (spent - net), which is the real dollars over
 *  whatever the sign of net. A negative allowance — salaried managers alone
 *  past the day's slice — therefore needs no special case: at net -$66 even
 *  $0 of hourly is $66 over and lands in "over" on its own, while a net of
 *  -$10 with nothing scheduled is $10 over and amber, which is the honest
 *  reading of a day that is barely past its slice. Clamping or hard-coding
 *  negative net to red would have broken that gradient for no gain. */
function budgetBand(spent: number, net: number | null): BudgetBand | null {
  if (net === null) return null;
  if (spent < net) return "under";
  return spent <= net + BUDGET_OVER_TOLERANCE ? "at" : "over";
}

/** Tone per band. Amber is the warning color this file already uses; green and
 *  red sit on the same 700 step so the three read as one scale rather than
 *  three borrowed palettes. Red alone adds weight and a wash, so the worst days
 *  are still the ones that jump out on a black-and-white printout. */
const BUDGET_BAND_CLASS: Record<BudgetBand, string> = {
  under: "text-green-700",
  at: "text-amber-700",
  over: "bg-red-50 font-semibold text-red-700",
};

/** Format an unavailability marker's time range. Times are "HH:MM" 24h strings
 *  straight off the form; a blank on either end means the employee didn't scope
 *  it, so we read it as all-day. */
function fmtMarkerRange(start: string, end: string): string {
  const parse = (t: string): [number, number] | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2])];
  };
  const s = parse(start);
  const e = parse(end);
  if (!s || !e) return "All day";
  return `${fmt12(s[0]!, s[1]!)} – ${fmt12(e[0]!, e[1]!)}`;
}

/* ============================================================
 * Shift colors + presets.
 *
 * `color` is stored on the shift as metadata.color (a hex string) and
 * round-trips to Beekeeper's own scheduler, so a color set here shows up
 * identically on both splashcarwashes.info and the Beekeeper app.
 * ============================================================ */

const SHIFT_COLORS = {
  unavailableAllDay: "#F4B6B6", // light red
  ptoFull: "#8B5CF6", // purple
  ptoHalf: "#C4B5FD", // lighter purple
  unavailable: "#FACC15", // yellow (partial-day unavailable)
  manager: "#9CA3AF", // grey
  csa: "#22C55E", // green
  attendant: "#3B82F6" // blue
} as const;

/** Colors that mark time-OFF / unavailability, not worked coverage. Excluded
 *  from the daily + weekly hour totals so PTO and all-day "Unavailable" markers
 *  (0:00–23:59 ≈ 24h) don't inflate the numbers. */
const NON_WORKING_COLORS = new Set<string>([
  SHIFT_COLORS.unavailableAllDay,
  SHIFT_COLORS.ptoFull,
  SHIFT_COLORS.ptoHalf,
  SHIFT_COLORS.unavailable
]);

/** A shift counts toward scheduled hours unless it's tagged a non-working
 *  color. Compared case-insensitively — colors round-trip through Beekeeper,
 *  which may hand hex back lowercased. */
function isWorkingShift(s: ShiftView): boolean {
  return !(s.color && NON_WORKING_COLORS.has(s.color.toUpperCase()));
}

/** Presets that set the full shift (times + title + color) in one click. */
interface TimePreset {
  key: string;
  label: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  title: string;
  color: string;
}

const TIME_PRESETS: TimePreset[] = [
  {
    key: "unavail-all",
    label: "Unavailable — all day",
    startHour: 0,
    startMinute: 0,
    endHour: 23,
    endMinute: 59,
    title: "Unavailable",
    color: SHIFT_COLORS.unavailableAllDay
  },
  {
    key: "pto-full",
    label: "PTO — full day",
    startHour: 8,
    startMinute: 0,
    endHour: 16,
    endMinute: 0,
    title: "PTO",
    color: SHIFT_COLORS.ptoFull
  },
  {
    key: "pto-half",
    label: "PTO — half day",
    startHour: 8,
    startMinute: 0,
    endHour: 12,
    endMinute: 0,
    title: "PTO (half day)",
    color: SHIFT_COLORS.ptoHalf
  }
];

/** Role presets: set the color (role -> color) and a TIME-PREFIXED title
 *  (e.g. "8 AM–1 PM Manager"), NOT the bare role word. Beekeeper's grid lanes
 *  shifts by title, so a bare "Manager" collapses every manager under one
 *  header and breaks the linear coverage view. A time-prefixed title is unique
 *  per start time, so Beekeeper renders shifts in start-time order while the
 *  color still codes the role and the role word stays in the label. */
interface TitlePreset {
  /** Role word appended after the time prefix. */
  role: string;
  color: string;
}

const TITLE_PRESETS: TitlePreset[] = [
  { role: "Manager", color: SHIFT_COLORS.manager },
  { role: "CSA", color: SHIFT_COLORS.csa },
  { role: "Attendant", color: SHIFT_COLORS.attendant }
];

/** Inline style for a colored chip — soft tinted fill with a solid color
 *  border. `color` is a hex like "#8B5CF6"; the "22" suffix is ~13% alpha. */
function chipStyle(color: string): React.CSSProperties {
  return { backgroundColor: `${color}22`, borderColor: color };
}

/* ============================================================
 * Component
 * ============================================================ */

interface FormState {
  mode: "add" | "edit";
  editingId: string | null;
  userId: string;
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  title: string;
  /** Hex color string, or "" for none. */
  color: string;
}

interface Props {
  locationCode: string;
  locationName: string;
  roster: RosterMember[];
  initialMonday: string;
  initialShifts: ShiftView[];
  initialShiftsError: string | null;
}

export function ScheduleWeekGrid({
  locationCode,
  locationName,
  roster,
  initialMonday,
  initialShifts,
  initialShiftsError
}: Props) {
  const [monday, setMonday] = useState(initialMonday);
  const [shifts, setShifts] = useState<ShiftView[]>(initialShifts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialShiftsError);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [unavail, setUnavail] = useState<UnavailabilityMarker[]>([]);
  const [budget, setBudget] = useState<WeekBudget | null>(null);

  const apiBase = `/schedule/api/loc/${encodeURIComponent(locationCode)}`;
  const days = useMemo(() => weekDates(monday), [monday]);

  const api = useCallback(
    async (path: string, opts?: RequestInit): Promise<Record<string, unknown>> => {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        ...opts
      });
      if (res.status === 401)
        throw new Error("Not signed in — sign in on the dashboard, then reload.");
      if (res.status === 403)
        throw new Error("You don't have access to this location's schedule.");
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const details = data.details as { message: string }[] | undefined;
        if (Array.isArray(details))
          throw new Error(details.map((d) => d.message).join("; "));
        throw new Error((data.error as string) || `Error ${res.status}`);
      }
      return data;
    },
    []
  );

  const loadShifts = useCallback(
    async (mon: string) => {
      setLoading(true);
      setError(null);
      try {
        const { startIso, endIso } = queryWindow(mon);
        const data = await api(
          `${apiBase}/shifts?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`
        );
        setShifts((data.shifts as ShiftView[]) || []);
      } catch (e) {
        setShifts([]);
        setError(e instanceof Error ? e.message : "Failed to load shifts.");
      } finally {
        setLoading(false);
      }
    },
    [api, apiBase]
  );

  // Refetch whenever the visible week changes (skip the SSR'd initial week).
  useEffect(() => {
    if (monday === initialMonday) return;
    void loadShifts(monday);
  }, [monday, initialMonday, loadShifts]);

  // Approved-unavailability overlay. Read-only; not SSR'd, so it loads on mount
  // AND on every week change. Fails soft — a fetch error just leaves the overlay
  // empty (logged) rather than blocking the schedule.
  const loadUnavailability = useCallback(
    async (mon: string) => {
      const start = mon;
      const end = addDays(mon, 6);
      try {
        const data = await api(
          `${apiBase}/unavailability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
        );
        setUnavail((data.unavailability as UnavailabilityMarker[]) || []);
      } catch {
        setUnavail([]);
      }
    },
    [api, apiBase]
  );

  useEffect(() => {
    void loadUnavailability(monday);
  }, [monday, loadUnavailability]);

  // Labor budget allowance for the visible week. Same posture as the
  // unavailability overlay: not SSR'd, reloaded on every week change, and fails
  // soft. A budget that will not load leaves the comparison off the screen
  // entirely rather than showing an allowance of $0, which would read as "you
  // are massively over" when the truth is "we do not know".
  const loadBudget = useCallback(
    async (mon: string) => {
      try {
        const data = await api(`${apiBase}/budget?monday=${encodeURIComponent(mon)}`);
        setBudget(data as unknown as WeekBudget);
      } catch {
        setBudget(null);
      }
    },
    [api, apiBase]
  );

  useEffect(() => {
    void loadBudget(monday);
  }, [monday, loadBudget]);

  const unavailByDay = useMemo(() => {
    const map = new Map<string, UnavailabilityMarker[]>();
    for (const d of days) map.set(d, []);
    for (const u of unavail) map.get(u.date)?.push(u);
    return map;
  }, [days, unavail]);

  const shiftsByDay = useMemo(() => {
    const map = new Map<string, ShiftView[]>();
    for (const d of days) map.set(d, []);
    for (const s of shifts) {
      const bucket = map.get(s.startDate);
      if (bucket) bucket.push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute));
    }
    return map;
  }, [days, shifts]);

  // PAID minutes bucketed by day (non-working markers excluded) — powers the
  // per-column daily total under "+ Add". Paid, not clock: the unpaid meal
  // break is already out, so this line and the dollar line below it are two
  // views of the same minutes.
  const dailyMinutes = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of days) map.set(d, 0);
    for (const s of shifts) {
      if (!isWorkingShift(s)) continue;
      const cur = map.get(s.startDate);
      if (cur !== undefined) map.set(s.startDate, cur + paidMinutes(s));
    }
    return map;
  }, [days, shifts]);

  // Variable payroll cost bucketed by day: HOURLY shifts only, priced
  // hours x rate. Salaried shifts are deliberately $0 here — see the payroll
  // cost model note above. `unrated` counts working shifts that carry no rate
  // (open/unassigned shifts, or an employee whose Beekeeper rate was never
  // entered); those add $0, so the day is UNDERSTATED and has to say so rather
  // than silently reading as cheap.
  const dailyCost = useMemo(() => {
    const map = new Map<string, { variable: number; unrated: number }>();
    for (const d of days) map.set(d, { variable: 0, unrated: 0 });
    for (const s of shifts) {
      if (!isWorkingShift(s)) continue;
      const cell = map.get(s.startDate);
      if (!cell) continue;
      if (isSalaried(s.payType)) continue;
      if (typeof s.rate !== "number") {
        cell.unrated += 1;
        continue;
      }
      cell.variable += (paidMinutes(s) / 60) * s.rate;
    }
    return map;
  }, [days, shifts]);

  // Flat weekly cost of everyone on salary at this location, whether or not
  // they appear on the grid — they are paid the same either way and the
  // monthly budget still has to carry them. Salaried members with no rate
  // entered are counted separately so the baseline can admit it is incomplete.
  const salaried = useMemo(() => {
    let weekly = 0;
    let unrated = 0;
    for (const r of roster) {
      if (!isSalaried(r.payType)) continue;
      if (typeof r.rate !== "number") {
        unrated += 1;
        continue;
      }
      weekly += r.rate * SALARY_WEEK_HOURS;
    }
    return { weekly, unrated };
  }, [roster]);

  const weekVariable = useMemo(
    () => days.reduce((sum, d) => sum + (dailyCost.get(d)?.variable ?? 0), 0),
    [days, dailyCost]
  );
  const weekUnrated = useMemo(
    () => days.reduce((sum, d) => sum + (dailyCost.get(d)?.unrated ?? 0), 0),
    [days, dailyCost]
  );

  /* ---- Budget comparison -------------------------------------------------
   * Everything below is null-safe on purpose: no budget row for the month is a
   * normal, supported state, and it must render as an absent comparison rather
   * than as a zero allowance. */

  /** Allowance dollars keyed by ET date, from the worker's proration. */
  const allowanceByDay = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const d of budget?.days ?? []) map.set(d.date, d.allowance);
    return map;
  }, [budget]);

  /** One day's share of the flat weekly salaried baseline. Divided by 7, not by
   *  a workweek: the budget it is netted out of was prorated across all seven
   *  calendar days too. */
  const salariedDaily = useMemo(() => salaried.weekly / 7, [salaried.weekly]);

  /** A day's allowance with the salaried baseline already taken out — the
   *  dollars actually available for HOURLY labor. Null stays null: an
   *  unconfigured month has no allowance to net anything out of, and must not
   *  become a negative one. May be negative when it is a number, and that is
   *  meaningful rather than a bug — see the note on the day line. */
  const netAllowanceByDay = useCallback(
    (date: string): number | null => {
      const gross = allowanceByDay.get(date);
      return typeof gross === "number" ? gross - salariedDaily : null;
    },
    [allowanceByDay, salariedDaily]
  );

  /** Hourly-only scheduled cost for a day — the figure now compared to the net
   *  allowance, and the only half of payroll the writer can move. */
  const dayHourly = useCallback(
    (date: string) => dailyCost.get(date)?.variable ?? 0,
    [dailyCost]
  );

  const weekTotal = weekVariable + salaried.weekly;

  /** The week card's allowance, netted the same way the day lines are so the
   *  two framings cannot drift apart. Null-safe on the same contract. */
  const netWeekAllowance =
    typeof budget?.weekAllowance === "number"
      ? budget.weekAllowance - salaried.weekly
      : null;

  // PAID minutes per employee for the visible week — powers the summary panel.
  // Keyed by userId; "" collects open/unassigned shifts. Same meal-break
  // deduction as the day columns and the cost math, so an employee's row here
  // is exactly the hours they will be paid for.
  const weeklyByUser = useMemo(() => {
    const inWeek = new Set(days);
    const map = new Map<string, number>();
    for (const s of shifts) {
      if (!inWeek.has(s.startDate) || !isWorkingShift(s)) continue;
      const key = s.userId || "";
      map.set(key, (map.get(key) ?? 0) + paidMinutes(s));
    }
    return map;
  }, [days, shifts]);

  const weeklyRows = useMemo(
    () =>
      roster
        .map((r) => ({ id: r.id, name: r.name, minutes: weeklyByUser.get(r.id) ?? 0 }))
        .filter((r) => r.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes),
    [roster, weeklyByUser]
  );
  const openMinutes = weeklyByUser.get("") ?? 0;
  const weekTotalMinutes = useMemo(
    () => [...weeklyByUser.values()].reduce((a, b) => a + b, 0),
    [weeklyByUser]
  );

  const rosterName = useCallback(
    (id: string) => roster.find((r) => r.id === id)?.name ?? id,
    [roster]
  );

  function openAdd(date: string) {
    setOkMsg(null);
    setError(null);
    setForm({
      mode: "add",
      editingId: null,
      userId: roster[0]?.id ?? "",
      date,
      startHour: 9,
      startMinute: 0,
      endHour: 17,
      endMinute: 0,
      title: "",
      color: ""
    });
  }

  function openEdit(s: ShiftView) {
    setOkMsg(null);
    setError(null);
    setForm({
      mode: "edit",
      editingId: s.id,
      userId: s.userId,
      date: s.startDate,
      startHour: s.startHour,
      startMinute: snapMinute(s.startMinute),
      endHour: s.endHour,
      endMinute: snapMinute(s.endMinute),
      title: s.title || "",
      color: s.color ?? ""
    });
  }

  async function saveForm() {
    if (!form) return;
    // An empty userId is intentional — it creates an open/unassigned shift.
    if (!form.date) {
      setError("Pick a date.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      userId: form.userId,
      date: form.date,
      startHour: form.startHour,
      startMinute: form.startMinute,
      endHour: form.endHour,
      endMinute: form.endMinute,
      title: form.title.trim() || undefined,
      color: form.color || undefined
    });
    try {
      if (form.mode === "edit" && form.editingId) {
        await api(`${apiBase}/shifts/${encodeURIComponent(form.editingId)}`, {
          method: "PUT",
          body
        });
        setOkMsg("Shift updated.");
      } else {
        await api(`${apiBase}/shifts`, { method: "POST", body });
        setOkMsg("Shift added.");
      }
      setForm(null);
      await loadShifts(monday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteForm() {
    if (!form || !form.editingId) return;
    if (!window.confirm("Delete this shift?")) return;
    setSaving(true);
    setError(null);
    try {
      await api(`${apiBase}/shifts/${encodeURIComponent(form.editingId)}`, {
        method: "DELETE"
      });
      setOkMsg("Shift deleted.");
      setForm(null);
      await loadShifts(monday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setSaving(false);
    }
  }

  // Duplicate the shift currently open in the editor onto other days of the
  // visible week. Copies the values as they sit in the form, so you can tweak
  // the times and then fan them out in one go. Reuses the create endpoint once
  // per day rather than a bulk route, which keeps the worker's overlap
  // validation and audit logging in play for every copy. Days that can't take
  // the shift are skipped and named in the summary instead of aborting the
  // rest of the run.
  async function copyFormToDays(targets: string[]) {
    if (!form || targets.length === 0) return;
    setCopying(true);
    setError(null);
    setOkMsg(null);

    const copied: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const unattempted: string[] = [];
    let firstFailure = "";

    for (let i = 0; i < targets.length; i++) {
      const date = targets[i]!;

      // The worker only runs overlap detection for a named employee — an
      // open/unassigned shift has no one to collide with, so it would happily
      // accept the same shift twice and re-clicking Copy would stack
      // duplicates. Catch the exact-duplicate case here instead.
      const duplicate = shifts.some(
        (s) =>
          s.startDate === date &&
          s.userId === form.userId &&
          s.startHour === form.startHour &&
          s.startMinute === form.startMinute &&
          s.endHour === form.endHour &&
          s.endMinute === form.endMinute
      );
      if (duplicate) {
        skipped.push(date);
        continue;
      }

      const body = JSON.stringify({
        userId: form.userId,
        date,
        startHour: form.startHour,
        startMinute: form.startMinute,
        endHour: form.endHour,
        endMinute: form.endMinute,
        title: form.title.trim() || undefined,
        color: form.color || undefined
      });
      try {
        await api(`${apiBase}/shifts`, { method: "POST", body });
        copied.push(date);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "copy failed";
        // A rejection can arrive two ways: the worker's own check phrases it
        // "overlaps an existing shift for this employee (…)", and any upstream
        // 409 arrives as "Beekeeper rejected: shift conflict". The 409 covers
        // more than employee overlap, so the summary says "rejected as
        // conflicting" rather than diagnosing the cause.
        if (/overlap|conflict/i.test(msg)) skipped.push(date);
        else {
          failed.push(date);
          if (!firstFailure) firstFailure = msg;
          // Auth failures won't fix themselves on the next day, so stop rather
          // than firing the rest and stacking identical errors. Remember what
          // never got tried so the summary can't imply those days are done.
          if (/not signed in|don't have access/i.test(msg)) {
            unattempted.push(...targets.slice(i + 1));
            break;
          }
        }
      }
    }

    setCopying(false);
    // Only dismiss the editor when something actually landed — on a total
    // failure the form (and the day selection) is the only way to retry.
    if (copied.length) setForm(null);
    await loadShifts(monday);

    const names = (ds: string[]) => ds.map((d) => dayHeader(d).weekday).join(", ");
    const parts: string[] = [];
    if (copied.length) parts.push(`Copied to ${names(copied)}.`);
    if (skipped.length)
      parts.push(`Skipped ${names(skipped)} — already scheduled or rejected as conflicting.`);
    if (failed.length) parts.push(`Failed on ${names(failed)}: ${firstFailure}`);
    if (unattempted.length) parts.push(`Did not attempt ${names(unattempted)}.`);
    const summary = parts.join(" ");
    if (copied.length) setOkMsg(summary);
    else setError(summary || "Nothing copied.");
  }

  // Duplicate every shift in the visible week onto the same weekday next week
  // (date + 7). Reuses the create endpoint per shift so the worker still runs
  // its overlap/validation checks; shifts that collide with something already
  // next week are skipped and tallied rather than aborting the whole copy.
  async function copyWeekForward() {
    const src = shifts.filter((s) => days.includes(s.startDate));
    if (src.length === 0) {
      setError("No shifts this week to copy.");
      return;
    }
    const nextMon = addDays(monday, 7);
    if (
      !window.confirm(
        `Copy ${src.length} shift${src.length === 1 ? "" : "s"} into the week of ${weekRangeLabel(nextMon)}? Existing shifts there are kept; overlaps are skipped.`
      )
    )
      return;
    setCopying(true);
    setError(null);
    setOkMsg(null);
    let ok = 0;
    let failed = 0;
    for (const s of src) {
      const body = JSON.stringify({
        userId: s.userId || "",
        date: addDays(s.startDate, 7),
        startHour: s.startHour,
        startMinute: s.startMinute,
        endHour: s.endHour,
        endMinute: s.endMinute,
        title: s.title || undefined,
        color: s.color || undefined
      });
      try {
        await api(`${apiBase}/shifts`, { method: "POST", body });
        ok++;
      } catch {
        failed++;
      }
    }
    setCopying(false);
    setMonday(nextMon);
    await loadShifts(nextMon);
    setOkMsg(
      failed === 0
        ? `Copied ${ok} shift${ok === 1 ? "" : "s"} into this week. Adjust as needed.`
        : `Copied ${ok} shift${ok === 1 ? "" : "s"}; ${failed} skipped (overlap or validation). Adjust as needed.`
    );
  }

  const overnight =
    form != null &&
    form.endHour * 60 + form.endMinute <= form.startHour * 60 + form.startMinute;

  return (
    <>
      {/* EVERY on-screen affordance lives inside this one wrapper, and the
          wrapper is display:none in print. That containment is deliberate and
          is the whole safety argument: the dollar figures, the allowance
          lines, the payroll table and the per-employee hours are not hidden
          one-by-one (a list that would rot the first time someone adds a
          number), they are excluded as a block. The printed page is built
          from a separate, explicit subtree below that can only ever say
          name / title / time. */}
      <div className="print:hidden">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
            Beekeeper · {roster.length} employee{roster.length === 1 ? "" : "s"}
          </p>
          <h1 className="text-2xl font-bold text-splash-navy">
            Schedule · {locationName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonday(addDays(monday, -7))}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            ← Prev
          </button>
          <button
            type="button"
            onClick={() => setMonday(initialMonday)}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setMonday(addDays(monday, 7))}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-splash-navy">
          Week of {weekRangeLabel(monday)}
        </span>
        {loading ? (
          <span className="text-sm text-splash-navy/60">Loading…</span>
        ) : null}
        <button
          type="button"
          onClick={copyWeekForward}
          disabled={copying || loading || saving}
          className="ml-auto rounded-splash-md border border-gray-light bg-white px-4 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40 disabled:opacity-50"
        >
          {copying ? "Copying…" : "Copy week → next"}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-splash-md border border-gray-light bg-white px-4 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          title="Print the staff-facing week schedule — names, shift titles and times only. Pay rates, dollar costs and budget lines are never printed."
        >
          Print schedule
        </button>
        <button
          type="button"
          onClick={() => openAdd(days[0]!)}
          className="rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          + Add shift
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-splash-md border border-splash-deny/50 bg-splash-deny/10 px-4 py-3 text-sm text-splash-deny"
        >
          {error}
        </div>
      ) : null}
      {okMsg ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 rounded-splash-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800"
        >
          {okMsg}
        </div>
      ) : null}

      {roster.length === 0 ? (
        <div className="mb-4 rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-4 text-sm text-yellow-900">
          No assignable employees are cached for this location yet. A super_admin
          can refill the cache with the manual sync, after which employees appear
          here.
        </div>
      ) : null}

      {/* Seven-column week grid. Horizontal scroll on narrow viewports keeps
          the day columns readable rather than squashing them. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[900px] grid-cols-7 gap-2">
          {days.map((date) => {
            const { weekday, label } = dayHeader(date);
            const list = shiftsByDay.get(date) ?? [];
            return (
              <div
                key={date}
                className="flex min-h-[260px] flex-col rounded-splash-lg border border-gray-light bg-white"
              >
                <div className="flex items-baseline justify-between border-b border-gray-light px-3 py-2">
                  <span className="text-sm font-bold text-splash-navy">
                    {weekday}
                  </span>
                  <span className="text-xs text-splash-navy/60">{label}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => openEdit(s)}
                      style={s.color ? chipStyle(s.color) : undefined}
                      className={
                        s.color
                          ? "rounded-splash-md border px-2 py-1.5 text-left transition-opacity hover:opacity-80"
                          : "rounded-splash-md border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-2 py-1.5 text-left transition-colors hover:border-splash-blue hover:bg-sudsy-blue-soft/70"
                      }
                    >
                      <span className="block truncate text-xs font-semibold text-splash-navy">
                        {s.userName}
                      </span>
                      {s.title ? (
                        <span className="block truncate text-xs font-medium text-splash-navy/80">
                          {s.title}
                        </span>
                      ) : null}
                      <span className="block text-xs text-splash-navy/70">
                        {fmt12(s.startHour, s.startMinute)} –{" "}
                        {fmt12(s.endHour, s.endMinute)}
                        {s.endDate !== s.startDate ? (
                          <span className="text-splash-blue"> +1</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                  {(unavailByDay.get(date) ?? []).map((u) => (
                    <div
                      key={u.id}
                      title="Approved unavailability (read-only)"
                      className="rounded-splash-md border border-dashed border-amber-400 bg-amber-50 px-2 py-1"
                    >
                      <span className="block truncate text-xs font-semibold text-amber-900">
                        {u.name}
                      </span>
                      <span className="block text-xs text-amber-800/80">
                        Unavailable · {fmtMarkerRange(u.start, u.end)}
                      </span>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => openAdd(date)}
                    className="mt-auto rounded-splash-md border border-dashed border-gray-light px-2 py-1 text-xs font-medium text-splash-navy/50 hover:border-splash-blue hover:text-splash-blue"
                  >
                    + Add
                  </button>
                  <div className="mt-1 border-t border-gray-light pt-1 text-center text-[11px] font-semibold text-splash-navy/70">
                    {(dailyMinutes.get(date) ?? 0) > 0
                      ? `${fmtHours(dailyMinutes.get(date) ?? 0)}h scheduled`
                      : "—"}
                  </div>
                  {/* Hourly cost only — salaried staff are carried once in
                      the week baseline below, so this number moves if and only
                      if the writer changed something they control. */}
                  {(dailyCost.get(date)?.variable ?? 0) > 0 ||
                  (dailyCost.get(date)?.unrated ?? 0) > 0 ? (
                    <div className="text-center text-[11px] font-semibold tabular-nums text-splash-navy">
                      {fmtMoney(dailyCost.get(date)?.variable ?? 0)}
                      {(dailyCost.get(date)?.unrated ?? 0) > 0 ? (
                        <span
                          className="ml-1 font-medium text-amber-700"
                          title="These shifts have no pay rate in Beekeeper and count as $0, so this day is understated."
                        >
                          · {dailyCost.get(date)?.unrated} unrated
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {/* Hourly spend against this day's HOURLY allowance: the
                      month's slice with the salaried baseline already netted
                      out. Both sides of this comparison are now things the
                      schedule writer can move, which is the whole point — the
                      old form buried an unmovable manager cost inside the
                      number they were being asked to steer. The variance is
                      unchanged by the netting, only its framing. */}
                  {(() => {
                    const net = netAllowanceByDay(date);
                    const spent = dayHourly(date);
                    const band = budgetBand(spent, net);
                    if (net === null || band === null) return null;
                    const over = spent - net;
                    const daysInMonth =
                      budget?.months.find(
                        (m) => m.month === `${date.slice(0, 7)}-01`
                      )?.daysInMonth ?? 30;
                    return (
                      <div
                        className={`rounded-splash-md text-center text-[11px] tabular-nums ${BUDGET_BAND_CLASS[band]}`}
                        title={
                          (net < 0
                            ? `Salaried staff alone (${fmtMoney(salariedDaily)}/day) already exceed this day's 1/${daysInMonth} slice of the monthly labor budget, so there are no hourly dollars left before a single shift is written. Any hourly spend is over.`
                            : `Scheduled hourly cost against 1/${daysInMonth} of the month's labor budget, less this day's share of the salaried baseline (${fmtMoney(salariedDaily)}). What is left for hourly labor.`) +
                          (band === "under"
                            ? ` Under by ${fmtMoney(net - spent)}.`
                            : band === "at"
                              ? ` ${fmtMoney(over)} over the allowance, within the ${fmtMoney(BUDGET_OVER_TOLERANCE)} tolerance.`
                              : ` Over by ${fmtMoney(over)}, past the ${fmtMoney(BUDGET_OVER_TOLERANCE)} tolerance.`)
                        }
                      >
                        {fmtMoney(spent)} of {fmtMoney(net)}
                        {/* The band is never carried by color alone: the label
                            below states it in words and the dollar figure is
                            the threshold itself, so a printout or a colorblind
                            reader loses nothing. */}
                        <span className="ml-1 font-medium">
                          {band === "under"
                            ? `· ${fmtMoney(net - spent)} left`
                            : Math.round(over) === 0
                              ? "· at budget"
                              : `· ${fmtMoney(over)} over`}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-employee weekly hours. Non-working markers (PTO / Unavailable) are
          excluded so this reads as actual scheduled coverage. */}
      <div className="mt-6 rounded-splash-lg border border-gray-light bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-splash-navy">
          Hours per employee · week of {weekRangeLabel(monday)}
        </h2>
        {weeklyRows.length === 0 && openMinutes === 0 ? (
          <p className="text-sm text-splash-navy/60">
            No scheduled hours this week.
          </p>
        ) : (
          <table className="w-full max-w-md text-sm">
            <tbody>
              {weeklyRows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-gray-light/60 last:border-0"
                >
                  <td className="py-1.5 pr-4 text-splash-navy">{r.name}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-splash-navy">
                    {fmtHours(r.minutes)}h
                  </td>
                </tr>
              ))}
              {openMinutes > 0 ? (
                <tr className="border-b border-gray-light/60 last:border-0">
                  <td className="py-1.5 pr-4 italic text-splash-navy/70">
                    Open / unassigned
                  </td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-splash-navy">
                    {fmtHours(openMinutes)}h
                  </td>
                </tr>
              ) : null}
              <tr>
                <td className="pr-4 pt-2 font-bold text-splash-navy">Total</td>
                <td className="pt-2 text-right font-bold tabular-nums text-splash-navy">
                  {fmtHours(weekTotalMinutes)}h
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Payroll cost · week. Split so the budget conversation and the
          scheduling conversation stay separate: the hourly line is what this
          week's grid decided, the salaried line is what the location costs
          before anyone is scheduled at all. */}
      <div className="mt-4 rounded-splash-lg border border-gray-light bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-splash-navy">
          Payroll cost · week of {weekRangeLabel(monday)}
        </h2>
        <table className="w-full max-w-md text-sm">
          <tbody>
            <tr className="border-b border-gray-light/60">
              <td className="py-1.5 pr-4 text-splash-navy">
                Hourly (scheduled)
                {weekUnrated > 0 ? (
                  <span className="ml-1 text-xs font-medium text-amber-700">
                    · {weekUnrated} unrated
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 text-right font-semibold tabular-nums text-splash-navy">
                {fmtMoney(weekVariable)}
              </td>
            </tr>
            <tr className="border-b border-gray-light/60">
              <td className="py-1.5 pr-4 text-splash-navy">
                Salaried (fixed)
                {salaried.unrated > 0 ? (
                  <span className="ml-1 text-xs font-medium text-amber-700">
                    · {salaried.unrated} unrated
                  </span>
                ) : null}
              </td>
              <td className="py-1.5 text-right font-semibold tabular-nums text-splash-navy">
                {fmtMoney(salaried.weekly)}
              </td>
            </tr>
            <tr className={netWeekAllowance !== null ? "border-b border-gray-light/60" : undefined}>
              <td className="pr-4 pt-2 font-bold text-splash-navy">
                Week total
              </td>
              <td className="pt-2 text-right font-bold tabular-nums text-splash-navy">
                {fmtMoney(weekTotal)}
              </td>
            </tr>
            {/* Budget rows appear only when the month is configured. An
                unconfigured month renders nothing at all — a $0 allowance would
                claim the location may spend nothing, which is a real and very
                different statement from "nobody set a budget".

                The allowance shown is NET of the salaried baseline, matching
                the day columns: it is what remains for hourly labor. The
                over/under is therefore hourly-vs-net, which is the same
                number the old all-in-vs-gross form produced — netting moves
                the salaried term from one side of the subtraction to the
                other, it does not change the difference. */}
            {netWeekAllowance !== null && budget ? (
              <>
                <tr className="border-b border-gray-light/60">
                  <td className="py-1.5 pr-4 pt-2 text-splash-navy">
                    Hourly allowance
                    <span
                      className="ml-1 text-xs font-medium text-splash-navy/60"
                      title={`This location's week share of the monthly labor budget (${fmtMoney(budget.weekAllowance ?? 0)}) less the salaried baseline (${fmtMoney(salaried.weekly)}). What is left to spend on hourly labor.`}
                    >
                      · net of salaried
                    </span>
                    {budget.unbudgetedDays > 0 ? (
                      <span
                        className="ml-1 text-xs font-medium text-amber-700"
                        title="This week crosses into a month with no labor budget set, so those days contribute no allowance and this figure is a floor."
                      >
                        · {budget.unbudgetedDays} of 7 days unbudgeted
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={`py-1.5 pt-2 text-right font-semibold tabular-nums ${
                      netWeekAllowance < 0 ? "text-amber-700" : "text-splash-navy"
                    }`}
                  >
                    {fmtMoney(netWeekAllowance)}
                  </td>
                </tr>
                <tr>
                  <td className="pr-4 pt-2 font-bold text-splash-navy">
                    {weekVariable > netWeekAllowance ? "Over by" : "Remaining"}
                  </td>
                  <td className="pt-2 text-right font-bold tabular-nums text-splash-navy">
                    {fmtMoney(Math.abs(netWeekAllowance - weekVariable))}
                  </td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
        <p className="mt-2 max-w-md text-xs text-splash-navy/60">
          Salaried staff are priced at rate x {SALARY_WEEK_HOURS}h and do not
          change when their shifts do. Hourly shifts longer than 6h have a
          30-minute unpaid meal break taken out, so a 7:30&nbsp;AM&ndash;4&nbsp;PM
          shift counts as 8h of hours and of dollars alike. Shifts flagged as
          unrated have no pay rate in Beekeeper and count as $0, so the total is
          a floor rather than an estimate.
        </p>
        {netWeekAllowance !== null && budget ? (
          <p className="mt-1 max-w-md text-xs text-splash-navy/60">
            The allowance is this location&rsquo;s monthly labor budget split
            evenly across the days of the month
            {budget.months.length > 1
              ? " — a week spanning two months draws each day from its own month"
              : ""}
            . That budget covers all labor, so the salaried baseline is
            subtracted from it here and the remainder is compared to the hourly
            line: the figure above is the dollars still available for hourly
            labor, not the location&rsquo;s total. Over or under comes out the
            same either way — netting only puts both sides of the comparison
            under the schedule writer&rsquo;s control.
            {netWeekAllowance < 0
              ? " This week the salaried baseline alone exceeds the budget, so the allowance is negative and any hourly hour is over."
              : ""}
          </p>
        ) : null}
      </div>

      {form ? (
        <EditorModal
          form={form}
          roster={roster}
          overnight={overnight}
          saving={saving}
          rosterName={rosterName}
          weekDays={days}
          copying={copying}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={saveForm}
          onDelete={deleteForm}
          onCopy={copyFormToDays}
        />
      ) : null}
      </div>

      {/* Staff-facing printout. Same `days` and same `shiftsByDay` the grid
          renders from, so the printed order is not merely similar to the
          on-screen order, it is the identical already-sorted array. */}
      <SchedulePrintSheet
        locationName={locationName}
        monday={monday}
        days={days}
        shiftsByDay={shiftsByDay}
      />
    </>
  );
}

/* ============================================================
 * Print sheet
 *
 * The wall copy. Managers pin this in the break room, so it is a DIFFERENT
 * document from the grid above rather than a restyling of it: the grid is a
 * budgeting instrument (hourly dollars, allowances, over/under bands, payroll
 * totals, per-employee hours) and none of that may be legible to staff. Pay
 * rates and labor budgets are admin-visibility data and a printed page
 * carrying them is a real incident, not an aesthetic one.
 *
 * The safety property is structural, not a checklist. Two rules:
 *
 *   1. Everything the component renders on screen sits inside ONE
 *      `print:hidden` wrapper, so the whole budgeting surface leaves the page
 *      as a block. A number added to the grid tomorrow inherits that.
 *   2. This subtree names its fields explicitly — userName, title, the two
 *      fmt12 times, the +1 overnight flag — and touches nothing else on
 *      ShiftView. `rate` and `payType` ride along on every shift object and
 *      are simply never read here.
 *
 * `display: none` is the mechanism on both sides, and that matters: an element
 * with display:none generates no boxes at all, so it is absent from paged
 * media and from the text layer of a print-to-PDF. Had the grid been pushed
 * off-canvas, clipped, sized to zero or made transparent it would still be in
 * the box tree and a PDF's text layer would carry every dollar figure. It is
 * not hidden, it is not rendered.
 *
 * ORDER. Rendered straight from the grid's own `shiftsByDay` map, which is
 * already sorted by start time. There is no second sort here to drift from it.
 *
 * The unavailability overlay is deliberately NOT printed: those markers are
 * approved time-off requests, not shifts, and a wall page is the wrong place
 * to publish who asked for which day off.
 * ============================================================ */

/** Print-only page rules Tailwind cannot express.
 *
 *  LANDSCAPE, because seven columns down a portrait page gives each day about
 *  an inch and names wrap to gibberish. Landscape at Letter gives ~1.4in a
 *  column, which holds a full name and a "7:30 AM – 4 PM" range.
 *
 *  The site header is a direct child of <body> and would otherwise print a
 *  navy banner across the top of every wall copy. Scoped to a <style> inside
 *  this component rather than globals.css so the rule exists only while the
 *  schedule grid is mounted.
 *
 *  The explicit display rule on the sheet is belt-and-braces: `hidden
 *  print:block` already does it, but that relies on Tailwind emitting the
 *  print variant after the base utility. If it ever did not, the failure would
 *  be a blank page rather than a leak — safe, but useless — so the id rule
 *  pins it. */
const PRINT_SHEET_CSS = `
@media print {
  /*  margin:0 is load-bearing, not cosmetic. Chrome/Edge suppress the browser's
   *  own print headers and footers (date/time, document title, page URL, page
   *  number) only when the @page margin is zero — those four items are painted
   *  by the browser into the page margin box, so no selector can reach them.
   *  Zeroing the sheet margin removes the box they live in. The 0.4in then has
   *  to come back as padding on our own root, or the table runs into the
   *  printer's unprintable edge. */
  @page { size: landscape; margin: 0; }
  body > header { display: none !important; }
  #schedule-print-sheet { display: block !important; padding: 0.4in; }
}
`;

/** Location names come from the Beekeeper org unit and often already end in
 *  "Schedule" (e.g. "Vestal - 134 Schedule"), which made the printed heading
 *  read "... Schedule Schedule". Append the word only when it is not already
 *  the last one. */
function printTitle(locationName: string): string {
  return /\bschedule\s*$/i.test(locationName)
    ? locationName
    : `${locationName} Schedule`;
}

function SchedulePrintSheet({
  locationName,
  monday,
  days,
  shiftsByDay
}: {
  locationName: string;
  monday: string;
  days: string[];
  /** The grid's own by-day buckets, already sorted by start time. */
  shiftsByDay: Map<string, ShiftView[]>;
}) {
  return (
    <div id="schedule-print-sheet" className="hidden print:block">
      <style>{PRINT_SHEET_CSS}</style>

      <h1 className="text-xl font-bold text-black">{printTitle(locationName)}</h1>
      <p className="mb-3 text-sm text-black">
        Week of {weekRangeLabel(monday)}
      </p>

      {/* A table, not the on-screen grid: table-layout:fixed gives seven equal
          columns that a print engine will not collapse, and a long day breaks
          down its own column instead of pushing the others out of the page. */}
      <table className="w-full table-fixed border-collapse text-black">
        <thead>
          <tr>
            {days.map((date) => {
              const { weekday, label } = dayHeader(date);
              return (
                <th
                  key={date}
                  className="border border-black/40 px-1 py-1 text-center text-xs font-bold"
                >
                  {weekday} {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <tr>
            {days.map((date) => {
              const list = shiftsByDay.get(date) ?? [];
              return (
                <td
                  key={date}
                  className="border border-black/40 p-1 align-top"
                >
                  {list.length === 0 ? (
                    <span className="text-[10px] text-black/50">—</span>
                  ) : (
                    list.map((s) => (
                      <div
                        key={s.id}
                        className="mb-1 break-inside-avoid border-b border-black/15 pb-1 last:mb-0 last:border-0 last:pb-0"
                      >
                        <span className="block text-[11px] font-bold leading-tight">
                          {s.userName}
                        </span>
                        {s.title ? (
                          <span className="block text-[10px] leading-tight">
                            {s.title}
                          </span>
                        ) : null}
                        <span className="block text-[10px] leading-tight">
                          {fmt12(s.startHour, s.startMinute)} –{" "}
                          {fmt12(s.endHour, s.endMinute)}
                          {s.endDate !== s.startDate ? " +1" : ""}
                        </span>
                      </div>
                    ))
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ============================================================
 * Editor modal
 * ============================================================ */

function EditorModal({
  form,
  roster,
  overnight,
  saving,
  rosterName,
  weekDays,
  copying,
  onChange,
  onClose,
  onSave,
  onDelete,
  onCopy
}: {
  form: FormState;
  roster: RosterMember[];
  overnight: boolean;
  saving: boolean;
  rosterName: (id: string) => string;
  /** The seven ET dates of the visible week — the available copy targets. */
  weekDays: string[];
  copying: boolean;
  onChange: (f: FormState) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  onCopy: (targetDates: string[]) => void;
}) {
  // Copy-to-days panel state. Collapsed by default so the editor stays as
  // simple as it was for the common single-shift edit.
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<string[]>([]);

  const toggleTarget = (date: string) =>
    setCopyTargets((prev) =>
      prev.includes(date) ? prev.filter((d) => d !== date) : [...prev, date]
    );

  const copyLabel =
    copyTargets.length === 0
      ? "Pick days"
      : `Copy to ${copyTargets.length} day${copyTargets.length === 1 ? "" : "s"}`;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    onChange({ ...form, [k]: v });

  const applyTimePreset = (p: TimePreset) =>
    onChange({
      ...form,
      startHour: p.startHour,
      startMinute: p.startMinute,
      endHour: p.endHour,
      endMinute: p.endMinute,
      title: p.title,
      color: p.color
    });

  const applyTitlePreset = (p: TitlePreset) =>
    onChange({
      ...form,
      // Time-prefix the role so the title is unique per start time and Beekeeper
      // renders linearly by start instead of laning every same-role shift under
      // one header. Composed from the CURRENT times — set the times first, then
      // click the role (re-click if you change the times afterward).
      title: `${fmtCompact(form.startHour, form.startMinute)}-${fmtCompact(form.endHour, form.endMinute)} ${p.role}`,
      color: p.color
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-splash-navy/40 p-4"
      onClick={copying ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold text-splash-navy">
          {form.mode === "edit" ? "Edit shift" : "Add shift"}
        </h2>

        <div className="space-y-4">
          <Field label="Employee">
            <select
              value={form.userId}
              onChange={(e) => set("userId", e.target.value)}
              className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            >
              <option value="">Unassigned (open shift)</option>
              {roster.map((r) => (
                <option key={r.id} value={r.id}>
                  {rosterName(r.id)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Date">
            <input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            />
          </Field>

          <Field label="Presets">
            <div className="flex flex-wrap gap-1.5">
              {TIME_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyTimePreset(p)}
                  style={chipStyle(p.color)}
                  className="rounded-splash-md border px-2.5 py-1 text-xs font-semibold text-splash-navy transition-opacity hover:opacity-80"
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => set("color", SHIFT_COLORS.unavailable)}
                style={chipStyle(SHIFT_COLORS.unavailable)}
                className="rounded-splash-md border px-2.5 py-1 text-xs font-semibold text-splash-navy transition-opacity hover:opacity-80"
              >
                Unavailable (keep times)
              </button>
            </div>
          </Field>

          <Field label="Role">
            <div className="flex flex-wrap items-center gap-1.5">
              {TITLE_PRESETS.map((p) => (
                <button
                  key={p.role}
                  type="button"
                  onClick={() => applyTitlePreset(p)}
                  style={chipStyle(p.color)}
                  className="rounded-splash-md border px-2.5 py-1 text-xs font-semibold text-splash-navy transition-opacity hover:opacity-80"
                >
                  {p.role}
                </button>
              ))}
              {form.color ? (
                <button
                  type="button"
                  onClick={() => set("color", "")}
                  className="rounded-splash-md border border-gray-light px-2.5 py-1 text-xs font-medium text-splash-navy/60 hover:text-splash-navy"
                >
                  Clear color
                </button>
              ) : null}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Start">
              <TimeSelect
                hour={form.startHour}
                minute={form.startMinute}
                onHour={(h) => set("startHour", h)}
                onMinute={(m) => set("startMinute", m)}
              />
            </Field>
            <Field label="End">
              <TimeSelect
                hour={form.endHour}
                minute={form.endMinute}
                onHour={(h) => set("endHour", h)}
                onMinute={(m) => set("endMinute", m)}
              />
            </Field>
          </div>

          {overnight ? (
            <p className="text-xs font-medium text-splash-blue">
              → Overnight shift (ends the next day)
            </p>
          ) : null}

          <Field label="Title (optional)">
            <div className="flex items-center gap-2">
              {form.color ? (
                <span
                  aria-hidden
                  className="h-5 w-5 shrink-0 rounded-full border border-gray-light"
                  style={{ backgroundColor: form.color }}
                />
              ) : null}
              <input
                type="text"
                value={form.title}
                maxLength={80}
                placeholder="Auto-generated from the times"
                onChange={(e) => set("title", e.target.value)}
                className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
              />
            </div>
          </Field>

          {form.mode === "edit" ? (
            <div className="rounded-splash-md border border-gray-light bg-gray-light/20 p-3">
              {!copyOpen ? (
                <button
                  type="button"
                  onClick={() => setCopyOpen(true)}
                  disabled={saving || copying}
                  className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark disabled:opacity-50"
                >
                  Copy to other days…
                </button>
              ) : (
                <>
                  <p className="mb-1 text-sm font-semibold text-splash-navy">
                    Copy to other days
                  </p>
                  <p className="mb-2.5 text-xs leading-relaxed text-splash-navy/60">
                    Duplicates the values above onto the days you pick. The original
                    shift is left alone — use Save changes for that. Days that already
                    hold this shift, or that the scheduler rejects as conflicting, are
                    skipped.
                  </p>
                  <div
                    role="group"
                    aria-label="Days to copy this shift to"
                    className="mb-3 flex flex-wrap gap-1.5"
                  >
                    {weekDays.map((d) => {
                      const head = dayHeader(d);
                      const isSource = d === form.date;
                      const checked = copyTargets.includes(d);
                      const tone = isSource
                        ? "cursor-not-allowed border-gray-light bg-gray-light/40 text-splash-navy/35"
                        : checked
                          ? "cursor-pointer border-splash-blue bg-splash-blue/10 text-splash-navy"
                          : "cursor-pointer border-gray-light bg-white text-splash-navy hover:bg-gray-light/40";
                      return (
                        <label
                          key={d}
                          className={`flex items-center gap-1.5 rounded-splash-md border px-2.5 py-1 text-xs font-semibold transition-colors ${tone}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isSource || copying}
                            onChange={() => toggleTarget(d)}
                            className="h-3.5 w-3.5 accent-splash-blue"
                          />
                          <span>
                            {head.weekday} {head.label}
                            {isSource ? " (this shift)" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onCopy(copyTargets)}
                      disabled={copying || saving || copyTargets.length === 0}
                      className="rounded-splash-md bg-splash-blue px-4 py-1.5 text-xs font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-50"
                    >
                      {copying ? "Copying…" : copyLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCopyOpen(false);
                        setCopyTargets([]);
                      }}
                      disabled={copying}
                      className="text-xs font-semibold text-splash-navy/60 hover:text-splash-navy disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <div>
            {form.mode === "edit" ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={saving || copying}
                className="rounded-splash-md border border-splash-deny/50 px-4 py-2 text-sm font-semibold text-splash-deny hover:bg-splash-deny/10 disabled:opacity-50"
              >
                Delete
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || copying}
              className="rounded-splash-md border border-gray-light px-4 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || copying}
              className="rounded-splash-md bg-splash-navy px-5 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-50"
            >
              {saving ? "Saving…" : form.mode === "edit" ? "Save changes" : "Add shift"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {label}
      </label>
      {children}
    </div>
  );
}

function TimeSelect({
  hour,
  minute,
  onHour,
  onMinute
}: {
  hour: number;
  minute: number;
  onHour: (h: number) => void;
  onMinute: (m: number) => void;
}) {
  const selCls =
    "rounded-splash-md border border-gray-light bg-white px-2 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
  // Include the current minute even if it isn't a quarter step, so preset
  // values like :59 (11:59pm "all day") display correctly instead of blank.
  const minuteOptions = MINUTE_STEPS.includes(minute)
    ? MINUTE_STEPS
    : [...MINUTE_STEPS, minute].sort((a, b) => a - b);
  return (
    <div className="flex gap-2">
      <select
        value={hour}
        onChange={(e) => onHour(Number(e.target.value))}
        className={`${selCls} flex-1`}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {fmt12(h, 0).replace(" ", "")}
          </option>
        ))}
      </select>
      <select
        value={minute}
        onChange={(e) => onMinute(Number(e.target.value))}
        className={selCls}
      >
        {minuteOptions.map((m) => (
          <option key={m} value={m}>
            :{pad(m)}
          </option>
        ))}
      </select>
    </div>
  );
}
