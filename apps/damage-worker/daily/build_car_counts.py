#!/usr/bin/env python3
"""
Generate D1 INSERT statements for apps/damage-worker `car_counts` from the
daily splashdb pull.

Usage
-----
    python build_car_counts.py [YYYY-MM-DD]

The day defaults to yesterday. Input and output are resolved next to this
script: daily_car_counts_<DAY>.csv in, car_counts_<DAY>.sql out.

Sources
-------
sales.lube_cars via locations.s_name    primary; matches how the 2026 monthly
                                        seed was built (the Splash export).
                                        CSV source label: 'splashdb'
spot_ai_car_counts.num_cars             camera gap fill for sites the Splash
                                        export never covers.
                                        CSV source label: 'spot_ai'
razayya_agent_collector.v_sale          DRB SiteWatch POS; ground truth for
                                        Guilderland-197 and Rensselaer-196.
                                        CSV source label: 'DRB'
ics_financial_performance_by_location   WashCo sites, absent from the export.
                                        CSV source label: 'ICS'

Precedence when more than one source supplies the same location_code:
    DRB (POS)  >  splashdb (sales)  >  spot_ai (camera)
POS counts actual transactions, so it wins. The camera is a last resort --
Rensselaer-196's camera runs ~12% under POS consistently.

location_code mapping is authoritative from Supabase public.pricing_simple
(site -> location_code), project rewokyofschtvqgxrxwl.
"""
import csv
import re
import sys
from datetime import date, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent

# site number -> location_code, verbatim from pricing_simple.
# The typos are real stored values, not mistakes here: 191 is 'montogomery'
# and 196 is 'rensselear'. They must be matched exactly.
SITE_TO_CODE = {
    "019": "bedford", "021": "brewster", "022": "bridgeport", "030": "cheshire",
    "032": "coscob", "040": "greenwich", "049": "darien", "050": "fairfield",
    "051": "hamden", "053": "stamford", "057": "middletown", "060": "newhaven",
    "065": "norwalk", "068": "shelton", "070": "westport", "073": "southbury",
    "074": "westhaven", "075": "whiteplainskensico", "076": "whiteplainscentral",
    "077": "tarrytown", "080": "wilton", "082": "cromwell", "083": "plattsburgh",
    "084": "williston", "085": "easthaven", "086": "newburgh", "088": "southeast",
    "089": "derby", "090": "milford", "091": "randolph", "092": "falmouth",
    "095": "springfield", "121": "batavia_veterans", "122": "binghamton",
    "123": "brockport", "124": "canandaigua", "125": "cicero", "126": "cortland",
    "127": "elmira_heights", "131": "batavia_liberty", "132": "newark",
    "133": "seneca_falls", "134": "vestal", "135": "watertown",
    "137": "williamsville", "138": "fairport", "139": "geneva_ii",
    "140": "brockport_ii", "141": "chili", "142": "rochester",
    "143": "spencerport", "144": "clay", "145": "liverpool", "147": "oswego",
    "148": "leray", "149": "hamburg", "150": "fayetteville", "151": "henrietta",
    "156": "johnson_city", "157": "batavia_ii", "159": "auburn",
    "160": "farmington", "182": "bohemia", "183": "northport",
    "184": "lindenhurst", "185": "hempstead", "186": "commack",
    "187": "eastnorthport", "191": "montogomery", "196": "rensselear",
    "197": "guilderland", "221": "rutland", "222": "shelburne",
    "231": "blackwood", "232": "cherry_hill", "233": "maple_shade",
    "241": "exton", "251": "newark_ii", "252": "wilmington",
}

# Sites with counts but no location_code in pricing_simple -> not inserted.
#   096 Splash USA Car Wash Bronx   has counts, no code (146 cars on 2026-09-04)
#   023 Bridgeport Lube / Wash      022 is the only Bridgeport code
#   011 Management                  not a store
NO_CODE_SITES = {"096", "023", "011"}
NON_STORE = {"online portal", "corporate", "splash management-011"}

# ICS name -> site number. VALUES COME FROM THE CSV, not from here.
# 057 Middletown is the only WashCo site absent from the Splash export.
# 077 WashCo White Plains is a DISTINCT site from 075 Kensico and 076 Central
# Ave. 'tarrytown' is just the common name pricing_simple stores for it.
# Confirmed by Josh 2026-09-05: the 2026 monthly seed was wrong to drop it as a
# duplicate, so it is included here and its history is under-counted.
INCLUDE_TARRYTOWN = True
ICS_SITE = {
    "WashCo Middletown": "057",
    "WashCo White Plains": "077",
}

# Fallback gap fills, used ONLY when the CSV carries no row for that site.
# The 2026-09-04 CSV predated the 'spot_ai'/'DRB' source labels and needed
# these; every CSV from 2026-09-05 on supplies the values directly, so these
# should normally go unused. A used fallback is reported loudly.
#
# WARNING: `spot_ai_car_counts` has MULTIPLE rows per site-day, one per camera
# dashboard, and at many sites those dashboards watch the SAME lane. Never
# SUM per site-day -- take one row (MAX/DISTINCT). 22 of 77 sites are affected.
# The same trap exists in `sales.lube_cars`, which returns two rows per
# location-day; for 9 locations they differ and MAX is correct.
FALLBACK = {
    "083": (456, "spot_ai"),   # Plattsburgh   (named 'ECO Plattsburgh-083' in spot_ai)
    "092": (317, "spot_ai"),   # Falmouth
    "196": (673, "DRB"),       # Rensselaer    camera runs ~12% under POS
    "197": (907, "DRB"),       # Guilderland   camera matched POS exactly on 09-04
}

# Higher wins when two sources supply the same location_code.
PRECEDENCE = {"DRB": 3, "splashdb": 2, "ICS": 2, "spot_ai": 1}

SITE_RE = re.compile(r"(\d{3})\s*$")


def site_of(name):
    """Trailing 3-digit site number, however it is punctuated."""
    m = SITE_RE.search(name.strip())
    return m.group(1) if m else None


def main(argv):
    if len(argv) > 1:
        day = argv[1]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            sys.exit(f"bad day {day!r}, expected YYYY-MM-DD")
    else:
        day = (date.today() - timedelta(days=1)).isoformat()

    note = f"{day} daily"
    csv_in = BASE / f"daily_car_counts_{day}.csv"
    sql_out = BASE / f"car_counts_{day}.sql"

    if not csv_in.exists():
        sys.exit(f"missing input: {csv_in}")

    # code -> (precedence, value, label). Multi-meter sites accumulate within
    # the same source tier; a stronger source replaces a weaker one outright.
    chosen = {}
    contrib = {}
    skipped = []
    conflicts = []
    seen_sites = set()

    with csv_in.open() as fh:
        reader = csv.DictReader(fh)
        for field in ("source", "location_name", "total_cars"):
            if field not in (reader.fieldnames or []):
                sys.exit(f"CSV missing required column {field!r}; got {reader.fieldnames}")

        for row in reader:
            name = (row.get("location_name") or "").strip()
            if not name:
                continue
            source = (row.get("source") or "").strip()
            raw = (row.get("total_cars") or "").strip()
            rowday = (row.get("day") or "").strip()
            if rowday and rowday != day:
                sys.exit(f"CSV row for {name} has day {rowday!r}, expected {day!r}")

            if source == "ICS":
                site = ICS_SITE.get(name)
                if site is None:
                    skipped.append((name, "ICS non-store"))
                    continue
                if site == "077" and not INCLUDE_TARRYTOWN:
                    skipped.append((name, "site 077/tarrytown held back, see note"))
                    continue
            else:
                if name.lower() in NON_STORE:
                    skipped.append((name, "not a store"))
                    continue
                site = site_of(name)
                if site is None:
                    skipped.append((name, "no site number in name"))
                    continue

            if site in NO_CODE_SITES:
                skipped.append((name, f"site {site} has no location_code"))
                continue
            code = SITE_TO_CODE.get(site)
            if code is None:
                skipped.append((name, f"site {site} not in pricing_simple"))
                continue

            if raw == "":
                # Blank is normal: a location present in `locations` with no
                # sales that day. Another CSV row or a fallback may fill it.
                skipped.append((name, f"blank {source or 'row'}"))
                continue

            val = int(float(raw))
            rank = PRECEDENCE.get(source, 0)
            seen_sites.add(site)

            prev = chosen.get(code)
            if prev is None:
                chosen[code] = (rank, val, source)
                contrib.setdefault(code, []).append(f"{name}={val} ({source})")
            elif rank > prev[0]:
                conflicts.append(f"{code}: {source} {val} overrides {prev[2]} {prev[1]}")
                chosen[code] = (rank, val, source)
                contrib.setdefault(code, []).append(f"{name}={val} ({source}, overrides)")
            elif rank == prev[0]:
                # Same source tier -> genuinely separate meters, so sum.
                chosen[code] = (rank, prev[1] + val, prev[2])
                contrib.setdefault(code, []).append(f"{name}={val} ({source})")
            else:
                conflicts.append(f"{code}: {source} {val} ignored, {prev[2]} {prev[1]} wins")
                skipped.append((name, f"{source} outranked by {prev[2]}"))

    # Fallbacks, only for sites the CSV never supplied.
    used_fallback = []
    for site, (val, label) in FALLBACK.items():
        if site in seen_sites:
            continue
        code = SITE_TO_CODE[site]
        if code in chosen:
            continue
        chosen[code] = (PRECEDENCE.get(label, 0), val, label)
        contrib.setdefault(code, []).append(f"site {site}={val} ({label}, fallback)")
        used_fallback.append(f"{code} (site {site}) = {val} from hardcoded {label} fallback")

    cars = {code: v for code, (_, v, _) in chosen.items()}
    rows = sorted(cars.items())
    total = sum(cars.values())

    lines = [
        f"-- car_counts daily load for {day}",
        f"-- note tag: '{note}'",
        "--",
        "-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.",
        "-- The DELETE makes a re-run of this same day idempotent.",
        "--",
        "-- WARNING: sumCarsInWindow() apportions every row across its date",
        "-- range. If a monthly row covering this month still exists, these",
        "-- daily rows will double-count. Check before applying:",
        "--   SELECT * FROM car_counts",
        f"--    WHERE start_date <= '{day}' AND end_date >= '{day}';",
        "--",
        "-- Apply with one statement per --command:",
        "--   npx wrangler d1 execute splash-damage-claims --remote --command \"...\"",
        "",
        f"DELETE FROM car_counts WHERE note = '{note}';",
        "",
        "INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES",
    ]
    for i, (code, val) in enumerate(rows):
        sep = "," if i < len(rows) - 1 else ";"
        lines.append(f"  ('{code}','{day}','{day}',{val},'{note}'){sep}")

    lines += ["", f"-- {len(rows)} rows, {total:,} cars total", ""]

    by_source = {}
    for code, (_, val, label) in chosen.items():
        by_source[label] = by_source.get(label, 0) + val
    lines.append("-- Totals by winning source:")
    for label in sorted(by_source):
        lines.append(f"--   {label}: {by_source[label]:,}")
    lines.append("")

    merged = {c: s for c, s in contrib.items() if len(s) > 1}
    if merged:
        lines.append("-- Sites with more than one contributing row:")
        for code, srcs in sorted(merged.items()):
            lines.append(f"--   {code}: " + " + ".join(srcs))
        lines.append("")

    if conflicts:
        lines.append("-- Source precedence applied:")
        for c in sorted(conflicts):
            lines.append(f"--   {c}")
        lines.append("")

    if used_fallback:
        lines.append("-- HARDCODED FALLBACKS USED (the CSV should have supplied these):")
        for f in used_fallback:
            lines.append(f"--   {f}")
        lines.append("")

    lines += ["-- Deliberately not inserted:"]
    for name, why in skipped:
        lines.append(f"--   {name} -- {why}")

    sql_out.write_text("\n".join(lines) + "\n")

    print(f"{len(rows)} rows, {total:,} cars -> {sql_out}")
    for label in sorted(by_source):
        print(f"  {label}: {by_source[label]:,}")
    for c in conflicts:
        print(f"  PRECEDENCE {c}")
    for f in used_fallback:
        print(f"  FALLBACK {f}")
    for name, why in skipped:
        print(f"  SKIP {name}: {why}")

    return rows, total


if __name__ == "__main__":
    main(sys.argv)
