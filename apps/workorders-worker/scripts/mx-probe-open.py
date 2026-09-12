#!/usr/bin/env python3
"""
Focused read-only probe: what does a site manager actually have open right now?

The 87/12 preventive-vs-reactive split is measured across six months of history,
but the serving question is about the LIVE queue: of the work orders currently
OPEN / IN_PROGRESS / ON_HOLD, how many are preventive, how many are overdue, and
how many land on a single location? That's the number behind the "group PM
separately so it doesn't overwhelm reactive" decision.

Note the filter parameter is `statuses` (repeatable), NOT `status` -- the API
rejects `status` outright. Matches packages/maintainx/src/work-orders.ts.

STRICTLY READ-ONLY. GET only.

Usage:
    python apps\\workorders-worker\\scripts\\mx-probe-open.py

Writes mx-probe-open-report.json next to this script.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

BASE = "https://api.getmaintainx.com/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
DEV_VARS = os.path.join(os.path.dirname(HERE), ".dev.vars")
REPORT_PATH = os.path.join(HERE, "mx-probe-open-report.json")

SLEEP_BETWEEN = 0.25
LIVE_STATUSES = ("OPEN", "IN_PROGRESS", "ON_HOLD")
SOON_DAYS = 7
MAX_PAGES = 60

_request_count = 0


def log(msg: str) -> None:
    print(msg, flush=True)


def load_token() -> str:
    if not os.path.exists(DEV_VARS):
        sys.exit(f"ERROR: {DEV_VARS} not found.")
    with open(DEV_VARS, "r", encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("MAINTAINX_API_KEY="):
                tok = line.split("=", 1)[1].strip().strip('"').strip("'")
                if tok:
                    return tok
    sys.exit("ERROR: MAINTAINX_API_KEY not found in .dev.vars")


HEADERS = {
    "Authorization": f"Bearer {load_token()}",
    "Accept": "application/json",
    "User-Agent": "splash-info-mx-probe/2.2",
}


def get_json(path: str, params: list[tuple[str, str]]):
    global _request_count
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    delay = 1.0
    for attempt in range(4):
        try:
            _request_count += 1
            req = urllib.request.Request(url, headers=HEADERS, method="GET")
            with urllib.request.urlopen(req, timeout=90) as resp:
                payload = json.loads(resp.read())
                time.sleep(SLEEP_BETWEEN)
                return resp.status, payload
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            return e.code, {"_error": e.read()[:300].decode("utf-8", "replace")}
        except Exception as e:  # noqa: BLE001
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            return 0, {"_error": str(e)}
    return 0, {"_error": "exhausted"}


def parse_dt(v):
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> None:
    now = datetime.now(timezone.utc)
    soon = now + timedelta(days=SOON_DAYS)
    report: dict = {"generated_at": now.isoformat(), "live_statuses": list(LIVE_STATUSES)}

    base = [("statuses", s) for s in LIVE_STATUSES] + [("limit", "100")]
    live: list[dict] = []
    cursor = None
    fetch_meta = {"pages": 0, "errors": []}
    for page in range(MAX_PAGES):
        params = list(base) + ([("cursor", cursor)] if cursor else [])
        code, payload = get_json("/workorders", params)
        if code != 200:
            fetch_meta["errors"].append({"page": page, "status": code,
                                         "detail": payload.get("_error")})
            break
        batch = payload.get("workOrders") or []
        live.extend(batch)
        fetch_meta["pages"] = page + 1
        cursor = payload.get("nextCursor")
        log(f"  page {page + 1}: +{len(batch)} (total {len(live)})")
        if not cursor or not batch:
            break
    report["fetch_meta"] = fetch_meta
    report["live_total"] = len(live)

    by_type = Counter()
    by_status = Counter()
    bucket = defaultdict(lambda: Counter())
    per_location = defaultdict(lambda: Counter())
    overdue_age_days: list[float] = []
    no_due_date = 0

    for wo in live:
        wtype = wo.get("type") or "UNKNOWN"
        by_type[wtype] += 1
        by_status[wo.get("status")] += 1
        due = parse_dt(wo.get("dueDate"))
        if due is None:
            b = "NO_DUE_DATE"
            no_due_date += 1
        elif due < now:
            b = "OVERDUE"
            overdue_age_days.append(round((now - due).total_seconds() / 86400, 1))
        elif due <= soon:
            b = "DUE_SOON"
        else:
            b = "UPCOMING"
        bucket[wtype][b] += 1
        loc = wo.get("locationId")
        per_location[loc][wtype] += 1
        per_location[loc]["total"] += 1

    def dist(vals):
        if not vals:
            return {"n": 0}
        return {"n": len(vals), "min": min(vals), "median": statistics.median(vals),
                "mean": round(statistics.mean(vals), 1), "max": max(vals)}

    loc_totals = [c["total"] for c in per_location.values()]
    report["by_type"] = dict(by_type)
    report["by_status"] = dict(by_status)
    report["urgency_buckets_by_type"] = {k: dict(v) for k, v in bucket.items()}
    report["no_due_date"] = no_due_date
    report["overdue_age_days"] = dist(overdue_age_days)
    report["per_location"] = {
        "locations_with_live_work": len(per_location),
        "total_per_location": dist(loc_totals),
        "preventive_per_location": dist([c.get("PREVENTIVE", 0) for c in per_location.values()]),
        "reactive_per_location": dist([c.get("REACTIVE", 0) for c in per_location.values()]),
        "worst_locations": sorted(
            ({"locationId": k, **dict(v)} for k, v in per_location.items()),
            key=lambda r: r.get("total", 0), reverse=True)[:10],
    }
    report["total_api_requests"] = _request_count

    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)

    log("\n" + "=" * 60)
    log(f"Live work orders:   {len(live)}  {dict(by_type)}")
    log(f"By status:          {dict(by_status)}")
    for t, b in bucket.items():
        log(f"  {t:12s} {dict(b)}")
    log(f"No due date:        {no_due_date}")
    log(f"Overdue age (days): {report['overdue_age_days']}")
    log(f"Per location:       {report['per_location']['total_per_location']}")
    log(f"  preventive:       {report['per_location']['preventive_per_location']}")
    log(f"  reactive:         {report['per_location']['reactive_per_location']}")
    log(f"API requests made:  {_request_count}")
    log(f"\nReport written to: {REPORT_PATH}")


if __name__ == "__main__":
    main()
