#!/usr/bin/env python3
"""
Build mt_punch rows from the Redshift punch export.

    python build_punches.py punches_raw.csv sites.csv > mt_punch.sql

Reads the shift CSV from export_punches.ps1 and a site CSV of
site_number,latitude,longitude,geofence_radius_m (dump it from Supabase), and
emits an idempotent upsert as one fixed statement with the rows bound as a
parameter (see main() for why).

WHAT THIS COMPUTES, AND WHAT IT DELIBERATELY DOES NOT

  For each punch coordinate it finds the nearest Splash site and the distance
  to it. That is all Layer A is.

  It does NOT decide whether a mechanic was where he should have been, and
  nothing downstream should read it that way. Per PLAN.md section 8 a punch is a
  cost-allocation claim that OPENS AT DEPARTURE: the mechanic punches into a
  site when he sets off for it, from wherever he is. Measured 2026-09-16, the
  first punch-in of the day is at a site 3.2% of the time and every later one
  45.1% -- because the day starts at home. `is_first_of_day` / `is_last_of_day`
  are emitted so that exclusion is a column test rather than a window function
  every consumer has to remember to write.

HAVERSINE, NOT POSTGIS. 85 fixed centres and a few thousand punches; the
equirectangular approximation below is accurate to well under a metre at these
latitudes over these distances, and installing a PostGIS dependency into a
production database to beat that would be a poor trade.
"""
import csv, json, math, sys
from collections import defaultdict

EARTH_M_PER_DEG = 111_320.0


def metres(lat1, lon1, lat2, lon2):
    """Equirectangular. Cheap, and exact enough: the error against haversine is
    sub-metre for the few-kilometre distances that matter here, and the ones
    that do not matter are already tens of kilometres away."""
    return math.hypot(
        (lat1 - lat2) * EARTH_M_PER_DEG,
        (lon1 - lon2) * EARTH_M_PER_DEG * math.cos(math.radians(lat1)),
    )


def load_sites(path):
    sites = []
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if not r.get("latitude"):
                continue  # closed sites and un-geocoded rows carry no centre
            sites.append((
                int(r["site_number"]),
                float(r["latitude"]),
                float(r["longitude"]),
                int(r["geofence_radius_m"] or 150),
            ))
    if not sites:
        sys.exit("no sites with coordinates -- run the G1 backfill first")
    return sites


def nearest(sites, lat, lon):
    best_n = best_d = best_r = None
    for n, la, lo, rad in sites:
        d = metres(lat, lon, la, lo)
        if best_d is None or d < best_d:
            best_n, best_d, best_r = n, d, rad
    return best_n, best_d, best_r


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def bind_arg(rows):
    """All rows as ONE psql \\bind argument: a JSON array, single-quoted for
    psql. Inside a quoted backslash-command argument psql turns '' into ' and
    treats a backslash as an escape, so both are doubled here; the server then
    receives the JSON byte-for-byte. json.dumps writes no raw newlines, so the
    argument stays on one line, and ASCII-only (non-ASCII as \\uXXXX), so it
    survives whatever codepage the stdout pipe uses. Floats go through repr,
    so no precision is lost."""
    js = json.dumps(rows, separators=(",", ":"))
    return "'" + js.replace("\\", "\\\\").replace("'", "''") + "'"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    sites = load_sites(sys.argv[2])

    rows = []
    with open(sys.argv[1], encoding="utf-8") as fh:
        for s in csv.DictReader(fh):
            rec = {
                "shift_id": s["shift_id"],
                "connecteam_user_id": int(s["connecteam_user_id"]),
                "start_utc": s["start_utc"],
                "end_utc": s["end_utc"] or None,
                "timezone": s["timezone"] or None,
                "duration_minutes": fnum(s["duration_minutes"]),
                "source_type": s["source_type"] or None,
            }
            for tag in ("in", "out"):
                la, lo = fnum(s[f"{tag}_lat"]), fnum(s[f"{tag}_lon"])
                rec[f"{tag}_lat"], rec[f"{tag}_lon"] = la, lo
                if la is None or lo is None:
                    rec[f"{tag}_site_number"] = None
                    rec[f"{tag}_distance_m"] = None
                    rec[f"{tag}_within_geofence"] = None
                else:
                    n, d, rad = nearest(sites, la, lo)
                    rec[f"{tag}_site_number"] = n
                    rec[f"{tag}_distance_m"] = round(d)
                    rec[f"{tag}_within_geofence"] = d <= rad
            rows.append(rec)

    # Day position, per mechanic, in LOCAL time. Using UTC would split a day at
    # 8pm Eastern and mislabel the evening punches of every late shift.
    by_day = defaultdict(list)
    for r in rows:
        by_day[(r["connecteam_user_id"], r["start_utc"][:10])].append(r)
    for group in by_day.values():
        group.sort(key=lambda r: r["start_utc"])
        for i, r in enumerate(group):
            r["is_first_of_day"] = i == 0
            r["is_last_of_day"] = i == len(group) - 1

    cols = ["shift_id", "connecteam_user_id", "is_mechanic", "start_utc", "end_utc",
            "timezone", "duration_minutes", "source_type",
            "in_lat", "in_lon", "in_site_number", "in_distance_m", "in_within_geofence",
            "out_lat", "out_lon", "out_site_number", "out_distance_m", "out_within_geofence",
            "is_first_of_day", "is_last_of_day"]

    # CONSTANT STATEMENT TEXT, AND WHY.
    #
    # This file used to inline every value into `insert ... values (...)`
    # chunks, so each run sent statements Postgres had never seen.
    # pg_stat_statements keeps one entry per distinct statement: it reached
    # 25 MB (310 punch inserts of up to 71 KB, plus the same for dwell) and
    # Supabase's monitoring re-read it on every scrape until the project ran
    # out of Disk IO budget.
    #
    # Placeholders in a multi-row VALUES list would not fix it, because the
    # shape still changes with the row count. Neither would COPY into a temp
    # table (tried): the temp table gets a new OID every run, and
    # pg_stat_statements hashes relation OIDs, so the identical insert text
    # still became a new entry per run.
    #
    # So the rows go up as ONE bind parameter (psql \bind, which needs psql
    # 16 or later; an older psql fails with "invalid command \bind", and
    # ON_ERROR_STOP rolls the whole load back) and a fixed statement unpacks
    # them with jsonb_to_recordset. The statement text, and the only relation
    # it names, are the same on every run whatever the row count.
    #
    # `ord` is each row's position in the export. DISTINCT ON keeps the last
    # occurrence of a key, which is what the old chunked upserts did when a key
    # repeated across chunks (a repeat INSIDE one chunk used to abort the run
    # with "cannot affect row a second time"; now the last one wins).
    payload = []
    for i, r in enumerate(rows):
        # Left null on insert and filled by the UPDATE at the end, from
        # mt_device_person. That table is the single source of truth for
        # who counts as a mechanic, so adding one there is the only edit
        # needed when the crew changes -- nothing here hardcodes a roster.
        # (The column is deliberately NULLABLE for this reason.)
        r["is_mechanic"] = None
        payload.append({"ord": i, **{c: r.get(c) for c in cols}})

    print("-- generated by build_punches.py -- do not hand-edit")
    print("begin;")
    # EVERY non-key column is refreshed, deliberately. An earlier version
    # listed only the site-match and day-flag columns, which made a re-run
    # silently useless for exactly the corrections most likely to need one:
    # fix a timezone, re-export after a duration bug, re-round a coordinate,
    # and the upsert would report success while leaving the old value in
    # place. A partial SET list on a generated upsert is a trap -- if a
    # column is worth writing on insert it is worth refreshing on conflict.
    #
    # No `;` here: the statement is ended by \g on the \bind line below.
    print(f"""insert into mt_punch ({', '.join(cols)})
select distinct on (shift_id) {', '.join(cols)}
from jsonb_to_recordset($1::jsonb) as r(
  ord bigint,
  shift_id text, connecteam_user_id bigint, is_mechanic boolean,
  start_utc timestamptz, end_utc timestamptz, timezone text,
  duration_minutes double precision, source_type text,
  in_lat double precision, in_lon double precision, in_site_number integer,
  in_distance_m integer, in_within_geofence boolean,
  out_lat double precision, out_lon double precision, out_site_number integer,
  out_distance_m integer, out_within_geofence boolean,
  is_first_of_day boolean, is_last_of_day boolean)
order by shift_id, ord desc
on conflict (shift_id) do update set
  connecteam_user_id = excluded.connecteam_user_id,
  start_utc = excluded.start_utc, end_utc = excluded.end_utc,
  timezone = excluded.timezone, duration_minutes = excluded.duration_minutes,
  source_type = excluded.source_type,
  in_lat = excluded.in_lat, in_lon = excluded.in_lon,
  in_site_number = excluded.in_site_number, in_distance_m = excluded.in_distance_m,
  in_within_geofence = excluded.in_within_geofence,
  out_lat = excluded.out_lat, out_lon = excluded.out_lon,
  out_site_number = excluded.out_site_number, out_distance_m = excluded.out_distance_m,
  out_within_geofence = excluded.out_within_geofence,
  is_first_of_day = excluded.is_first_of_day, is_last_of_day = excluded.is_last_of_day,
  built_at = now()""")
    print("\\bind " + bind_arg(payload) + " \\g")
    print("""
-- Resolved here, not in Python: mt_device_person is the single source of truth
-- for who counts as a mechanic, so adding one there is the only change needed.
update mt_punch p set is_mechanic = exists (
  select 1 from mt_device_person d where d.connecteam_user_id = p.connecteam_user_id
);
commit;""")


if __name__ == "__main__":
    main()
