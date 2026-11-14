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
  parseInput,
  priceNumber,
  recipientsFor,
  totalDiff,
  type PriceMatchLine
} from "./price-match";
import type { Session } from "@splash/auth";

const env = { SUPABASE_URL: "x", SUPABASE_SERVICE_KEY: "x" };
const NCS = "https://estore.ncswash.com/shop/parts/539";

function line(over: Partial<PriceMatchLine> = {}): PriceMatchLine {
  return {
    part: "X458 Sprocket",
    ncs_part_no: "",
    qty: "",
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

describe("prices", () => {
  it("reads plain prices only", () => {
    expect(priceNumber("$1,229.67")).toBe(1229.67);
    expect(priceNumber("76")).toBe(76);
    expect(priceNumber("9.25/foot")).toBeNull();
  });
  it("differences and totals", () => {
    expect(lineDiff(line())).toBe(62.54);
    expect(lineDiff(line({ competitor_price: "9.25/foot" }))).toBeNull();
    expect(totalDiff([line({ qty: "2" }), line({ ncs_price: "76", competitor_price: "69" })])).toBe(132.08);
    expect(totalDiff([line(), line({ ncs_price: "10/foot" })])).toBeNull();
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

describe("spreadsheet", () => {
  it("is a zip that carries a hyperlink and keeps text prices", () => {
    const bytes = buildPriceMatchXlsx({ competitor: "Triumph", note: "", lines: [line({ competitor_price: "9.25/foot" })] });
    expect(bytes[0]).toBe(0x50); // "PK"
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`<f>HYPERLINK("${NCS}")</f>`);
    expect(text).toContain("9.25/foot");
  });
});
