#!/usr/bin/env python3
"""
Focused read-only probe: are comment photos reachable?

The /workorders/{id}/comments payload is only {id, authorId, content, createdAt}
-- no attachments field. But comments with empty content clearly exist and are
almost certainly photo-only posts. This script determines whether those photos
surface in the parent work order's `attachments` array (in which case mirroring
work-order attachments captures them, and timestamp proximity can re-associate
them with their comment) or whether they are unreachable via the API.

STRICTLY READ-ONLY. GET only.

Usage:
    python apps\\workorders-worker\\scripts\\mx-probe-comments.py

Writes mx-probe-comments-report.json next to this script.
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
REPORT_PATH = os.path.join(HERE, "mx-probe-comments-report.json")

SLEEP_BETWEEN = 0.25
MAX_RETRIES = 4
SAMPLE_WORK_ORDERS = 40          # reactive WOs that have a comment watermark
CORRELATION_WINDOW_SEC = 120     # attachment vs comment timestamp proximity

# Known case: two empty-content comments one second apart on 2026-06-22.
KNOWN_EMPTY_COMMENT_WO = 106036388

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


TOKEN = load_token()
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/json",
    "User-Agent": "splash-info-mx-probe/2.1",
}


def get_json(path_or_url: str, params: list[tuple[str, str]] | None = None,
             authed: bool = True):
    global _request_count
    url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = dict(HEADERS) if authed else {"User-Agent": HEADERS["User-Agent"]}
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        try:
            _request_count += 1
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
                time.sleep(SLEEP_BETWEEN)
                try:
                    return resp.status, json.loads(body)
                except json.JSONDecodeError:
                    return resp.status, {"_error": "non-json"}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return e.code, {"_error": e.read()[:300].decode("utf-8", "replace")}
        except Exception as e:  # noqa: BLE001
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
            return 0, {"_error": str(e)}
    return 0, {"_error": "exhausted"}


def items_of(payload, *keys):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in keys:
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


def parse_dt(v):
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def wo_body(payload):
    if isinstance(payload, dict):
        inner = payload.get("workOrder")
        return inner if isinstance(inner, dict) else payload
    return {}


def main() -> None:
    report: dict = {"generated_at": datetime.now(timezone.utc).isoformat()}

    # ---- 1. What does the OpenAPI spec say about the comments endpoint? -----
    log("== OpenAPI: comments endpoint + Comment schema ==")
    status, spec = get_json("https://api.getmaintainx.com/v1/openapi.json", authed=False)
    spec_info = {"status": status}
    if status == 200 and isinstance(spec, dict):
        paths = spec.get("paths", {})
        comment_paths = {p: sorted(m.upper() for m in ops)
                         for p, ops in paths.items() if "comment" in p.lower()}
        spec_info["comment_paths"] = comment_paths
        for p, ops in paths.items():
            if "comment" in p.lower() and "get" in ops:
                op = ops["get"]
                spec_info["get_comments_params"] = [
                    {"name": pa.get("name"), "in": pa.get("in"),
                     "enum": (pa.get("schema") or {}).get("enum")}
                    for pa in op.get("parameters", [])
                ]
                break
        schemas = (spec.get("components") or {}).get("schemas", {})
        spec_info["comment_schemas"] = {
            name: sorted((s.get("properties") or {}).keys())
            for name, s in schemas.items() if "comment" in name.lower()
        }
        # Does any attachment-ish path exist beyond PUT/DELETE?
        spec_info["attachment_paths"] = {
            p: sorted(m.upper() for m in ops)
            for p, ops in paths.items() if "attachment" in p.lower()
        }
        log(f"  comment paths: {comment_paths}")
        log(f"  comment schemas: {spec_info['comment_schemas']}")
    report["openapi"] = spec_info

    # ---- 2. Do expands work on the comments endpoint? ----------------------
    log(f"\n== Expand attempts on /workorders/{KNOWN_EMPTY_COMMENT_WO}/comments ==")
    expand_results = {}
    for exp in (None, "attachments", "author", "images", "files"):
        params = [("limit", "100")] + ([("expand", exp)] if exp else [])
        st, payload = get_json(f"/workorders/{KNOWN_EMPTY_COMMENT_WO}/comments", params)
        cs = items_of(payload, "comments")
        expand_results[exp or "<none>"] = {
            "status": st,
            "count": len(cs),
            "keys": sorted({k for c in cs if isinstance(c, dict) for k in c}),
            "error": payload.get("_error") if isinstance(payload, dict) else None,
        }
        log(f"  expand={exp}: status {st}, keys {expand_results[exp or '<none>']['keys']}")
    report["comment_expand_attempts"] = expand_results

    # ---- 3. The known empty-comment work order, in full -------------------
    log(f"\n== Known case: WO {KNOWN_EMPTY_COMMENT_WO} ==")
    st, detail = get_json(f"/workorders/{KNOWN_EMPTY_COMMENT_WO}")
    body = wo_body(detail)
    atts = body.get("attachments") or []
    st2, cpayload = get_json(f"/workorders/{KNOWN_EMPTY_COMMENT_WO}/comments",
                             [("limit", "100")])
    comments = items_of(cpayload, "comments")
    report["known_case"] = {
        "work_order_id": KNOWN_EMPTY_COMMENT_WO,
        "attachment_count": len(atts),
        "attachments": [
            {"id": a.get("id"), "fileName": a.get("fileName"),
             "createdAt": a.get("createdAt"), "mimeType": a.get("mimeType")}
            for a in atts if isinstance(a, dict)
        ],
        "comments": [
            {"id": c.get("id"), "authorId": c.get("authorId"),
             "createdAt": c.get("createdAt"),
             "content_len": len(c.get("content") or ""),
             "content": (c.get("content") or "")[:120]}
            for c in comments if isinstance(c, dict)
        ],
    }
    log(f"  {len(atts)} attachments, {len(comments)} comments "
        f"({sum(1 for c in comments if not (c.get('content') or ''))} empty)")

    # ---- 4. Correlate across a sample of reactive, commented work orders ---
    log(f"\n== Sampling {SAMPLE_WORK_ORDERS} reactive work orders with comments ==")
    since = (datetime.now(timezone.utc) - timedelta(days=183)).strftime("%Y-%m-%dT%H:%M:%SZ")
    candidates: list[dict] = []
    cursor = None
    for _ in range(12):
        params = [("createdAt[gte]", since), ("limit", "100")]
        if cursor:
            params.append(("cursor", cursor))
        st, payload = get_json("/workorders", params)
        if st != 200:
            break
        batch = items_of(payload, "workOrders")
        cursor = payload.get("nextCursor") if isinstance(payload, dict) else None
        candidates += [w for w in batch
                       if w.get("type") == "REACTIVE" and w.get("lastMessageSentAt")]
        if len(candidates) >= SAMPLE_WORK_ORDERS or not cursor or not batch:
            break
    candidates = candidates[:SAMPLE_WORK_ORDERS]
    log(f"  {len(candidates)} candidates")

    rows = []
    totals = {
        "work_orders": 0,
        "comments": 0,
        "empty_comments": 0,
        "attachments": 0,
        "empty_comments_matched_to_attachment": 0,
        "attachments_matched_to_any_comment": 0,
        "attachments_matched_to_empty_comment": 0,
        "work_orders_with_more_attachments_than_empty_comments": 0,
    }
    for wo in candidates:
        wid = wo.get("id")
        st, detail = get_json(f"/workorders/{wid}")
        if st != 200:
            continue
        b = wo_body(detail)
        atts = [a for a in (b.get("attachments") or []) if isinstance(a, dict)]
        st2, cpayload = get_json(f"/workorders/{wid}/comments", [("limit", "100")])
        cs = [c for c in items_of(cpayload, "comments") if isinstance(c, dict)]
        empties = [c for c in cs if not (c.get("content") or "").strip()]

        att_times = [(a, parse_dt(a.get("createdAt"))) for a in atts]
        matched_empty = 0
        for c in empties:
            ct = parse_dt(c.get("createdAt"))
            if ct and any(at and abs((at - ct).total_seconds()) <= CORRELATION_WINDOW_SEC
                          for _a, at in att_times):
                matched_empty += 1
        matched_att_any = matched_att_empty = 0
        for _a, at in att_times:
            if not at:
                continue
            if any(parse_dt(c.get("createdAt")) and
                   abs((at - parse_dt(c.get("createdAt"))).total_seconds()) <= CORRELATION_WINDOW_SEC
                   for c in cs):
                matched_att_any += 1
            if any(parse_dt(c.get("createdAt")) and
                   abs((at - parse_dt(c.get("createdAt"))).total_seconds()) <= CORRELATION_WINDOW_SEC
                   for c in empties):
                matched_att_empty += 1

        totals["work_orders"] += 1
        totals["comments"] += len(cs)
        totals["empty_comments"] += len(empties)
        totals["attachments"] += len(atts)
        totals["empty_comments_matched_to_attachment"] += matched_empty
        totals["attachments_matched_to_any_comment"] += matched_att_any
        totals["attachments_matched_to_empty_comment"] += matched_att_empty
        if len(atts) > len(empties):
            totals["work_orders_with_more_attachments_than_empty_comments"] += 1

        rows.append({
            "work_order_id": wid,
            "comments": len(cs),
            "empty_comments": len(empties),
            "attachments": len(atts),
            "empty_matched": matched_empty,
            "att_matched_any_comment": matched_att_any,
        })
        log(f"  WO {wid}: {len(cs)}c ({len(empties)} empty), {len(atts)}a, "
            f"{matched_empty} empty matched")

    report["correlation"] = {"window_seconds": CORRELATION_WINDOW_SEC,
                            "totals": totals, "rows": rows}
    report["total_api_requests"] = _request_count

    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)

    log("\n" + "=" * 60)
    log(f"Work orders sampled:                {totals['work_orders']}")
    log(f"Comments / empty comments:          {totals['comments']} / {totals['empty_comments']}")
    log(f"Attachments on those work orders:   {totals['attachments']}")
    log(f"Empty comments near an attachment:  {totals['empty_comments_matched_to_attachment']}")
    log(f"Attachments near any comment:       {totals['attachments_matched_to_any_comment']}")
    log(f"API requests made:                  {_request_count}")
    log(f"\nReport written to: {REPORT_PATH}")


if __name__ == "__main__":
    main()
