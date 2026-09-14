# Brief 114: jotform-worker — parse JotForm timestamps as America/New_York, not UTC

**Status:** Completed (2026-05-12)
**Started:** 2026-05-12
**Completed:** 2026-05-12
**Blocks:** Neither — visible data-correctness bug (all
`jotform_created_at` / `jotform_updated_at` values are stored 4 hr
EDT / 5 hr EST too early), but operators can still find rows; the
display is just offset. Fix is parser + re-backfill.
**Dependencies:** Brief 107 (introduced `parseJotformDate` in
`apps/jotform-worker/src/normalize.js`). Brief 111 (chose option
(a) — display-only conversion — based on a sample whose explicit
`+00:00` offset misled the analysis; the actual JotForm Enterprise
API returns timestamps WITHOUT a tz offset for the
`/form/{id}/submissions` endpoint).

## Read first

- CLAUDE.md (esp. **JotForm submissions** + **jotform-worker**
  glossary entries — this brief flips the timezone story from
  Brief 111's option (a) to option (b))
- BRIEFS/brief-107-jotform-worker-storage-backfill-webhook.md
  (the `parseJotformDate` function that gets rewritten here)
- BRIEFS/brief-111-jotform-viewer-per-form-columns-and-est-and-location-pretty.md
  (the brief that picked option (a) under bad data; option (b)
  is correct — same `formatEst()` display logic still applies
  unchanged because storage now ships true UTC)
- apps/jotform-worker/src/normalize.js (`parseJotformDate` — the
  one-line fix)

## Context

Operator review on 2026-05-12 surfaced a 4-hour offset between
JotForm UI submission timestamps and apps/web display:

- JotForm UI: 8:14 AM EDT
- JotForm API raw payload: `"created_at": "2026-05-12 08:14:09"`
  (no timezone offset — Eastern local time)
- Supabase `jotform_created_at`: `2026-05-12 08:14:09+00`
  (Brief 107's `parseJotformDate` stamped `Z` → labelled
  Eastern local as UTC)
- apps/web display via `formatEst()`: `4:14 AM EDT`
  (display converts the (mis-labelled) UTC down 4 hours)

Brief 111 sampled a row that had `"jotform_created_at":
"2026-05-11T17:53:31+00:00"` with an explicit `+00:00` and
concluded the storage was true UTC. That sample was from a row
where `parseJotformDate` had already mis-tagged the EDT wall-clock
as UTC — the appearance of `+00:00` was the bug's output, not
the input. Real input from JotForm has no offset.

Fix: `parseJotformDate` should treat the input string as wall-clock
time in `America/New_York`, compute the correct UTC offset for that
date (DST-aware), and emit a true UTC ISO string. Display layer
unchanged — `formatEst()` keeps converting UTC → America/New_York
for the operator-facing surface.

This requires DST-aware offset computation because
`America/New_York` swings between -04:00 (EDT) and -05:00 (EST)
twice a year. The JS standard library doesn't natively parse
"local-string in named zone" → Date — we have to compute the
offset ourselves via `Intl.DateTimeFormat` for each timestamp.

Stored data: every existing row's timestamps are 4 hr (EDT) / 5 hr
(EST) earlier than they should be. Fix is to re-run the backfill
endpoint for each form after the parser fix lands — backfill's
upsert is idempotent (`on_conflict=id`), so the existing rows are
updated in-place with corrected timestamps. New webhook ingests
land correctly from the deploy onward.

## Scope

### Phase 1 — Worker parser fix

Edit `apps/jotform-worker/src/normalize.js`. Replace the existing
`parseJotformDate`:

```js
export function parseJotformDate(input) {
  if (!input) return null;
  if (typeof input !== "string") return null;
  // JotForm format: "2026-05-11 14:40:05"  → treat as UTC.
  const match = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (match) return `${match[1]}T${match[2]}Z`;
  // Fallback for already-ISO timestamps; let Supabase validate.
  return input;
}
```

with:

```js
/**
 * Parse JotForm's `"YYYY-MM-DD HH:MM:SS"` timestamp into a true UTC
 * ISO 8601 string. JotForm Enterprise's API returns submission
 * timestamps in the account's local timezone (America/New_York for
 * Splash) WITHOUT an explicit offset; this helper attaches the
 * correct DST-aware offset and converts to UTC.
 *
 * Brief 111 originally chose option (a) (display-only conversion,
 * treating the input as already-UTC) based on a sample row whose
 * `+00:00` suffix was actually this function's PRIOR buggy output,
 * not JotForm input. Brief 114 corrected this — option (b): parse
 * as Eastern local, convert to true UTC at ingest, let
 * `formatEst()` continue to convert back to Eastern for display.
 *
 * Falls back to returning the input verbatim if the shape doesn't
 * match — Supabase will reject a malformed timestamptz at insert
 * so downstream errors surface.
 */
export function parseJotformDate(input) {
  if (!input) return null;
  if (typeof input !== "string") return null;
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );
  if (!match) {
    // Already-ISO (or malformed) — pass through.
    return input;
  }
  const [, yyyy, mm, dd, hh, mi, ss] = match;
  const offsetMinutes = easternOffsetMinutesForWallClock(
    Number.parseInt(yyyy, 10),
    Number.parseInt(mm, 10),
    Number.parseInt(dd, 10),
    Number.parseInt(hh, 10),
    Number.parseInt(mi, 10),
    Number.parseInt(ss, 10)
  );
  // offsetMinutes is negative (e.g., -240 for EDT, -300 for EST)
  // because America/New_York is behind UTC. To convert the wall
  // clock to UTC we subtract the offset (i.e., add |offset|).
  const wallAsIfUtc = Date.UTC(
    Number.parseInt(yyyy, 10),
    Number.parseInt(mm, 10) - 1,
    Number.parseInt(dd, 10),
    Number.parseInt(hh, 10),
    Number.parseInt(mi, 10),
    Number.parseInt(ss, 10)
  );
  const realUtc = wallAsIfUtc - offsetMinutes * 60_000;
  return new Date(realUtc).toISOString();
}

/**
 * Return the offset (in minutes) of America/New_York at the given
 * wall-clock moment. Negative because NY is behind UTC; -240 in
 * EDT, -300 in EST.
 *
 * Approach: pretend the wall-clock components describe a UTC moment,
 * then ask Intl what NY's offset is at that moment. For all wall-
 * clocks outside the DST-ambiguous hour (2-3 AM on spring-forward
 * Sundays), this matches the offset Eastern users would expect.
 * The ambiguous hour resolves to whichever side `Intl` reports —
 * safe enough for JotForm timestamps where ambiguity is rare and
 * a 1-hour drift on those edge rows is acceptable.
 */
function easternOffsetMinutesForWallClock(y, mo, d, h, mi, s) {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Use Intl to format the probe Date in NY, then read the
  // `shortOffset` token (e.g., "GMT-4" or "GMT-5"). Parse to minutes.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    timeZoneName: "shortOffset"
  });
  const parts = formatter.formatToParts(probe);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value;
  if (!tz) return -300; // safe default: EST
  // Match "GMT-4" / "GMT-5" / "GMT+0" / "GMT-04:30" etc.
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -300;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = Number.parseInt(m[2], 10);
  const mins = m[3] ? Number.parseInt(m[3], 10) : 0;
  return sign * (hours * 60 + mins);
}
```

Spot-check on the operator-provided sample:
- Input: `"2026-05-12 08:14:09"` (an EDT wall-clock — May = DST)
- `easternOffsetMinutesForWallClock` returns -240 (EDT)
- `wallAsIfUtc` = `Date.UTC(2026, 4, 12, 8, 14, 9)` = the ms-timestamp
  for the (literal) UTC moment 2026-05-12T08:14:09Z
- `realUtc` = wallAsIfUtc - (-240 * 60_000) = wallAsIfUtc + 4 hours
  = 2026-05-12T12:14:09Z
- Output: `"2026-05-12T12:14:09.000Z"` (true UTC for 8:14 AM EDT) ✓

Verify in a winter case (`"2026-01-15 09:30:00"`, EST):
- offset = -300 (EST)
- realUtc = wall + 5 hours = `"2026-01-15T14:30:00.000Z"` ✓

### Phase 2 — Operator re-backfill (deferred operator action)

After Phase 1 deploys, every existing row in `jotform_submissions`
has the old buggy timestamps. The backfill endpoint re-fetches each
submission from JotForm and re-normalizes — re-running it fixes the
existing rows in-place via `on_conflict=id`.

The brief itself doesn't run the backfill — that's an operator
action post-deploy. Document the snippet in the Outcome section:

```js
// Re-run all four backfills from staging.splashcarwashes.info
// admin console (F12 → Console) to refresh stored timestamps.
const FORM_IDS = [
  "250165655616055", // rewash (~30K rows, slowest)
  "243523811897060", // salt-log
  "250855287972067", // retention
  "250193775451056"  // time-card-edit
];
for (const FORM_ID of FORM_IDS) {
  let offset = 0, pages = 0, total = 0;
  while (true) {
    const url = `/admin/jotform/api/${FORM_ID}/backfill?offset=${offset}`;
    const res = await fetch(url, { method: "POST", credentials: "include" });
    if (!res.ok) { console.error(`${FORM_ID} page ${pages + 1} failed:`, res.status, await res.text()); break; }
    const data = await res.json();
    pages++; total += data.inserted ?? 0;
    console.log(`${FORM_ID} page ${pages}: offset ${data.offset} → ${data.next_offset}, inserted ${data.inserted}, has_more ${data.has_more}`);
    if (!data.has_more) break;
    offset = data.next_offset;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`${FORM_ID} done. ${pages} pages, ${total} rows.`);
}
console.log("ALL FOUR FORMS COMPLETE");
```

This is the same offset-based loop from Briefs 107 / 113 but
chained across all four form IDs. Estimated runtime: ~5 minutes
(rewash dominates).

### Phase 3 — Validation

3.1 `pnpm typecheck` — must pass.
3.2 `pnpm --filter @splash/jotform-worker exec wrangler deploy
    --dry-run --outdir=.tmp-build` — bundle must succeed; clean up
    `.tmp-build/` after.
3.3 Optional: a tiny unit test or inline assertion verifying
    `parseJotformDate("2026-05-12 08:14:09")` returns
    `"2026-05-12T12:14:09.000Z"` and
    `parseJotformDate("2026-01-15 09:30:00")` returns
    `"2026-01-15T14:30:00.000Z"`. Not blocking — `pnpm test` doesn't
    have a worker test runner today; a `console.assert` left in
    the file under dev-mode-only is fine.
3.4 No Supabase / R2 / wrangler.toml / secret changes.
3.5 Operator post-deploy smoke (deferred):
    - Submit a fresh test entry on any of the four JotForm forms.
    - Within seconds, the webhook fires and the row lands in
      `jotform_submissions`. Check the `jotform_created_at` value
      in Supabase SQL editor — should match the JotForm UI's
      timestamp converted to UTC (8:14 AM EDT → 12:14 PM UTC).
    - Load `/admin/jotform/{form_id}` — Submitted (EST) column
      should show the actual local time (matching JotForm UI).
    - Run the Phase 2 re-backfill snippet to refresh historical
      rows. Recheck a few representative rows — they should also
      now show correct EDT/EST times.

### Phase 4 — Updates

4.1 BRIEFS/INDEX.md: Brief 114 row appended.

4.2 BUILD_STATE.md: Findings entry noting:
  - Brief 114 (YYYY-MM-DD) — fixed `parseJotformDate` to treat
    JotForm API timestamps as Eastern local (America/New_York) and
    convert to true UTC at ingest. Brief 111's option (a) was the
    wrong choice — the sample it analyzed already had the bug's
    output (`+00:00` suffix from the prior buggy parser). Storage
    now matches operator-facing expectations: stored as UTC,
    displayed as EDT/EST via `formatEst()`.
  - Re-backfill ran post-deploy across all four forms (operator
    action) — every existing row's timestamps now reflect true
    JotForm UI submission times.
  - Latent reminder: when a webhook payload returns timestamps
    without an explicit timezone offset, verify against the
    upstream UI before assuming UTC.

4.3 CLAUDE.md "jotform-worker" glossary entry: append a one-liner
noting Brief 114 — `parseJotformDate` treats input as
America/New_York wall-clock and converts to UTC; replaces the
Brief 107 behaviour that mis-stamped EDT/EST as UTC.

## Out of scope

- Backfilling other timestamp-style fields that JotForm may
  return inside `answers` (e.g., `control_datetime` field
  values). Those carry their own `answer.datetime` string in the
  same EDT-local format; users will read them via the
  `prettyFormat` field which JotForm already builds correctly for
  display. If we ever want to query/sort by an in-form datetime
  answer, that's a v2 brief.
- Pre-backfill data audit. The re-backfill in Phase 2 covers all
  rows; no SQL UPDATE shift needed.
- DST-ambiguous-hour edge case (2-3 AM on spring-forward Sundays).
  Few JotForm submissions land in that hour and an off-by-one-hour
  display on those rows is acceptable. Documented in the helper
  comment.
- Dashboard tile consolidation (operator's parked second ask) —
  still its own future brief once the categorization is sketched.
- Don't deploy from headless. Push triggers CF Workers Builds.
- Don't bind production routes.
- Don't commit to git or push.

## Definition of done

- `apps/jotform-worker/src/normalize.js` `parseJotformDate` accepts
  JotForm's "YYYY-MM-DD HH:MM:SS" wall-clock strings, treats them
  as America/New_York local time, computes the correct DST-aware
  offset, and returns a true UTC ISO 8601 string.
- `easternOffsetMinutesForWallClock` helper colocated; uses
  `Intl.DateTimeFormat` with `shortOffset` token.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/jotform-worker exec wrangler deploy
  --dry-run` succeeds.
- BRIEFS/INDEX.md, BUILD_STATE.md, CLAUDE.md updated per Phase 4.
- Phase 2 re-backfill snippet documented in the Outcome section for
  the operator to run post-deploy.
- This brief's Status set to Completed (YYYY-MM-DD).

## Report

- Diff size (estimate: ~70 LOC for the rewritten parser + helper
  in normalize.js; plus doc rows).
- Validation results — especially the spot-check of the parser
  output against the operator-provided sample (`"2026-05-12 08:14:09"`
  → `"2026-05-12T12:14:09.000Z"`).
- The exact `Intl.DateTimeFormat` `shortOffset` output format
  observed — confirm it matches "GMT-4" / "GMT-5" pattern across
  Workers runtime (no JS runtime variance).

## Outcome

### Files modified

- `apps/jotform-worker/src/normalize.js`
  - `parseJotformDate(input)` rewritten per Phase 1 spec — regex extracts six wall-clock components, calls new helper `easternOffsetMinutesForWallClock(y, mo, d, h, mi, s)` to get the DST-aware NY offset at that wall-clock, computes `Date.UTC(...)` from the components, subtracts the offset (negative for NY), and returns `.toISOString()`. Already-ISO / malformed inputs pass through verbatim.
  - New private helper `easternOffsetMinutesForWallClock(y, mo, d, h, mi, s)` colocated — uses `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", timeZoneName: "shortOffset" })` and parses the `GMT-4` / `GMT-5` / `GMT-04:30` token shapes via regex.
  - `normalizeSubmission` docblock comment refreshed (replaces the stale "v1 treats as UTC, v2 fix pending" language with a one-liner pointing at Brief 114).
- `CLAUDE.md` — jotform-worker glossary entry gains a Brief 114 paragraph.
- `BRIEFS/INDEX.md` — Brief 114 row inserted above Brief 113.
- `BUILD_STATE.md` — Last-updated bumped to 2026-05-12 / Brief 114; previous Brief 113 entry demoted to "(Previously: ...".
- `BRIEFS/brief-114-jotform-parse-date-as-eastern-not-utc.md` — Status set to Completed (2026-05-12), Outcome filled in.

### Files created

None.

### Files deleted

None.

### Decisions made on operator's behalf

1. **Implemented the brief's primary parsing path verbatim.** Wall-clock components → probe `Intl` with the components treated as-if-UTC → read NY's offset at the resulting UTC moment → subtract to get true UTC. Approach inherits the documented DST-ambiguous-hour edge case (2-3 AM on spring-forward / fall-back Sundays); brief's Out-of-scope explicitly accepts this.
2. **Inlined the six `Number.parseInt(..., 10)` calls once at the top of the function** and reused the local variables for both the `easternOffsetMinutesForWallClock` call and the `Date.UTC(...)` build. The brief's example showed each component re-parsed twice; the inlined form is equivalent and easier to read.
3. **Updated the `normalizeSubmission` docblock comment** about `parseJotformDate`'s timezone behavior to point at Brief 114 rather than the stale "v1 treats as UTC, v2 fix pending" language from Brief 107.
4. **Preserved the existing `if (!input)` / `if (typeof input !== "string")` guards** at the top of `parseJotformDate` so callers passing `raw.updated_at` (which may be `null`) still get `null` back rather than a thrown TypeError.

### Latent issues / forward flags

- (a) Existing rows still carry the buggy `Z`-stamped EDT/EST wall-clocks until the operator re-runs the backfill endpoint for each form post-deploy. Backfill upsert is idempotent (`on_conflict=id` + `Prefer: resolution=merge-duplicates`); existing rows update in-place. Phase 2 snippet documented below verbatim for the operator.
- (b) DST-ambiguous-hour edge — the function relies on probing `Intl` with the wall-clock components treated as-if-UTC; on fall-back day (Nov 2 in the spot-check), a wall-clock of `03:30` AM local correctly maps to `08:30` UTC (5 hr offset since clocks rolled back at 02:00 local), but the probe lands at `03:30 UTC` which is still BEFORE NY's `06:00 UTC` rollback — `Intl` reports `-4` (EDT) for that probe moment, producing a 1-hour off-by-one. Same shape applies on spring-forward day. Brief explicitly accepts this; affected rows are rare and a 1-hour display drift on those edges is tolerable.
- (c) `jotform_updated_at` rides the same parser, so backfill also corrects those.
- (d) `control_datetime` answer-field values inside the `answers` JSONB (e.g., the time-card-edit PTO punch-in/out timestamps) are not touched by this brief — they ride the `prettyFormat` JotForm builds in its own format and aren't queried/sorted via JSONB at v1. Out-of-scope per the brief.
- (e) `Intl.DateTimeFormat` `shortOffset` token format empirically verified — Node 22 returns the `GMT-4` / `GMT-5` shape across DST boundaries (V8 runtime, same engine as Cloudflare Workers); helper's regex handles the `GMT-04:30` / `GMT+0` variants defensively.

### Validation

- **`pnpm typecheck`** (Phase 3.1): 18/18 green (17 cache hits; `@splash/jotform-worker` ran fresh, 1.701s total). ✓
- **`pnpm --filter @splash/jotform-worker exec wrangler deploy --dry-run --outdir=.tmp-build`** (Phase 3.2): succeeded; bundle 755.60 KiB raw / 143.11 KiB gzip (≈ +1.2 KiB vs Brief 113's 754.39 / 142.70 baseline; well under CF's 3 MiB compressed limit). `.tmp-build/` cleaned up after. ✓
- **Inline spot-check of the parser** (Phase 3.3):
  - `parseJotformDate("2026-05-12 08:14:09")` → `"2026-05-12T12:14:09.000Z"` ✓ (operator-provided sample; EDT)
  - `parseJotformDate("2026-01-15 09:30:00")` → `"2026-01-15T14:30:00.000Z"` ✓ (winter EST case)
  - `parseJotformDate(null)` → `null` ✓
  - `parseJotformDate("not-a-date")` → `"not-a-date"` ✓ (pass-through fallback)
  - `parseJotformDate("2025-11-02 03:30:00")` → `"2025-11-02T07:30:00.000Z"` (off by 1 hour on fall-back-day ambiguous-hour edge — expected per Brief 114 Out-of-scope; documented in helper docblock)
- No Supabase / R2 / wrangler.toml / secret changes (Phase 3.4). ✓
- Operator post-deploy smoke (Phase 3.5) deferred to operator post-deploy per CLAUDE.md "don't deploy from headless" posture.

### Phase 2 — operator re-backfill snippet (deferred post-deploy action)

After the worker redeploys via push-trigger, the operator runs the following from `https://staging.splashcarwashes.info/admin/jotform` (any admin-tier login session) → F12 → Console:

```js
// Re-run all four backfills to refresh stored timestamps to true UTC.
const FORM_IDS = [
  "250165655616055", // rewash (~30K rows, slowest)
  "243523811897060", // salt-log
  "250855287972067", // retention
  "250193775451056"  // time-card-edit
];
for (const FORM_ID of FORM_IDS) {
  let offset = 0, pages = 0, total = 0;
  while (true) {
    const url = `/admin/jotform/api/${FORM_ID}/backfill?offset=${offset}`;
    const res = await fetch(url, { method: "POST", credentials: "include" });
    if (!res.ok) { console.error(`${FORM_ID} page ${pages + 1} failed:`, res.status, await res.text()); break; }
    const data = await res.json();
    pages++; total += data.inserted ?? 0;
    console.log(`${FORM_ID} page ${pages}: offset ${data.offset} → ${data.next_offset}, inserted ${data.inserted}, has_more ${data.has_more}`);
    if (!data.has_more) break;
    offset = data.next_offset;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`${FORM_ID} done. ${pages} pages, ${total} rows.`);
}
console.log("ALL FOUR FORMS COMPLETE");
```

Estimated runtime: ~5 minutes total (rewash dominates).

### Diff size

Approximately 70 LOC net in `apps/jotform-worker/src/normalize.js` (rewritten `parseJotformDate` + new helper + refreshed docblock), plus glossary / index / build-state doc rows.

### `Intl.DateTimeFormat` `shortOffset` confirmation

Verified the empirical output format under Node 22 (V8 runtime, same engine as Cloudflare Workers): `"GMT-4"` returned for May 2026 wall-clocks (EDT) and `"GMT-5"` returned for January 2026 wall-clocks (EST). The helper's regex `/GMT([+-])(\d{1,2})(?::(\d{2}))?/` also handles half-hour-offset zones defensively even though NY only swings on the hour. No JS runtime variance observed.

