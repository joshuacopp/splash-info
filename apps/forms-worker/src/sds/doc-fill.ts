// Fill a site's details onto a downloadable safety programme.
//
// WHY AT DOWNLOAD TIME rather than storing one PDF per site. There are ~40
// sites and three documents, and the contacts change whenever somebody moves
// region. Pre-rendering 120 files would mean 120 going stale on the day an RM
// changes, with no way to tell a fresh copy from a year-old one. Filling on the
// way out means the copy somebody downloads is right at the moment they
// download it, and the only stored artefact is the blank master.
//
// THE BLANK MASTER STAYS REACHABLE. These documents have hand-writable blanks
// precisely because a site may need a copy before anybody has set its contacts,
// so asking for no location serves the file untouched -- see the route. The
// fields are only ever filled over blanks that were already there.
//
// FAIL SOFT, LOUDLY. Every failure here degrades to the unfilled document,
// which is exactly the paper process it replaces: blank lines somebody writes
// on. That is a safe thing to degrade to, unlike a 404 on a safety programme or
// -- much worse -- the WRONG site's contacts. So a lookup that cannot be
// completed produces an empty field, never a guess, and says so in the log.

import { PDFDocument } from "pdf-lib";
import { sanitizeForWinAnsi } from "@splash/pdf-report";

import type { Env } from "../index.js";

/**
 * The AcroForm field names, which `scripts/add-hazcom-fields.mjs` puts into the
 * document. Anything not in this list is left alone, so a document carrying
 * other fields keeps them.
 *
 * NOTE ON THE LABELS: the document says "Regional Manager (Primary)" and "Area
 * Manager (Secondary)", which lines up with the column names -- `rm_*` is the
 * Regional Manager and `am_*` the Area Manager, the role CLAUDE.md records the
 * org now calls Regional Director. The field names follow the columns so there
 * is no translation step to get wrong.
 */
const FIELD_NAMES = ["site_block", "rm_name", "rm_phone", "am_name", "am_phone"] as const;

export type DocFillValues = Record<(typeof FIELD_NAMES)[number], string>;

function sbHeaders(env: Env) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

/**
 * `+16077685674` -> `(607) 768-5674`.
 *
 * Anything that is not a recognisable North American number is returned as it
 * was stored rather than reshaped: a number printed in an unexpected format is
 * still dialable, whereas one this function has rearranged on a guess may not
 * be. An empty result means no number, which leaves the blank intact.
 */
export function formatUsPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return raw.trim();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

interface SiteContacts {
  location_pretty: string | null;
  address: string | null;
  regional_manager: string | null;
  rm_email: string | null;
  area_manager: string | null;
  am_email: string | null;
}

/**
 * Phone numbers for a set of emails, from the MaintainX mirror.
 *
 * MAINTAINX IS THE SOURCE because that is where these numbers are already
 * maintained -- everybody there has one because it is how they log in -- and it
 * is kept current by the 11:30 UTC sync without anybody re-entering anything.
 * `locations.rm_phone` / `am_phone` exist but are not used: a second place to
 * type a phone number is a second place for it to be wrong.
 */
async function phonesByEmail(env: Env, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = emails.filter((e) => e).map((e) => e.toLowerCase());
  if (wanted.length === 0) return out;

  const url = new URL("/rest/v1/maintainx_users", env.SUPABASE_URL);
  url.searchParams.set("select", "email,phone_number");
  url.searchParams.set("email", `in.(${wanted.map((e) => `"${e}"`).join(",")})`);
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    // Soft: names and the site block still fill, and the phone blanks stay
    // writable. Logged because a site silently getting a half-filled document
    // looks the same as one whose contacts have no numbers on file.
    console.error("[forms.doc-fill] phone lookup failed", resp.status);
    return out;
  }
  const rows = (await resp.json().catch(() => [])) as {
    email: string | null;
    phone_number: string | null;
  }[];
  for (const r of rows) {
    if (r.email && r.phone_number) out.set(r.email.toLowerCase(), r.phone_number);
  }
  return out;
}

/**
 * Everything that goes onto one site's copy.
 *
 * Null when the location resolves to nothing, which the caller turns into a
 * 404 rather than serving a document headed with a code nobody recognises.
 */
export async function resolveDocFill(
  env: Env,
  locationCode: string
): Promise<DocFillValues | null> {
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set(
    "select",
    "location_pretty,address,regional_manager,rm_email,area_manager,am_email"
  );
  url.searchParams.set("location_code", `eq.${locationCode}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!resp.ok) {
    console.error("[forms.doc-fill] site lookup failed", locationCode, resp.status);
    return null;
  }
  const rows = (await resp.json().catch(() => [])) as SiteContacts[];
  const site = rows[0];
  if (!site) return null;

  const phones = await phonesByEmail(
    env,
    [site.rm_email, site.am_email].filter((e): e is string => !!e)
  );

  // Name over address, as two lines in one multiline field. The name alone is
  // what somebody reads to check they have the right copy; the address is what
  // makes it a record of a place.
  const siteBlock = [site.location_pretty, site.address]
    .filter((p) => p && p.trim())
    .join("\n");

  return {
    site_block: siteBlock,
    rm_name: site.regional_manager?.trim() || "",
    rm_phone: formatUsPhone(phones.get(site.rm_email?.toLowerCase() ?? "")),
    am_name: site.area_manager?.trim() || "",
    am_phone: formatUsPhone(phones.get(site.am_email?.toLowerCase() ?? ""))
  };
}

/**
 * Write the values into the PDF's form fields and flatten.
 *
 * Returns null when the document carries NONE of the fields -- an unfillable
 * document is the normal case for two of the three programmes, and the caller
 * serves the stored bytes untouched rather than running them through pdf-lib
 * for nothing.
 *
 * FLATTENING IS DELIBERATE, and the reason this never runs on the blank master.
 * Flattening turns the values into page content, so they print and render the
 * same in every viewer -- including the phone viewers that do not draw field
 * appearances until a field is focused. The cost is that the fields stop being
 * writable, which is right for a filled copy and wrong for a blank one: hence
 * no location, no flatten, blanks intact.
 */
export async function fillSafetyDocPdf(
  bytes: ArrayBuffer | Uint8Array,
  values: DocFillValues
): Promise<Uint8Array | null> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const present = new Set(form.getFields().map((f) => f.getName()));
  const fillable = FIELD_NAMES.filter((n) => present.has(n));
  if (fillable.length === 0) return null;

  for (const name of fillable) {
    const value = values[name];
    if (!value) continue;
    // sanitizeForWinAnsi: the standard-font encoding cannot represent
    // typographic characters, and setText throws on the first one it cannot
    // encode. A curly apostrophe in a location name would otherwise take down
    // the whole download.
    form.getTextField(name).setText(sanitizeForWinAnsi(value));
  }

  form.flatten();
  return await doc.save();
}
