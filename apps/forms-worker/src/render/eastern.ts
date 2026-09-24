// Eastern wall-clock helpers for render-time field defaults.
//
// WHY NOT toISOString().
//
//   The worker runs in UTC. `new Date().toISOString().slice(0,10)` is the UTC
//   date, which is TOMORROW from 8pm Eastern onward (7pm in winter). A form
//   opened during an evening site visit would pre-fill the wrong day, and a
//   pre-filled wrong value is worse than an empty one: nobody re-reads a field
//   that is already populated. It has no error, no log and no symptom until
//   someone tries to reconcile a visit against a date that never happened.
//
//   Every site is Eastern, so the site's wall clock is the right clock for a
//   visit date and time.

const EASTERN = "America/New_York";

function easternParts(at: Date): Map<string, string> {
  return new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: EASTERN,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
}

/** YYYY-MM-DD for `<input type="date" value>`. */
export function easternToday(at: Date = new Date()): string {
  const p = easternParts(at);
  return `${p.get("year")}-${p.get("month")}-${p.get("day")}`;
}

/** HH:MM (24h) for `<input type="time" value>`. The browser renders it in the
 *  viewer's locale — a 12-hour clock shows 8:02 PM — but the wire format for
 *  the value attribute is always 24-hour. */
export function easternNow(at: Date = new Date()): string {
  const p = easternParts(at);
  // Intl emits "24" for midnight under hour12:false in some runtimes; the
  // value attribute needs "00" or the browser silently ignores the default.
  const hour = p.get("hour") === "24" ? "00" : p.get("hour");
  return `${hour}:${p.get("minute")}`;
}
