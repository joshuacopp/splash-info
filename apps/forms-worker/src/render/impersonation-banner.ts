// The "you are viewing as someone else" bar on forms-worker pages.
//
// apps/web's global Header carries this bar (ImpersonationBanner.tsx) on
// every page it renders, but form pages are served by THIS worker, so
// without a copy here a super admin opening a form while viewing as someone
// had no sign they were impersonating -- and in view mode the submit then
// failed for no visible reason.
//
// Deliberately smaller than the apps/web bar: it has Stop, not the mode
// switch. Switching to act mode needs a reason and is a decision worth making
// on an admin page; the apps/web bar is one click away.
//
// Stop posts to /sysadmin/api/impersonation/stop (same origin; the browser
// sends the cookie and Origin) and lands on /admin/sysadmin, matching the
// apps/web bar.

import type { Session } from "@splash/auth";
import { escapeHtml } from "./util.js";

export function impersonationBannerHtml(session: Session | null | undefined): string {
  const imp = session?.impersonation;
  if (!imp) return "";
  const acting = imp.mode === "act";
  const until = new Date(imp.expiresAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York"
  });
  const bg = acting ? "#dc2626" : "#fde68a";
  const fg = acting ? "#ffffff" : "#451a03";
  const btnBg = acting ? "#ffffff" : "#451a03";
  const btnFg = acting ? "#b91c1c" : "#fffbeb";
  const lead = acting ? "Acting as " : "Viewing as ";
  const tail = acting
    ? "— what you submit is recorded as them."
    : "— view only; submitting is blocked.";
  return `<div role="alert" style="background:${bg};color:${fg};padding:8px 16px;font-size:14px;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <strong>${lead}${escapeHtml(session?.email ?? "")}</strong>
  <span>${tail} Ends ${escapeHtml(until)} ET.</span>
  <button type="button" id="imp-stop" style="height:32px;padding:0 12px;border:0;border-radius:6px;font-weight:700;cursor:pointer;background:${btnBg};color:${btnFg};">Stop</button>
  <span id="imp-err" style="width:100%;text-align:center;font-size:12px;"></span>
</div>
<script>
(function () {
  var b = document.getElementById("imp-stop");
  if (!b) return;
  b.addEventListener("click", function () {
    b.disabled = true;
    fetch("/sysadmin/api/impersonation/stop", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).then(function (r) {
      if (r.ok) { window.location.assign("/admin/sysadmin"); return; }
      b.disabled = false;
      document.getElementById("imp-err").textContent = "Couldn't stop (" + r.status + "). Try again.";
    }).catch(function () {
      b.disabled = false;
      document.getElementById("imp-err").textContent = "Couldn't stop. Check your connection.";
    });
  });
})();
</script>`;
}
