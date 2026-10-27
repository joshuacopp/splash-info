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

// ---------------------------------------------------------------------------
// Multi-site grids
// ---------------------------------------------------------------------------

const MULTI: FormSchema = {
  fields: [
    {
      id: "g",
      key: "packages",
      type: "package_price_grid",
      label: "Packages",
      required: true,
      keyFieldKey: "",
      keyColumn: "pricing_simple.site",
      multiSite: true
    }
  ]
};

/** pricing_simple by site number. Anything not listed has no rows. */
function stubSites(sites: Record<string, { name: string; pkgs: string[] }>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const site = (url.searchParams.get("site") ?? "").replace(/^eq\./, "");
    const s = sites[site];
    const rows = s ? s.pkgs.map((pkg) => ({ pkg, location_pretty: s.name, site })) : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

const row = (pkg: string, cs: string, cm: string, ns = "", nm = "") => ({
  pkg,
  current_single: cs,
  current_monthly: cm,
  new_single: ns,
  new_monthly: nm
});

describe("resolvePriceGrids (multi-site)", () => {
  it("resolves each site, stores its name, and pads typed site numbers", async () => {
    stubSites({
      "122": { name: "Binghamton", pkgs: ["ultra_bath", "express"] },
      "019": { name: "Milford", pkgs: ["ultra_bath"] }
    });
    const payload: Record<string, unknown> = {
      packages: [
        { site: "122", rows: [row("ultra_bath", "24", "39.99", "26")] },
        { site: "19", rows: [row("ultra_bath", "22", "35", "24")] }
      ]
    };
    expect(await resolvePriceGrids(ENV, MULTI, payload)).toEqual({ ok: true });
    expect(payload.packages).toEqual([
      {
        site: "122",
        site_name: "Binghamton",
        rows: [row("ultra_bath", "24.00", "39.99", "26.00", "39.99")]
      },
      {
        site: "019",
        site_name: "Milford",
        rows: [row("ultra_bath", "22.00", "35.00", "24.00", "35.00")]
      }
    ]);
  });

  it("refuses an unknown site number", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["express"] } });
    const payload: Record<string, unknown> = {
      packages: [{ site: "999", rows: [row("express", "10", "20")] }]
    };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.packages).toContain("999 isn't a known site");
  });

  it("refuses the same site twice, however it was typed", async () => {
    stubSites({ "019": { name: "Milford", pkgs: ["express"] } });
    const payload: Record<string, unknown> = {
      packages: [
        { site: "19", rows: [row("express", "10", "20")] },
        { site: "019", rows: [row("express", "10", "20")] }
      ]
    };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.packages).toContain("listed twice");
  });

  it("refuses a site added with no changes instead of dropping it", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["express"] } });
    const payload: Record<string, unknown> = { packages: [{ site: "122", rows: [] }] };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.packages).toContain("add at least one change");
  });

  it("names the site in a row error", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["express"] } });
    const payload: Record<string, unknown> = {
      packages: [{ site: "122", rows: [row("express", "", "20")] }]
    };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.packages).toBe("Binghamton (122): Express: enter both current prices");
  });
});

describe("resolvePriceGrids (menu changes)", () => {
  it("stores a discontinued package with no prices, and a rename with its prices", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["works", "ultimate"] } });
    const payload: Record<string, unknown> = {
      packages: [
        {
          site: "122",
          rows: [
            { ...row("works", "12", "24.99", "14"), rename_to: "  Bath " },
            { pkg: "ultimate", current_single: "", current_monthly: "", new_single: "", new_monthly: "", discontinue: true }
          ]
        }
      ]
    };
    expect(await resolvePriceGrids(ENV, MULTI, payload)).toEqual({ ok: true });
    const site = (payload.packages as Array<{ rows: unknown[] }>)[0]!;
    expect(site.rows).toEqual([
      { ...row("works", "12.00", "24.99", "14.00", "24.99"), rename_to: "Bath" },
      { pkg: "ultimate", current_single: "", current_monthly: "", new_single: "", new_monthly: "", discontinue: true }
    ]);
  });

  it("drops a rename to the package's own name", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["ultra_bath"] } });
    const payload: Record<string, unknown> = {
      packages: [{ site: "122", rows: [{ ...row("ultra_bath", "20", "40"), rename_to: "ultra bath" }] }]
    };
    await resolvePriceGrids(ENV, MULTI, payload);
    const r = (payload.packages as Array<{ rows: Array<Record<string, unknown>> }>)[0]!.rows[0]!;
    expect(r.rename_to).toBeUndefined();
  });

  it("accepts a site whose only changes are a new package and a service", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["bath"] } });
    const payload: Record<string, unknown> = {
      packages: [
        {
          site: "122",
          rows: [],
          new_packages: [{ name: "Bubble Bath", single: "25", monthly: "49.99" }],
          services: [
            { category: "lube", name: "Full synthetic oil change", current: "79.99", new: "84.99" },
            { category: "detail", name: "Interior detail", current: "150", new: "" }
          ]
        }
      ]
    };
    expect(await resolvePriceGrids(ENV, MULTI, payload)).toEqual({ ok: true });
    expect(payload.packages).toEqual([
      {
        site: "122",
        site_name: "Binghamton",
        rows: [],
        new_packages: [{ name: "Bubble Bath", single: "25.00", monthly: "49.99" }],
        services: [
          { category: "lube", name: "Full synthetic oil change", current: "79.99", new: "84.99" },
          { category: "detail", name: "Interior detail", current: "150.00", new: "150.00" }
        ]
      }
    ]);
  });

  it("refuses a new package that already exists at the site", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["bubble_bath"] } });
    const payload: Record<string, unknown> = {
      packages: [{ site: "122", rows: [], new_packages: [{ name: "Bubble Bath", single: "25", monthly: "49" }] }]
    };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.packages).toContain("already exists here");
  });

  it("refuses a service with no category or no current price", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["bath"] } });
    const payload: Record<string, unknown> = {
      packages: [
        {
          site: "122",
          rows: [],
          services: [
            { category: "", name: "Wax", current: "10", new: "12" },
            { category: "lube", name: "Oil change", current: "", new: "50" }
          ]
        }
      ]
    };
    const r = await resolvePriceGrids(ENV, MULTI, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fields.packages).toContain("choose Lube or Detail");
      expect(r.fields.packages).toContain("Oil change: enter the current price");
    }
  });

  it("ignores wholly blank new-package and service rows", async () => {
    stubSites({ "122": { name: "Binghamton", pkgs: ["bath"] } });
    const payload: Record<string, unknown> = {
      packages: [
        {
          site: "122",
          rows: [row("bath", "10", "20", "11")],
          new_packages: [{ name: "", single: "", monthly: "" }],
          services: [{ category: "lube", name: "", current: "", new: "" }]
        }
      ]
    };
    expect(await resolvePriceGrids(ENV, MULTI, payload)).toEqual({ ok: true });
    const s = (payload.packages as Array<Record<string, unknown>>)[0]!;
    expect(s.new_packages).toBeUndefined();
    expect(s.services).toBeUndefined();
  });
});
