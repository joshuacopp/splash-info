// Giveaways -- the no-sign-in entry page customers fill in on the site tablet.
//
//   GET  /forms/giveaway/{token}[?site=N]          the form (or "not open yet" / "ended")
//   GET  /forms/giveaway/{token}?done=1[&site=N]    "You're entered" -- returns to a blank form
//   POST /forms/giveaway/{token}[?site=N]           record an entry
//
// The token is giveaways.token: the link is the only gate, like the site
// status link. `?site=N` stamps the entry with the tablet's site; a number that
// isn't a real site is ignored rather than refused, so a mistyped link still
// takes entries.
//
// SHARED TABLET: every input is autocomplete="off" and nothing is kept in the
// browser. A successful entry redirects (303) to a GET, so a refresh never
// enters twice, and the thank-you screen returns to an EMPTY form on its own,
// so the next customer never sees the last one's details. A refused entry is
// re-rendered with the values (not put in the URL, which would leave them in
// the tablet's history).

import { isOriginAllowed } from "@splash/http";
import { isValidEmail } from "@splash/types/email-validate";
import {
  GIVEAWAY_FIELD_KEYS,
  GIVEAWAY_SMS_CONSENT_TEXT,
  effectiveSmsConsent,
  giveawayFieldLabel,
  normalizeGiveawayPhone,
  normalizeGiveawayPlate,
  type GiveawayFieldKey
} from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getSite } from "../site-status/data.js";
import {
  easternToday,
  findDuplicate,
  getGiveawayByToken,
  giveawayState,
  insertEntry,
  type Giveaway
} from "./data.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOGO = "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png";

function page(title: string, body: string, status = 200, extraHead = ""): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - Splash</title>${extraHead}
<style>
:root{--navy:#1c164e;--blue:#2b3491;--green:#059669;--red:#dc2626;--line:#d9e1ea;--muted:#5b6b82}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f6f9;color:var(--navy)}
header{background:var(--navy);padding:12px 16px;text-align:center}header img{height:44px}
main{max-width:640px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:14px}
h1{font-size:26px;margin:0 0 8px}.prize{font-size:18px;line-height:1.45;white-space:pre-line;margin:0 0 6px}
label{display:block;font-weight:700;font-size:17px;margin:16px 0 6px}.req{color:var(--red)}.opt{color:var(--muted);font-weight:400;font-size:14px}
input[type=text],input[type=email],input[type=tel]{width:100%;font-size:20px;padding:12px;border:1px solid #b8c4d2;border-radius:8px;background:#fff;color:var(--navy)}
input.bad{border-color:var(--red);border-width:2px}
.fielderr{color:var(--red);font-size:15px;margin-top:4px}
.consent{display:flex;gap:12px;align-items:flex-start;margin-top:20px;padding:14px;border:1px solid var(--line);border-radius:8px;background:#f7f9fb;font-size:14px;line-height:1.45;font-weight:400}
.consent input{width:26px;height:26px;flex:0 0 auto;margin:0}
button,.btn{display:block;width:100%;border:0;border-radius:10px;padding:16px;font-size:20px;font-weight:700;color:#fff;background:var(--blue);cursor:pointer;text-decoration:none;text-align:center;margin-top:22px}
.msg{border-radius:8px;padding:12px 14px;margin-bottom:12px;font-size:16px}.err{background:#fde2e0}
.done{text-align:center}.done h1{font-size:30px;color:var(--green)}.muted{color:var(--muted);font-size:15px}
</style></head><body><header><img src="${LOGO}" alt="Splash Car Wash"></header><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The URL is the credential. same-origin (not no-referrer) so the page's
      // own POST still carries an Origin isOriginAllowed accepts.
      "Referrer-Policy": "same-origin",
      "X-Robots-Tag": "noindex"
    }
  });
}

function notFound(): Response {
  return page("Giveaway", `<div class="card"><h1>This link isn't valid</h1><p>Ask a team member for help.</p></div>`, 404);
}

function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

function header(g: Giveaway): string {
  return `<h1>${esc(g.title)}</h1>${g.prize ? `<p class="prize">${esc(g.prize)}</p>` : ""}`;
}

/** The site from `?site=N`, or null when absent / not a real site. */
async function siteFrom(env: Env, url: URL): Promise<{ site_number: number; site: string } | null> {
  const raw = url.searchParams.get("site");
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  try {
    return await getSite(env, Number(raw));
  } catch {
    return null;
  }
}

function selfUrl(url: URL, extra: Record<string, string> = {}): string {
  const next = new URL(url.pathname, url.origin);
  const site = url.searchParams.get("site");
  if (site && /^\d{1,4}$/.test(site)) next.searchParams.set("site", site);
  for (const [k, v] of Object.entries(extra)) next.searchParams.set(k, v);
  return next.pathname + next.search;
}

type Values = Partial<Record<GiveawayFieldKey, string>> & { sms?: boolean };

const INPUT: Record<GiveawayFieldKey, string> = {
  name: `type="text" maxlength="100" autocapitalize="words"`,
  email: `type="email" maxlength="254" inputmode="email" autocapitalize="off" spellcheck="false"`,
  phone: `type="tel" maxlength="20" inputmode="tel"`,
  plate: `type="text" maxlength="12" autocapitalize="characters" spellcheck="false"`,
  barcode: `type="text" maxlength="64" autocapitalize="characters" spellcheck="false"`
};

function renderForm(g: Giveaway, url: URL, values: Values, errors: Record<string, string>, topError?: string): string {
  const parts: string[] = [];
  for (const k of GIVEAWAY_FIELD_KEYS) {
    const f = g.fields[k];
    if (f.mode === "off") continue;
    const req = f.mode === "required";
    const err = errors[k];
    parts.push(
      `<label for="gw-${k}">${esc(giveawayFieldLabel(g.fields, k))} ${req ? `<span class="req">*</span>` : `<span class="opt">(optional)</span>`}</label>` +
        `<input id="gw-${k}" name="${k}" ${INPUT[k]} autocomplete="off"${req ? " required" : ""}${err ? ` class="bad" aria-invalid="true"` : ""} value="${esc(values[k] ?? "")}">` +
        (err ? `<div class="fielderr">${esc(err)}</div>` : "")
    );
  }
  const consent = effectiveSmsConsent(g);
  if (consent !== "off") {
    parts.push(
      `<label class="consent"><input type="checkbox" name="sms_consent" value="1"${values.sms ? " checked" : ""}${consent === "required" ? " required" : ""}><span>${consent === "required" ? `<span class="req">*</span> ` : ""}${esc(GIVEAWAY_SMS_CONSENT_TEXT)}</span></label>` +
        (errors.sms_consent ? `<div class="fielderr">${esc(errors.sms_consent)}</div>` : "")
    );
  }
  return `${topError ? `<div class="msg err">${esc(topError)}</div>` : ""}<div class="card">${header(g)}
<form method="post" action="${esc(selfUrl(url))}" autocomplete="off">${parts.join("")}<button type="submit">Enter</button></form></div>`;
}

export async function handleGiveawayPage(env: Env, url: URL, token: string): Promise<Response> {
  const g = await getGiveawayByToken(env, token).catch(() => null);
  if (!g) return notFound();
  const state = giveawayState(g, easternToday());

  if (url.searchParams.get("done") === "1") {
    // Back to a blank form after a few seconds, or at once with the button.
    const back = selfUrl(url);
    return page(
      g.title,
      `<div class="card done"><h1>You're entered!</h1><p class="prize">Good luck!</p><p class="muted">${esc(g.title)}</p><a class="btn" href="${esc(back)}">Next entry</a><p class="muted">This screen clears in a few seconds.</p></div>`,
      200,
      `<meta http-equiv="refresh" content="8;url=${esc(back)}">`
    );
  }

  if (state === "not_started") {
    return page(g.title, `<div class="card">${header(g)}<p class="muted">Entries open ${esc(fmtDay(g.starts_on!))}.</p></div>`);
  }
  if (state === "ended" || state === "archived") {
    return page(g.title, `<div class="card">${header(g)}<p class="muted">This giveaway has ended. Thanks for your interest!</p></div>`);
  }
  return page(g.title, renderForm(g, url, {}, {}));
}

const BARCODE_RE = /^[A-Za-z0-9 ._/#:+-]{1,64}$/;

export async function handleGiveawayPost(env: Env, req: Request, url: URL, token: string): Promise<Response> {
  const g = await getGiveawayByToken(env, token).catch(() => null);
  if (!g) return notFound();
  if (!isOriginAllowed(req)) {
    return page(g.title, renderForm(g, url, {}, {}, "Couldn't verify the page. Try again."), 403);
  }
  if (giveawayState(g, easternToday()) !== "open") return handleGiveawayPage(env, url, token);

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return page(g.title, renderForm(g, url, {}, {}, "That didn't come through. Try again."), 400);
  }
  const raw = (k: string) => String(fd.get(k) ?? "").replace(/\s+/g, " ").trim();
  const values: Values = { sms: fd.get("sms_consent") === "1" };
  for (const k of GIVEAWAY_FIELD_KEYS) values[k] = raw(k).slice(0, 254);

  const errors: Record<string, string> = {};
  const clean: Record<GiveawayFieldKey, string | null> = { name: null, email: null, phone: null, plate: null, barcode: null };
  for (const k of GIVEAWAY_FIELD_KEYS) {
    const mode = g.fields[k].mode;
    const v = values[k] ?? "";
    if (mode === "off" || v === "") {
      if (mode === "required") errors[k] = `Enter your ${giveawayFieldLabel(g.fields, k).toLowerCase()}.`;
      continue;
    }
    switch (k) {
      case "name":
        if (v.length > 100) errors.name = "That name is too long.";
        else clean.name = v;
        break;
      case "email":
        if (!isValidEmail(v)) errors.email = "Check the email address.";
        else clean.email = v.toLowerCase();
        break;
      case "phone": {
        const p = normalizeGiveawayPhone(v);
        if (!p) errors.phone = "Enter a 10-digit phone number.";
        else clean.phone = p;
        break;
      }
      case "plate": {
        const p = normalizeGiveawayPlate(v);
        if (!p) errors.plate = "Enter the plate, letters and numbers only.";
        else clean.plate = p;
        break;
      }
      case "barcode":
        if (!BARCODE_RE.test(v)) errors.barcode = "Use letters and numbers only.";
        else clean.barcode = v;
        break;
    }
  }

  const consentMode = effectiveSmsConsent(g);
  const consented = consentMode !== "off" && values.sms === true;
  if (consentMode === "required" && !consented) {
    errors.sms_consent = "Tick the box to enter.";
  }
  // Consent is to texts "at the number provided": without a number there is nothing to consent for.
  if (consented && !clean.phone && !errors.phone) {
    errors.phone = "Enter your phone number to get texts, or untick the box.";
  }

  const anyValue = GIVEAWAY_FIELD_KEYS.some((k) => clean[k] !== null);
  if (Object.keys(errors).length === 0 && !anyValue) {
    return page(g.title, renderForm(g, url, values, {}, "Fill in at least one box to enter."), 422);
  }
  if (Object.keys(errors).length > 0) {
    return page(g.title, renderForm(g, url, values, errors, "Check the highlighted boxes."), 422);
  }

  try {
    if (g.one_per_person) {
      const dup = await findDuplicate(env, { giveaway_id: g.id, ...clean });
      if (dup) {
        const what = giveawayFieldLabel(g.fields, dup).toLowerCase();
        return page(g.title, renderForm(g, url, {}, {}, `This ${what} has already been entered in this giveaway. One entry per person.`), 409);
      }
    }
    const site = await siteFrom(env, url);
    await insertEntry(env, {
      giveaway_id: g.id,
      site_number: site?.site_number ?? null,
      site_name: site?.site ?? null,
      ...clean,
      sms_consent: consented,
      sms_consent_text: consented ? GIVEAWAY_SMS_CONSENT_TEXT : null,
      ip: req.headers.get("cf-connecting-ip"),
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 500) || null
    });
  } catch (err) {
    console.error("[giveaways] entry failed", err);
    return page(g.title, renderForm(g, url, values, {}, "Something went wrong saving your entry. Try again."), 502);
  }

  return new Response(null, { status: 303, headers: { Location: selfUrl(url, { done: "1" }), "Cache-Control": "no-store" } });
}
