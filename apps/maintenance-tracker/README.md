# maintenance-tracker

Plan: `PLAN.md` (rev 8). Session map: `HANDOFF.md`.

## Phase 1 pipeline (Layer A — punch fidelity)

Export → build → apply, the same shape as `apps/damage-worker/daily`, because
the compute belongs in Redshift and the joining belongs in Supabase.

## Keeping it current

**Do not run the steps below by hand for a routine refresh.** `refresh.ps1`
does the whole chain and is what the scheduled tasks call:

```powershell
setx SUPABASE_DB_URL "<Project Settings -> Database -> Connection string>"  # once, then reopen the shell
#   Either the Direct or the Session pooler string works -- refresh.ps1 converts
#   the direct one, whose host is IPv6-only and unreachable from an IPv4 network.
.\register_schedule.ps1        # daily 06:30 punches+dwell, weekly Sun 05:30 full
.\refresh.ps1                  # or run it now
.\refresh.ps1 -DryRun          # export + build, write nothing
```

The MaintainX half of the tracker keeps itself current (webhooks plus three
crons on workorders-worker). **The Connecteam and Geotab halves do not** --
they come out of Redshift, which Cloudflare cannot reach, so they run here on
Task Scheduler exactly as `apps/damage-worker/daily` does for car counts.
Without that, `/admin/maintenance` goes on rendering September for ever while
looking exactly as authoritative as it does today.

Every write is an idempotent upsert over the whole window, so a missed run
needs no backfill -- just run it again.

The manual steps below are for development and one-off investigation.

```powershell
# dump site centres once: site_number,latitude,longitude,geofence_radius_m
#
# Use the SESSION POOLER string, not the one labelled "Direct connection".
# Supabase → Project Settings → Database → Connection string → Session pooler:
#   postgresql://postgres.<project-ref>:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
#
# The direct host (db.<project-ref>.supabase.co) resolves over IPv6 ONLY. On an
# IPv4 network psql fails with "could not translate host name ... to address",
# which reads like a typo or a dead project rather than what it is. The pooler
# answers on IPv4. Session mode (5432) not transaction mode (6543): the generated
# file is one BEGIN/COMMIT and session mode is the one that holds a real
# transaction across statements.
#
# Region is in the hostname and the prefix is NOT always aws-0 -- this project is
# aws-1-us-east-2. Copy the host from the dashboard rather than assuming.
$env:SUPABASE_DB_URL = "<Supabase Session pooler connection string>"

# Layer A - punch fidelity
.\export_punches.ps1                                   # Redshift -> punches_raw.csv
python build_punches.py punches_raw.csv sites.csv > mt_punch.sql
node apply_punches.mjs mt_punch.sql

# Layer B - GPS dwell
psql "service=splashdb" --csv -P pager=off -f queries_dwell.sql -o dwell_raw.csv
python build_dwell.py dwell_raw.csv sites.csv > mt_gps_dwell.sql
node apply_punches.mjs mt_gps_dwell.sql            # same applier, any .sql file
```

**Redshift access is READ-ONLY and must stay that way.** It is a company-wide
warehouse; every query here is a `SELECT`. Nothing in this pipeline writes to
it — the only writes go to Supabase.

Redshift is reached through the **existing `splashdb` pg_service entry** the
car-counts export already uses — `razayya_agent_collector` is a schema inside
`splashdb`, not a separate database.

## The one thing to know before reading mt_punch

**`within_geofence` is not a compliance verdict.** A punch is a cost-allocation
claim that *opens at departure* (PLAN.md §8): the mechanic punches into a site
when he sets off for it, from wherever he happens to be. Measured 2026-09-16:

| | at a site |
|---|---|
| first punch-in of the day | 3.2% |
| every later punch-in | 45.1% |
| last punch-out of the day | 2.9% |
| every earlier punch-out | 45.2% |
| punch-out within 200 m of the **next** punch-in | 84.5% |

The last row is the convention itself, visible in the data — one shift closed
and the next opened standing in the same spot. Any report over this table must
exclude `is_first_of_day` and `is_last_of_day`, or it will accuse every mechanic
of the same thing every morning.

Non-mobile punches (`source_type` admin / pc) are PTO and manual corrections and
never carry GPS. Exclude them from the denominator rather than scoring them as
failures.

## Layer B — what a "stay" is, and what it is not

Geotab logs densely while moving (median gap **5 s**) and goes quiet while
parked: of 25,534 gaps over 5 minutes, **25,491 involve under 100 m of
movement**. Only 20% of pings are at speed ≤ 3 at all. A stay is therefore
encoded mostly as the *absence* of pings, and PLAN.md §5's description
("consecutive GPS points below a speed threshold") would miss nearly all of it.

Stays are sessionised on **implied speed** between consecutive pings, not on
raw step distance. That distinction is not academic — the first version used a
150 m distance threshold, which at 5-second pings tolerates **108 km/h**, and
whole motorway drives collapsed into single "stays": 90% of intervals spanned
over 300 m, one was 43 minutes and 7.4 km at up to 66. After the fix, 99.6% of
intervals sit under 100 m of spread.

**It tracks the vehicle, not the person.** A mechanic can be at a site with the
van parked elsewhere, or riding with a colleague. `mt_device_person` gives the
likely driver, never a proven one.

Most dwell hours are overnight parking at home, which is expected and is not an
exception — 13,741 h of stays over the window, of which 1,869 h (14%) are inside
a site geofence, across 3,315 intervals of which 41% match a site.
