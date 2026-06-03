(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // src/index.js
  var TABLE_CONFIG = "pricing_simple";
  var TABLE_RESOLVED = "pricing_simple_resolved";
  var CACHE_TTL = 300;
  var STALE_TTL = 86400;
  // Brief 152: pragmatic email validation. Canonical helper lives in
  // packages/types/src/email-validate.ts (isValidEmail). This worker is
  // legacy JS not part of the workspace, so the regex is duplicated here.
  // Must reject leading/trailing/consecutive dots in local-part. If you
  // change one, change the other.
  function isValidEmail(s) {
    if (!s) return false;
    const trimmed = String(s).trim();
    if (trimmed.length === 0 || trimmed.length > 254) return false;
    const re = /^(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9_+-]|\.(?!\.))*[A-Za-z0-9])@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
    return re.test(trimmed);
  }
  __name(isValidEmail, "isValidEmail");
  addEventListener("fetch", (event) => event.respondWith(handle(event.request, event)));
  async function handle(request, event) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    const parts = path.split("/");
    if (path === "admin/clear-cache") {
      try {
        await caches.default.delete(new Request("https://internal-cache/pricing_simple_resolved"));
        return new Response("\u2705 Cache cleared", { headers: { "content-type": "text/plain" } });
      } catch (e) {
        return new Response("\u26A0\uFE0F Cache clear failed", { status: 500 });
      }
    }
    if (parts[0] === "admin") return handleAdminRoutes(request, parts, event);
    if (path === "api/submit-signup" && request.method === "POST") {
      return handleSignupSubmission(request, event);
    }
    const PREFIXES = /* @__PURE__ */ new Set(["signup", "q", "join"]);
    const segs = PREFIXES.has(parts[0]) ? parts.slice(1) : parts;
    if (!segs[0]) return new Response("Not found", { status: 404 });
    if (segs.length === 1) {
      const loc = segs[0].toLowerCase();
      const rows = await listPackages(loc, event);
      rows.sort((a, b) => (Number(a.sort) || 99) - (Number(b.sort) || 99));
      const prefix = PREFIXES.has(parts[0]) ? `/${parts[0]}` : "";
      const useSimplifiedPicker = true;
      return new Response(renderPicker(loc, rows, prefix, useSimplifiedPicker), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    if (segs.length >= 2) {
      const loc = segs[0].toLowerCase();
      const pkg = segs[1].toLowerCase();
      const row = await fetchOne(loc, pkg, event);
      if (!row) {
        return new Response("Package not found", { status: 404 });
      }
      return new Response(renderSignupForm(loc, pkg, row), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
  __name(handle, "handle");
  async function handleAdminRoutes(request, parts, event) {
    const url = new URL(request.url);
    if (parts[1] === "login" && request.method === "GET") {
      return html(200, renderLoginPage());
    }
    if (parts[1] === "login" && request.method === "POST") {
      return handleLogin(request);
    }
    if (parts[1] === "logout") {
      return new Response("", {
        status: 302,
        headers: {
          "Location": "/admin",
          "Set-Cookie": "sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0, sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        }
      });
    }
    if (parts[1] === "change-password") {
      const authResult2 = await checkAuth(request);
      if (!authResult2.authenticated) {
        if (authResult2.reason === "tool_not_granted" || authResult2.reason === "tool_access_lookup_failed") {
          return html(403, renderPricingForbidden(authResult2.user && authResult2.user.email));
        }
        return Response.redirect(`${url.origin}/admin`, 302);
      }
      if (request.method === "GET") {
        return html(200, renderChangePasswordPage());
      }
      if (request.method === "POST") {
        return handleChangePassword(request, authResult2.user);
      }
    }
    const authResult = await checkAuth(request);
    if (!authResult.authenticated) {
      if (authResult.reason === "tool_not_granted" || authResult.reason === "tool_access_lookup_failed") {
        return html(403, renderPricingForbidden(authResult.user && authResult.user.email));
      }
      return html(200, renderLoginPage());
    }
    const { user, locations, isSuperAdmin, mustChangePassword } = authResult;
    if (mustChangePassword && parts[1] !== "change-password") {
      return Response.redirect(`${url.origin}/admin/change-password?required=true`, 302);
    }
    const slug = (parts[1] || "").toLowerCase();
    if (!slug) {
      if (locations.length === 0) {
        return html(403, renderPricingNoLocations(user.email));
      }
      if (locations.length === 1) {
        return Response.redirect(`${url.origin}/admin/${locations[0].location_code}`, 302);
      }
      const emailPrefix2 = user.email.split("@")[0].toLowerCase();
      return Response.redirect(`${url.origin}/admin/${emailPrefix2}`, 302);
    }
    const emailPrefix = user.email.split("@")[0].toLowerCase();
    if (slug === emailPrefix) {
      if (request.method === "GET") {
        const rows = await fetchAllLocationPkgs(locations);
        return html(200, renderUserLocations(user, rows));
      }
      if (request.method === "POST") {
        return handleBulkUpdate(request, user, locations);
      }
    }
    const hasAccess = isSuperAdmin || locations.some((l) => l.location_code === slug);
    if (!hasAccess) {
      return html(403, pageWrap(indexMsg(`You don't have access to ${esc(slug)}.`, "err")));
    }
    if (request.method === "GET") {
      const rows = await fetchAllLocationPkgs([{ location_code: slug }]);
      return html(200, renderUserLocations(user, rows));
    }
    if (request.method === "POST") {
      const form = await readForm(request);
      const action = (form.get("action") || "").trim();
      if (!["full", "same", "flash5", "flash2", "special", "flip", "bogo"].includes(action)) {
        const rows2 = await fetchAllLocationPkgs([{ location_code: slug }]);
        return html(400, renderUserLocations(user, rows2, "Invalid action."));
      }
      // BOGO is a schedule modifier, not a pricing mode -- never touches `pricing`.
      // pkg_list[] = packages to turn ON; all others at this location get turned OFF.
      // Zero in the list is valid (means "turn BOGO off everywhere here").
      if (action === "bogo") {
        const onPkgs = form.getAll("pkg_list[]");
        const ok = await setBogo(slug, onPkgs);
        const rows = await fetchAllLocationPkgs([{ location_code: slug }]);
        return html(ok ? 200 : 500, renderUserLocations(
          user,
          rows,
          ok ? `Updated ${esc(slug)} BOGO.` : "Update failed."
        ));
      }
      let mode = action;
      if (action === "flip") {
        const current = await getCurrentMode(slug);
        mode = current === "full" ? "same" : "full";
      }
      const pkgList = form.getAll("pkg_list[]");
      const specialPrice = form.get("special_price") || null;
      const ok = await setMode(slug, mode, pkgList.length > 0 ? pkgList : null, specialPrice);
      const rows = await fetchAllLocationPkgs([{ location_code: slug }]);
      return html(ok ? 200 : 500, renderUserLocations(
        user,
        rows,
        ok ? `Updated ${esc(slug)} to <b>${esc(mode)}</b>.` : "Update failed."
      ));
    }
    return html(405, pageWrap(indexMsg("Method not allowed.", "err")));
  }
  __name(handleAdminRoutes, "handleAdminRoutes");
  async function handleSignupSubmission(request, event) {
    const debugLogs = [];
    debugLogs.push("=== handleSignupSubmission called ===");
    console.log("=== handleSignupSubmission called ===");
    try {
      const data = await request.json();
      debugLogs.push("Request data: " + JSON.stringify(data));
      console.log("Request data:", JSON.stringify(data));
      const phone = data.phone;
      debugLogs.push("Phone extracted: " + phone);
      const deniedPatterns = [
        "0000000000",
        "1111111111",
        "2222222222",
        "3333333333",
        "4444444444",
        "5555555555",
        "6666666666",
        "7777777777",
        "8888888888",
        "9999999999",
        "1234567890",
        "0987654321"
      ];
      const invalidAreaCodes = ["011", "111", "211", "311", "411", "511", "611", "711", "811", "911"];
      const areaCode = phone.substring(0, 3);
      if (deniedPatterns.includes(phone) || invalidAreaCodes.includes(areaCode)) {
        return new Response(JSON.stringify({
          denied: true,
          error: "This number is invalid. Please enter a valid phone number."
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (!isValidEmail(data.email)) {
        return new Response(JSON.stringify({
          denied: true,
          error: "Please enter a valid email address."
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      const suspiciousCheck = await fetch(
        `${SUPABASE_URL}/rest/v1/suspicious_phones?phone=eq.${phone}`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        }
      );
      debugLogs.push("Phone being checked: " + phone);
      debugLogs.push("Suspicious check status: " + suspiciousCheck.status);
      console.log("Phone being checked:", phone);
      console.log("Suspicious check status:", suspiciousCheck.status);
      if (suspiciousCheck.ok) {
        const records = await suspiciousCheck.json();
        debugLogs.push("Records found: " + JSON.stringify(records));
        console.log("Records found:", JSON.stringify(records));
        if (records && records.length > 0) {
          const record = records[0];
          const tier = record.tier;
          const count = record.usage_count;
          if (tier === "Deny") {
            await logUsage(phone, data.phone_formatted, count + 1, data.location, data.location_pretty, "Deny", "blocked", null, request);
            return new Response(JSON.stringify({
              denied: true,
              error: "This number is either invalid or has been manually denied due to repeated usage. Enter a valid phone number.",
              count
            }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
      }
      const usageCheck = await fetch(
        `${SUPABASE_URL}/rest/v1/maxpass_signups?phone=eq.${phone}&select=id`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        }
      );
      console.log("Usage check status:", usageCheck.status);
      const usages = await usageCheck.json();
      const existingUses = usages.length;
      console.log("Existing uses in maxpass_signups:", existingUses);
      let tierToCheck = null;
      if (existingUses >= 9) {
        tierToCheck = "Monitor";
      } else if (existingUses >= 2) {
        tierToCheck = "Warn";
      }
      console.log("Tier to check:", tierToCheck, "for existing uses:", existingUses);
      if (existingUses === 2 && !data.user_confirmed) {
        console.log("Creating Warn tier entry (this will be 3rd use)");
        await createOrUpdateSuspicious(phone, "Warn", 3);
        return new Response(JSON.stringify({
          warning: true,
          message: `Warning - Phone number ${data.phone_formatted} has been submitted ${existingUses} times before. Please verify this is a valid phone number.`,
          count: existingUses + 1,
          phone: data.phone_formatted
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (existingUses === 9 && !data.user_confirmed) {
        console.log("Upgrading to Monitor tier (this will be 10th use)");
        await createOrUpdateSuspicious(phone, "Monitor", 10);
        await logUsage(phone, data.phone_formatted, 10, data.location, data.location_pretty, "Monitor", "flagged", null, request);
        return new Response(JSON.stringify({
          monitor: true,
          message: "This phone number has been flagged due to repeated use in this form. Please re-enter your number carefully.",
          count: 10,
          phone: data.phone_formatted
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (tierToCheck === "Warn" && !data.user_confirmed) {
        await logUsage(phone, data.phone_formatted, existingUses + 1, data.location, data.location_pretty, "Warn", "warned", null, request);
        return new Response(JSON.stringify({
          warning: true,
          message: `Warning - Phone number ${data.phone_formatted} has been submitted ${existingUses} times before. Please verify this is a valid phone number.`,
          count: existingUses + 1,
          phone: data.phone_formatted
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (tierToCheck === "Monitor" && !data.monitor_acknowledged) {
        await logUsage(phone, data.phone_formatted, existingUses + 1, data.location, data.location_pretty, "Monitor", "flagged", null, request);
        return new Response(JSON.stringify({
          monitor: true,
          message: "This phone number has been flagged due to repeated use in this form. Please re-enter your number carefully.",
          count: existingUses + 1,
          phone: data.phone_formatted
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (tierToCheck) {
        console.log("Updating usage count to:", existingUses + 1);
        await updateUsageCount(phone, existingUses + 1);
      }
      const ipAddress = request.headers.get("CF-Connecting-IP") || "Unknown";
      const userAgent = request.headers.get("User-Agent") || "Unknown";
      const country = request.cf?.country || "Unknown";
      const city = request.cf?.city || "Unknown";
      const region = request.cf?.region || "Unknown";
      const confirmationToken = crypto.randomUUID();
      const supabaseResponse = await fetch(`${SUPABASE_URL}/rest/v1/maxpass_signups`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          location_code: data.location,
          location_pretty: data.location_pretty,
          package_code: data.package,
          package_pretty: data.package_pretty,
          today_price: parseFloat(data.today_price),
          monthly_price: parseFloat(data.monthly_price),
          phone: data.phone,
          phone_formatted: data.phone_formatted,
          terms_text: data.terms,
          terms_agreed: data.terms_agreed,
          submitted_at: data.timestamp,
          ip_address: ipAddress,
          user_agent: userAgent,
          country,
          city,
          region,
          email: data.email,
          confirmation_token: confirmationToken,
          // BOGO fields -- defensive defaults so non-BOGO signups and older
          // clients (which don't post these fields) land as is_bogo=false /
          // recurring_start_date=null without breaking the insert.
          is_bogo: data.is_bogo === true,
          recurring_start_date: data.recurring_start_date || null
        })
      });
      console.log("Maxpass signup insert status:", supabaseResponse.status);
      if (!supabaseResponse.ok) {
        const errorText = await supabaseResponse.text();
        console.error("Supabase error:", supabaseResponse.status, errorText);
        throw new Error("Supabase write failed");
      }
      const finalCount = existingUses + 1;
      const tierForLog = data.user_confirmed || data.monitor_acknowledged ? tierToCheck : null;
      const userResponseLog = data.monitor_acknowledged ? "monitor_confirmed" : data.user_confirmed ? "warn_confirmed" : "submitted";
      debugLogs.push("Logging successful submission with tier: " + tierForLog + ", count: " + finalCount + ", response: " + userResponseLog);
      console.log("Logging successful submission with tier:", tierForLog, "count:", finalCount, "response:", userResponseLog);
      await logUsage(
        phone,
        data.phone_formatted,
        finalCount,
        data.location,
        data.location_pretty,
        tierForLog,
        "allowed",
        userResponseLog,
        request
      );
      debugLogs.push("Usage logged successfully");
      console.log("Usage logged successfully");
      return new Response(JSON.stringify({
        success: true,
        debug: debugLogs
        // Include debug logs in response
      }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      console.error("Signup submission error:", error);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  __name(handleSignupSubmission, "handleSignupSubmission");
  async function createOrUpdateSuspicious(phone, tier, count) {
    const payload = {
      phone,
      tier,
      usage_count: count,
      last_seen: (/* @__PURE__ */ new Date()).toISOString(),
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    console.log("createOrUpdateSuspicious - attempting upsert for phone:", phone, "tier:", tier, "count:", count);
    const updateResponse = await fetch(`${SUPABASE_URL}/rest/v1/suspicious_phones?phone=eq.${phone}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(payload)
    });
    console.log("createOrUpdateSuspicious UPDATE response status:", updateResponse.status);
    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error("createOrUpdateSuspicious UPDATE error:", errorText);
      return false;
    }
    const updateResult = await updateResponse.json();
    console.log("createOrUpdateSuspicious UPDATE result:", JSON.stringify(updateResult));
    if (updateResult && updateResult.length > 0) {
      console.log("createOrUpdateSuspicious - existing record updated successfully");
      return true;
    }
    console.log("createOrUpdateSuspicious - no existing record, inserting new one");
    const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/suspicious_phones`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(payload)
    });
    console.log("createOrUpdateSuspicious INSERT response status:", insertResponse.status);
    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      console.error("createOrUpdateSuspicious INSERT error:", errorText);
      return false;
    }
    const insertResult = await insertResponse.json();
    console.log("createOrUpdateSuspicious INSERT result:", JSON.stringify(insertResult));
    return true;
  }
  __name(createOrUpdateSuspicious, "createOrUpdateSuspicious");
  async function updateUsageCount(phone, count) {
    const payload = {
      usage_count: count,
      last_seen: (/* @__PURE__ */ new Date()).toISOString(),
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    console.log("updateUsageCount - updating phone:", phone, "to count:", count);
    const response = await fetch(`${SUPABASE_URL}/rest/v1/suspicious_phones?phone=eq.${phone}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(payload)
    });
    console.log("updateUsageCount response status:", response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("updateUsageCount error:", errorText);
    } else {
      const result = await response.json();
      console.log("updateUsageCount SUCCESS - result:", JSON.stringify(result));
    }
    return response.ok;
  }
  __name(updateUsageCount, "updateUsageCount");
  async function logUsage(phone, phoneFormatted, count, locationCode, locationPretty, tier, action, userResponse, request) {
    const ipAddress = request.headers.get("CF-Connecting-IP") || "Unknown";
    const payload = {
      phone,
      phone_formatted: phoneFormatted,
      usage_count_at_time: count,
      location_code: locationCode,
      location_pretty: locationPretty,
      tier,
      action_taken: action,
      user_response: userResponse,
      ip_address: ipAddress,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    console.log("logUsage payload:", JSON.stringify(payload));
    const response = await fetch(`${SUPABASE_URL}/rest/v1/phone_usage_log`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    console.log("logUsage response status:", response.status);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("logUsage error:", errorText);
    }
  }
  __name(logUsage, "logUsage");
  async function handleBulkUpdate(request, user, locations) {
    const form = await readForm(request);
    const l = (form.get("loc") || "").toLowerCase().trim();
    const action = (form.get("action") || "").trim();
    if (!l) return html(400, pageWrap(indexMsg("Missing location.", "err")));
    if (!["full", "same", "flash5", "flash2", "special", "flip", "bogo"].includes(action)) {
      return html(400, pageWrap(indexMsg("Invalid action.", "err")));
    }
    const hasAccess = locations.some((loc) => loc.location_code === l);
    if (!hasAccess) {
      return html(403, pageWrap(indexMsg("Access denied.", "err")));
    }
    // BOGO is a schedule modifier, not a pricing mode -- never touches `pricing`.
    if (action === "bogo") {
      const onPkgs = form.getAll("pkg_list[]");
      const ok = await setBogo(l, onPkgs);
      const rows = await fetchAllLocationPkgs(locations);
      return html(ok ? 200 : 500, renderUserLocations(
        user,
        rows,
        ok ? `Updated <b>${esc(l)}</b> BOGO.` : "Update failed."
      ));
    }
    let mode = action;
    if (action === "flip") {
      const current = await getCurrentMode(l);
      mode = current === "full" ? "same" : "full";
    }
    const pkgList = form.getAll("pkg_list[]");
    const specialPrice = form.get("special_price") || null;
    const ok = await setMode(l, mode, pkgList.length > 0 ? pkgList : null, specialPrice);
    const rows = await fetchAllLocationPkgs(locations);
    return html(ok ? 200 : 500, renderUserLocations(
      user,
      rows,
      ok ? `Updated <b>${esc(l)}</b> to <b>${esc(mode)}</b>.` : "Update failed."
    ));
  }
  __name(handleBulkUpdate, "handleBulkUpdate");
  async function handleLogin(request) {
    const form = await readForm(request);
    const email = (form.get("email") || "").trim();
    const password = (form.get("password") || "").trim();
    const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    if (!authResponse.ok) {
      return html(401, renderLoginPage("Invalid email or password"));
    }
    const authData = await authResponse.json();
    return new Response("", {
      status: 302,
      headers: {
        "Location": "/admin",
        "Set-Cookie": `sb-access-token=${authData.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600, sb-refresh-token=${authData.refresh_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
      }
    });
  }
  __name(handleLogin, "handleLogin");
  async function handleChangePassword(request, user) {
    const form = await readForm(request);
    const newPassword = (form.get("new_password") || "").trim();
    const confirmPassword = (form.get("confirm_password") || "").trim();
    if (!newPassword || newPassword.length < 8) {
      return html(400, renderChangePasswordPage("Password must be at least 8 characters"));
    }
    if (newPassword !== confirmPassword) {
      return html(400, renderChangePasswordPage("Passwords do not match"));
    }
    try {
      const updateResponse = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: "PUT",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          password: newPassword
        })
      });
      if (!updateResponse.ok) {
        const errData = await updateResponse.json().catch(() => ({}));
        const msg = errData.msg || "Password requirements not met";
        console.error("Password update failed:", updateResponse.status, errData);
        return html(400, renderChangePasswordPage(msg));
      }
      await fetch(`${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user.id}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ must_change_password: false })
      });
      return html(200, renderChangePasswordPage("Password successfully updated! Redirecting...", true));
    } catch (error) {
      console.error("Password change error:", error);
      return html(500, renderChangePasswordPage("An error occurred. Please try again."));
    }
  }
  __name(handleChangePassword, "handleChangePassword");
  async function checkAuth(request) {
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const accessToken = cookies["sb-access-token"];
    if (!accessToken) {
      return { authenticated: false };
    }
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${accessToken}`
      }
    });
    if (!userResponse.ok) {
      return { authenticated: false };
    }
    const user = await userResponse.json();
    const permCheck = await fetch(`${SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user.id}&select=role,must_change_password`, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    const perms = await permCheck.json();
    const isSuperAdmin = perms.some((p) => p.role === "super_admin");
    const mustChangePassword = perms.some((p) => p.must_change_password === true);
    if (!isSuperAdmin) {
      const toolGrantResp = await fetch(
        `${SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user.id}&tool=eq.pricing&select=tool`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`
          }
        }
      );
      if (!toolGrantResp.ok) {
        console.error("user_tool_access lookup failed:", toolGrantResp.status);
        return { authenticated: false, reason: "tool_access_lookup_failed", user };
      }
      const grants = await toolGrantResp.json();
      if (!Array.isArray(grants) || grants.length === 0) {
        return { authenticated: false, reason: "tool_not_granted", user };
      }
    }
    let locations = [];
    if (isSuperAdmin) {
      locations = await listDistinctLocations();
    } else {
      const locResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/${TABLE_CONFIG}?or=(site_email.eq.${user.email},am_email.eq.${user.email},rm_email.eq.${user.email})&select=location_code,location_pretty,pricing`,
        { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const allRows = await locResponse.json();
      const seen = /* @__PURE__ */ new Map();
      for (const row of allRows) {
        const code = (row.location_code || "").toLowerCase();
        if (code && !seen.has(code)) {
          seen.set(code, {
            location_code: code,
            location_pretty: row.location_pretty || code,
            pricing: row.pricing || ""
          });
        }
      }
      locations = Array.from(seen.values());
    }
    return {
      authenticated: true,
      user,
      locations,
      isSuperAdmin,
      mustChangePassword
    };
  }
  __name(checkAuth, "checkAuth");
  function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(";").forEach((cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name) cookies[name] = value;
    });
    return cookies;
  }
  __name(parseCookies, "parseCookies");
  function renderPricingNoLocations(email) {
    const safeEmail = String(email || "this account").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Setup Incomplete \u2014 Pricing Admin</title>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --yellow: #f1c61e;
    --white: #ffffff;
    --muted: #6b7280;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    background-attachment: fixed;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 480px;
    background: var(--white);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 28px 32px 22px;
    text-align: center;
  }
  .card-header img { display: block; height: 56px; width: auto; margin: 0 auto 12px; }
  .card-header .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .card-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #fff; }
  .card-body { padding: 24px 32px 28px; text-align: center; }
  .card-body p { margin: 0 0 8px; font-size: 14px; color: var(--splash-navy); }
  .card-body .email { font-weight: 700; word-break: break-all; }
  .card-body .muted { color: var(--muted); font-size: 13px; }
  .info-banner {
    background: #fef3c7;
    border: 1px solid var(--yellow);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin: 12px 0 4px;
    font-size: 13px;
    color: #78350f;
    text-align: left;
  }
  .info-banner strong { display: block; margin-bottom: 4px; color: #78350f; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    padding: 10px 20px; height: 42px;
    font: 700 14px var(--font-body);
    border-radius: var(--radius-sm); cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: none;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Pricing Admin</div>
      <h1>Setup Incomplete</h1>
    </div>
    <div class="card-body">
      <p><span class="email">${safeEmail}</span> has been granted access to Pricing Admin, but no locations have been assigned to you yet.</p>
      <div class="info-banner">
        <strong>Next step</strong>
        Your administrator needs to add your email to the appropriate location rows in the pricing system (as Site, AM, or RM contact).
      </div>
      <p class="muted">Once that's done, refresh this page.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Return to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
  }
  __name(renderPricingNoLocations, "renderPricingNoLocations");
  function renderPricingForbidden(email) {
    const safeEmail = String(email || "this account").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Access Denied \u2014 Pricing Admin</title>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --white: #ffffff;
    --muted: #6b7280;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    background-attachment: fixed;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 460px;
    background: var(--white);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 28px 32px 22px;
    text-align: center;
  }
  .card-header img { display: block; height: 56px; width: auto; margin: 0 auto 12px; }
  .card-header .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .card-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #fff; }
  .card-body { padding: 24px 32px 28px; text-align: center; }
  .card-body p { margin: 0 0 8px; font-size: 14px; color: var(--splash-navy); }
  .card-body .email { font-weight: 700; word-break: break-all; }
  .card-body .muted { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    padding: 10px 20px; height: 42px;
    font: 700 14px var(--font-body);
    border-radius: var(--radius-sm); cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: none;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Pricing Admin</div>
      <h1>Access Denied</h1>
    </div>
    <div class="card-body">
      <p>Sorry, <span class="email">${safeEmail}</span> doesn't have access to Pricing Admin.</p>
      <p class="muted">Contact your administrator if you need access.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Return to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
  }
  __name(renderPricingForbidden, "renderPricingForbidden");
  function renderLoginPage(error = "") {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<title>Splash Car Washes \u2014 Sign In</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --racecar-red: #dc3e26;
    --gray-light: #dbdbdb;
    --white: #ffffff;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .login-card {
    width: 100%; max-width: 420px;
    background: var(--splash-navy);
    border: 3px solid var(--splash-navy);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .login-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: var(--white);
    padding: 28px 32px 24px;
    text-align: center;
  }
  .login-logo { display: block; height: 60px; width: auto; margin: 0 auto 12px; object-fit: contain; }
  .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .login-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: var(--white); line-height: 1.2; }
  .login-body { background: var(--white); padding: 26px 32px 28px; }
  .form-intro {
    text-align: center; color: var(--splash-navy);
    opacity: 0.75; font-size: 14px; margin: 0 0 18px;
  }
  .form-group { margin-bottom: 14px; }
  label { display: block; font-size: 0.875rem; font-weight: 600; color: var(--splash-navy); margin-bottom: 6px; }
  .req { color: var(--sudsy-blue); font-weight: 700; }
  input {
    width: 100%; height: 42px; padding: 8px 14px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: var(--white);
    border: 1.5px solid var(--gray-light);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input::placeholder { color: #9aa0a6; }
  input:hover { border-color: var(--sudsy-blue); }
  input:focus {
    outline: none;
    border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  button {
    width: 100%; height: 46px; margin-top: 10px;
    font: 700 1rem var(--font-body); letter-spacing: 0.02em;
    color: var(--white); background: var(--splash-blue);
    border: none; border-radius: var(--radius-sm);
    box-shadow: var(--shadow-btn); cursor: pointer;
    transition: background-color 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
  }
  button:hover { background: var(--splash-blue-dark); box-shadow: 0 6px 16px rgba(43, 52, 145, 0.35); }
  button:active { transform: translateY(1px); }
  .error {
    margin-top: 14px; padding: 10px 14px;
    font: 600 14px var(--font-body); color: var(--white);
    background: var(--racecar-red); border-radius: var(--radius-sm);
    text-align: center;
  }
</style>
</head>
<body>
  <div class="login-card">
    <div class="login-header">
      <img class="login-logo" src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Internal Tools</div>
      <h1>Sign In</h1>
    </div>
    <div class="login-body">
      <p class="form-intro">Sign in with your Splash account to continue.</p>
      <form method="POST" action="/admin/login" autocomplete="on">
        <div class="form-group">
          <label for="email">Email Address <span class="req">*</span></label>
          <input type="email" id="email" name="email" placeholder="your.name@splashcarwashes.com" required autocomplete="email" autofocus/>
        </div>
        <div class="form-group">
          <label for="password">Password <span class="req">*</span></label>
          <input type="password" id="password" name="password" placeholder="Enter password" required autocomplete="current-password"/>
        </div>
        <button type="submit">Sign In</button>
        ${error ? `<div class="error">${esc(error)}</div>` : ""}
      </form>
    </div>
  </div>
</body>
</html>`;
  }
  __name(renderLoginPage, "renderLoginPage");
  function renderChangePasswordPage(message = "", success = false) {
    const messageHtml = message ? `<div class="${success ? "success" : "error"}">${esc(message)}</div>` : "";
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<title>Change Password \u2014 Splash Car Washes</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --racecar-red: #dc3e26;
    --ok: #067647;
    --gray-light: #dbdbdb;
    --white: #ffffff;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 420px;
    background: var(--splash-navy);
    border: 3px solid var(--splash-navy);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: var(--white); padding: 28px 32px 24px; text-align: center;
  }
  .card-header img { display: block; height: 56px; width: auto; margin: 0 auto 12px; object-fit: contain; }
  .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .card-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: var(--white); line-height: 1.2; }
  .card-body { background: var(--white); padding: 26px 32px 28px; }
  .form-group { margin-bottom: 14px; }
  label { display: block; font-size: 0.875rem; font-weight: 600; color: var(--splash-navy); margin-bottom: 6px; }
  .req { color: var(--sudsy-blue); font-weight: 700; }
  input {
    width: 100%; height: 42px; padding: 8px 14px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: var(--white);
    border: 1.5px solid var(--gray-light);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  input::placeholder { color: #9aa0a6; }
  input:hover { border-color: var(--sudsy-blue); }
  input:focus {
    outline: none;
    border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  button {
    width: 100%; height: 46px; margin-top: 10px;
    font: 700 1rem var(--font-body); letter-spacing: 0.02em;
    color: var(--white); background: var(--splash-blue);
    border: none; border-radius: var(--radius-sm);
    box-shadow: var(--shadow-btn); cursor: pointer;
    transition: background-color 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
  }
  button:hover { background: var(--splash-blue-dark); box-shadow: 0 6px 16px rgba(43, 52, 145, 0.35); }
  button:active { transform: translateY(1px); }
  .error {
    margin-bottom: 14px; padding: 10px 14px;
    font: 600 14px var(--font-body); color: var(--white);
    background: var(--racecar-red); border-radius: var(--radius-sm); text-align: center;
  }
  .success {
    margin-bottom: 14px; padding: 10px 14px;
    font: 600 14px var(--font-body); color: var(--white);
    background: var(--ok); border-radius: var(--radius-sm); text-align: center;
  }
  .back-link {
    display: flex; justify-content: center; gap: 14px;
    margin-top: 18px; font-size: 13px;
  }
  .back-link a {
    color: var(--splash-blue); font-weight: 600;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .back-link a:hover { color: var(--splash-blue-dark); text-decoration: underline; }
  .back-link svg { width: 12px; height: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Pricing Admin</div>
      <h1>Change Password</h1>
    </div>
    <div class="card-body">
      ${messageHtml}
      <form method="POST" autocomplete="on">
        <div class="form-group">
          <label for="new_password">New Password <span class="req">*</span></label>
          <input type="password" id="new_password" name="new_password" placeholder="Enter new password (min 8 characters)" required minlength="8" autocomplete="new-password"/>
        </div>
        <div class="form-group">
          <label for="confirm_password">Confirm New Password <span class="req">*</span></label>
          <input type="password" id="confirm_password" name="confirm_password" placeholder="Confirm new password" required minlength="8" autocomplete="new-password"/>
        </div>
        <button type="submit">Update Password</button>
      </form>
      <div class="back-link">
        <a href="/admin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to Pricing Admin</a>
        <a href="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> Dashboard</a>
      </div>
    </div>
  </div>
  ${success ? '<script>setTimeout(() => window.location.href = "/admin", 1800)<\/script>' : ""}
</body>
</html>`;
  }
  __name(renderChangePasswordPage, "renderChangePasswordPage");
  function renderUserLocations(user, rows = [], message = "") {
    const grouped = {};
    for (const r of rows) {
      const code = (r.location_code || "").toLowerCase();
      if (!grouped[code]) {
        grouped[code] = { pretty: r.location_pretty || code, pkgs: [] };
      }
      grouped[code].pkgs.push({ pkg: r.pkg, pricing: r.pricing || "", bogo: r.bogo === true });
    }
    const cards = Object.entries(grouped).map(([loc, info]) => {
      const pkgList = info.pkgs.map((p) => {
        const modeClass = p.pricing === "full" ? "mode-full" : p.pricing === "same" ? "mode-same" : p.pricing === "flash5" ? "mode-flash5" : p.pricing === "flash2" ? "mode-flash2" : p.pricing === "special" ? "mode-special" : "";
        const bogoPill = p.bogo ? `<span class="pkg-bogo">BOGO</span>` : "";
        return `<div><span class="pkg-name">${esc(p.pkg)}</span><span class="pkg-tags"><span class="pkg-mode ${modeClass}">${esc(p.pricing || "unset")}</span>${bogoPill}</span></div>`;
      }).join("");
      const pkgsJson = JSON.stringify(info.pkgs.map((p) => p.pkg));
      const bogoJson = JSON.stringify(info.pkgs.map((p) => ({ pkg: p.pkg, on: !!p.bogo })));
      return `
      <div class="card" data-location="${esc(info.pretty).toLowerCase()}" data-loc-code="${esc(loc)}" data-pkgs='${pkgsJson}' data-bogo='${bogoJson}'>
        <div class="card-head">
          <div>
            <div class="card-title">${esc(info.pretty)}</div>
            <div class="card-sub">${esc(loc)}</div>
          </div>
        </div>
        <div class="pkg-grid">${pkgList}</div>
        <form method="POST" class="card-form">
          <input type="hidden" name="loc" value="${esc(loc)}"/>
          <div class="actions">
            <button class="btn b-flip" name="action" value="flip">Quick Flip</button>
            <button class="btn b-full pkg-select" name="action" value="full">Full Price</button>
            <button class="btn b-same pkg-select" name="action" value="same">Same As Today</button>
            <button class="btn b-f5 pkg-select" name="action" value="flash5">$5 Flash</button>
            <button class="btn b-f2 pkg-select" name="action" value="flash2">$2 Flash</button>
            <button class="btn b-sp pkg-select" name="action" value="special">Special</button>
          </div>
          <button type="button" class="btn b-bogo bogo-select">Toggle BOGO</button>
        </form>
      </div>`;
    }).join("");
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<title>Pricing Admin \u2014 Splash Car Washes</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --sudsy-blue-soft: #d6f1fb;
    --splash-navy: #1c164e;
    --cream: #f5eedd;
    --yellow: #f1c61e;
    --racecar-red: #dc3e26;
    --ok: #067647;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #e3e6eb;
    --border-strong: #d0d4dc;
    --muted: #6b7280;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body); font-size: 14px;
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    background-attachment: fixed;
    min-height: 100vh;
  }
 
  /* ========== TOPBAR (matches Damage Claims sizing) ========== */
  header.topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 32px;
    flex-wrap: wrap;
    gap: 16px;
    color: #fff;
  }
  header.topbar .topbar-left {
    display: flex; align-items: center; gap: 18px;
    flex-wrap: wrap;
  }
  header.topbar .brand {
    display: flex; align-items: center; gap: 18px;
    text-decoration: none; color: inherit;
    transition: opacity 0.15s ease;
  }
  header.topbar .brand:hover { opacity: 0.85; }
  header.topbar .brand img { height: 56px; width: auto; object-fit: contain; flex-shrink: 0; }
  header.topbar .brand-text { display: flex; flex-direction: column; gap: 2px; }
  header.topbar .brand-text .eyebrow {
    font-size: 0.75rem; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  header.topbar .brand-text .title {
    font-size: 1.375rem; font-weight: 700;
    color: #fff; margin: 0; line-height: 1.2;
  }
  header.topbar .nav-back {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 18px;
    font: 700 0.875rem var(--font-body);
    color: #fff; background: transparent;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: var(--radius-sm);
    text-decoration: none; cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  header.topbar .nav-back:hover {
    background: rgba(255,255,255,0.1);
    border-color: var(--white);
  }
  header.topbar .nav-back svg { width: 14px; height: 14px; flex-shrink: 0; }

  header.topbar .who {
    display: flex; align-items: center; gap: 16px;
    flex-wrap: wrap;
  }
  header.topbar .who .email {
    color: rgba(255,255,255,0.85);
    font-size: 0.875rem;
  }
  header.topbar .who a {
    padding: 8px 18px;
    font: 700 0.875rem var(--font-body);
    color: #fff; background: transparent;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  header.topbar .who a:hover {
    background: rgba(255,255,255,0.1);
    border-color: var(--white);
  }
 
  /* ========== MAIN ========== */
  main { max-width: 1320px; margin: 28px auto 48px; padding: 0 28px; }
 
  .toolbar {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 18px 24px;
    box-shadow: var(--shadow-card);
    margin-bottom: 18px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  .toolbar .label {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  .toolbar .search {
    flex: 1; max-width: 480px; min-width: 240px;
    height: 42px; padding: 8px 14px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: var(--white);
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .toolbar .search:focus {
    outline: none; border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  .toolbar .count {
    margin-left: auto;
    font-size: 13px; color: var(--muted);
  }
 
  .msg {
    margin: 0 0 18px;
    padding: 12px 16px;
    border-radius: var(--radius-sm);
    font-weight: 600; font-size: 14px;
  }
  .msg.ok { background: #ecfdf3; color: var(--ok); border: 1px solid #b7e9c8; }
  .msg.err { background: #fef2f2; color: var(--racecar-red); border: 1px solid #fecaca; }
  .msg b { font-weight: 700; }
 
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 18px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px 22px 18px;
    box-shadow: var(--shadow-card);
    display: flex; flex-direction: column;
  }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
  .card-title { font-size: 16px; font-weight: 700; color: var(--splash-navy); letter-spacing: -0.005em; }
  .card-sub {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-top: 2px;
  }
 
  .pkg-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;
    margin: 0 0 16px;
    padding: 12px 14px;
    background: #f8f9fb;
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .pkg-grid > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
  .pkg-name { font-weight: 600; color: var(--splash-navy); }
  .pkg-mode {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 999px;
    background: #e5e7eb; color: var(--muted);
    white-space: nowrap;
  }
  .mode-full   { background: #dbeafe; color: #1d4ed8; }
  .mode-same   { background: #d1fae5; color: #047857; }
  .mode-flash5 { background: #fef3c7; color: #92400e; }
  .mode-flash2 { background: #fee2e2; color: #991b1b; }
  .mode-special{ background: #fce7f3; color: #9f1239; }

  .pkg-tags { display: inline-flex; align-items: center; gap: 5px; }
  .pkg-bogo {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 999px;
    background: var(--yellow); color: var(--splash-navy);
    white-space: nowrap;
  }
 
  .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .btn {
    appearance: none; border: 1.5px solid transparent; cursor: pointer;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    font: 700 12px var(--font-body);
    letter-spacing: 0.02em;
    text-align: center;
    transition: filter 0.15s ease, transform 0.05s ease, box-shadow 0.15s ease;
  }
  .btn:hover { filter: brightness(1.1); box-shadow: 0 4px 10px rgba(28, 22, 78, 0.18); }
  .btn:active { transform: translateY(1px); }
  /* Quick Flip: primary "do the obvious thing" action, sits in row 1 alongside the others */
  .b-flip { background: var(--splash-navy); color: #fff; }
  /* Pricing actions, light \u2192 dark blue scale */
  .b-full { background: var(--sudsy-blue); color: var(--splash-navy); }
  .b-same { background: var(--splash-blue); color: #fff; }
  .b-f5   { background: var(--splash-blue-dark); color: #fff; }
  .b-f2   { background: var(--splash-navy); color: #fff; }
  /* Special is the odd one out (custom price) \u2014 outlined */
  .b-sp   { background: #fff; color: var(--splash-blue); border-color: var(--splash-blue); }
  .b-sp:hover { background: var(--sudsy-blue-soft); }
  /* BOGO toggle: full-width row beneath the 3x2 mode grid, yellow promo accent */
  .b-bogo {
    width: 100%;
    margin-top: 8px;
    background: var(--yellow);
    color: var(--splash-navy);
    border-color: var(--yellow);
  }
  .b-bogo:hover { filter: brightness(1.05); }

 
  /* ========== MODAL ========== */
  .overlay {
    position: fixed; inset: 0;
    background: rgba(28, 22, 78, 0.72);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center;
    z-index: 9999; padding: 20px;
  }
  .overlay.active { display: flex; }
  .modal {
    background: var(--white);
    border-radius: var(--radius-lg);
    width: 100%; max-width: 480px;
    max-height: 88vh; overflow: hidden;
    box-shadow: 0 20px 60px rgba(28, 22, 78, 0.5);
    display: flex; flex-direction: column;
    position: relative;
    isolation: isolate;
  }
  .modal-head {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 20px 24px;
    flex-shrink: 0;
  }
  .modal-head .eyebrow {
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .modal-head h3 {
    margin: 0; font-size: 18px; font-weight: 700; line-height: 1.2;
    color: #fff;
  }
  .modal-body {
    padding: 18px 24px;
    overflow-y: auto;
    flex: 1 1 auto;
    background: #fff;
  }
  .pkg-list {
    margin: 0 0 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  /* Override the global label style \u2014 modal labels are clickable rows, not form labels */
  .modal .pkg-list label {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px;
    margin: 0;
    background: #fff;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    font: 500 14px var(--font-body);
    color: var(--splash-navy);
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
    text-transform: none;
    letter-spacing: 0;
  }
  .modal .pkg-list label:hover {
    background: var(--sudsy-blue-soft);
    border-color: var(--sudsy-blue);
  }
  .modal .pkg-list input[type="checkbox"] {
    appearance: none;
    width: 18px; height: 18px;
    border: 1.5px solid var(--border-strong);
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    margin: 0;
    padding: 0;
    height: 18px; /* override global input height */
  }
  .modal .pkg-list input[type="checkbox"]:hover {
    border-color: var(--sudsy-blue);
  }
  .modal .pkg-list input[type="checkbox"]:checked {
    background: var(--splash-blue);
    border-color: var(--splash-blue);
  }
  .modal .pkg-list input[type="checkbox"]:checked::after {
    content: "";
    position: absolute; top: 2px; left: 5px;
    width: 5px; height: 10px;
    border: solid #fff;
    border-width: 0 2.5px 2.5px 0;
    transform: rotate(45deg);
  }
  .special-input { margin: 14px 0 4px; }
  .special-input label {
    display: block;
    font-size: 0.875rem; font-weight: 600;
    color: var(--splash-navy); margin-bottom: 6px;
    text-transform: none;
    letter-spacing: 0;
  }
  .special-input input {
    width: 100%; height: 42px; padding: 8px 14px;
    font: 14px var(--font-body); color: var(--splash-navy);
    background: #fff;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .special-input input:focus {
    outline: none; border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
  }
  .modal-actions {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 16px 24px 22px;
    background: #fff;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .modal-actions button {
    height: 42px; padding: 0 22px;
    font: 700 14px var(--font-body); letter-spacing: 0.02em;
    border: none; border-radius: var(--radius-sm); cursor: pointer;
    transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
  }
  .modal-cancel {
    background: transparent;
    color: var(--splash-navy);
    border: 1.5px solid var(--border-strong) !important;
  }
  .modal-cancel:hover { background: #f3f4f6; border-color: var(--splash-navy) !important; }
  .modal-confirm {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .modal-confirm:hover {
    background: var(--splash-blue-dark);
    box-shadow: 0 6px 16px rgba(43, 52, 145, 0.35);
  }
  .modal-confirm:active { transform: translateY(1px); }

</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <a class="brand" href="/" title="Return to dashboard">
        <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
        <div class="brand-text">
          <span class="eyebrow">Internal Tools</span>
          <span class="title">Pricing Admin</span>
        </div>
      </a>
      <a class="nav-back" href="/" title="Return to dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        Dashboard
      </a>
    </div>
    <div class="who">
      <span class="email">${esc(user.email)}</span>
      <a href="/admin/change-password">Change Password</a>
      <a href="/admin/logout">Sign Out</a>
    </div>
  </header>
 
  <main>
    ${message ? `<div class="msg ${/Invalid|fail/i.test(message) ? "err" : "ok"}">${message}</div>` : ""}
 
    <div class="toolbar">
      <span class="label">Locations</span>
      <input type="text" class="search" id="locationSearch" placeholder="Search locations..."/>
      <span class="count" id="locationCount"></span>
    </div>
 
    <div class="grid" id="locations">
      ${cards || `<div class="empty">No locations found.</div>`}
    </div>
  </main>
 
  <script>
  // Search filter
  (function(){
    const box = document.getElementById('locationSearch');
    const countEl = document.getElementById('locationCount');
    const cards = Array.from(document.querySelectorAll('#locations .card'));
 
    function updateCount() {
      const visible = cards.filter(c => c.style.display !== 'none').length;
      if (countEl) countEl.textContent = visible + ' of ' + cards.length;
    }
    updateCount();
 
    if (!box) return;
    box.addEventListener('input', function(){
      const q = (this.value||'').toLowerCase();
      cards.forEach(c => {
        const slug = (c.getAttribute('data-location')||'').toLowerCase();
        const code = (c.getAttribute('data-loc-code')||'').toLowerCase();
        const match = slug.includes(q) || code.includes(q);
        c.style.display = match ? '' : 'none';
      });
      updateCount();
    });
  })();
 
  // Package selector modal
  (function(){
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    document.body.appendChild(overlay);
 
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('active');
    });
 
    document.querySelectorAll('.pkg-select').forEach(btn => {
      btn.addEventListener('click', function(e){
        e.preventDefault();
 
        const card = e.target.closest('.card');
        const form = e.target.closest('form');
        const action = e.target.value;
        const pkgs = JSON.parse(card.getAttribute('data-pkgs') || '[]');
 
        if (!pkgs.length) { alert('No packages found'); return; }
 
        const isSpecial = action === 'special';
        const labelMap = {
          full:    { eyebrow: 'Apply Pricing', title: 'Full Price' },
          same:    { eyebrow: 'Apply Pricing', title: 'Same As Today' },
          flash5:  { eyebrow: 'Apply Pricing', title: '$5 Flash' },
          flash2:  { eyebrow: 'Apply Pricing', title: '$2 Flash' },
          special: { eyebrow: 'Set Special',   title: 'Custom Price' }
        };
        const labels = labelMap[action] || { eyebrow: 'Select', title: 'Packages' };
 
        const pkgCheckboxes = pkgs.map(p =>
          '<label><input type="checkbox" class="pkg-check" value="' + p + '"> ' + p + '</label>'
        ).join('');
 
        const specialInput = isSpecial
          ? '<div class="special-input"><label for="specialPriceInput">Special Price ($)</label><input type="number" id="specialPriceInput" min="0" step="0.01" placeholder="0.00" required></div>'
          : '';
 
        overlay.innerHTML =
          '<div class="modal">' +
            '<div class="modal-head">' +
              '<div class="eyebrow">' + labels.eyebrow + '</div>' +
              '<h3>' + labels.title + '</h3>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="pkg-list">' + pkgCheckboxes + '</div>' +
              specialInput +
            '</div>' +
            '<div class="modal-actions">' +
              '<button type="button" class="modal-cancel">Cancel</button>' +
              '<button type="button" class="modal-confirm">Apply</button>' +
            '</div>' +
          '</div>';
 
        overlay.classList.add('active');
 
        overlay.querySelector('.modal-cancel').onclick = () => overlay.classList.remove('active');
 
        overlay.querySelector('.modal-confirm').onclick = () => {
          const selected = Array.from(overlay.querySelectorAll('.pkg-check:checked')).map(c => c.value);
 
          if (selected.length === 0) {
            alert('Please select at least one package');
            return;
          }
 
          if (isSpecial) {
            const priceInput = overlay.querySelector('#specialPriceInput');
            const price = parseFloat(priceInput.value);
            if (isNaN(price) || price <= 0) {
              alert('Please enter a valid special price');
              return;
            }
            const priceField = document.createElement('input');
            priceField.type = 'hidden';
            priceField.name = 'special_price';
            priceField.value = price.toFixed(2);
            form.appendChild(priceField);
          }
 
          const actionField = document.createElement('input');
          actionField.type = 'hidden';
          actionField.name = 'action';
          actionField.value = action;
          form.appendChild(actionField);
 
          selected.forEach(pkg => {
            const field = document.createElement('input');
            field.type = 'hidden';
            field.name = 'pkg_list[]';
            field.value = pkg;
            form.appendChild(field);
          });
 
          form.submit();
        };
      });
    });

    // BOGO toggle modal -- independent of the mode-button (pkg-select) group.
    // - Reads current per-package BOGO state from data-bogo, pre-checks rows.
    // - Zero checked is valid (means "turn BOGO off for every package here").
    // - Submits the full intent: hidden action=bogo + pkg_list[] for each checked.
    document.querySelectorAll('.bogo-select').forEach(btn => {
      btn.addEventListener('click', function(e){
        e.preventDefault();

        const card = e.target.closest('.card');
        const form = e.target.closest('form');
        let bogoState = [];
        try { bogoState = JSON.parse(card.getAttribute('data-bogo') || '[]'); }
        catch (_) { bogoState = []; }

        if (!bogoState.length) { alert('No packages found'); return; }

        const pkgCheckboxes = bogoState.map(p =>
          '<label><input type="checkbox" class="bogo-check" value="' + p.pkg + '"' +
          (p.on ? ' checked' : '') + '> ' + p.pkg + '</label>'
        ).join('');

        overlay.innerHTML =
          '<div class="modal">' +
            '<div class="modal-head">' +
              '<div class="eyebrow">Toggle Promo</div>' +
              '<h3>Buy One Get One</h3>' +
            '</div>' +
            '<div class="modal-body">' +
              '<div class="pkg-list">' + pkgCheckboxes + '</div>' +
            '</div>' +
            '<div class="modal-actions">' +
              '<button type="button" class="modal-cancel">Cancel</button>' +
              '<button type="button" class="modal-confirm">Apply</button>' +
            '</div>' +
          '</div>';

        overlay.classList.add('active');

        overlay.querySelector('.modal-cancel').onclick = () => overlay.classList.remove('active');

        overlay.querySelector('.modal-confirm').onclick = () => {
          // Zero checked is valid -- it means "turn BOGO off for every package".
          const selected = Array.from(overlay.querySelectorAll('.bogo-check:checked')).map(c => c.value);

          const actionField = document.createElement('input');
          actionField.type = 'hidden';
          actionField.name = 'action';
          actionField.value = 'bogo';
          form.appendChild(actionField);

          selected.forEach(pkg => {
            const field = document.createElement('input');
            field.type = 'hidden';
            field.name = 'pkg_list[]';
            field.value = pkg;
            form.appendChild(field);
          });

          form.submit();
        };
      });
    });
  })();
  <\/script>
</body>
</html>`;
  }
  __name(renderUserLocations, "renderUserLocations");
  function renderPicker(loc, rows, prefix, useSimplifiedPicker = false) {
    const escHtml = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]), "escHtml");
    const cards = rows.map((r) => {
      const first = Number(r.today).toFixed(2);
      const monthly = Number(r.ongoing).toFixed(2);
      return `
      <div class="card" data-pkg="${escHtml(r.pkg)}">
        <div class="title">${escHtml(r.pretty_pkg)}</div>
        <div class="price">First month: <span class="price-amount">$${first}</span></div>
        <div class="ongoing">Then $${monthly}/month</div>
      </div>`;
    }).join("");
    if (useSimplifiedPicker) {
      return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<title>${escHtml(cap(loc))} \u2013 Choose Package</title>
<style>
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html {
    overflow: hidden;
    height: 100%;
    width: 100%;
    position: fixed;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
    height: 100%;
    width: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    position: fixed;
  }

  .scroll-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 20px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }

  /* Bubble animations */
  .bubble {
    position: absolute;
    bottom: -100px;
    background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
    border-radius: 50%;
    opacity: 0.6;
    animation: rise linear infinite;
    box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5),
                0 0 20px rgba(255, 255, 255, 0.3);
    pointer-events: none;
    z-index: 1;
  }

  .bubble::before {
    content: '';
    position: absolute;
    top: 10%;
    left: 10%;
    width: 40%;
    height: 40%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
    border-radius: 50%;
  }

  @keyframes rise {
    0% {
      bottom: -100px;
      transform: translateX(0) scale(1);
    }
    50% {
      transform: translateX(100px) scale(1.1);
    }
    100% {
      bottom: 110vh;
      transform: translateX(-100px) scale(0.8);
    }
  }

  .bubble:nth-child(1) { left: 10%; width: 60px; height: 60px; animation-duration: 8s; animation-delay: 0s; }
  .bubble:nth-child(2) { left: 20%; width: 40px; height: 40px; animation-duration: 6s; animation-delay: 1s; }
  .bubble:nth-child(3) { left: 35%; width: 80px; height: 80px; animation-duration: 10s; animation-delay: 2s; }
  .bubble:nth-child(4) { left: 50%; width: 50px; height: 50px; animation-duration: 7s; animation-delay: 0.5s; }
  .bubble:nth-child(5) { left: 65%; width: 70px; height: 70px; animation-duration: 9s; animation-delay: 1.5s; }
  .bubble:nth-child(6) { left: 80%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
  .bubble:nth-child(7) { left: 15%; width: 55px; height: 55px; animation-duration: 8.5s; animation-delay: 2.5s; }
  .bubble:nth-child(8) { left: 75%; width: 35px; height: 35px; animation-duration: 7.5s; animation-delay: 1.2s; }
  .bubble:nth-child(9) { left: 40%; width: 65px; height: 65px; animation-duration: 9.5s; animation-delay: 0.3s; }
  .bubble:nth-child(10) { left: 90%; width: 50px; height: 50px; animation-duration: 8s; animation-delay: 2s; }

  .container {
    max-width: 700px;
    width: 100%;
    background: white;
    border-radius: 16px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    position: relative;
    z-index: 10;
  }

  .header {
    background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
    padding: 30px 20px;
    text-align: center;
  }

  .logo {
    max-width: 200px;
    height: auto;
    margin-bottom: 10px;
  }

  .location-title {
    color: white;
    font-size: 28px;
    font-weight: bold;
    margin-top: 15px;
  }

  .content {
    padding: 30px 20px;
  }

  .subtitle {
    text-align: center;
    color: #64748b;
    font-size: 16px;
    margin-bottom: 25px;
  }

  .grid {
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr 1fr;
  }

  .card {
    background: #fff;
    border: 2px solid #e2e8f0;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
    position: relative;
  }

  .card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 24px rgba(59, 130, 246, 0.2);
    border-color: #3b82f6;
  }

  .card:active {
    transform: translateY(-2px);
  }

  .title {
    font-weight: 700;
    font-size: 20px;
    margin-bottom: 12px;
    color: #1e3a8a;
  }

  .price {
    font-size: 16px;
    color: #475569;
    margin-bottom: 6px;
  }

  .price-amount {
    font-size: 24px;
    font-weight: bold;
    color: #1e3a8a;
    display: block;
    margin-top: 4px;
  }

  .ongoing {
    font-size: 14px;
    color: #64748b;
    margin-top: 8px;
  }

  .hint {
    text-align: center;
    color: #64748b;
    font-size: 14px;
    margin-top: 25px;
    padding: 15px;
    background: #f8fafc;
    border-radius: 8px;
  }

  @media (max-width: 600px) {
    .grid {
      grid-template-columns: 1fr;
    }
    
    .location-title {
      font-size: 24px;
    }

    .title {
      font-size: 18px;
    }
  }
</style>
</head>
<body>
  <!-- Animated bubbles -->
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>

  <div class="scroll-wrapper">
    <div class="container">
    <div class="header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full (1) 1.png" alt="Splash Car Wash" class="logo">
      <div class="location-title">${escHtml(cap(loc))}</div>
    </div>

    <div class="content">
      <div class="subtitle">Select your MaxPass package</div>
      
      <div class="grid">
        ${cards || `<div style="grid-column: 1 / -1; text-align: center; color: #64748b;">No packages configured for ${escHtml(loc)}.</div>`}
      </div>

      <div class="hint">
        \u{1F4A7} Tap a package to continue with your signup
      </div>
    </div>
  </div>

  <script>
    (function(){
      var loc = ${JSON.stringify(loc)};
      var prefix = ${JSON.stringify(prefix || "/signup")};

      document.querySelectorAll('.card').forEach(function(btn){
        btn.addEventListener('click', function(){
          var pkg = btn.getAttribute('data-pkg') || '';
          var href = prefix + '/' + encodeURIComponent(loc) + '/' + encodeURIComponent(pkg);
          window.location.href = href;
        });
      });
    })();
  <\/script>
  </div>
</body>
</html>`;
    }
    return `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(cap(loc))} \u2013 choose package</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;padding:16px;background:#fafafa}
  h1{font-size:20px;margin:12px 0 16px}
  form{display:block;max-width:700px;margin:0 auto}
  .inputs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px}
  .inputs input{padding:12px 10px;font-size:16px;border-radius:10px;border:1px solid #e2e2e2;outline:none}
  .inputs input:invalid{border-color:#d33}
  .grid{display:grid;gap:12px;grid-template-columns:1fr 1fr}
  .card{display:block;background:#fff;border-radius:12px;padding:16px;text-align:left;border:1px solid #e8e8e8;box-shadow:0 1px 3px rgba(0,0,0,.08);cursor:pointer;opacity:.6;pointer-events:none}
  .card.enabled{opacity:1;pointer-events:auto}
  .title{font-weight:600;margin-bottom:6px}
  .price,.ongoing{font-size:14px;opacity:.85}
  .hint{font-size:12px;opacity:.7;margin-top:8px}
  @media (max-width:680px){.inputs{grid-template-columns:1fr 1fr}}
  @media (max-width:460px){.inputs{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}
  .error{color:#b00020;font-size:13px;margin:6px 0 0}
</style>
</head>
<body>
  <form id="pkgForm" novalidate>
    <h1>Select package \u2013 ${escHtml(cap(loc))}</h1>

    <div class="inputs">
      <div>
        <input id="last4" name="last4" inputmode="numeric" pattern="\\d{4}" maxlength="4" required placeholder="Last 4 of card"/>
        <div id="e-last4" class="error" style="display:none">Enter 4 digits.</div>
      </div>
      <div>
        <input id="plate" name="plate" maxlength="24" required placeholder="Plate / Barcode"/>
        <div id="e-plate" class="error" style="display:none">This field is required.</div>
      </div>
      <div>
        <input id="phone" name="phone" inputmode="tel" maxlength="20" required placeholder="Phone"/>
        <div id="e-phone" class="error" style="display:none">Enter at least 10 digits.</div>
      </div>
    </div>

    <div class="grid">
      ${cards || `<div>No packages configured for ${escHtml(loc)}.</div>`}
    </div>

    <div class="hint">Enter all fields, then tap a package.</div>
  </form>

  <script>
    (function(){
      var last4 = document.getElementById('last4');
      var plate = document.getElementById('plate');
      var phone = document.getElementById('phone');
      var eLast = document.getElementById('e-last4');
      var ePlate= document.getElementById('e-plate');
      var ePhone= document.getElementById('e-phone');
      var loc = ${JSON.stringify(loc)};
      var prefix = ${JSON.stringify(prefix || "/signup")};

      function valid(){
        var ok4 = /^\\d{4}$/.test((last4.value||'').trim());
        var okP = (plate.value||'').trim().length > 0;
        var digits = (phone.value||'').replace(/\\D+/g,'');
        var okPh = digits.length >= 10;
        eLast.style.display  = ok4 ? 'none'  : 'block';
        ePlate.style.display = okP ? 'none'  : 'block';
        ePhone.style.display = okPh ? 'none' : 'block';
        var ok = ok4 && okP && okPh;
        document.querySelectorAll('.card').forEach(function(btn){
          if (ok) btn.classList.add('enabled'); else btn.classList.remove('enabled');
        });
        return ok;
      }
      ['input','blur'].forEach(function(ev){
        last4.addEventListener(ev, valid);
        plate.addEventListener(ev, valid);
        phone.addEventListener(ev, valid);
      });
      valid();

      document.querySelectorAll('.card').forEach(function(btn){
        btn.addEventListener('click', function(){
          if (!valid()) return;
          var params = new URLSearchParams();
          params.set('last4', (last4.value||'').trim());
          params.set('plate', (plate.value||'').trim());
          params.set('phone', (phone.value||'').trim());
          var pkg = btn.getAttribute('data-pkg') || '';
          var href = prefix + '/' + encodeURIComponent(loc) + '/' + encodeURIComponent(pkg) + '?' + params.toString();
          window.location.href = href;
        });
      });
    })();
  <\/script>
</body>
</html>`;
  }
  __name(renderPicker, "renderPicker");
  function renderSignupForm(loc, pkg, row) {
    const escHtml = /* @__PURE__ */ __name((s) => String(s ?? "").replace(/[&<>"']/g, (m2) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m2]), "escHtml");
    const todayPrice = Number(row.today).toFixed(2);
    const monthlyPrice = Number(row.ongoing).toFixed(2);
    const tz = "America/New_York";
    const localNow = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: tz }));
    const y = localNow.getFullYear(), m = localNow.getMonth(), d = localNow.getDate();
    const start = new Date(y, m, d);
    const next = addMonthsClamp(start, 1);
    const startStr = mmddyyyy(start);
    const nextStr = mmddyyyy(next);
    const isFamilyPlan = ["family_express", "family_ultra_bath", "family_bubble_bath"].includes(row.pkg?.toLowerCase());
    // BOGO is a schedule modifier that stacks on any pricing mode:
    //   month1 (today) = whatever `today` resolved to (full, $5 flash, etc.)
    //   month2 (today + 1mo) = FREE
    //   month3 (today + 2mo) = recurring billing at `ongoing` begins
    const isBogo = row.bogo === true;
    const month3 = isBogo ? addMonthsClamp(start, 2) : null;
    const month3Str = month3 ? mmddyyyy(month3) : "";
    const month3Iso = month3 ? yyyymmdd(month3) : "";
    const priceTextToday = `$${todayPrice} plus tax`;
    const priceTextMonthly = isFamilyPlan ? `$${monthlyPrice} + $0.01 per additional vehicle, plus tax` : `$${monthlyPrice} plus tax`;
    let termsText = isFamilyPlan ? `This recurring program will charge ${priceTextToday} today (${startStr}) and $${monthlyPrice} + $0.01 per additional vehicle (limit 4 total vehicles) plus tax beginning on ${nextStr} and every anniversary date of each month thereafter until paused or cancelled by the customer or Splash. Members use vehicle license plate and/or receive a barcode to identify their vehicle. Each vehicle enrolled in the Family Plan must have its own license plate and/or barcode on file. Unless otherwise specified this program cannot be combined with other offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber & Lyft vehicles. * I understand I will be charged monthly the agreed amount of the plan I selected plus any applicable tax every month until the agreement is terminated by either Splash or myself. Cancellations may be made at any time during the month to discontinue the membership, which will be effective the next month. However, notice of cancellation must be made at least five (5) days prior to the end of my billing date to avoid the next months charge to my credit card. Splash Car Wash will continue to charge me each month until I cancel. I may cancel either in person, via www.splashcarwashes.com and clicking "Manage My Membership", or by phone (203-324-8451). Upon cancellation, all vehicles enrolled under this Family Plan will be deactivated effective the next billing cycle. If I do use my membership, NO REFUNDS WILL BE MADE. Terms and conditions are subject to change, and I will be notified either on site, via email, or by text 30 days prior. I will make sure my email address and/or phone number are on file with Splash is up to date and accurate. *Livery, Taxis, Uber & Lyft vehicles shall be on commercial plans set up through our fleet program. If found not using authorized fleet program, Splash reserves the right to: 1) Terminate the unlimited membership and deactivate all vehicles enrolled under the Family Plan. 2) Retroactively charge the difference of retail washes and unlimited program effective date of initial misuse. 3) Suspend or deny any vehicle who has violated these terms. *Promotional Pricing \u2013 I understand my credit card will be charged the one time promotional price at sign up. After 30 Days, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time. *Presale Offer \u2013 I understand my credit card will be charged $0.01 at sign up. After 2 months, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time.` : `This recurring program will charge ${priceTextToday} today (${startStr}) and ${priceTextMonthly} beginning on ${nextStr} and every anniversary date of each month thereafter until paused or cancelled by the customer or Splash. Members use vehicle license plate and/or receive a barcode to identify their vehicle. Unless otherwise specified this program cannot be combined with other offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber & Lyft vehicles. * I understand I will be charged monthly the agreed amount of the plan I selected plus any applicable tax every month until the agreement is terminated by either Splash or myself. Cancellations may be made at any time during the month to discontinue the membership, which will be effective the next month. However, notice of cancellation must be made at least five (5) days prior to the end of my billing date to avoid the next months charge to my credit card. Splash Car Wash will continue to charge me each month until I cancel. I may cancel either in person, via www.splashcarwashes.com and clicking "Manage My Membership", or by phone (203-324-8451). If I do use my membership, NO REFUNDS WILL BE MADE. Terms and conditions are subject to change, and I will be notified either on site, via email, or by text 30 days prior. I will make sure my email address and/or phone number are on file with Splash is up to date and accurate. *Livery, Taxis, Uber & Lyft vehicles shall be on commercial plans set up through our fleet program. If found not using authorized fleet program, Splash reserves the right to: 1) Terminate the unlimited membership. 2) Retroactively charge the difference of retail washes and unlimited program effective date of initial misuse. 3) Suspend or deny any vehicle who has violated these terms. *Promotional Pricing \u2013 I understand my credit card will be charged the one time promotional price at sign up. After 30 Days, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time. *Presale Offer \u2013 I understand my credit card will be charged $0.01 at sign up. After 2 months, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time.`;
    if (isBogo) {
      // BOGO overrides the standard recurring sentence with a 3-step schedule
      // (charged today / second month free / recurring from month-3). Works
      // stacked on any pricing mode because priceTextToday templates the
      // resolved `today` price (full, $5 flash, special, etc.).
      termsText = isFamilyPlan ? `This recurring program will charge ${priceTextToday} today (${startStr}), your second month (${nextStr}) is FREE, and then $${monthlyPrice} + $0.01 per additional vehicle (limit 4 total vehicles) plus tax beginning on ${month3Str} and every anniversary date of each month thereafter until paused or cancelled by the customer or Splash. Members use vehicle license plate and/or receive a barcode to identify their vehicle. Each vehicle enrolled in the Family Plan must have its own license plate and/or barcode on file. Unless otherwise specified this program cannot be combined with other offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber & Lyft vehicles. * I understand I will be charged monthly the agreed amount of the plan I selected plus any applicable tax every month until the agreement is terminated by either Splash or myself. Cancellations may be made at any time during the month to discontinue the membership, which will be effective the next month. However, notice of cancellation must be made at least five (5) days prior to the end of my billing date to avoid the next months charge to my credit card. Splash Car Wash will continue to charge me each month until I cancel. I may cancel either in person, via www.splashcarwashes.com and clicking "Manage My Membership", or by phone (203-324-8451). Upon cancellation, all vehicles enrolled under this Family Plan will be deactivated effective the next billing cycle. If I do use my membership, NO REFUNDS WILL BE MADE. Terms and conditions are subject to change, and I will be notified either on site, via email, or by text 30 days prior. I will make sure my email address and/or phone number are on file with Splash is up to date and accurate. *Livery, Taxis, Uber & Lyft vehicles shall be on commercial plans set up through our fleet program. If found not using authorized fleet program, Splash reserves the right to: 1) Terminate the unlimited membership and deactivate all vehicles enrolled under the Family Plan. 2) Retroactively charge the difference of retail washes and unlimited program effective date of initial misuse. 3) Suspend or deny any vehicle who has violated these terms. *Promotional Pricing – I understand my credit card will be charged the one time promotional price at sign up. After 30 Days, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time. *Presale Offer – I understand my credit card will be charged $0.01 at sign up. After 2 months, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time.` : `This recurring program will charge ${priceTextToday} today (${startStr}), your second month (${nextStr}) is FREE, and then ${priceTextMonthly} beginning on ${month3Str} and every anniversary date of each month thereafter until paused or cancelled by the customer or Splash. Members use vehicle license plate and/or receive a barcode to identify their vehicle. Unless otherwise specified this program cannot be combined with other offers or discounts. Retail unlimited programs exclude Limos, Taxis, Uber & Lyft vehicles. * I understand I will be charged monthly the agreed amount of the plan I selected plus any applicable tax every month until the agreement is terminated by either Splash or myself. Cancellations may be made at any time during the month to discontinue the membership, which will be effective the next month. However, notice of cancellation must be made at least five (5) days prior to the end of my billing date to avoid the next months charge to my credit card. Splash Car Wash will continue to charge me each month until I cancel. I may cancel either in person, via www.splashcarwashes.com and clicking "Manage My Membership", or by phone (203-324-8451). If I do use my membership, NO REFUNDS WILL BE MADE. Terms and conditions are subject to change, and I will be notified either on site, via email, or by text 30 days prior. I will make sure my email address and/or phone number are on file with Splash is up to date and accurate. *Livery, Taxis, Uber & Lyft vehicles shall be on commercial plans set up through our fleet program. If found not using authorized fleet program, Splash reserves the right to: 1) Terminate the unlimited membership. 2) Retroactively charge the difference of retail washes and unlimited program effective date of initial misuse. 3) Suspend or deny any vehicle who has violated these terms. *Promotional Pricing – I understand my credit card will be charged the one time promotional price at sign up. After 30 Days, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time. *Presale Offer – I understand my credit card will be charged $0.01 at sign up. After 2 months, I acknowledge Splash Car Wash will continue to charge the card on file each month, at full price, until I cancel. I am aware that I can cancel my Unlimited Car Wash Membership at any time.`;
    }
    const bogoCallout = isBogo ? `
            <div class="bogo-callout">
                <div class="bogo-banner">BOGO -- Buy One, Get One Free</div>
                <ol class="bogo-steps">
                    <li><strong>Today (${startStr}):</strong> ${priceTextToday}</li>
                    <li><strong>${nextStr}:</strong> Second month <strong>FREE</strong></li>
                    <li><strong>${month3Str}:</strong> Recurring billing begins at ${priceTextMonthly}</li>
                </ol>
            </div>` : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
    <title>Splash Car Wash - Sign Up</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html {
            overflow: hidden;
            height: 100%;
            width: 100%;
            position: fixed;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
            height: 100%;
            width: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            position: fixed;
        }

        .scroll-wrapper {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow-y: auto;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: flex-start;
        }

        /* Bubble animations */
        .bubble {
            position: absolute;
            bottom: -100px;
            background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
            border-radius: 50%;
            opacity: 0.6;
            animation: rise linear infinite;
            box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5),
                        0 0 20px rgba(255, 255, 255, 0.3);
            pointer-events: none;
            z-index: 1;
        }

        .bubble::before {
            content: '';
            position: absolute;
            top: 10%;
            left: 10%;
            width: 40%;
            height: 40%;
            background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
            border-radius: 50%;
        }

        @keyframes rise {
            0% {
                bottom: -100px;
                transform: translateX(0) scale(1);
            }
            50% {
                transform: translateX(100px) scale(1.1);
            }
            100% {
                bottom: 110vh;
                transform: translateX(-100px) scale(0.8);
            }
        }

        .bubble:nth-child(1) { left: 10%; width: 60px; height: 60px; animation-duration: 8s; animation-delay: 0s; }
        .bubble:nth-child(2) { left: 20%; width: 40px; height: 40px; animation-duration: 6s; animation-delay: 1s; }
        .bubble:nth-child(3) { left: 35%; width: 80px; height: 80px; animation-duration: 10s; animation-delay: 2s; }
        .bubble:nth-child(4) { left: 50%; width: 50px; height: 50px; animation-duration: 7s; animation-delay: 0.5s; }
        .bubble:nth-child(5) { left: 65%; width: 70px; height: 70px; animation-duration: 9s; animation-delay: 1.5s; }
        .bubble:nth-child(6) { left: 80%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
        .bubble:nth-child(7) { left: 15%; width: 55px; height: 55px; animation-duration: 8.5s; animation-delay: 2.5s; }
        .bubble:nth-child(8) { left: 75%; width: 35px; height: 35px; animation-duration: 7.5s; animation-delay: 1.2s; }
        .bubble:nth-child(9) { left: 40%; width: 65px; height: 65px; animation-duration: 9.5s; animation-delay: 0.3s; }
        .bubble:nth-child(10) { left: 90%; width: 50px; height: 50px; animation-duration: 8s; animation-delay: 2s; }

        .container {
            max-width: 600px;
            width: 100%;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
            position: relative;
            z-index: 10;
        }

        .header {
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            padding: 30px 20px;
            text-align: center;
        }

        .logo {
            max-width: 200px;
            height: auto;
            margin-bottom: 10px;
        }

        .logo-placeholder {
            background: white;
            padding: 20px 40px;
            border-radius: 8px;
            display: inline-block;
            font-size: 24px;
            font-weight: bold;
            color: #1e3a8a;
            margin-bottom: 10px;
        }

        .package-info {
            background: rgba(255, 255, 255, 0.95);
            padding: 25px;
            margin: 0 20px 20px 20px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .package-name {
            font-size: 28px;
            font-weight: bold;
            color: #1e3a8a;
            margin-bottom: 15px;
            text-align: center;
        }

        .pricing {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-top: 15px;
        }

        .price-item {
            background: #f8fafc;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            border: 2px solid #e2e8f0;
        }

        .price-label {
            font-size: 12px;
            text-transform: uppercase;
            color: #64748b;
            font-weight: 600;
            margin-bottom: 5px;
        }

        .price-amount {
            font-size: 24px;
            font-weight: bold;
            color: #1e3a8a;
        }

        .price-note {
            font-size: 11px;
            color: #64748b;
            margin-top: 3px;
        }

        /* BOGO callout -- visible 3-step schedule between pricing and form */
        .bogo-callout {
            background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
            border: 2px solid #f1c61e;
            border-radius: 12px;
            padding: 18px 22px;
            margin: 0 20px 20px 20px;
            box-shadow: 0 4px 12px rgba(241, 198, 30, 0.25);
        }
        .bogo-banner {
            font-size: 16px;
            font-weight: 800;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: #1c164e;
            text-align: center;
            margin-bottom: 10px;
        }
        .bogo-steps {
            margin: 0;
            padding-left: 22px;
            color: #1c164e;
            font-size: 14px;
            line-height: 1.55;
        }
        .bogo-steps li { margin-bottom: 4px; }
        .bogo-steps strong { font-weight: 700; }

        .form-content {
            padding: 30px 20px;
        }

        .form-group {
            margin-bottom: 25px;
        }

        label {
            display: block;
            font-weight: 600;
            color: #334155;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .required {
            color: #dc2626;
        }

        input[type="tel"],
        input[type="email"] {
            width: 100%;
            padding: 14px 16px;
            font-size: 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            transition: all 0.3s ease;
            font-family: inherit;
        }

        input[type="tel"]:focus,
        input[type="email"]:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        input[type="tel"].error,
        input[type="email"].error {
            border-color: #dc2626;
        }

        .error-message {
            color: #dc2626;
            font-size: 13px;
            margin-top: 6px;
            display: none;
        }

        .error-message.show {
            display: block;
        }

        .terms-container {
            background: #f8fafc;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px;
            max-height: 200px;
            overflow-y: auto;
            margin-bottom: 15px;
        }

        .terms-text {
            font-size: 13px;
            line-height: 1.6;
            color: #475569;
        }

        .checkbox-group {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 15px;
            background: #fef3c7;
            border: 2px solid #fbbf24;
            border-radius: 8px;
        }

        input[type="checkbox"] {
            width: 20px;
            height: 20px;
            margin-top: 2px;
            cursor: pointer;
            flex-shrink: 0;
        }

        .checkbox-label {
            font-size: 14px;
            color: #334155;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
        }

        .submit-btn {
            width: 100%;
            padding: 16px;
            font-size: 18px;
            font-weight: bold;
            color: white;
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-top: 25px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .submit-btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(59, 130, 246, 0.3);
        }

        .submit-btn:disabled {
            background: #cbd5e1;
            cursor: not-allowed;
            opacity: 0.6;
        }

        @media (max-width: 480px) {
            .pricing {
                grid-template-columns: 1fr;
            }

            .package-name {
                font-size: 24px;
            }

            .price-amount {
                font-size: 20px;
            }
        }
    </style>
</head>
<body>
    <!-- Animated bubbles -->
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>
    <div class="bubble"></div>

    <div class="scroll-wrapper">
        <div class="container">
        <div class="header">
            <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full (1) 1.png" alt="Splash Car Wash" class="logo">
        </div>

        <div class="package-info">
            <div class="package-name">${escHtml(row.pretty_pkg)}</div>
            <div class="pricing">
                <div class="price-item">
                    <div class="price-label">Today's Price</div>
                    <div class="price-amount">$${todayPrice}</div>
                    <div class="price-note">${isFamilyPlan ? "+ $0.01/additional vehicle, plus tax" : "plus tax"}</div>
                </div>
                <div class="price-item">
                    <div class="price-label">Monthly Price</div>
                    <div class="price-amount">$${monthlyPrice}</div>
                    <div class="price-note">${isFamilyPlan ? "+ $0.01/additional vehicle, plus tax" : "plus tax"}</div>
                </div>
            </div>
        </div>
        ${bogoCallout}

        <form class="form-content" id="signupForm">
            <input type="hidden" name="location" value="${escHtml(loc)}">
            <input type="hidden" name="package" value="${escHtml(pkg)}">
            <input type="hidden" name="location_pretty" value="${escHtml(row.location_pretty)}">
            <input type="hidden" name="package_pretty" value="${escHtml(row.pretty_pkg)}">
            <input type="hidden" name="today_price" value="${todayPrice}">
            <input type="hidden" name="monthly_price" value="${monthlyPrice}">
            <input type="hidden" name="is_bogo" value="${isBogo ? "true" : "false"}">
            <input type="hidden" name="recurring_start_date" value="${month3Iso}">
            
            <div class="form-group">
                <label for="phone">
                    Phone Number <span class="required">*</span>
                </label>
                <input
                    type="tel"
                    id="phone"
                    name="phone"
                    placeholder="(555)555-5555"
                    maxlength="13"
                    required
                    autocomplete="off"
                >
                <div class="error-message" id="phoneError">
                    Please enter a valid 10-digit phone number
                </div>
            </div>

            <div class="form-group">
                <label for="email">
                    Email Address <span class="required">*</span>
                </label>
                <input
                    type="email"
                    id="email"
                    name="email"
                    placeholder="you@example.com"
                    required
                    autocomplete="off"
                >
                <div class="error-message" id="emailError">
                    Please enter a valid email address
                </div>
            </div>

            <div class="form-group">
                <label>Terms & Conditions</label>
                <div class="terms-container">
                    <div class="terms-text">${escHtml(termsText)}</div>
                </div>
                <input type="hidden" name="terms" value="${escHtml(termsText)}">
                <div class="checkbox-group">
                    <input 
                        type="checkbox" 
                        id="agreeTerms" 
                        name="agreeTerms" 
                        value="true"
                        required
                    >
                    <label for="agreeTerms" class="checkbox-label">
                        I agree to the Terms & Conditions <span class="required">*</span>
                    </label>
                </div>
            </div>

            <button type="submit" class="submit-btn" id="submitBtn" disabled>
                Complete Sign Up
            </button>
        </form>
    </div>

    <script>
        const phoneInput = document.getElementById('phone');
        const phoneError = document.getElementById('phoneError');
        const emailInput = document.getElementById('email');
        const emailError = document.getElementById('emailError');
        const agreeCheckbox = document.getElementById('agreeTerms');
        const submitBtn = document.getElementById('submitBtn');
        const form = document.getElementById('signupForm');

        // Phone formatting
        phoneInput.addEventListener('input', function(e) {
            let value = e.target.value.replace(/\\D/g, '');
            if (value.length > 10) value = value.slice(0, 10);

            let formatted = '';
            if (value.length > 0) formatted = '(' + value.substring(0, 3);
            if (value.length >= 4) formatted += ')' + value.substring(3, 6);
            if (value.length >= 7) formatted += '-' + value.substring(6, 10);

            e.target.value = formatted;
            validatePhone();
            checkFormValidity();
        });

        phoneInput.addEventListener('blur', validatePhone);

        function validatePhone() {
            const digits = phoneInput.value.replace(/\\D/g, '');
            const isValid = digits.length === 10;

            if (phoneInput.value && !isValid) {
                phoneInput.classList.add('error');
                phoneError.classList.add('show');
                return false;
            } else {
                phoneInput.classList.remove('error');
                phoneError.classList.remove('show');
                return isValid;
            }
        }

        emailInput.addEventListener('input', checkFormValidity);
        emailInput.addEventListener('blur', validateEmail);

        function validateEmail() {
            const val = emailInput.value.trim();
            const isValid = val.length > 0 && val.length <= 254 && /^(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9_+-]|\\.(?!\\.))*[A-Za-z0-9])@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$/.test(val);

            if (val && !isValid) {
                emailInput.classList.add('error');
                emailError.classList.add('show');
                return false;
            } else {
                emailInput.classList.remove('error');
                emailError.classList.remove('show');
                return isValid;
            }
        }

        agreeCheckbox.addEventListener('change', checkFormValidity);

        function checkFormValidity() {
            const phoneDigits = phoneInput.value.replace(/\\D/g, '');
            const phoneValid = phoneDigits.length === 10;
            const emailVal = emailInput.value.trim();
            const emailValid = emailVal.length > 0 && emailVal.length <= 254 && /^(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9_+-]|\\.(?!\\.))*[A-Za-z0-9])@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$/.test(emailVal);
            const termsAgreed = agreeCheckbox.checked;
            submitBtn.disabled = !(phoneValid && emailValid && termsAgreed);
        }

        // Form submission
        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            if (!validatePhone() || !validateEmail() || !agreeCheckbox.checked) return;

            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';

            const formData = new FormData(form);
            const data = {
                location: formData.get('location'),
                package: formData.get('package'),
                location_pretty: formData.get('location_pretty'),
                package_pretty: formData.get('package_pretty'),
                today_price: formData.get('today_price'),
                monthly_price: formData.get('monthly_price'),
                is_bogo: formData.get('is_bogo') === 'true',
                recurring_start_date: formData.get('recurring_start_date') || null,
                phone: phoneInput.value.replace(/\\D/g, ''),
                phone_formatted: phoneInput.value,
                email: emailInput.value.trim(),
                terms: formData.get('terms'),
                terms_agreed: agreeCheckbox.checked,
                timestamp: new Date().toISOString()
            };

            try {
                const response = await fetch('/api/submit-signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.json();

                // DEBUG: Log the response to browser console
                if (result.debug) {
                    console.log('=== FRAUD DETECTION DEBUG LOGS ===');
                    result.debug.forEach(log => console.log(log));
                    console.log('=== END DEBUG LOGS ===');
                }

                // DENIED - Show deny modal
                if (result.denied) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Complete Sign Up';
                    submitBtn.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)';
                    showDenyModal(result.error);
                    return;
                }

                // WARNING - Show warning modal (usage 3-9)
                if (result.warning) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Complete Sign Up';
                    submitBtn.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)';
                    showWarningModal(result.message, data);
                    return;
                }

                // MONITOR - Show monitor modal (usage 10+)
                if (result.monitor) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Complete Sign Up';
                    submitBtn.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)';
                    showMonitorModal(result.message, data);
                    return;
                }

                // SUCCESS
                if (response.ok && result.success) {
                    showSuccessModal();
                } else {
                    // Other error
                    const errorMsg = result.error || 'Submission failed. Please try again.';

                    if (errorMsg.toLowerCase().includes('phone') || errorMsg.toLowerCase().includes('number')) {
                        phoneInput.classList.add('error');
                        phoneError.textContent = errorMsg;
                        phoneError.classList.add('show');
                        phoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        phoneInput.focus();
                    } else {
                        submitBtn.textContent = 'Error - See Above';
                        phoneError.textContent = errorMsg;
                        phoneError.classList.add('show');
                    }

                    submitBtn.style.background = 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
                    submitBtn.disabled = false;

                    setTimeout(() => {
                        submitBtn.textContent = 'Complete Sign Up';
                        submitBtn.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)';
                    }, 5000);
                }
            } catch (error) {
                console.error('Form submission error:', error);

                phoneError.textContent = 'Network error. Please check your connection and try again.';
                phoneError.classList.add('show');

                submitBtn.textContent = 'Network Error - Retry';
                submitBtn.style.background = 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
                submitBtn.disabled = false;

                setTimeout(() => {
                    submitBtn.textContent = 'Complete Sign Up';
                    submitBtn.style.background = 'linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)';
                }, 5000);
            }
        });

        // DENY MODAL (Red - Error)
        function showDenyModal(errorMessage) {
            const overlay = createModalOverlay();
            const modal = document.createElement('div');
            modal.style.cssText = modalBaseStyle;

            modal.innerHTML =
                '<div style="font-size: 80px; margin-bottom: 20px; color: #dc2626;">\u2715</div>' +
                '<h2 style="color: #dc2626; font-size: 32px; margin-bottom: 15px; font-weight: bold;">Invalid Phone Number</h2>' +
                '<p style="color: #64748b; font-size: 16px; margin-bottom: 35px; line-height: 1.5;">' + errorMessage + '</p>' +
                '<button id="denyOkBtn" style="' + buttonStyle('linear-gradient(135deg, #dc2626 0%, #ef4444 100%)') + '">Enter Valid Number</button>';

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            document.getElementById('denyOkBtn').addEventListener('click', function() {
                document.body.removeChild(overlay);
                phoneInput.value = '';
                phoneInput.focus();
            });
        }

        // WARNING MODAL (Yellow - Warning)
        function showWarningModal(message, formData) {
            const overlay = createModalOverlay();
            const modal = document.createElement('div');
            modal.style.cssText = modalBaseStyle;

            modal.innerHTML =
                '<div style="font-size: 80px; margin-bottom: 20px; color: #f59e0b;">\u26A0</div>' +
                '<h2 style="color: #f59e0b; font-size: 32px; margin-bottom: 15px; font-weight: bold;">Phone Number Warning</h2>' +
                '<p style="color: #64748b; font-size: 16px; margin-bottom: 35px; line-height: 1.5;">' + message + '</p>' +
                '<div style="display: grid; gap: 12px;">' +
                    '<button id="confirmPhoneBtn" style="' + buttonStyle('linear-gradient(135deg, #059669 0%, #10b981 100%)') + '">This is My Phone Number</button>' +
                    '<button id="changePhoneBtn" style="' + buttonStyle('linear-gradient(135deg, #6b7280 0%, #9ca3af 100%)') + '">Enter New Number</button>' +
                '</div>';

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // User confirms it's their number - proceed with submission
            document.getElementById('confirmPhoneBtn').addEventListener('click', async function() {
                document.body.removeChild(overlay);
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting...';

                // Add user_confirmed flag and re-submit
                formData.user_confirmed = true;

                const response = await fetch('/api/submit-signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formData)
                });

                const result = await response.json();

                if (result.debug) {
                    console.log('=== FRAUD DETECTION DEBUG LOGS (Confirmed) ===');
                    result.debug.forEach(log => console.log(log));
                    console.log('=== END DEBUG LOGS ===');
                }

                if (response.ok && result.success) {
                    showSuccessModal();
                } else {
                    submitBtn.textContent = 'Submission Failed';
                    submitBtn.style.background = 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
                    submitBtn.disabled = false;
                }
            });

            // User wants to change number
            document.getElementById('changePhoneBtn').addEventListener('click', function() {
                document.body.removeChild(overlay);
                phoneInput.value = '';
                phoneInput.focus();
            });
        }

        // MONITOR MODAL (Orange - Severe Warning)
        function showMonitorModal(message, formData) {
            const overlay = createModalOverlay();
            const modal = document.createElement('div');
            modal.style.cssText = modalBaseStyle;

            modal.innerHTML =
                '<div style="font-size: 80px; margin-bottom: 20px; color: #ea580c;">\u{1F6A8}</div>' +
                '<h2 style="color: #ea580c; font-size: 32px; margin-bottom: 15px; font-weight: bold;">Number Flagged</h2>' +
                '<p style="color: #64748b; font-size: 16px; margin-bottom: 35px; line-height: 1.5;">' + message + '</p>' +
                '<div style="display: grid; gap: 12px;">' +
                    '<button id="monitorConfirmBtn" style="' + buttonStyle('linear-gradient(135deg, #059669 0%, #10b981 100%)') + '">This is My Phone Number</button>' +
                    '<button id="monitorChangeBtn" style="' + buttonStyle('linear-gradient(135deg, #ea580c 0%, #f97316 100%)') + '">Enter Different Number</button>' +
                '</div>';

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // User confirms - allow submission with monitor_acknowledged flag
            document.getElementById('monitorConfirmBtn').addEventListener('click', async function() {
                document.body.removeChild(overlay);
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting...';

                // Add monitor_acknowledged flag and re-submit
                formData.monitor_acknowledged = true;

                const response = await fetch('/api/submit-signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(formData)
                });

                const result = await response.json();

                if (result.debug) {
                    console.log('=== FRAUD DETECTION DEBUG LOGS (Monitor Acknowledged) ===');
                    result.debug.forEach(log => console.log(log));
                    console.log('=== END DEBUG LOGS ===');
                }

                if (response.ok && result.success) {
                    showSuccessModal();
                } else {
                    submitBtn.textContent = 'Submission Failed';
                    submitBtn.style.background = 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)';
                    submitBtn.disabled = false;
                }
            });

            // User wants to change number
            document.getElementById('monitorChangeBtn').addEventListener('click', function() {
                document.body.removeChild(overlay);
                phoneInput.value = '';
                phoneInput.focus();
            });
        }

        // SUCCESS MODAL (Green - Success)
        function showSuccessModal() {
            const overlay = createModalOverlay();
            const modal = document.createElement('div');
            modal.style.cssText = modalBaseStyle;

            modal.innerHTML =
                '<div style="font-size: 80px; margin-bottom: 20px; color: #059669;">\u2713</div>' +
                '<h2 style="color: #059669; font-size: 36px; margin-bottom: 15px; font-weight: bold;">MaxPass Success!</h2>' +
                '<p style="color: #64748b; font-size: 18px; margin-bottom: 35px;">Signup completed successfully</p>' +
                '<button id="fillAgainBtn" style="' + buttonStyle('linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)') + '">Fill Form Again?</button>';

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            document.getElementById('fillAgainBtn').addEventListener('click', function() {
                window.location.href = '/signup/${escHtml(loc)}';
            });

            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) {
                    window.location.href = '/signup/${escHtml(loc)}';
                }
            });
        }

        // HELPER: Create modal overlay
        function createModalOverlay() {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; animation: fadeIn 0.2s ease;';
            return overlay;
        }

        // HELPER: Modal base style
        const modalBaseStyle = 'background: white; border-radius: 20px; padding: 50px 40px; text-align: center; max-width: 500px; width: 90%; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4); animation: slideUp 0.3s ease;';

        // HELPER: Button style generator
        function buttonStyle(gradient) {
            return 'width: 100%; padding: 18px; font-size: 18px; font-weight: bold; color: white; background: ' + gradient + '; border: none; border-radius: 12px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; transition: transform 0.2s ease, box-shadow 0.2s ease;';
        }

        // Add animations
        const animStyle = document.createElement('style');
        animStyle.textContent =
            '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }' +
            '@keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }' +
            'button:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3); }' +
            'button:active { transform: translateY(0); }';
        document.head.appendChild(animStyle);
    <\/script>
    </div>
</body>
</html>`;
  }
  __name(renderSignupForm, "renderSignupForm");
  async function fetchAllLocationPkgs(locations) {
    const codes = locations.map((l) => l.location_code);
    if (codes.length === 0) return [];
    const u = new URL(SUPABASE_URL);
    u.pathname = `/rest/v1/${TABLE_CONFIG}`;
    const orClause = codes.map((c) => `location_code.eq.${c}`).join(",");
    u.search = new URLSearchParams({
      select: "location_code,location_pretty,pkg,pricing,bogo",
      or: `(${orClause})`,
      order: "location_pretty.asc,pkg.asc"
    }).toString();
    const r = await fetch(u.toString(), {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    if (!r.ok) {
      console.error("fetchAllLocationPkgs failed:", r.status, await r.text().catch(() => ""));
      return [];
    }
    return r.json();
  }
  __name(fetchAllLocationPkgs, "fetchAllLocationPkgs");
  async function listDistinctLocations() {
    const u = new URL(SUPABASE_URL);
    u.pathname = `/rest/v1/${TABLE_CONFIG}`;
    u.search = new URLSearchParams({
      select: "location_code,location_pretty,pricing",
      order: "location_pretty.asc"
    }).toString();
    const r = await fetch(u.toString(), {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!r.ok) return [];
    const rows = await r.json();
    const seen = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const code = (row.location_code || "").toLowerCase();
      if (code && !seen.has(code)) {
        seen.set(code, {
          location_code: code,
          location_pretty: row.location_pretty || code,
          pricing: row.pricing || ""
        });
      }
    }
    return Array.from(seen.values());
  }
  __name(listDistinctLocations, "listDistinctLocations");
  async function getCurrentMode(location_code) {
    const u = new URL(SUPABASE_URL);
    u.pathname = `/rest/v1/${TABLE_CONFIG}`;
    u.search = new URLSearchParams({
      select: "pricing",
      location_code: `eq.${location_code}`,
      limit: "1"
    }).toString();
    const r = await fetch(u.toString(), {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!r.ok) return null;
    const arr = await r.json();
    return arr[0]?.pricing || null;
  }
  __name(getCurrentMode, "getCurrentMode");
  async function setMode(location, mode, pkgList = null, specialPrice = null) {
    const u = new URL(SUPABASE_URL);
    u.pathname = `/rest/v1/${TABLE_CONFIG}`;
    if (pkgList && pkgList.length > 0) {
      const orPkgs = pkgList.map((p) => `pkg.eq.${encodeURIComponent(p)}`).join(",");
      u.search = `location_code=eq.${encodeURIComponent(location)}&or=(${orPkgs})`;
    } else {
      u.search = `location_code=eq.${encodeURIComponent(location)}`;
    }
    const body = { pricing: mode, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
    if (mode === "special" && specialPrice) {
      body.special = parseFloat(specialPrice);
    }
    const r = await fetch(u.toString(), {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Supabase update failed:", r.status, txt);
      return false;
    }
    try {
      await caches.default.delete(new Request("https://internal-cache/pricing_simple_resolved"));
    } catch (e) {
      console.warn("Cache invalidation failed:", e);
    }
    return true;
  }
  __name(setMode, "setMode");
  async function setBogo(location, onPkgs = []) {
    // BOGO is a boolean schedule modifier -- orthogonal to `pricing`. This
    // writer NEVER touches the pricing column. Modal submits the full intent
    // (checked vs unchecked across every package at the location), so we apply
    // it as two PATCHes: clear all -> then set the chosen subset. End state
    // matches the checkboxes exactly.
    const safeOn = Array.isArray(onPkgs) ? onPkgs.filter((p) => typeof p === "string" && p.length > 0) : [];
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    // Pass 1: clear bogo across every package at this location.
    const clearUrl = new URL(SUPABASE_URL);
    clearUrl.pathname = `/rest/v1/${TABLE_CONFIG}`;
    clearUrl.search = `location_code=eq.${encodeURIComponent(location)}`;
    const clearRes = await fetch(clearUrl.toString(), {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ bogo: false, updated_at: nowIso })
    });
    if (!clearRes.ok) {
      const txt = await clearRes.text().catch(() => "");
      console.error("setBogo clear failed:", clearRes.status, txt);
      return false;
    }
    // Pass 2: set bogo=true on the chosen subset (skip when nothing checked).
    if (safeOn.length > 0) {
      const setUrl = new URL(SUPABASE_URL);
      setUrl.pathname = `/rest/v1/${TABLE_CONFIG}`;
      const orPkgs = safeOn.map((p) => `pkg.eq.${encodeURIComponent(p)}`).join(",");
      setUrl.search = `location_code=eq.${encodeURIComponent(location)}&or=(${orPkgs})`;
      const setRes = await fetch(setUrl.toString(), {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ bogo: true, updated_at: nowIso })
      });
      if (!setRes.ok) {
        const txt = await setRes.text().catch(() => "");
        console.error("setBogo set failed:", setRes.status, txt);
        return false;
      }
    }
    // Cache invalidation -- same key as setMode (signup form re-reads bogo from
    // pricing_simple_resolved, so stale view bytes would mis-render the schedule).
    try {
      await caches.default.delete(new Request("https://internal-cache/pricing_simple_resolved"));
    } catch (e) {
      console.warn("Cache invalidation failed:", e);
    }
    return true;
  }
  __name(setBogo, "setBogo");
  async function fetchOne(loc, pkg, ctx) {
    const allData = await getCachedPricingView(ctx);
    return allData.find(
      (r) => (r.location_code || "").toLowerCase() === loc.toLowerCase() && (r.pkg || "").toLowerCase() === pkg.toLowerCase()
    ) || null;
  }
  __name(fetchOne, "fetchOne");
  async function listPackages(loc, ctx) {
    const allData = await getCachedPricingView(ctx);
    return allData.filter(
      (r) => (r.location_code || "").toLowerCase() === loc.toLowerCase()
    );
  }
  __name(listPackages, "listPackages");
  async function getCachedPricingView(ctx) {
    const cache = caches.default;
    const cacheKey = new Request("https://internal-cache/pricing_simple_resolved");
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cacheAge = Date.now() - new Date(cached.headers.get("date")).getTime();
      if (cacheAge < CACHE_TTL * 1e3) {
        return await cached.json();
      }
      if (cacheAge < STALE_TTL * 1e3) {
        ctx.waitUntil(refreshPricingCache(cache, cacheKey));
        return await cached.json();
      }
    }
    return await fetchAndCachePricing(cache, cacheKey, cached);
  }
  __name(getCachedPricingView, "getCachedPricingView");
  async function fetchAndCachePricing(cache, cacheKey, fallback) {
    try {
      const u = new URL(SUPABASE_URL);
      u.pathname = `/rest/v1/${TABLE_RESOLVED}`;
      u.search = new URLSearchParams({
        select: "location_pretty,location_code,pkg,pretty_pkg,today,ongoing,sort,bogo"
      }).toString();
      const r = await fetch(u.toString(), {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
      });
      if (!r.ok) throw new Error(`Supabase error: ${r.status}`);
      const data = await r.json();
      const cacheResponse = new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "date": (/* @__PURE__ */ new Date()).toUTCString()
        }
      });
      await cache.put(cacheKey, cacheResponse);
      return data;
    } catch (error) {
      console.error("Supabase fetch failed:", error);
      if (fallback) return await fallback.json();
      return [];
    }
  }
  __name(fetchAndCachePricing, "fetchAndCachePricing");
  async function refreshPricingCache(cache, cacheKey) {
    try {
      await fetchAndCachePricing(cache, cacheKey, null);
    } catch (error) {
      console.error("Background refresh failed:", error);
    }
  }
  __name(refreshPricingCache, "refreshPricingCache");
  function mmddyyyy(dt) {
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    const y = dt.getFullYear();
    return `${m}-${d}-${y}`;
  }
  __name(mmddyyyy, "mmddyyyy");
  // ISO YYYY-MM-DD built from local y/m/d -- used for the recurring_start_date
  // column. The Date objects in renderSignupForm represent ET wall-clock; using
  // .toISOString() would convert to UTC and could shift a day across midnight
  // for late-evening ET submissions. Building from local components keeps the
  // stored ISO date identical to the mmddyyyy date the customer sees in terms.
  function yyyymmdd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  __name(yyyymmdd, "yyyymmdd");
  function addMonthsClamp(date, months) {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }
  __name(addMonthsClamp, "addMonthsClamp");
  function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }
  __name(cap, "cap");
  async function readForm(request) {
    const ctype = request.headers.get("content-type") || "";
    if (ctype.includes("application/x-www-form-urlencoded")) return new URLSearchParams(await request.text());
    if (ctype.includes("multipart/form-data")) return await request.formData();
    if (ctype.includes("application/json")) {
      const obj = await request.json().catch(() => ({}));
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(obj || {})) sp.set(k, String(v));
      return sp;
    }
    return new URLSearchParams(new URL(request.url).search);
  }
  __name(readForm, "readForm");
  function pageWrap(inner) {
    return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<title>Admin</title>
</head><body><div class="wrap">${inner}</div></body></html>`;
  }
  __name(pageWrap, "pageWrap");
  function indexMsg(msg, kind = "ok") {
    return `<div class="msg ${kind}">${msg}</div>`;
  }
  __name(indexMsg, "indexMsg");
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
  }
  __name(esc, "esc");
  function html(status, body) {
    const doc = body.startsWith("<!doctype") ? body : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Admin</title></head><body>${body}</body></html>`;
    return new Response(doc, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  __name(html, "html");
})();
//# sourceMappingURL=index.js.map
