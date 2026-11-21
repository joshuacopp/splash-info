import { describe, expect, it } from "vitest";
import {
  effectiveSmsConsent,
  normalizeGiveawayPhone,
  normalizeGiveawayPlate,
  parseGiveawaySettings,
  readGiveawayFields
} from "@splash/forms-schema";
import { giveawayState } from "./data.js";

const fields = (over: Record<string, string> = {}) => ({
  name: { mode: over.name ?? "off" },
  email: { mode: over.email ?? "off" },
  phone: { mode: over.phone ?? "required" },
  plate: { mode: over.plate ?? "off" },
  barcode: { mode: over.barcode ?? "off" }
});

describe("parseGiveawaySettings", () => {
  it("accepts a phone-only giveaway", () => {
    const r = parseGiveawaySettings({ title: " Bills  tickets ", fields: fields(), sms_consent: "optional" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Bills tickets");
      expect(r.value.one_per_person).toBe(true);
      expect(r.value.prize).toBeNull();
    }
  });

  it("refuses a giveaway with every field off", () => {
    const r = parseGiveawaySettings({ title: "x", fields: fields({ phone: "off" }), sms_consent: "off" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("at least one field") });
  });

  it("refuses an end date before the start date", () => {
    const r = parseGiveawaySettings({ title: "x", fields: fields(), sms_consent: "off", starts_on: "2026-12-10", ends_on: "2026-12-01" });
    expect(r.ok).toBe(false);
  });

  it("refuses an unknown mode and a missing title", () => {
    expect(parseGiveawaySettings({ title: "x", fields: fields({ name: "maybe" }), sms_consent: "off" }).ok).toBe(false);
    expect(parseGiveawaySettings({ title: "  ", fields: fields(), sms_consent: "off" }).ok).toBe(false);
  });

  it("drops a label that just repeats the default", () => {
    const f = { ...fields({ barcode: "optional" }), barcode: { mode: "optional", label: "Barcode" } };
    const r = parseGiveawaySettings({ title: "x", fields: f, sms_consent: "off" });
    expect(r.ok && r.value.fields.barcode).toEqual({ mode: "optional" });
  });
});

describe("entry normalising", () => {
  it("phone: punctuation and a leading 1 are fine, short numbers are not", () => {
    expect(normalizeGiveawayPhone("(607) 555-0123")).toBe("6075550123");
    expect(normalizeGiveawayPhone("+1 607 555 0123")).toBe("6075550123");
    expect(normalizeGiveawayPhone("555-0123")).toBeNull();
    expect(normalizeGiveawayPhone("1075550123")).toBeNull();
  });

  it("plate: upper-case, spaces and dashes dropped", () => {
    expect(normalizeGiveawayPlate("abc-12 34")).toBe("ABC1234");
    expect(normalizeGiveawayPlate(" - ")).toBeNull();
    expect(normalizeGiveawayPlate("ABCDEFGHIJK")).toBeNull();
  });
});

describe("consent and state", () => {
  it("the consent box is off whenever phone is off", () => {
    const f = readGiveawayFields(fields({ phone: "off", email: "required" }));
    expect(effectiveSmsConsent({ fields: f, sms_consent: "required" })).toBe("off");
    expect(effectiveSmsConsent({ fields: readGiveawayFields(fields()), sms_consent: "required" })).toBe("required");
  });

  it("stored fields read leniently", () => {
    expect(readGiveawayFields({ phone: { mode: "nonsense" } }).phone.mode).toBe("off");
    expect(readGiveawayFields(null).name.mode).toBe("off");
  });

  it("dates are inclusive Eastern days", () => {
    const g = { starts_on: "2026-12-01", ends_on: "2026-12-10", archived_at: null };
    expect(giveawayState(g, "2026-11-30")).toBe("not_started");
    expect(giveawayState(g, "2026-12-01")).toBe("open");
    expect(giveawayState(g, "2026-12-10")).toBe("open");
    expect(giveawayState(g, "2026-12-11")).toBe("ended");
    expect(giveawayState({ ...g, archived_at: "2026-12-05T00:00:00Z" }, "2026-12-05")).toBe("archived");
  });
});
