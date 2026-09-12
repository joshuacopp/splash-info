#!/usr/bin/env python3
"""
Verification probe for the Phase 1 ingest design.

Three unknowns gate the backfill plan in supabase/maintainx-ingest-phase-1-plan.md:

  1. Is `limit=200` actually honored? packages/maintainx/src/work-orders.ts:16
     sets PAGE_LIMIT=200, but every probe so far used limit=100 and got ~98
     rows/page. If MaintainX silently caps at 100 then that constant is fiction
     and the serving path's effective ceiling is half what the code implies.

  2. Does `updatedAt[gte]` filter, or is it accepted and ignored? The docs say
     it works (ISO 8601 UTC). The whole incremental sweep depends on it, so it
     gets tested in BOTH directions with value validation, not just a 200 check.

  3. Which `expand` tokens does GET /workorders accept? The client hardcodes
     assignees/location/categories. Ingest needs parts, expenditures, timeItems,
     attachments and procedure fields. A bad expand value is a 400 that fails the
     whole page, so these get confirmed against the OpenAPI enum AND probed
     one at a time.

Plus: sort tokens (the history pass needs a createdAt sort for its stop
condition), createdAt range filters, cursor/filter interaction, and whether
`deletedAt` ever appears on a list payload.

Note the API 400s on unknown query params -- `status` and `expand`-on-comments
both did. So a 200 is decent evidence a param is real. Decent, not proof: every
filter here is also validated against the values that come back.

STRICTLY READ-ONLY. GET only.

Usage:
    python apps\\workorders-worker\\scripts\\mx-probe-params.py

Writes mx-probe-params-report.json next to this script.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://api.getmaintainx.com/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
DEV_VARS = os.path.join(os.path.dirname(HERE), ".dev.vars")
REPORT_PATH = os.path.join(HERE, "mx-probe-params-report.json")

SLEEP_BETWEEN = 0.25
MAX_RETRIES = 4

LIMITS_TO_TRY = [50, 100, 150, 200, 250, 500, 1000]

SORTS_TO_TRY = [
    "-updatedAt", "updatedAt",
    "-createdAt", "createdAt",
    "-dueDate", "dueDate",
    "-id", "id",
]

# Hardcoded in the client today: assignees, location, categories.
# The rest map to mx_work_order_* child tables the schema already has.
EXPANDS_TO_TRY = [
    "assignees", "location", "categories",
    "parts", "expenditures", "timeItems", "times",
    "attachments", "procedure", "procedureFields",
    "vendors", "teams", "requester", "asset",
    "workRequest", "recurrence", "recurrenceInfo",
]

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
    "User-Agent": "splash-info-mx-probe/3.0",
}


def get_json(path: str, params: list[tuple[str, str]] | None = None):
    """Returns (status, payload). Never raises."""
    global _request_count
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        try:
            _request_count += 1
            req = urllib.request.Request(url, headers=HEADERS, method="GET")
            with urllib.request.urlopen(req, timeout=90) as resp:
                payload = json.loads(resp.read())
                time.sleep(SLEEP_BETWEEN)
                return resp.status, payload
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
            body = e.read()[:400].decode("utf-8", "replace")
            time.sleep(SLEEP_BETWEEN)
            return e.code, {"_error": body}
        except Exception as e:  # noqa: BLE001
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return 0, {"_error": str(e)}
    return 0, {"_error": "exhausted"}


def rows(payload) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    got = payload.get("workOrders")
    return got if isinstance(got, list) else []


def parse_dt(v):
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def span(items: list[dict], field: str) -> dict:
    """min/max of a datetime field across rows, as ISO strings."""
    vals = [d for d in (parse_dt(r.get(field)) for r in items) if d is not None]
    if not vals:
        return {"n": 0, "min": None, "max": None}
    return {"n": len(vals), "min": iso(min(vals)), "max": iso(max(vals))}


# ---------------------------------------------------------------- section 1

def probe_openapi(report: dict) -> None:
    log("\n[1/7] OpenAPI: declared parameters for GET /workorders")
    code, spec = get_json("/openapi.json")
    out: dict = {"status": code}
    report["openapi"] = out
    if code != 200 or not isinstance(spec, dict):
        out["error"] = str(spec)[:300]
        log(f"  FAILED ({code})")
        return

    op = ((spec.get("paths") or {}).get("/workorders") or {}).get("get") or {}
    params = op.get("parameters") or []
    declared = []
    for p in params:
        if not isinstance(p, dict):
            continue
        schema = p.get("schema") or {}
        enum = schema.get("enum") or (schema.get("items") or {}).get("enum")
        declared.append({
            "name": p.get("name"),
            "in": p.get("in"),
            "type": schema.get("type"),
            "enum": enum,
            "description": (p.get("description") or "")[:160] or None,
        })
    out["declared_params"] = declared
    names = [d["name"] for d in declared]
    out["param_names"] = names
    log(f"  {len(declared)} declared params: {', '.join(str(n) for n in names)}")

    # The expand enum is the authoritative answer to unknown #3.
    expand_enum = next(
        (d["enum"] for d in declared if d["name"] == "expand" and d["enum"]), None
    )
    out["expand_enum"] = expand_enum
    log(f"  expand enum: {expand_enum}")

    for probe in ("updatedAt[gte]", "updatedAt[lte]", "createdAt[gte]", "createdAt[lte]"):
        out.setdefault("date_params_declared", {})[probe] = probe in names

    # And the work-order schema, for the field list the ingest types need.
    schemas = (spec.get("components") or {}).get("schemas") or {}
    wo_schema = next(
        (v for k, v in schemas.items()
         if isinstance(v, dict) and k.lower().replace("_", "") in ("workorder", "workorderresponse")),
        None,
    )
    if isinstance(wo_schema, dict):
        props = wo_schema.get("properties") or {}
        out["work_order_schema_fields"] = sorted(props.keys())
        log(f"  WorkOrder schema: {len(props)} fields")


# ---------------------------------------------------------------- section 2

def probe_limit(report: dict) -> None:
    log("\n[2/7] Is limit=200 honored? (unknown #1)")
    out: dict = {}
    report["limit"] = out
    for lim in LIMITS_TO_TRY:
        code, payload = get_json("/workorders", [("limit", str(lim))])
        got = rows(payload)
        out[str(lim)] = {
            "status": code,
            "returned": len(got),
            "honored": code == 200 and len(got) == lim,
            "error": payload.get("_error") if code != 200 else None,
        }
        log(f"  limit={lim:<5} -> {code} {len(got)} rows")

    ok = [int(k) for k, v in out.items() if v["status"] == 200 and v["returned"] > 0]
    effective = max((out[str(k)]["returned"] for k in ok), default=0)
    out["_effective_max_page_size"] = effective
    out["_client_PAGE_LIMIT_200_is_real"] = effective >= 200
    log(f"  => effective max page size: {effective}")


# ---------------------------------------------------------------- section 3

def probe_updated_at(report: dict) -> None:
    log("\n[3/7] Does updatedAt[gte] actually filter? (unknown #2)")
    now = datetime.now(timezone.utc)
    out: dict = {}
    report["updated_at_filter"] = out

    # Baseline: unbounded, newest first.
    code, payload = get_json("/workorders", [("limit", "100"), ("sort", "-updatedAt")])
    base_rows = rows(payload)
    out["baseline"] = {"status": code, "returned": len(base_rows),
                       "updatedAt_span": span(base_rows, "updatedAt")}
    log(f"  baseline: {len(base_rows)} rows, span {out['baseline']['updatedAt_span']}")

    # Direction A -- gte with a RECENT bound. If the filter works we should see
    # every row at or after it. If it's ignored we'd still see recent rows on a
    # -updatedAt sort, so value validation is what decides, not the count.
    gte_bound = now - timedelta(days=2)
    code, payload = get_json("/workorders", [
        ("updatedAt[gte]", iso(gte_bound)), ("limit", "100"), ("sort", "updatedAt"),
    ])
    got = rows(payload)
    violations = [
        {"id": r.get("id"), "updatedAt": r.get("updatedAt")}
        for r in got
        if (d := parse_dt(r.get("updatedAt"))) is not None and d < gte_bound
    ]
    out["gte_recent"] = {
        "status": code,
        "bound": iso(gte_bound),
        "returned": len(got),
        "updatedAt_span": span(got, "updatedAt"),
        "violations": len(violations),
        "violation_sample": violations[:5],
        "error": payload.get("_error") if code != 200 else None,
    }
    log(f"  gte(now-2d) -> {code} {len(got)} rows, {len(violations)} violations")

    # Direction B -- lte with an OLD bound. This is the clean discriminator:
    # if the filter is silently ignored the newest row comes back as today,
    # which is impossible when the bound is two years back.
    lte_bound = now - timedelta(days=730)
    code, payload = get_json("/workorders", [
        ("updatedAt[lte]", iso(lte_bound)), ("limit", "100"), ("sort", "-updatedAt"),
    ])
    got = rows(payload)
    violations = [
        {"id": r.get("id"), "updatedAt": r.get("updatedAt")}
        for r in got
        if (d := parse_dt(r.get("updatedAt"))) is not None and d > lte_bound
    ]
    out["lte_old"] = {
        "status": code,
        "bound": iso(lte_bound),
        "returned": len(got),
        "updatedAt_span": span(got, "updatedAt"),
        "violations": len(violations),
        "violation_sample": violations[:5],
        "error": payload.get("_error") if code != 200 else None,
    }
    log(f"  lte(now-730d) -> {code} {len(got)} rows, {len(violations)} violations")

    # Both bounds at once -- a narrow window should return a narrow span.
    w_lo, w_hi = now - timedelta(days=30), now - timedelta(days=23)
    code, payload = get_json("/workorders", [
        ("updatedAt[gte]", iso(w_lo)), ("updatedAt[lte]", iso(w_hi)),
        ("limit", "100"), ("sort", "updatedAt"),
    ])
    got = rows(payload)
    out["window"] = {
        "status": code, "gte": iso(w_lo), "lte": iso(w_hi),
        "returned": len(got), "updatedAt_span": span(got, "updatedAt"),
        "error": payload.get("_error") if code != 200 else None,
    }
    log(f"  window(30d..23d ago) -> {code} {len(got)} rows, span {out['window']['updatedAt_span']}")

    a, b = out["gte_recent"], out["lte_old"]
    out["_verdict"] = (
        "WORKS" if a["status"] == 200 and b["status"] == 200
        and a["violations"] == 0 and b["violations"] == 0
        else "REJECTED" if 400 in (a["status"], b["status"])
        else "ACCEPTED_BUT_IGNORED"
    )
    log(f"  => updatedAt filter: {out['_verdict']}")


# ---------------------------------------------------------------- section 4

def probe_created_at(report: dict) -> None:
    log("\n[4/7] createdAt range filters (history pass bound)")
    now = datetime.now(timezone.utc)
    out: dict = {}
    report["created_at_filter"] = out

    gte_bound = now - timedelta(days=183)
    code, payload = get_json("/workorders", [
        ("createdAt[gte]", iso(gte_bound)), ("limit", "100"), ("sort", "createdAt"),
    ])
    got = rows(payload)
    violations = sum(
        1 for r in got
        if (d := parse_dt(r.get("createdAt"))) is not None and d < gte_bound
    )
    out["gte_6mo"] = {
        "status": code, "bound": iso(gte_bound), "returned": len(got),
        "createdAt_span": span(got, "createdAt"), "violations": violations,
        "error": payload.get("_error") if code != 200 else None,
    }
    log(f"  createdAt[gte](6mo) -> {code} {len(got)} rows, {violations} violations")

    lte_bound = now - timedelta(days=730)
    code, payload = get_json("/workorders", [
        ("createdAt[lte]", iso(lte_bound)), ("limit", "100"), ("sort", "-createdAt"),
    ])
    got = rows(payload)
    violations = sum(
        1 for r in got
        if (d := parse_dt(r.get("createdAt"))) is not None and d > lte_bound
    )
    out["lte_old"] = {
        "status": code, "bound": iso(lte_bound), "returned": len(got),
        "createdAt_span": span(got, "createdAt"), "violations": violations,
        "error": payload.get("_error") if code != 200 else None,
    }
    log(f"  createdAt[lte](2yr) -> {code} {len(got)} rows, {violations} violations")

    out["_verdict"] = (
        "WORKS" if out["gte_6mo"]["status"] == 200 and out["lte_old"]["status"] == 200
        and out["gte_6mo"]["violations"] == 0 and out["lte_old"]["violations"] == 0
        else "REJECTED" if 400 in (out["gte_6mo"]["status"], out["lte_old"]["status"])
        else "ACCEPTED_BUT_IGNORED"
    )
    log(f"  => createdAt filter: {out['_verdict']}")


# ---------------------------------------------------------------- section 5

def probe_sorts(report: dict) -> None:
    log("\n[5/7] Sort tokens (history pass needs a createdAt sort)")
    out: dict = {}
    report["sorts"] = out
    for s in SORTS_TO_TRY:
        code, payload = get_json("/workorders", [("sort", s), ("limit", "20")])
        got = rows(payload)
        field = s.lstrip("-")
        ordered = None
        if got and field in ("updatedAt", "createdAt", "dueDate"):
            vals = [parse_dt(r.get(field)) for r in got]
            vals = [v for v in vals if v is not None]
            if len(vals) > 1:
                ordered = (
                    all(a >= b for a, b in zip(vals, vals[1:])) if s.startswith("-")
                    else all(a <= b for a, b in zip(vals, vals[1:]))
                )
        out[s] = {
            "status": code, "returned": len(got),
            "correctly_ordered": ordered,
            "span": span(got, field) if field != "id" else None,
            "error": payload.get("_error") if code != 200 else None,
        }
        log(f"  sort={s:<12} -> {code} {len(got)} rows ordered={ordered}")


# ---------------------------------------------------------------- section 6

def probe_expands(report: dict) -> None:
    log("\n[6/7] expand tokens, one at a time (unknown #3)")
    out: dict = {}
    report["expands"] = out

    # Baseline key set with no expand, so we can tell which keys an expand ADDS.
    code, payload = get_json("/workorders", [("limit", "5")])
    base = rows(payload)
    base_keys = set()
    for r in base:
        base_keys |= set(r.keys())
    report["baseline_row_keys"] = sorted(base_keys)
    log(f"  baseline row keys ({len(base_keys)}): {sorted(base_keys)}")

    for token in EXPANDS_TO_TRY:
        code, payload = get_json("/workorders", [("expand", token), ("limit", "5")])
        got = rows(payload)
        keys = set()
        for r in got:
            keys |= set(r.keys())
        added = sorted(keys - base_keys)
        populated = sorted(
            k for k in added
            if any(r.get(k) not in (None, [], {}, "") for r in got)
        )
        out[token] = {
            "status": code,
            "accepted": code == 200,
            "returned": len(got),
            "added_keys": added,
            "added_keys_populated": populated,
            "error": payload.get("_error") if code != 200 else None,
        }
        flag = "OK " if code == 200 else "REJ"
        log(f"  {flag} expand={token:<16} {code} added={added}")

    accepted = [t for t, v in out.items() if v["accepted"]]
    out["_accepted"] = accepted
    log(f"  => accepted: {accepted}")


# ---------------------------------------------------------------- section 7

def probe_cursor_and_deleted(report: dict) -> None:
    log("\n[7/7] cursor+filter interaction, and deletedAt visibility")
    now = datetime.now(timezone.utc)
    out: dict = {}
    report["cursor_with_filter"] = out

    # A filtered walk must survive paging, or incremental sync can only ever
    # read its own first page.
    params = [("updatedAt[gte]", iso(now - timedelta(days=30))),
              ("limit", "100"), ("sort", "updatedAt")]
    code, payload = get_json("/workorders", params)
    p1 = rows(payload)
    cursor = payload.get("nextCursor") if isinstance(payload, dict) else None
    out["page1"] = {"status": code, "returned": len(p1),
                    "has_cursor": bool(cursor),
                    "span": span(p1, "updatedAt")}
    if cursor:
        code2, payload2 = get_json("/workorders", params + [("cursor", cursor)])
        p2 = rows(payload2)
        ids1 = {r.get("id") for r in p1}
        out["page2"] = {
            "status": code2, "returned": len(p2),
            "span": span(p2, "updatedAt"),
            "overlap_with_page1": len({r.get("id") for r in p2} & ids1),
            "filter_still_applied": out["page1"]["span"]["min"] is not None,
            "error": payload2.get("_error") if code2 != 200 else None,
        }
        log(f"  page2 -> {code2} {len(p2)} rows, overlap={out['page2']['overlap_with_page1']}")
    else:
        out["page2"] = {"skipped": "no nextCursor on page 1"}
        log("  page2 skipped (no cursor)")

    # Does a list payload ever carry deletedAt? Determines whether deletes are
    # observable at all, or only as disappearance from the result set.
    code, payload = get_json("/workorders", [("limit", "100"), ("sort", "-updatedAt")])
    got = rows(payload)
    report["deleted_at"] = {
        "rows_checked": len(got),
        "key_present_on": sum(1 for r in got if "deletedAt" in r),
        "non_null_on": sum(1 for r in got if r.get("deletedAt")),
        "sample": [r.get("deletedAt") for r in got if r.get("deletedAt")][:3],
    }
    log(f"  deletedAt present on {report['deleted_at']['key_present_on']}/{len(got)} rows")


def main() -> None:
    report: dict = {"generated_at": datetime.now(timezone.utc).isoformat()}

    probe_openapi(report)
    probe_limit(report)
    probe_updated_at(report)
    probe_created_at(report)
    probe_sorts(report)
    probe_expands(report)
    probe_cursor_and_deleted(report)

    report["total_api_requests"] = _request_count
    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)

    log("\n" + "=" * 62)
    log("VERDICTS")
    log(f"  max page size:        {report.get('limit', {}).get('_effective_max_page_size')}"
        f"  (client claims 200)")
    log(f"  updatedAt filter:     {report.get('updated_at_filter', {}).get('_verdict')}")
    log(f"  createdAt filter:     {report.get('created_at_filter', {}).get('_verdict')}")
    log(f"  expand accepted:      {report.get('expands', {}).get('_accepted')}")
    log(f"  openapi expand enum:  {report.get('openapi', {}).get('expand_enum')}")
    log(f"  API requests made:    {_request_count}")
    log(f"\nReport written to: {REPORT_PATH}")


if __name__ == "__main__":
    main()
