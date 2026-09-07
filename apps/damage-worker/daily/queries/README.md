# Daily car-count pull queries

The four SQL files here are the **source of truth** for the daily Splash car-count
pull. Before 2026-09-06 they existed only in chat transcripts and inside an open
DBeaver editor tab, which is why the daily pull broke twice. They are versioned now.
Change them here, not in the GUI.

## What they produce

One CSV, written to the parent folder as:

```
apps/damage-worker/daily/daily_car_counts_<DAY>.csv
```

with this exact header:

```
source,location_name,day,total_cars
```

`build_car_counts.py` in the parent folder consumes that file and emits
`car_counts_<DAY>.sql`, the D1 load. Run it with no edits:

```
python build_car_counts.py 2026-09-05     # or omit the arg for yesterday
```

## The four sources

| File | `source` value | Connection | Covers |
|---|---|---|---|
| `01_splashdb_lube_cars.sql` | `splashdb` | splashdb (Redshift) | The primary. ~84 locations, ~75 reporting. |
| `02_spot_ai.sql` | `spot_ai` | splashdb (Redshift) | Camera gap-fill: 083 Plattsburgh, 092 Falmouth. |
| `03_ics.sql` | `ICS` | splashdb (Redshift) | WashCo: 057 Middletown, 077 White Plains/Tarrytown. |
| `04_drb_pos.sql` | `DRB` | splashdb (Redshift) | POS: 196 Rensselaer, 197 Guilderland. |

All four run on the **`splashdb`** connection. The DBeaver connection named
`master` (SQL Server) is **not** used, despite Josh calling ICS "the master
database" — see the trap note in `03_ics.sql`.

Source precedence, enforced by `build_car_counts.py`:
**DRB (POS) > splashdb (sales) > spot_ai (camera).**

## The day placeholder

Every file uses the literal placeholder **`'{DAY}'`** — a single-quoted
`YYYY-MM-DD` date, e.g. `'2026-09-05'`. Find-and-replace every occurrence
before running. The default day is *yesterday*.

## How to run

1. Open DBeaver, connect to **splashdb**.
2. New SQL script (`Ctrl+]`). Paste one file's main query.
3. Replace every `'{DAY}'` with the target date.
4. Execute (`Ctrl+Enter`).
5. **For `04_drb_pos.sql`, run the completeness pre-check first.** If
   `mx_logtime` is well short of ~11,600 at Guilderland, the extract is a
   partial day — stop, do not load it.
6. Export the result set (below), append to the CSV, repeat for the next file.
7. Run `python build_car_counts.py <DAY>`, then the overlap pre-flight, then
   `apply.mjs --dry-run`, then apply.

## Export: use DBeaver's exporter, never the screen

**Right-click the result grid → Export resultset… → CSV.**

Do **not** transcribe values from screenshots. That path was used once, it is
slow, and it is how the ~31-car discrepancy in the 2026-09-04 load happened.
The exporter gives the real values including NULLs.

Blank `total_cars` is **normal and expected** — a location present in
`locations` with no sales that day. Keep those rows; `build_car_counts.py`
handles blanks. The 2026-09-05 CSV had 7 intentionally blank rows out of 89.

You will need to add the constant `source` column if you export a query that
doesn't already select it — all four files here do select it, so a straight
export lines up with the CSV header as-is.

## The two traps that matter most

**1. `sales.lube_cars` — use MAX, never SUM.**
Two rows come back per location-day. For ~66 locations it's a value plus a
NULL (harmless), but for **9 locations the two rows carry genuinely different
values**. Verified against known-good 09-04 loads: Bedford H&L-019 max=257 /
sum=267 (loaded 257); Bridgeport-022 max=251 / sum=297 (loaded 251).
The originally-recovered query used SUM. That was the bug; it is corrected in
`01_splashdb_lube_cars.sql`. Do not revert it.

**2. `spot_ai_car_counts` — one dashboard row per site-day, never SUM.**
One row per Spot AI dashboard, and many dashboards watch the same lane.
**22 of 77 sites** have duplicate rows (14×2, 6×3, 2×4). Hamburg-149 on 09-04
is three identical rows of 174 that sum to a bogus 522. De-duplicated, the
camera tracks paid washes within a few percent.

## Read-only, always

Every query here is a plain `SELECT`. Standing rule from Josh: **DBeaver
connections are read-only — SELECT only, on every connection, always.** No
DDL, no DML, no temp tables, no `SET`. Writes go to D1 or Supabase instead.

## Gaps

`02_spot_ai.sql`'s de-duplicated gap-fill query is a **reconstruction**, not a
verbatim recovery — the transcript only preserved pre-discovery `SUM` versions
of the Spot AI queries. Columns and filter style are recovered; the `MAX`
aggregate follows the documented rule. Spot-check its output against the
previous day before trusting it. The other three are verbatim (with `01`'s
aggregate deliberately corrected from `SUM` to `MAX`).
