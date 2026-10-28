#!/usr/bin/env python3
"""
Build mt_gps_dwell rows from the Redshift dwell export.

    python build_dwell.py dwell_raw.csv sites.csv > mt_gps_dwell.sql

Takes the stay intervals from queries/20_dwell.sql and attaches the nearest
Splash site to each, using the same per-site geofence radius Layer A uses.

WHY THE SITE MATCH HAPPENS HERE AND NOT IN THE SQL

  The site centres live in Supabase and the pings live in Redshift, and we have
  READ-ONLY access to Redshift -- correctly, it is a company-wide warehouse.
  Pushing 85 coordinates into a query as a literal VALUES list would work but
  would bury the one number anybody ever wants to tune (the radius) inside a
  generated string. It lives in the sites CSV instead.

SPREAD_FILTER is the crawl guard. A genuine stay is tight: after the
implied-speed fix 99.6% of intervals sit under 100 m of spread. Anything much
wider crept under the threshold in stop-start traffic and is travel, not a
visit. Rows above the limit are DROPPED and COUNTED to stderr rather than
silently skipped -- a filter nobody can see the effect of is a filter nobody
will notice has gone wrong.
"""
import csv, json, math, sys
from collections import Counter

EARTH_M_PER_DEG = 111_320.0
SPREAD_FILTER_M = 300


def metres(lat1, lon1, lat2, lon2):
    return math.hypot(
        (lat1 - lat2) * EARTH_M_PER_DEG,
        (lon1 - lon2) * EARTH_M_PER_DEG * math.cos(math.radians(lat1)),
    )


def load_sites(path):
    sites = []
    with open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if not r.get("latitude"):
                continue
            sites.append((int(r["site_number"]), float(r["latitude"]),
                          float(r["longitude"]), int(r["geofence_radius_m"] or 150)))
    if not sites:
        sys.exit("no sites with coordinates -- run the G1 backfill first")
    return sites


def nearest(sites, lat, lon):
    best = None
    for n, la, lo, rad in sites:
        d = metres(lat, lon, la, lo)
        if best is None or d < best[1]:
            best = (n, d, rad)
    return best


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

    rows, stats = [], Counter()
    with open(sys.argv[1], encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            spread = int(float(r["spread_m"] or 0))
            stats["read"] += 1
            if spread > SPREAD_FILTER_M:
                stats["dropped_spread"] += 1
                continue
            lat, lon = float(r["centroid_lat"]), float(r["centroid_lon"])
            n, d, rad = nearest(sites, lat, lon)
            within = d <= rad
            stats["at_site"] += 1 if within else 0
            rows.append({
                "device_id": r["device_id"],
                "arrived_at": r["arrived_at"],
                "departed_at": r["departed_at"],
                "dwell_minutes": float(r["dwell_minutes"]),
                "centroid_lat": lat,
                "centroid_lon": lon,
                "spread_m": spread,
                "ping_count": int(r["ping_count"] or 0),
                # Nearest site is recorded even when far away: "the nearest site
                # was 30 km off" is a useful fact, and null here would lose it.
                "matched_site_number": n,
                "distance_m": round(d),
                "within_geofence": within,
            })

    cols = ["device_id", "arrived_at", "departed_at", "dwell_minutes",
            "centroid_lat", "centroid_lon", "spread_m", "ping_count",
            "matched_site_number", "distance_m", "within_geofence"]

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
    print("-- generated by build_dwell.py -- do not hand-edit")
    print("begin;")
    # REPLACE, NOT UPSERT, and this is load-bearing.
    #
    # mt_gps_dwell is keyed on (device_id, arrived_at), but arrived_at is
    # DERIVED -- it is a session boundary this query recomputes over the whole
    # window every run. One extra ping can merge two stays or split one, and
    # the boundary moves. An upsert then inserts the new interval ALONGSIDE the
    # old one instead of replacing it, and the pair overlap in time.
    #
    # Nothing complains. The rows are individually valid, the load reports
    # success, and mt_punch_allocation quietly counts the same minutes twice --
    # inflating on-site hours on a dashboard that looks exactly as trustworthy
    # as it did before. Measured on the first scheduled run: 3,325 intervals
    # exported, 3,799 rows in the table, 476 of them overlapping.
    #
    # The delete is safe because this export is the WHOLE window, not a day,
    # and refresh.ps1 enforces a row-count floor BEFORE applying -- so a
    # truncated export aborts rather than emptying the table. Both statements
    # are inside the same transaction, so a failure mid-load rolls back to the
    # previous contents rather than leaving the table short.
    print("delete from mt_gps_dwell;")
    # After the delete above and the DISTINCT ON, the ON CONFLICT should never
    # fire. It is kept from the old statement as a guard rather than removed,
    # so the write semantics are unchanged if either of those ever changes.
    # No `;`: the statement is ended by \g on the \bind line below.
    print(f"""insert into mt_gps_dwell ({', '.join(cols)})
select distinct on (device_id, arrived_at) {', '.join(cols)}
from jsonb_to_recordset($1::jsonb) as r(
  ord bigint,
  device_id text, arrived_at timestamptz, departed_at timestamptz,
  dwell_minutes double precision, centroid_lat double precision,
  centroid_lon double precision, spread_m integer, ping_count integer,
  matched_site_number integer, distance_m integer, within_geofence boolean)
order by device_id, arrived_at, ord desc
on conflict (device_id, arrived_at) do update set
  departed_at = excluded.departed_at, dwell_minutes = excluded.dwell_minutes,
  centroid_lat = excluded.centroid_lat, centroid_lon = excluded.centroid_lon,
  spread_m = excluded.spread_m, ping_count = excluded.ping_count,
  matched_site_number = excluded.matched_site_number,
  distance_m = excluded.distance_m, within_geofence = excluded.within_geofence,
  built_at = now()""")
    payload = [{"ord": i, **{c: r[c] for c in cols}} for i, r in enumerate(rows)]
    print("\\bind " + bind_arg(payload) + " \\g")
    print("commit;")

    print(f"read {stats['read']}, dropped {stats['dropped_spread']} for spread "
          f">{SPREAD_FILTER_M}m, wrote {len(rows)}, of which {stats['at_site']} "
          f"({stats['at_site']/max(len(rows),1)*100:.1f}%) inside a site geofence",
          file=sys.stderr)


if __name__ == "__main__":
    main()
