// One shared photo froze the mirror for days. This is the test for that.
//
// upsertMxWorkOrderAttachments lives in @splash/db-supabase, which has no test
// harness of its own; it is exercised from here because this worker is the
// package's only caller and already has vitest wired.
//
// WHAT WENT WRONG, so the next person does not have to reconstruct it:
//
//   MaintainX can return ONE attachment on SEVERAL work orders. Measured
//   2026-09-16, attachment 222410195 -- a photo uploaded 2026-04-18 -- comes
//   back on three different Springfield work orders, byte-identical each time.
//
//   mx-ingest.ts batches a whole page of work orders into one attachment
//   upsert. Two work orders in one page referencing that photo put the same id
//   in the array twice, and Postgres rejects the entire command with 21000,
//   "ON CONFLICT DO UPDATE command cannot affect row a second time".
//
//   That failed the page. The pass returned without advancing its cursor. The
//   next tick re-read the identical page and failed identically. work_orders_live
//   sat on one page from the day the mirror went live, and because
//   mx-reconcile.ts declines while the live pass is mid-cursor, the daily
//   reconciliation was silently off for the whole of that time as well.

import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertMxWorkOrderAttachments, type MxWorkOrderAttachmentRow } from "@splash/db-supabase";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_KEY: "service-key"
};

interface Captured {
  url: string;
  body: MxWorkOrderAttachmentRow[];
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : []
    });
    return new Response("", { status: 201 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

/** The real shape: the thumbnail entry is emitted FIRST by mapAttachments,
 *  ahead of the attachments array, precisely so a de-dupe keeps the entry
 *  carrying is_thumbnail. */
function row(id: number, workOrderId: number, isThumbnail: boolean): MxWorkOrderAttachmentRow {
  return {
    id,
    work_order_id: workOrderId,
    file_name: "photo.jpeg",
    mime_type: "image/jpeg",
    is_thumbnail: isThumbnail
  };
}

describe("upsertMxWorkOrderAttachments de-duplication", () => {
  it("collapses one attachment shared by two work orders in the same page", () => {
    const calls = stubFetch();

    // Springfield 111388118 and 115330231, both carrying photo 222410195 as
    // their thumbnail, as they arrive together in one live-walk page.
    return upsertMxWorkOrderAttachments(ENV, [
      row(222410195, 111388118, true),
      row(999000111, 111388118, false),
      row(222410195, 115330231, true)
    ]).then((result) => {
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);

      const ids = calls[0]!.body.map((r) => r.id);
      // The whole point. Two of these in one command is 21000 and a lost page.
      expect(ids).toEqual([222410195, 999000111]);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it("keeps the FIRST occurrence, which is the one marked is_thumbnail", () => {
    const calls = stubFetch();

    // mapAttachments puts the thumbnail first and documents that a de-dupe must
    // preserve it -- the list walk only ever sees thumbnails, so losing the
    // marker loses the only signal that this image is the work order's cover.
    // Keeping LAST here would quietly undo that.
    return upsertMxWorkOrderAttachments(ENV, [
      row(222410195, 111388118, true),
      row(222410195, 115330231, false)
    ]).then(() => {
      expect(calls[0]!.body).toHaveLength(1);
      expect(calls[0]!.body[0]!.is_thumbnail).toBe(true);
      expect(calls[0]!.body[0]!.work_order_id).toBe(111388118);
    });
  });

  it("leaves an already-unique batch untouched", () => {
    const calls = stubFetch();
    return upsertMxWorkOrderAttachments(ENV, [
      row(1, 10, false),
      row(2, 11, false),
      row(3, 12, false)
    ]).then(() => {
      expect(calls[0]!.body.map((r) => r.id)).toEqual([1, 2, 3]);
    });
  });

  it("sends nothing at all for an empty batch", () => {
    const calls = stubFetch();
    return upsertMxWorkOrderAttachments(ENV, []).then((result) => {
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });
});
