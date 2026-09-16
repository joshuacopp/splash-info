# maintenance-tracker

Plan: `PLAN.md` (rev 8). Session map: `HANDOFF.md`.

## Phase 1 pipeline (Layer A — punch fidelity)

Export → build → apply, the same shape as `apps/damage-worker/daily`, because
the compute belongs in Redshift and the joining belongs in Supabase.

```powershell
.\export_punches.ps1                                   # Redshift -> punches_raw.csv
# dump site centres once: site_number,latitude,longitude,geofence_radius_m
python build_punches.py punches_raw.csv sites.csv > mt_punch.sql
$env:SUPABASE_DB_URL = "<Supabase connection string (URI)>"
node apply_punches.mjs mt_punch.sql
```

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
