import { describe, expect, it } from "vitest";

import { canFillForm, normalizeFillAudience, type FillCaller } from "./fill-audience.js";

const caller = (over: Partial<FillCaller> = {}): FillCaller => ({
  isAdmin: false,
  groups: new Set(),
  tags: new Set(),
  ...over
});

describe("canFillForm", () => {
  it("lets everyone fill an unrestricted form", () => {
    expect(canFillForm({ fillAudience: [], accessTag: null }, caller())).toBe(true);
  });

  it("refuses a site login on a Regional Director form", () => {
    const rule = { fillAudience: ["rd" as const], accessTag: null };
    expect(canFillForm(rule, caller({ groups: new Set(["site"]) }))).toBe(false);
    expect(canFillForm(rule, caller({ groups: new Set(["rd"]) }))).toBe(true);
  });

  it("does not treat an RM as an RD", () => {
    const rule = { fillAudience: ["rd" as const], accessTag: null };
    expect(canFillForm(rule, caller({ groups: new Set(["rm"]) }))).toBe(false);
  });

  it("admits tag holders only for the form's own tag", () => {
    const rule = { fillAudience: ["tag" as const], accessTag: "price_change" };
    expect(canFillForm(rule, caller({ tags: new Set(["price_change"]) }))).toBe(true);
    expect(canFillForm(rule, caller({ tags: new Set(["crd"]) }))).toBe(false);
  });

  it("does not fall open when the audience is tag but the form has no tag", () => {
    const rule = { fillAudience: ["tag" as const], accessTag: null };
    expect(canFillForm(rule, caller({ tags: new Set(["price_change"]) }))).toBe(false);
  });

  it("always admits admins", () => {
    const rule = { fillAudience: ["tag" as const], accessTag: null };
    expect(canFillForm(rule, caller({ isAdmin: true }))).toBe(true);
  });

  it("admits any one of several groups", () => {
    const rule = { fillAudience: ["rm" as const, "rd" as const], accessTag: null };
    expect(canFillForm(rule, caller({ groups: new Set(["rd"]) }))).toBe(true);
  });
});

describe("normalizeFillAudience", () => {
  it("drops unknown values and duplicates", () => {
    expect(normalizeFillAudience(["rm", "boss", "rm", "tag"])).toEqual(["rm", "tag"]);
    expect(normalizeFillAudience(null)).toEqual([]);
  });
});
