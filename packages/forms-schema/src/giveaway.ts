// Giveaway contests (2026-11-20). Not a form-builder form: the entry fields
// are FIXED (below) and each contest only switches each one Off / Optional /
// Required, so the people running contests never touch field types or keys.
// Tables in supabase/giveaways-01.sql; worker in apps/forms-worker/src/giveaways/;
// setup page /admin/giveaways.
//
// SELF-CONTAINED ON PURPOSE (no relative imports): apps/web imports the runtime
// values through the `@splash/forms-schema/giveaway` subpath. The package root
// uses `.js` specifiers Next's webpack cannot resolve.

export const GIVEAWAY_FIELD_KEYS = ["name", "email", "phone", "plate", "barcode"] as const;
export type GiveawayFieldKey = (typeof GIVEAWAY_FIELD_KEYS)[number];

export const GIVEAWAY_FIELD_MODES = ["off", "optional", "required"] as const;
export type GiveawayFieldMode = (typeof GIVEAWAY_FIELD_MODES)[number];

export interface GiveawayFieldSetting {
  mode: GiveawayFieldMode;
  /** Shown on the entry page instead of the default label, e.g. "Receipt number" for the barcode. */
  label?: string;
}

export type GiveawayFields = Record<GiveawayFieldKey, GiveawayFieldSetting>;

export const GIVEAWAY_FIELD_DEFAULT_LABEL: Record<GiveawayFieldKey, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone number",
  plate: "License plate",
  barcode: "Barcode"
};

export const GIVEAWAY_LABEL_MAX = 60;
export const GIVEAWAY_TITLE_MAX = 120;
export const GIVEAWAY_PRIZE_MAX = 1000;

/** The SMS marketing consent box. Off when the giveaway doesn't collect a phone. */
export type GiveawaySmsConsent = "off" | "optional" | "required";

/**
 * Shown verbatim next to the box, and copied onto each entry that ticks it
 * (giveaway_entries.sms_consent_text). If this wording ever changes, entries
 * already taken keep the text their customer actually agreed to.
 */
export const GIVEAWAY_SMS_CONSENT_TEXT =
  "By checking this box and entering my phone number, I agree to receive recurring automated marketing text messages from Splash Car Washes at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Msg frequency varies. At any time, reply STOP to opt out or HELP for help.";

export interface GiveawaySettings {
  title: string;
  prize: string | null;
  /** YYYY-MM-DD, Eastern, inclusive. */
  starts_on: string | null;
  ends_on: string | null;
  fields: GiveawayFields;
  sms_consent: GiveawaySmsConsent;
  one_per_person: boolean;
}

/** A new giveaway: phone only (the common case). */
export function defaultGiveawayFields(): GiveawayFields {
  return {
    name: { mode: "off" },
    email: { mode: "off" },
    phone: { mode: "required" },
    plate: { mode: "off" },
    barcode: { mode: "off" }
  };
}

/** Read a stored `fields` jsonb leniently: anything unrecognised is "off". */
export function readGiveawayFields(raw: unknown): GiveawayFields {
  const out = {} as GiveawayFields;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const k of GIVEAWAY_FIELD_KEYS) {
    const v = obj[k] as { mode?: unknown; label?: unknown } | undefined;
    const mode = (GIVEAWAY_FIELD_MODES as readonly string[]).includes(String(v?.mode)) ? (v!.mode as GiveawayFieldMode) : "off";
    const label = typeof v?.label === "string" && v.label.trim() ? v.label.trim().slice(0, GIVEAWAY_LABEL_MAX) : undefined;
    out[k] = label ? { mode, label } : { mode };
  }
  return out;
}

export function giveawayFieldLabel(fields: GiveawayFields, key: GiveawayFieldKey): string {
  return fields[key].label || GIVEAWAY_FIELD_DEFAULT_LABEL[key];
}

/** The consent box actually shows only when phone is collected. */
export function effectiveSmsConsent(s: { fields: GiveawayFields; sms_consent: GiveawaySmsConsent }): GiveawaySmsConsent {
  return s.fields.phone.mode === "off" ? "off" : s.sms_consent;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate settings sent from the setup page. Returns a sentence for the
 * person when something is wrong.
 */
export function parseGiveawaySettings(input: unknown): { ok: true; value: GiveawaySettings } | { ok: false; error: string } {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return { ok: false, error: "Give the giveaway a title." };
  if (title.length > GIVEAWAY_TITLE_MAX) return { ok: false, error: `Keep the title to ${GIVEAWAY_TITLE_MAX} characters.` };
  const prizeRaw = typeof o.prize === "string" ? o.prize.trim() : "";
  if (prizeRaw.length > GIVEAWAY_PRIZE_MAX) return { ok: false, error: `Keep the description to ${GIVEAWAY_PRIZE_MAX} characters.` };

  const date = (v: unknown): string | null | "bad" => {
    if (v === null || v === undefined || v === "") return null;
    return typeof v === "string" && YMD.test(v) ? v : "bad";
  };
  const starts = date(o.starts_on);
  const ends = date(o.ends_on);
  if (starts === "bad" || ends === "bad") return { ok: false, error: "A date couldn't be read. Pick it again." };
  if (starts && ends && ends < starts) return { ok: false, error: "The end date is before the start date." };

  const fieldsIn = o.fields && typeof o.fields === "object" ? (o.fields as Record<string, unknown>) : {};
  const fields = {} as GiveawayFields;
  for (const k of GIVEAWAY_FIELD_KEYS) {
    const v = (fieldsIn[k] ?? {}) as { mode?: unknown; label?: unknown };
    if (!(GIVEAWAY_FIELD_MODES as readonly string[]).includes(String(v.mode))) {
      return { ok: false, error: `Choose Off, Optional or Required for ${GIVEAWAY_FIELD_DEFAULT_LABEL[k]}.` };
    }
    const label = typeof v.label === "string" ? v.label.replace(/\s+/g, " ").trim() : "";
    if (label.length > GIVEAWAY_LABEL_MAX) {
      return { ok: false, error: `Keep the ${GIVEAWAY_FIELD_DEFAULT_LABEL[k]} label to ${GIVEAWAY_LABEL_MAX} characters.` };
    }
    fields[k] = label && label !== GIVEAWAY_FIELD_DEFAULT_LABEL[k] ? { mode: v.mode as GiveawayFieldMode, label } : { mode: v.mode as GiveawayFieldMode };
  }
  if (GIVEAWAY_FIELD_KEYS.every((k) => fields[k].mode === "off")) {
    return { ok: false, error: "Turn on at least one field, or there is nothing to enter." };
  }

  const sms = String(o.sms_consent ?? "optional");
  if (sms !== "off" && sms !== "optional" && sms !== "required") return { ok: false, error: "Choose how the text-message box works." };

  return {
    ok: true,
    value: {
      title,
      prize: prizeRaw || null,
      starts_on: starts,
      ends_on: ends,
      fields,
      sms_consent: sms,
      one_per_person: o.one_per_person !== false
    }
  };
}

// --- entry values ---------------------------------------------------------------

/** 10 digits, or null. Accepts punctuation and a leading 1. */
export function normalizeGiveawayPhone(s: string): string | null {
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return /^[2-9]\d{9}$/.test(d) ? d : null;
}

/** "(607) 555-0123" */
export function formatGiveawayPhone(d: string | null | undefined): string {
  if (!d || !/^\d{10}$/.test(d)) return d ?? "";
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Upper-case letters and digits only (spaces and dashes dropped), 1-10 long, or null. */
export function normalizeGiveawayPlate(s: string): string | null {
  const p = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return p.length >= 1 && p.length <= 10 ? p : null;
}

/** One stored entry, as the admin API returns it. */
export interface GiveawayEntry {
  id: string;
  created_at: string;
  site_number: number | null;
  site_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  plate: string | null;
  barcode: string | null;
  sms_consent: boolean;
}
