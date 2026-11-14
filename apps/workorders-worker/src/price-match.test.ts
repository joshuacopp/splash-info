// Price Match rules -- the ones that would fail quietly: an email to NCS from
// test mode, a "$9.25/foot" price turned into a wrong number, a part missing
// its NCS link.

import { describe, expect, it } from "vitest";
import {
  buildPriceMatchEmail,
  buildPriceMatchXlsx,
  canUsePriceMatch,
  lineDiff,
  nameFromEmail,
  orderTotal,
  ordersSavings,
  parseInput,
  parseQty,
  priceNumber,
  recipientsFor,
  resolveOrders,
  type PriceMatchLine,
  type ResolvedOrder
} from "./price-match";
import type { Session } from "@splash/auth";

const env = { SUPABASE_URL: "x", SUPABASE_SERVICE_KEY: "x" };
const NCS = "https://estore.ncswash.com/shop/parts/539";

function line(over: Partial<PriceMatchLine> = {}): PriceMatchLine {
  return {
    part: "X458 Sprocket",
    ncs_part_no: "",
    ncs_price: "229.67",
    ncs_url: NCS,
    competitor_part_no: "",
    competitor_price: "167.13",
    competitor_url: "",
    ...over
  };
}

describe("access", () => {
  it("needs the grant; super_admin alone is not enough", () => {
    expect(canUsePriceMatch({ role: "super_admin", tools: [] } as unknown as Session)).toBe(false);
    expect(canUsePriceMatch({ role: "location_admin", tools: ["price_match"] } as unknown as Session)).toBe(true);
  });
});

describe("recipients", () => {
  const live = { ...env, PRICE_MATCH_MODE: "live", PRICE_MATCH_TO: "achryst@ncswash.com, MSoderquist@ncswash.com" };
  it("test mode goes only to the test address", () => {
    expect(recipientsFor({ ...live, PRICE_MATCH_MODE: "test", PRICE_MATCH_TEST_TO: "me@x.com" }, "josh@x.com")).toEqual({
      to: "me@x.com",
      cc: [],
      test: true
    });
    expect(recipientsFor({ ...env }, "Josh@x.com")).toEqual({ to: "josh@x.com", cc: [], test: true });
  });
  it("live: first address To, the rest plus the sender CC", () => {
    expect(recipientsFor(live, "Josh@x.com")).toEqual({
      to: "achryst@ncswash.com",
      cc: ["msoderquist@ncswash.com", "josh@x.com"],
      test: false
    });
  });
  it("live with no recipients configured falls back to test", () => {
    expect(recipientsFor({ ...env, PRICE_MATCH_MODE: "live" }, "j@x.com").test).toBe(true);
  });
});

describe("parsing", () => {
  it("skips blank rows and requires the NCS link", () => {
    const r = parseInput({ competitor: "Triumph", lines: [line(), { part: "" }] });
    expect("input" in r && r.input.lines).toHaveLength(1);
    expect(parseInput({ competitor: "Triumph", lines: [line({ ncs_url: "" })] })).toHaveProperty("error");
    expect(parseInput({ competitor: "Triumph", lines: [line({ competitor_url: "not a url" })] })).toHaveProperty("error");
    expect(parseInput({ competitor: "", lines: [line()] })).toHaveProperty("error");
    expect(parseInput({ competitor: "Triumph", lines: [] })).toHaveProperty("error");
  });
});

describe("orders", () => {
  it("quantities: blank or 0 = not ordered, junk refused", () => {
    expect(parseQty("")).toBe(0);
    expect(parseQty("0")).toBe(0);
    expect(parseQty(" 12 ")).toBe(12);
    expect(parseQty("12.5")).toBe(12.5);
    expect(parseQty("ten")).toBeNull();
    expect(parseQty("-1")).toBeNull();
  });
  it("lines quantities up with the kept lines when a blank row is dropped", () => {
    const r = parseInput({
      competitor: "Triumph",
      lines: [line(), { part: "" }, line({ part: "Chain" })],
      orders: [{ location_id: 7, qty: ["2", "99", "5"] }]
    });
    expect("input" in r && r.input.orders[0]!.qty).toEqual([2, 5]);
    expect(parseInput({ competitor: "T", lines: [line()], orders: [{ location_id: 7, qty: ["x"] }] })).toHaveProperty("error");
    expect(
      parseInput({ competitor: "T", lines: [line()], orders: [{ location_id: 7, qty: [1] }, { location_id: 7, qty: [1] }] })
    ).toHaveProperty("error");
    expect(parseInput({ competitor: "T", lines: [line()], initials: "12" })).toHaveProperty("error");
  });
  const sites = [
    { id: 1, site_number: 147, site: "Binghamton", location: "1 Main St, Binghamton, NY 13901", ship_to_address: null },
    { id: 2, site_number: 9, site: "Oswego", location: "x", ship_to_address: "255 West Seneca Street PMB 400, Oswego, NY 13126" }
  ];
  const at = new Date("2026-11-14T15:00:00Z");
  it("POs follow the Kleen-Rite sequence and skip numbers already used", () => {
    const r = resolveOrders(
      [{ location_id: 1, qty: [1] }, { location_id: 2, qty: [3] }],
      sites,
      "Jc",
      at,
      ["147-20261114-JC"]
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.orders.map((o) => o.po_number)).toEqual(["147-20261114-Jc2", "009-20261114-Jc"]);
    expect(r.orders[0]!.ship_to).toBe("Splash Express\n1 Main St\nBinghamton, NY 13901");
    expect(r.orders[1]!.ship_to).toContain("PMB 400");
  });
  it("a site with no quantities is an error, not an empty PO", () => {
    expect(resolveOrders([{ location_id: 1, qty: [0] }], sites, "Jc", at, [])).toHaveProperty("error");
    expect(resolveOrders([{ location_id: 99, qty: [1] }], sites, "Jc", at, [])).toHaveProperty("error");
  });
});

describe("prices", () => {
  it("reads plain prices only", () => {
    expect(priceNumber("$1,229.67")).toBe(1229.67);
    expect(priceNumber("76")).toBe(76);
    expect(priceNumber("9.25/foot")).toBeNull();
  });
  it("differences are per unit", () => {
    expect(lineDiff(line())).toBe(62.54);
    expect(lineDiff(line({ competitor_price: "9.25/foot" }))).toBeNull();
  });
  it("order totals and savings use the matched price x qty", () => {
    const ls = [line(), line({ ncs_price: "76", competitor_price: "69" })];
    expect(orderTotal(ls, [2, 0])).toBe(334.26);
    expect(ordersSavings(ls, [{ qty: [2, 0] }, { qty: [0, 3] }])).toBe(146.08);
    expect(orderTotal([line({ competitor_price: "9.25/foot" })], [10])).toBeNull();
    expect(orderTotal([line({ competitor_price: "9.25/foot" }), line()], [0, 1])).toBe(167.13);
    expect(ordersSavings(ls, [])).toBeNull();
  });
});

describe("email", () => {
  const request = {
    competitor: "Triumph Car Wash Parts",
    note: "",
    lines: [line(), line({ part: "X458 Chain", ncs_price: "10/foot", competitor_price: "9.25/foot" })]
  };
  it("live email has no test banner and lists the attachments", () => {
    const e = buildPriceMatchEmail({ request, sender: "josh.copp@splashcarwashes.com", fileNames: ["quote.pdf"], xlsxName: "pm.xlsx", test: null });
    expect(e.subject).toBe("Price Match Request - Triumph Car Wash Parts");
    expect(e.html).not.toContain("TEST");
    expect(e.html).toContain("$229.67");
    expect(e.html).toContain("9.25/foot");
    expect(e.text).toContain("Attached: pm.xlsx, quote.pdf.");
    expect(e.text).toContain("Josh Copp");
  });
  it("test email says where it would have gone", () => {
    const e = buildPriceMatchEmail({
      request,
      sender: "j@x.com",
      fileNames: [],
      xlsxName: "pm.xlsx",
      test: { to: "achryst@ncswash.com", cc: ["j@x.com"] }
    });
    expect(e.subject.startsWith("[TEST] ")).toBe(true);
    expect(e.text).toContain("Live, this goes to achryst@ncswash.com, CC j@x.com.");
  });
  it("escapes what the user typed", () => {
    const e = buildPriceMatchEmail({
      request: { ...request, competitor: "<b>Acme</b>" },
      sender: "j@x.com",
      fileNames: [],
      xlsxName: "pm.xlsx",
      test: null
    });
    expect(e.html).not.toContain("<b>Acme");
  });
  it("names from emails", () => {
    expect(nameFromEmail("josh.copp@splashcarwashes.com")).toBe("Josh Copp");
  });
});

describe("order email", () => {
  const order: ResolvedOrder = {
    location_id: 1,
    site_number: 147,
    site_name: "Binghamton",
    po_number: "147-20261114-Jc",
    ship_to: "Splash Express\n1 Main St\nBinghamton, NY 13901",
    qty: [2, 0]
  };
  const request = { competitor: "Triumph", note: "", lines: [line(), line({ part: "Chain" })] };
  it("carries the PO, ship-to and only the ordered parts", () => {
    const e = buildPriceMatchEmail({ request, orders: [order], sender: "j@x.com", fileNames: [], xlsxName: "pm.xlsx", test: null });
    expect(e.subject).toBe("Price Match Request - Triumph + PO 147-20261114-Jc");
    expect(e.html).toContain("PO 147-20261114-Jc");
    expect(e.html).toContain("Binghamton, NY 13901");
    expect(e.text).toContain("2 x X458 Sprocket @ $167.13 = $334.26");
    expect(e.text).not.toContain("x Chain");
    expect(e.text).toContain("$125.08 less than NCS pricing");
  });
  it("no orders = a plain price match, per unit", () => {
    const e = buildPriceMatchEmail({ request, sender: "j@x.com", fileNames: [], xlsxName: "pm.xlsx", test: null });
    expect(e.html).toContain("Prices are per unit.");
    expect(e.html).not.toContain("Ship to");
  });
  it("orders add a second sheet", () => {
    const text = new TextDecoder().decode(buildPriceMatchXlsx(request, [order]));
    expect(text).toContain("xl/worksheets/sheet2.xml");
  });
});

describe("spreadsheet", () => {
  it("is a zip that carries a hyperlink and keeps text prices", () => {
    const bytes = buildPriceMatchXlsx({ competitor: "Triumph", lines: [line({ competitor_price: "9.25/foot" })] });
    expect(bytes[0]).toBe(0x50); // "PK"
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`<f>HYPERLINK("${NCS}")</f>`);
    expect(text).toContain("9.25/foot");
  });
});
