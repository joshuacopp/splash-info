#!/usr/bin/env python3
"""
Read-only MaintainX API volume probe.

Measures how much data a 6-month backfill into Supabase would actually move, so
the ingest loop, the sweep priority and the R2 attachment mirror can be sized
from real numbers instead of guesses.

STRICTLY READ-ONLY. Only issues GET. Never touches POST /subscriptions.
Never downloads an attachment body -- it reads Content-Length via a 1-byte
Range request.

Usage (from the repo root, in PowerShell):

    python apps\\workorders-worker\\scripts\\mx-probe.py

Reads MAINTAINX_API_KEY from apps/workorders-worker/.dev.vars (gitignored).
The token is never printed. Writes mx-probe-report.json next to this script.

Round 2 additions: true (un-capped) 6-month count, work-order type and
recurrence breakdown cross-tabbed against requester/comment/cost presence,
attachment object key discovery so size probing actually works, and sample
comment bodies (cost detail currently lives in comment free text).
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
REPORT_PATH = os.path.join(HERE, "mx-probe-report.json")

# Politeness / safety. Rate limits are undocumented, so go slow and back off blind.
# Round 1 made 153 requests at 0.30s with zero 429s, so this is comfortable.
SLEEP_BETWEEN = 0.25
MAX_RETRIES = 5
PAGE_LIMIT = 100

MAX_WO_PAGES = 400        # ~40k work orders; 6 months is expected near 200 pages
MAX_REQ_PAGES = 200
MAX_REF_PAGES = 100

SAMPLE_PLAIN = 15         # randomly spread work orders
SAMPLE_CHATTY = 15        # work orders that actually have a comment watermark
SAMPLE_COMMENT_BODIES = 8
SAMPLE_ATTACHMENTS = 30

SIX_MONTHS_DAYS = 183

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
    "User-Agent": "splash-info-mx-probe/2.0",
}


def request(url: str, method: str = "GET", extra_headers: dict | None = None,
            authed: bool = True):
    """Returns (status, headers, body_bytes). Retries on 429/5xx."""
    global _request_count
    headers = dict(HEADERS) if authed else {"User-Agent": HEADERS["User-Agent"]}
    if extra_headers:
        headers.update(extra_headers)
    delay = 1.0
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, headers=headers, method=method)
        try:
            _request_count += 1
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                time.sleep(SLEEP_BETWEEN)
                return resp.status, dict(resp.headers), body
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                retry_after = e.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
                log(f"  [retry] {e.code} -- sleeping {wait:.1f}s")
                time.sleep(wait)
                delay *= 2
                continue
            return e.code, dict(e.headers), e.read()
        except Exception as e:  # noqa: BLE001
            if attempt < MAX_RETRIES - 1:
                log(f"  [retry] {type(e).__name__} -- sleeping {delay:.1f}s")
                time.sleep(delay)
                delay *= 2
                continue
            return 0, {}, str(e).encode()
    return 0, {}, b""


def get_json(path: str, params: list[tuple[str, str]] | None = None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    status, headers, body = request(url)
    if status != 200:
        return status, headers, {"_error": body[:400].decode("utf-8", "replace")}
    try:
        return status, headers, json.loads(body)
    except json.JSONDecodeError:
        return status, headers, {"_error": "non-json response"}


def extract_items(payload):
    """MaintainX list responses wrap the array; find it without assuming the key."""
    if isinstance(payload, list):
        return payload, None
    if not isinstance(payload, dict):
        return [], None
    cursor = payload.get("nextCursor") or payload.get("next_cursor")
    for key in ("workOrders", "workRequests", "comments", "users", "locations",
                "teams", "categories", "vendors", "parts", "data", "items", "results"):
        if isinstance(payload.get(key), list):
            return payload[key], cursor
    for key, val in payload.items():
        if isinstance(val, list) and key not in ("errors",):
            return val, cursor
    return [], cursor


def page_all(path: str, base_params: list[tuple[str, str]], max_pages: int,
             label: str, stop_before=None) -> tuple[list, dict]:
    """stop_before: callable(item) -> True to halt paging (list is newest-first)."""
    items: list = []
    cursor = None
    meta = {"pages": 0, "truncated": False, "envelope_keys": None, "errors": [],
            "stopped_on_date": False}
    for page in range(max_pages):
        params = list(base_params) + [("limit", str(PAGE_LIMIT))]
        if cursor:
            params.append(("cursor", cursor))
        status, _hdrs, payload = get_json(path, params)
        if status != 200:
            meta["errors"].append({"page": page, "status": status,
                                   "detail": payload.get("_error")})
            break
        if page == 0 and isinstance(payload, dict):
            meta["envelope_keys"] = sorted(payload.keys())
        batch, cursor = extract_items(payload)
        items.extend(batch)
        meta["pages"] = page + 1
        if page % 10 == 0 or not cursor:
            log(f"  {label}: page {page + 1}, total {len(items)}")
        if stop_before and batch and stop_before(batch[-1]):
            meta["stopped_on_date"] = True
            break
        if not cursor or not batch:
            break
    else:
        meta["truncated"] = True
    return items, meta


def parse_dt(value):
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def nonempty(value) -> bool:
    return isinstance(value, list) and len(value) > 0


def dist(values: list) -> dict:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "mean": round(statistics.mean(values), 2),
        "max": max(values),
        "total": sum(values),
    }


def main() -> None:
    now = datetime.now(timezone.utc)
    cutoff_6mo = now - timedelta(days=SIX_MONTHS_DAYS)
    cutoff_30d = now - timedelta(days=30)
    since_6mo = cutoff_6mo.strftime("%Y-%m-%dT%H:%M:%SZ")
    report: dict = {"generated_at": now.isoformat(), "window_start_6mo": since_6mo,
                    "probe_version": 2}

    # ---- 1. Full 6-month work order walk ------------------------------------
    log(f"\n== Work orders created since {since_6mo} (full walk) ==")
    expands = [("expand", e) for e in
               ("expenditures", "parts", "time_items", "times", "categories")]
    work_orders, wo_meta = page_all(
        "/workorders",
        [("createdAt[gte]", since_6mo)] + expands,
        MAX_WO_PAGES,
        "workorders",
        stop_before=lambda w: (parse_dt(w.get("createdAt")) or now) < cutoff_6mo,
    )
    # Trust the local date rather than the server filter.
    in_window = [w for w in work_orders
                 if (parse_dt(w.get("createdAt")) or now) >= cutoff_6mo]
    log(f"  fetched {len(work_orders)}, {len(in_window)} inside the 6-month window")

    statuses, priorities, types = Counter(), Counter(), Counter()
    last_30d = 0
    recurring = 0
    # Cross-tab: for each work order type, how much of it actually matters?
    by_type = defaultdict(lambda: Counter())
    with_requester = with_expend = with_parts = with_time = with_watermark = 0
    expend_lines = parts_lines = time_lines = 0
    oldest = newest = None

    for wo in in_window:
        created = parse_dt(wo.get("createdAt"))
        if created:
            oldest = created if oldest is None or created < oldest else oldest
            newest = created if newest is None or created > newest else newest
            if created >= cutoff_30d:
                last_30d += 1
        wtype = wo.get("type") or "UNKNOWN"
        statuses[wo.get("status")] += 1
        priorities[wo.get("priority")] += 1
        types[wtype] += 1
        t = by_type[wtype]
        t["total"] += 1
        if wo.get("recurrenceInfo"):
            recurring += 1
            t["recurring"] += 1
        if wo.get("requesterId") is not None:
            with_requester += 1
            t["with_requester"] += 1
        if wo.get("lastMessageSentAt"):
            with_watermark += 1
            t["with_comments"] += 1
        if nonempty(wo.get("expenditures")):
            with_expend += 1
            t["with_expenditures"] += 1
            expend_lines += len(wo["expenditures"])
        if nonempty(wo.get("parts")):
            with_parts += 1
            t["with_parts"] += 1
            parts_lines += len(wo["parts"])
        if nonempty(wo.get("timeItems")):
            with_time += 1
            t["with_time_items"] += 1
            time_lines += len(wo["timeItems"])

    n = max(len(in_window), 1)
    report["work_orders"] = {
        "meta": wo_meta,
        "total_6mo": len(in_window),
        "total_fetched": len(work_orders),
        "total_last_30d": last_30d,
        "oldest_created": str(oldest),
        "newest_created": str(newest),
        "by_status": dict(statuses),
        "by_priority": dict(priorities),
        "by_type": dict(types),
        "type_crosstab": {k: dict(v) for k, v in by_type.items()},
        "recurring": recurring,
        "with_requester_id": with_requester,
        "with_last_message_sent_at": with_watermark,
        "with_expenditures": with_expend,
        "expenditure_line_total": expend_lines,
        "with_parts": with_parts,
        "part_line_total": parts_lines,
        "with_time_items": with_time,
        "time_item_line_total": time_lines,
        "pct_with_requester": round(100 * with_requester / n, 1),
        "pct_recurring": round(100 * recurring / n, 1),
        "pct_with_comments": round(100 * with_watermark / n, 1),
    }

    # ---- 2. Sample detail: comments (biased toward WOs that have them) -------
    log("\n== Sampling work orders for comments + attachments ==")
    chatty = [w for w in in_window if w.get("lastMessageSentAt")]
    plain = [w for w in in_window if not w.get("lastMessageSentAt")]

    def spread(seq, k):
        if not seq:
            return []
        step = max(1, len(seq) // k)
        return seq[::step][:k]

    sample = spread(chatty, SAMPLE_CHATTY) + spread(plain, SAMPLE_PLAIN)

    comment_counts_chatty, comment_counts_plain = [], []
    attachment_counts = []
    attachment_objects: list[dict] = []
    comment_bodies: list[dict] = []
    comment_envelope_keys = None

    for wo in sample:
        wid = wo.get("id")
        if wid is None:
            continue
        is_chatty = bool(wo.get("lastMessageSentAt"))

        status, _h, detail = get_json(f"/workorders/{wid}")
        atts = []
        if status == 200 and isinstance(detail, dict):
            body = detail.get("workOrder") if isinstance(detail.get("workOrder"), dict) else detail
            atts = body.get("attachments") or []
            attachment_counts.append(len(atts))
            for a in atts:
                if isinstance(a, dict):
                    attachment_objects.append(a)

        cstatus, _h2, cpayload = get_json(f"/workorders/{wid}/comments", [("limit", "100")])
        ccount = 0
        if cstatus == 200:
            if comment_envelope_keys is None and isinstance(cpayload, dict):
                comment_envelope_keys = sorted(cpayload.keys())
            citems, _c = extract_items(cpayload)
            ccount = len(citems)
            if is_chatty and len(comment_bodies) < SAMPLE_COMMENT_BODIES and citems:
                comment_bodies.append({
                    "work_order_id": wid,
                    "comment_keys": sorted({k for c in citems if isinstance(c, dict) for k in c}),
                    "samples": [
                        {k: (v[:300] if isinstance(v, str) else v) for k, v in c.items()}
                        for c in citems[:3] if isinstance(c, dict)
                    ],
                })
        (comment_counts_chatty if is_chatty else comment_counts_plain).append(ccount)
        log(f"  WO {wid} ({'chatty' if is_chatty else 'plain'}): "
            f"{ccount} comments, {len(atts)} attachments")

    report["comments"] = {
        "envelope_keys": comment_envelope_keys,
        "per_wo_with_watermark": dist(comment_counts_chatty),
        "per_wo_without_watermark": dist(comment_counts_plain),
        "bodies": comment_bodies,
    }

    # ---- 3. Attachments: discover the URL field, then size them -------------
    log(f"\n== Attachments ({len(attachment_objects)} objects found) ==")
    att_keys = sorted({k for a in attachment_objects for k in a})
    report["attachments"] = {
        "per_work_order": dist(attachment_counts),
        "object_keys": att_keys,
        "sample_object": (
            {k: (str(v)[:120] if k.lower().endswith("url") else v)
             for k, v in attachment_objects[0].items()}
            if attachment_objects else None
        ),
    }
    log(f"  attachment object keys: {att_keys}")

    url_keys = [k for k in att_keys if "url" in k.lower() or k in ("href", "link")]
    sizes: list[int] = []
    size_errors: list[dict] = []
    for a in attachment_objects[:SAMPLE_ATTACHMENTS]:
        # Prefer an explicit size field if MaintainX gives one -- free, no request.
        for sk in ("fileSize", "size", "sizeBytes", "contentLength"):
            if isinstance(a.get(sk), int) and a[sk] > 0:
                sizes.append(a[sk])
                break
        else:
            url = next((a[k] for k in url_keys if isinstance(a.get(k), str)), None)
            if not url:
                size_errors.append({"reason": "no url field", "keys": sorted(a.keys())})
                continue
            # Signed S3-style URLs reject extra auth headers, so send none.
            st, hdrs, _b = request(url, extra_headers={"Range": "bytes=0-0"}, authed=False)
            h = {k.lower(): v for k, v in hdrs.items()}
            size = None
            cr = h.get("content-range")
            if cr and "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                size = int(cr.rsplit("/", 1)[1])
            elif h.get("content-length", "").isdigit() and int(h["content-length"]) > 1:
                size = int(h["content-length"])
            if size:
                sizes.append(size)
                log(f"  {size / 1024:.0f} KB")
            else:
                size_errors.append({"reason": f"status {st}, no length",
                                    "headers": sorted(h.keys())})
    report["attachments"]["size_bytes"] = dist(sizes)
    report["attachments"]["size_errors"] = size_errors[:10]

    mean_size = statistics.mean(sizes) if sizes else 0
    mean_per_wo = statistics.mean(attachment_counts) if attachment_counts else 0
    backfill_gb = mean_per_wo * mean_size * len(in_window) / 1024 ** 3
    monthly_gb = mean_per_wo * mean_size * last_30d / 1024 ** 3
    report["r2_projection"] = {
        "mean_attachment_bytes": round(mean_size),
        "mean_attachments_per_work_order": round(mean_per_wo, 3),
        "backfill_gb": round(backfill_gb, 3),
        "monthly_growth_gb": round(monthly_gb, 3),
        "backfill_cost_usd_per_month_at_0.015_per_gb": round(backfill_gb * 0.015, 3),
        "caveat": "small sample; one large video would dominate",
    }

    # ---- 4. Work requests ---------------------------------------------------
    log("\n== Work requests (no date filter available) ==")
    reqs, req_meta = page_all("/workrequests", [], MAX_REQ_PAGES, "workrequests")
    req_status = Counter()
    contact_types = Counter()
    with_contact = with_wo = with_creator = 0
    req_in_6mo = 0
    for r in reqs:
        req_status[r.get("requestStatus")] += 1
        ci = r.get("creatorContactInfo")
        if isinstance(ci, dict) and ci.get("value"):
            with_contact += 1
            contact_types[ci.get("type")] += 1
        if r.get("workOrderId"):
            with_wo += 1
        if r.get("creatorId") is not None:
            with_creator += 1
        created = parse_dt(r.get("createdAt"))
        if created and created >= cutoff_6mo:
            req_in_6mo += 1
    report["work_requests"] = {
        "meta": req_meta,
        "total_seen": len(reqs),
        "created_in_6mo": req_in_6mo,
        "by_status": dict(req_status),
        "with_creator_contact_info": with_contact,
        "contact_types": dict(contact_types),
        "with_work_order_id": with_wo,
        "with_creator_id": with_creator,
    }

    # ---- 5. Reference tables ------------------------------------------------
    log("\n== Reference tables ==")
    refs = {}
    for path in ("/users", "/locations", "/teams", "/categories", "/vendors", "/parts"):
        items, meta = page_all(path, [], MAX_REF_PAGES, path.strip("/"))
        refs[path] = {"count": len(items), "pages": meta["pages"],
                      "truncated": meta["truncated"], "errors": meta["errors"]}
        log(f"  {path}: {len(items)}{' (TRUNCATED)' if meta['truncated'] else ''}")
    report["reference_tables"] = refs
    report["total_api_requests"] = _request_count

    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)

    log("\n" + "=" * 60)
    log(f"Work orders (6mo):     {len(in_window)}  [truncated={wo_meta['truncated']}]")
    log(f"Work orders (30d):     {last_30d}")
    log(f"By type:               {dict(types)}")
    log(f"Recurring:             {recurring} ({report['work_orders']['pct_recurring']}%)")
    log(f"With requesterId:      {with_requester} ({report['work_orders']['pct_with_requester']}%)")
    log(f"With comments:         {with_watermark} ({report['work_orders']['pct_with_comments']}%)")
    log(f"With timeItems:        {with_time} ({time_lines} lines)")
    log(f"Work requests (6mo):   {req_in_6mo} of {len(reqs)} seen")
    log(f"Mean attachments/WO:   {mean_per_wo:.3f}")
    log(f"Mean attachment size:  {mean_size / 1024:.0f} KB")
    log(f"R2 backfill estimate:  {report['r2_projection']['backfill_gb']} GB")
    log(f"API requests made:     {_request_count}")
    log(f"\nReport written to: {REPORT_PATH}")


if __name__ == "__main__":
    main()
