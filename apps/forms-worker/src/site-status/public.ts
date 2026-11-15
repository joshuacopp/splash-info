// Site status -- the two no-sign-in pages.
//
//   /forms/site-status/{token}[?site=N]
//     The COMPANY-WIDE reopen link (site_status_settings.open_token). Security
//     by obscurity, by operator decision (2026-11-15): whoever has the link can
//     mark a site open and log / clear "equipment down" items, after typing
//     their name. It can NOT close a site -- that needs the site's RD or RM,
//     signed in. Staff enter their site number to pick the site. Rotating the
//     token from the board kills every copy of the old link.
//
//   /forms/site-status/manage/{token}
//     A per-person link mailed to the RD and RM when a closure runs past its
//     estimate: extend the estimate or mark the site open. SHA-256 of the
//     token is stored (site_closure_links); 7-day expiry; dead once the site
//     is open.
//
// Both pages POST back to themselves and redirect (303) to a GET so a
// refresh never repeats an action.

import { isOriginAllowed } from "@splash/http";
import type { Env } from "../index.js";
import {
  REASON_LABEL,
  findClosureLink,
  getClosure,
  getOpenClosureForSite,
  getSettings,
  getSite,
  listOpenClosures,
  listOpenDownItems,
  getDownItem,
  type Closure
} from "./data.js";
import {
  DOWN_ITEM_SUGGESTIONS,
  changeEstimate,
  clearDown,
  parseEstimate,
  reopenClosure,
  reportDownItem,
  sha256Hex
} from "./actions.js";
import { between, fmtDuration, fmtEt } from "./format.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} - Splash</title>
<style>
:root{--navy:#0b2a4a;--blue:#1b75bb;--green:#1f8a4c;--red:#c0392b;--line:#d9e1ea;--muted:#5b6b82}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f6f9;color:var(--navy)}
header{background:var(--navy);color:#fff;padding:14px 16px;font-weight:700;font-size:18px}
main{max-width:640px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
h1{font-size:22px;margin:4px 0 10px}h2{font-size:17px;margin:0 0 10px}
label{display:block;font-weight:600;margin:10px 0 4px}
input,select,textarea{width:100%;font-size:17px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--navy)}
button,.btn{display:inline-block;border:0;border-radius:8px;padding:12px 18px;font-size:16px;font-weight:700;color:#fff;background:var(--blue);cursor:pointer;text-decoration:none;margin-top:12px}
.green{background:var(--green)}.ghost{background:#fff;color:var(--blue);border:1px solid var(--blue)}.small{padding:7px 12px;font-size:14px;margin-top:0}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:13px;font-weight:700}
.closed{background:#fde2e0;color:var(--red)}.open{background:#dcf2e4;color:var(--green)}.down{background:#fff1d1;color:#7a5200}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:8px 0}dt{color:var(--muted);font-size:14px}dd{margin:0}
.msg{border-radius:8px;padding:10px 12px;margin-bottom:12px}.ok{background:#dcf2e4}.err{background:#fde2e0}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid var(--line);padding:8px 0}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chips button{margin-top:0;background:#eef4fa;color:var(--navy);font-weight:600}
.muted{color:var(--muted);font-size:14px}
</style></head><body><header>Splash &middot; Site status</header><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The URL is the credential. same-origin (not no-referrer) so this
      // page's own POST still carries an Origin isOriginAllowed accepts.
      "Referrer-Policy": "same-origin",
      "X-Robots-Tag": "noindex"
    }
  });
}

function notFound(): Response {
  return page("Link not valid", `<div class="card"><h1>This link isn't valid</h1><p>Ask your manager for the current site status link.</p></div>`, 404);
}

function msgHtml(url: URL): string {
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  if (ok) return `<div class="msg ok">${esc(ok)}</div>`;
  if (err) return `<div class="msg err">${esc(err)}</div>`;
  return "";
}

function redirect(url: URL, params: Record<string, string>): Response {
  const next = new URL(url.pathname, url.origin);
  for (const [k, v] of Object.entries(params)) if (v) next.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { Location: next.pathname + next.search, "Cache-Control": "no-store" } });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function closureDl(c: Closure, now: Date): string {
  const reason = REASON_LABEL[c.reason] + (c.reason_detail ? ` - ${c.reason_detail}` : "");
  const overdue = new Date(c.est_reopen_at).getTime() < now.getTime();
  return `<dl>
<dt>Reason</dt><dd>${esc(reason)}</dd>
<dt>Closed</dt><dd>${esc(fmtEt(c.closed_at))} by ${esc(c.closed_by)}</dd>
<dt>Expected open</dt><dd>${esc(fmtEt(c.est_reopen_at))}${overdue ? ` <span class="pill closed">overdue</span>` : ""}</dd>
<dt>Closed for</dt><dd>${esc(fmtDuration(now.getTime() - new Date(c.closed_at).getTime()))}</dd>
</dl>`;
}

/** "YYYY-MM-DDTHH:mm" typed on the page = Eastern wall clock. */
export function easternLocalToIso(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number) as unknown as number[];
  const guess = Date.UTC(y!, mo! - 1, d!, hh!, mm!);
  // Offset of New York at that instant (EST -5 / EDT -4), probed twice so a
  // time near a DST change settles on the right side.
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
      .formatToParts(new Date(t))
      .find((p) => p.type === "timeZoneName")?.value;
    const o = /GMT([+-]\d+)/.exec(parts ?? "");
    return (o ? Number(o[1]) : -5) * 3600000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}

// ---- company-wide link ---------------------------------------------------------

async function checkOpenToken(env: Env, token: string): Promise<boolean> {
  const s = await getSettings(env);
  return !!s && safeEqual(s.open_token, token);
}

export async function handleSiteLinkPage(env: Env, req: Request, url: URL, token: string): Promise<Response> {
  if (!(await checkOpenToken(env, token))) return notFound();
  const now = new Date();
  const siteParam = url.searchParams.get("site");

  if (!siteParam) {
    const open = await listOpenClosures(env).catch(() => [] as Closure[]);
    const closedList = open.length
      ? `<div class="card"><h2>Closed right now</h2>${open
          .map(
            (c) =>
              `<div class="row"><span><strong>${esc(c.site_name)}</strong> (${c.site_number})<br><span class="muted">since ${esc(fmtEt(c.closed_at))}</span></span><a class="btn small" href="?site=${c.site_number}">Open it</a></div>`
          )
          .join("")}</div>`
      : "";
    return page(
      "Site status",
      `${msgHtml(url)}<div class="card"><h1>Which site?</h1><form method="get"><label for="site">Site number</label><input id="site" name="site" inputmode="numeric" pattern="[0-9]{1,4}" required autofocus placeholder="e.g. 122"><button type="submit">Continue</button></form></div>${closedList}`
    );
  }

  const siteNumber = Number(siteParam);
  const site = Number.isInteger(siteNumber) ? await getSite(env, siteNumber) : null;
  if (!site) {
    return page("Site status", `<div class="msg err">There is no site ${esc(siteParam)}.</div><div class="card"><a class="btn ghost" href="?">Try again</a></div>`, 404);
  }
  const [closure, down] = await Promise.all([getOpenClosureForSite(env, siteNumber), listOpenDownItems(env, siteNumber)]);

  const statusCard = closure
    ? `<div class="card"><h1>${esc(site.site)} (${site.site_number}) <span class="pill closed">CLOSED</span></h1>${closureDl(closure, now)}
<form method="post"><input type="hidden" name="action" value="reopen"><input type="hidden" name="site" value="${site.site_number}">
<label for="name">Your name</label><input id="name" name="name" required maxlength="80" autocomplete="name">
<label for="note">Note (optional)</label><input id="note" name="note" maxlength="300">
<button class="green" type="submit">Mark ${esc(site.site)} open</button></form></div>`
    : `<div class="card"><h1>${esc(site.site)} (${site.site_number}) <span class="pill open">OPEN</span></h1><p class="muted">This site is not marked closed. Only the RD or RM can close a site.</p></div>`;

  const downCard = `<div class="card"><h2>Equipment down</h2>${
    down.length
      ? down
          .map(
            (d) =>
              `<div class="row"><span><strong>${esc(d.item)}</strong>${d.note ? ` - ${esc(d.note)}` : ""}<br><span class="muted">since ${esc(fmtEt(d.reported_at))}</span></span><form method="post" style="margin:0"><input type="hidden" name="action" value="clear"><input type="hidden" name="site" value="${site.site_number}"><input type="hidden" name="item_id" value="${esc(d.id)}"><input type="hidden" name="name" class="name-copy"><button class="small" type="submit">Back up</button></form></div>`
          )
          .join("")
      : `<p class="muted">Nothing reported down.</p>`
  }
<form method="post"><input type="hidden" name="action" value="down"><input type="hidden" name="site" value="${site.site_number}">
<label for="item">Report something down</label><input id="item" name="item" list="items" required maxlength="80" placeholder="e.g. Vacuums">
<datalist id="items">${DOWN_ITEM_SUGGESTIONS.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
<label for="dnote">Details (optional)</label><input id="dnote" name="note" maxlength="300">
<label for="dname">Your name</label><input id="dname" name="name" required maxlength="80" autocomplete="name">
<button class="ghost" type="submit">Report down</button></form>
<p class="muted">Equipment down shows on the status board. It does not send an email.</p></div>
<script>
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){
  var c=f.querySelector('.name-copy'); if(!c) return;
  var n=(document.getElementById('dname')||{}).value||(document.getElementById('name')||{}).value||'';
  if(!n){n=prompt('Your name')||'';} if(!n){e.preventDefault();return;} c.value=n;});});
</script>`;

  return page(`${site.site} status`, `${msgHtml(url)}${statusCard}${downCard}<p><a href="?">Choose a different site</a></p>`);
}

export async function handleSiteLinkPost(env: Env, req: Request, url: URL, token: string): Promise<Response> {
  if (!(await checkOpenToken(env, token))) return notFound();
  if (!isOriginAllowed(req)) return page("Error", `<div class="msg err">Couldn't verify the page. Go back, reload and try again.</div>`, 403);
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "").trim();
  const siteNumber = Number(get("site"));
  const site = Number.isInteger(siteNumber) ? await getSite(env, siteNumber) : null;
  if (!site) return redirect(url, { err: "Pick a site." });
  const back = (p: Record<string, string>) => redirect(url, { site: String(siteNumber), ...p });
  const name = get("name").replace(/\s+/g, " ").slice(0, 80);
  if (!name) return back({ err: "Type your name." });
  const by = `${name} (site link)`;

  const action = get("action");
  if (action === "reopen") {
    const closure = await getOpenClosureForSite(env, siteNumber);
    if (!closure) return back({ ok: `${site.site} is already open.` });
    const r = await reopenClosure(env, closure, { by, via: "link", note: get("note") });
    return r.ok ? back({ ok: `${site.site} is marked open. Thank you.` }) : back({ err: r.error });
  }
  if (action === "down") {
    const r = await reportDownItem(env, { siteNumber, item: get("item"), note: get("note"), by, via: "link" });
    return r.ok ? back({ ok: "Reported." }) : back({ err: r.error });
  }
  if (action === "clear") {
    const item = await getDownItem(env, get("item_id"));
    if (!item || item.site_number !== siteNumber) return back({ ok: "That was already cleared." });
    const r = await clearDown(env, item.id, by, "link");
    return r.ok ? back({ ok: `${item.item} marked back up.` }) : back({ err: r.error });
  }
  return back({ err: "Unknown action." });
}

// ---- emailed manage link -----------------------------------------------------------

async function loadManageLink(env: Env, token: string): Promise<{ closure: Closure; recipient: string } | Response> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return notFound();
  const link = await findClosureLink(env, await sha256Hex(token)).catch(() => null);
  if (!link) return notFound();
  if (new Date(link.expires_at).getTime() < Date.now()) {
    return page("Link expired", `<div class="card"><h1>This link has expired</h1><p>Use the <a href="/admin/site-status">site status board</a> instead.</p></div>`, 410);
  }
  const closure = await getClosure(env, link.closure_id);
  if (!closure) return notFound();
  return { closure, recipient: link.recipient };
}

const EXTEND_CHOICES: Array<[number, string]> = [
  [30, "30 min"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [480, "8 hours"],
  [1440, "24 hours"]
];

export async function handleManagePage(env: Env, url: URL, token: string): Promise<Response> {
  const loaded = await loadManageLink(env, token);
  if (loaded instanceof Response) return loaded;
  const { closure } = loaded;
  const title = `${closure.site_name} (${closure.site_number})`;
  if (closure.reopened_at) {
    return page(
      title,
      `${msgHtml(url)}<div class="card"><h1>${esc(title)} <span class="pill open">OPEN</span></h1><p>Reopened ${esc(fmtEt(closure.reopened_at))} by ${esc(closure.reopened_by ?? "-")} after ${esc(fmtDuration(between(closure.closed_at, closure.reopened_at)))}.</p></div>`
    );
  }
  const now = new Date();
  return page(
    title,
    `${msgHtml(url)}<div class="card"><h1>${esc(title)} <span class="pill closed">CLOSED</span></h1>${closureDl(closure, now)}</div>
<div class="card"><h2>Still closed? Extend it</h2>
<form method="post"><input type="hidden" name="action" value="extend">
<label>Expected to reopen in</label>
<div class="chips">${EXTEND_CHOICES.map(([m, l]) => `<button type="submit" name="minutes" value="${m}">${l}</button>`).join("")}</div>
<label for="note">Note (optional)</label><input id="note" name="note" maxlength="300">
</form>
<form method="post" id="ext-custom"><input type="hidden" name="action" value="extend">
<label for="at">Or reopen at (Eastern)</label><input id="at" type="datetime-local" name="reopen_at_local" required>
<button type="submit">Set time</button></form></div>
<div class="card"><h2>Already open?</h2><form method="post"><input type="hidden" name="action" value="reopen"><button class="green" type="submit">Mark ${esc(closure.site_name)} open</button></form></div>`
  );
}

export async function handleManagePost(env: Env, req: Request, url: URL, token: string): Promise<Response> {
  const loaded = await loadManageLink(env, token);
  if (loaded instanceof Response) return loaded;
  if (!isOriginAllowed(req)) return page("Error", `<div class="msg err">Couldn't verify the page. Go back, reload and try again.</div>`, 403);
  const { closure, recipient } = loaded;
  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "").trim();
  if (closure.reopened_at) return redirect(url, { ok: "This site is already open." });

  if (get("action") === "reopen") {
    const r = await reopenClosure(env, closure, { by: recipient, via: "email_link" });
    return redirect(url, r.ok ? { ok: `${closure.site_name} is marked open.` } : { err: r.error });
  }
  if (get("action") === "extend") {
    const local = get("reopen_at_local");
    const body: Record<string, unknown> = local
      ? { reopen_at: easternLocalToIso(local) ?? "invalid" }
      : { minutes: get("minutes") };
    const est = parseEstimate(body);
    if (typeof est === "string") return redirect(url, { err: est });
    const r = await changeEstimate(env, closure, { estimate: est, by: recipient, note: get("note") });
    return redirect(url, r.ok ? { ok: `Now expected to reopen ${fmtEt(r.value.est_reopen_at)}.` } : { err: r.error });
  }
  return redirect(url, { err: "Unknown action." });
}

