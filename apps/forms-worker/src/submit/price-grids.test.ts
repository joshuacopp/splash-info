// resolvePriceGrids — the server's half of the package price grid.
//
// The browser only collects what was typed. These cases pin the rules that
// make a stored price-change request trustworthy: a blank new price means
// "unchanged" and is stored as the current price, a package the site does not
// sell is refused, and a current price is never optional. The network is the
// only stub -- pricing_simple answers with the site's package list.

import { afterEach, describe, expect, it } from "vitest";
import type { FormSchema } from "@splash/forms-schema";
import { resolvePriceGrids } from "./price-grids.js";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_KEY: "k" } as never;

const SCHEMA: FormSchema = {
  fields: [
    { id: "f1", key: "site", type: "short_text", label: "Site #", required: true },
    {
      id: "f2",
      key: "packages",
      type: "package_price_grid",
      label: "Packages",
      required: true,
      keyFieldKey: "site",
      keyColumn: "pricing_simple.site"
    }
  ]
};

const realFetch = globalThis.fetch;
let lastUrl: URL | null = null;

function stubPackages(rows: Array<{ pkg: string }> | "fail") {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastUrl = new URL(typeof input === "string" ? input : input.toString());
    if (rows === "fail") return new Response("boom", { status: 500 });
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  lastUrl = null;
});

describe("resolvePriceGrids", () => {
  it("fills a blank new price from the current one and normalises the rest", async () => {
    stubPackages([{ pkg: "Ultimate" }, { pkg: "Express" }]);
    const payload: Record<string, unknown> = {
      site: "19",
      packages: [
        {
          pkg: "Ultimate",
          current_single: "$24",
          current_monthly: "39.9",
          new_single: "26.5",
          new_monthly: ""
        }
      ]
    };
    const result = await resolvePriceGrids(ENV, SCHEMA, payload);
    expect(result).toEqual({ ok: true });
    expect(payload.packages).toEqual([
      {
        pkg: "Ultimate",
        current_single: "24.00",
        current_monthly: "39.90",
        new_single: "26.50",
        new_monthly: "39.90"
      }
    ]);
    // The typed "19" is padded to pricing_simple's 3-digit form.
    expect(lastUrl?.searchParams.get("site")).toBe("eq.019");
  });

  it("orders rows the way the site does, not the way they were ticked", async () => {
    stubPackages([{ pkg: "Ultimate" }, { pkg: "Express" }]);
    const row = (pkg: string) => ({
      pkg,
      current_single: "10",
      current_monthly: "20",
      new_single: "",
      new_monthly: ""
    });
    const payload: Record<string, unknown> = {
      site: "019",
      packages: [row("Express"), row("Ultimate")]
    };
    await resolvePriceGrids(ENV, SCHEMA, payload);
    expect((payload.packages as Array<{ pkg: string }>).map((r) => r.pkg)).toEqual([
      "Ultimate",
      "Express"
    ]);
  });

  it("refuses a package the site does not sell", async () => {
    stubPackages([{ pkg: "Ultimate" }]);
    const payload: Record<string, unknown> = {
      site: "019",
      packages: [
        { pkg: "Platinum", current_single: "1", current_monthly: "2", new_single: "", new_monthly: "" }
      ]
    };
    const result = await resolvePriceGrids(ENV, SCHEMA, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.fields.packages).toContain("Platinum");
    }
  });

  it("refuses a missing current price rather than guessing it", async () => {
    stubPackages([{ pkg: "Ultimate" }]);
    const payload: Record<string, unknown> = {
      site: "019",
      packages: [
        { pkg: "Ultimate", current_single: "", current_monthly: "20", new_single: "22", new_monthly: "" }
      ]
    };
    const result = await resolvePriceGrids(ENV, SCHEMA, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields.packages).toMatch(/current prices/);
  });

  it("treats a non-price in the new box as an error, not as 'unchanged'", async () => {
    stubPackages([{ pkg: "Ultimate" }]);
    const payload: Record<string, unknown> = {
      site: "019",
      packages: [
        { pkg: "Ultimate", current_single: "10", current_monthly: "20", new_single: "abc", new_monthly: "" }
      ]
    };
    const result = await resolvePriceGrids(ENV, SCHEMA, payload);
    expect(result.ok).toBe(false);
  });

  it("reports a pricing_simple outage as retryable (502), not a bad answer", async () => {
    stubPackages("fail");
    const payload: Record<string, unknown> = {
      site: "019",
      packages: [
        { pkg: "Ultimate", current_single: "10", current_monthly: "20", new_single: "", new_monthly: "" }
      ]
    };
    const result = await resolvePriceGrids(ENV, SCHEMA, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});
