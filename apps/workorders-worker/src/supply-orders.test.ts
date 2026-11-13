// Supply Orders rules -- the parts that fail quietly if they drift: a PO
// number reused, the vendor email losing a line, an approver able to empty
// an order, a price read off the wrong JSON-LD block.

import { describe, expect, it } from "vitest";
import {
  applyQtyEdits,
  approverFor,
  canApproveFor,
  cleanInitials,
  estimate,
  initialsFrom,
  nextPo,
  parseLines,
  poBase,
  shipToFor
} from "./supply-orders";
import { buildVendorEmail, vendorLine } from "./supply-orders-email";
import { mapResult, priceFromProductHtml } from "./supply-orders-catalog";
import type { Session } from "@splash/auth";

function session(over: Partial<Session> = {}): Session {
  return {
    userId: "u",
    email: "gm@splashcarwashes.com",
    role: "location_admin",
    dcRole: null,
    tools: ["supply_orders"],
    locations: [],
    ...over
  } as unknown as Session;
}

describe("initials", () => {
  it("uses the operator's format from a full name", () => {
    expect(initialsFrom("Bobbijo Mathews", "x@y.com")).toBe("Bm");
  });
  it("falls back to a first.last email", () => {
    expect(initialsFrom(null, "josh.copp@splashcarwashes.com")).toBe("Jc");
  });
  it("copes with a one-word email", () => {
    expect(initialsFrom(null, "oswegowash@splashcarwashes.com")).toBe("Os");
  });
  it("cleans typed initials", () => {
    expect(cleanInitials(" B.M ")).toBe("BM");
    expect(cleanInitials("123")).toBeNull();
    expect(cleanInitials("abcdef")).toBe("abcd");
  });
});

describe("PO numbers", () => {
  it("builds {site}-{yyyymmdd Eastern}-{initials}", () => {
    // 03:30 UTC on Nov 11 is still Nov 10 in New York.
    expect(poBase(147, new Date("2026-11-11T03:30:00Z"), "Bm")).toBe("147-20261110-Bm");
    expect(poBase(19, new Date("2026-11-11T15:00:00Z"), "Jc")).toBe("019-20261111-Jc");
  });
  it("adds 2/3/4 for repeats, ignoring case", () => {
    const b = "147-20261110-Bm";
    expect(nextPo(b, [])).toBe(b);
    expect(nextPo(b, ["147-20261110-BM"])).toBe(`${b}2`);
    expect(nextPo(b, [b, `${b}2`])).toBe(`${b}3`);
  });
});

describe("approval", () => {
  const site = { rm_email: "RM@splashcarwashes.com", am_email: "rd@splashcarwashes.com" };
  it("RM and RD approve; a GM does not", () => {
    expect(canApproveFor(session({ email: "rm@splashcarwashes.com" }), site)).toBe(true);
    expect(canApproveFor(session({ email: "rd@splashcarwashes.com" }), site)).toBe(true);
    expect(canApproveFor(session(), site)).toBe(false);
  });
  it("admin tier can always approve", () => {
    expect(canApproveFor(session({ role: "super_admin" } as Partial<Session>), site)).toBe(true);
  });
  it("routes to the RM, else the RD", () => {
    expect(approverFor(site)).toBe("rm@splashcarwashes.com");
    expect(approverFor({ rm_email: null, am_email: "rd@x.com" })).toBe("rd@x.com");
    expect(approverFor({ rm_email: null, am_email: null })).toBeNull();
  });
});

describe("cart", () => {
  it("merges the same SKU and uppercases it", () => {
    const r = parseLines([
      { sku: "guss50", name: "Thumb gun", qty: 2, source: "catalog", product_path: "p-1249-gun.aspx" },
      { sku: "GUSS50", name: "Thumb gun", qty: 3, source: "catalog", product_path: "p-1249-gun.aspx" }
    ]);
    expect("lines" in r && r.lines).toEqual([
      expect.objectContaining({ sku: "GUSS50", qty: 5, source: "catalog", product_url: "https://www.kleen-ritecorp.com/p-1249-gun.aspx" })
    ]);
  });
  it("treats a bad product path as a manual line", () => {
    const r = parseLines([{ sku: "X1", name: "Thing", qty: 1, source: "catalog", product_path: "https://evil.example/x" }]);
    expect("lines" in r && r.lines[0]!.source).toBe("manual");
  });
  it("drops image URLs that are not Kleen-Rite's CDN", () => {
    const r = parseLines([{ sku: "X1", name: "Thing", qty: 1, image_url: "https://evil.example/a.png" }]);
    expect("lines" in r && r.lines[0]!.image_url).toBeNull();
  });
  it("rejects empty carts, zero quantities and missing descriptions", () => {
    expect(parseLines([])).toHaveProperty("error");
    expect(parseLines([{ sku: "X1", name: "Thing", qty: 0 }])).toHaveProperty("error");
    expect(parseLines([{ sku: "X1", name: "", qty: 1 }])).toHaveProperty("error");
  });
  it("estimates only from priced lines", () => {
    expect(estimate([{ qty: 2, unit_price_cents: 150 }, { qty: 1, unit_price_cents: null }])).toBe(300);
    expect(estimate([{ qty: 2, unit_price_cents: null }])).toBeNull();
  });
});

describe("approver edits", () => {
  const lines = [
    { line_no: 1, sku: "A", qty: 2 },
    { line_no: 2, sku: "B", qty: 1 }
  ];
  it("records only real changes", () => {
    expect(applyQtyEdits(lines, [{ line_no: 1, qty: 2 }, { line_no: 2, qty: 4 }])).toEqual({
      changes: [{ line_no: 2, sku: "B", from: 1, to: 4 }]
    });
  });
  it("refuses to remove every line", () => {
    expect(applyQtyEdits(lines, [{ line_no: 1, qty: 0 }, { line_no: 2, qty: 0 }])).toHaveProperty("error");
  });
  it("refuses a line that is not on the order", () => {
    expect(applyQtyEdits(lines, [{ line_no: 9, qty: 1 }])).toHaveProperty("error");
  });
});

describe("vendor email", () => {
  const order = {
    po_number: "147-20261110-Bm",
    account_no: "169231",
    shipping_method: "Ground shipping",
    ship_to: shipToFor({ ship_to_address: "255 West Seneca Street Oswego NY 13126 PMB 400", location: "293 NY-104" }, "Splash Express"),
    site_name: "Oswego"
  };
  const lines = [{ sku: "GUSS50", name: "Plastic thumb gun", qty: 5, uom: "Each" }];
  it("matches the hand-written layout, ship-to override first", () => {
    const e = buildVendorEmail({ order, lines, vendor: { ship_to_company: "Splash Express" }, test: false });
    expect(e.text).toBe(
      [
        "Account - 169231",
        "",
        "PO - 147-20261110-Bm",
        "",
        "GUSS50 - Plastic thumb gun - Qty 5",
        "",
        "Ground shipping",
        "Splash Express",
        "255 West Seneca Street Oswego NY 13126 PMB 400"
      ].join("\n")
    );
    expect(e.subject).toBe("Order - PO 147-20261110-Bm - Splash Oswego");
    expect(e.html).not.toContain("$");
  });
  it("marks test emails loudly", () => {
    const e = buildVendorEmail({ order, lines, vendor: { ship_to_company: "Splash Express" }, test: true });
    expect(e.subject.startsWith("[TEST")).toBe(true);
    expect(e.text).toContain("TEST ORDER");
  });
  it("shows a non-Each unit", () => {
    expect(vendorLine({ sku: "VSKMF100", name: "Towels", qty: 2, uom: "Case" })).toBe("VSKMF100 - Towels (Case) - Qty 2");
  });
  it("ships to the physical address when there is no override", () => {
    expect(shipToFor({ ship_to_address: null, location: "1 Main St" }, "Splash Express")).toBe("Splash Express\n1 Main St");
  });
});

describe("catalog parsing", () => {
  it("maps a Searchspring result", () => {
    expect(
      mapResult({
        sku: "GUSS50",
        name: "Spray Gun &amp; Tip",
        url: "p-1249-spraying-system-gun.aspx",
        thumbnailImageUrl: "https://cdn.kleen-ritecorp.com/x/product images/1249.jpg",
        uom: "Each",
        minimumquantity: "1",
        isactive: "true",
        isobsolete: "false"
      })
    ).toMatchObject({
      sku: "GUSS50",
      name: "Spray Gun & Tip",
      image_url: "https://cdn.kleen-ritecorp.com/x/product%20images/1249.jpg"
    });
  });
  it("skips obsolete items", () => {
    expect(mapResult({ sku: "A", name: "B", url: "p-1-a.aspx", isobsolete: "true" })).toBeNull();
  });
  it("reads offers.price from the Product JSON-LD only", () => {
    const html =
      `<script type="application/ld+json">{"@type":"BreadcrumbList","offers":{"price":1}}</script>` +
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer","price":204.31}}</script>`;
    expect(priceFromProductHtml(html)).toBe(20431);
    expect(priceFromProductHtml("<html></html>")).toBeNull();
  });
});
