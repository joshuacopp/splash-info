// POST /api/submit-signup — fraud detection + maxpass_signups insert.
//
// =============================================================================
// MODAL RESPONSE CONTRACTS (consumed by render/form.ts submit handler)
// =============================================================================
//
//   DENY:    400 { denied: true,  error: string, count?: number }
//   WARN:    200 { warning: true, message: string, count: number, phone: string }
//   MONITOR: 200 { monitor: true, message: string, count: number, phone: string }
//   SUCCESS: 200 { success: true, confirmation_token: string }


import {
  countSignupsByPhone,
  createOrUpdateSuspicious,
  createServiceClient,
  getSuspiciousPhone,
  insertSignup,
  logPhoneUsage,
  updateUsageCount
} from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import type { MaxpassSignupInsert, SuspiciousPhoneTier } from "@splash/types/signups";
import type { Env } from "../env.js";

/** Submission body from the form's submit JS — see render/form.ts. */
interface SubmitBody {
  location: string;
  location_pretty: string;
  package: string;
  package_pretty: string;
  today_price: string | number;
  monthly_price: string | number;
  phone: string;
  phone_formatted: string;
  email?: string | null;
  terms?: string;
  terms_agreed?: boolean;
  timestamp?: string;
  /** Set by the form's WarnModal "This is My Phone Number" handler. */
  user_confirmed?: boolean;
  /** Set by the form's MonitorModal "This is My Phone Number" handler. */
  monitor_acknowledged?: boolean;
}



const DENIED_PHONE_PATTERNS: ReadonlySet<string> = new Set([
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
]);

const INVALID_AREA_CODES: ReadonlySet<string> = new Set([
  "011",
  "111",
  "211",
  "311",
  "411",
  "511",
  "611",
  "711",
  "811",
  "911"
]);

function isHardcodedDeny(phoneDigits: string): boolean {
  if (DENIED_PHONE_PATTERNS.has(phoneDigits)) return true;
  if (phoneDigits.length >= 3 && INVALID_AREA_CODES.has(phoneDigits.substring(0, 3))) {
    return true;
  }
  return false;
}


function tierForExistingUses(existingUses: number): SuspiciousPhoneTier | null {
  if (existingUses >= 9) return "Monitor";
  if (existingUses >= 2) return "Warn";
  return null;
}


interface RequestContext {
  ipAddress: string;
  userAgent: string;
  country: string;
  city: string;
  region: string;
}

function captureRequestContext(request: Request): RequestContext {
  // request.cf is typed by @cloudflare/workers-types as
  // IncomingRequestCfProperties — country / city / region are strings or
  // undefined. Default each to "Unknown" matching legacy behavior so
  // SharePoint sees a non-null value.
  const cf = (request.cf ?? {}) as { country?: string; city?: string; region?: string };
  return {
    ipAddress: request.headers.get("CF-Connecting-IP") ?? "Unknown",
    userAgent: request.headers.get("User-Agent") ?? "Unknown",
    country: cf.country ?? "Unknown",
    city: cf.city ?? "Unknown",
    region: cf.region ?? "Unknown"
  };
}


export async function handleSignupSubmission(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  let body: SubmitBody;
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const phone = (body.phone ?? "").trim();
  if (!phone) return jsonError(400, "phone required");

  const ctx = captureRequestContext(request);
  const sb = createServiceClient(env);

 
  if (isHardcodedDeny(phone)) {

    await logPhoneUsage(sb, {
      phone,
      phone_formatted: body.phone_formatted ?? phone,
      usage_count_at_time: 1,
      location_code: body.location ?? null,
      location_pretty: body.location_pretty ?? null,
      tier: null,
      action_taken: "blocked",
      user_response: "blocked",
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent
    });
    return json(
      {
        denied: true,
        error: "This number is invalid. Please enter a valid phone number."
      },
      400
    );
  }

  const suspicious = await getSuspiciousPhone(sb, phone);
  if (suspicious?.tier === "Deny") {
    await logPhoneUsage(sb, {
      phone,
      phone_formatted: body.phone_formatted ?? phone,
      usage_count_at_time: (suspicious.usage_count ?? 0) + 1,
      location_code: body.location ?? null,
      location_pretty: body.location_pretty ?? null,
      tier: "Deny",
      action_taken: "blocked",
      user_response: "blocked",
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent
    });
    return json(
      {
        denied: true,
        error:
          "This number is either invalid or has been manually denied due to repeated usage. Enter a valid phone number.",
        count: suspicious.usage_count
      },
      400
    );
  }

  const existingUses = await countSignupsByPhone(sb, phone);
  const tierToCheck = tierForExistingUses(existingUses);

  if (existingUses === 2 && !body.user_confirmed) {
    await createOrUpdateSuspicious(sb, { phone, tier: "Warn", count: 3 });
    return json(
      {
        warning: true,
        message: `Warning - Phone number ${body.phone_formatted ?? phone} has been submitted ${existingUses} times before. Please verify this is a valid phone number.`,
        count: existingUses + 1,
        phone: body.phone_formatted ?? phone
      },
      200
    );
  }

  if (existingUses === 9 && !body.user_confirmed) {
    await createOrUpdateSuspicious(sb, { phone, tier: "Monitor", count: 10 });
    await logPhoneUsage(sb, {
      phone,
      phone_formatted: body.phone_formatted ?? phone,
      usage_count_at_time: 10,
      location_code: body.location ?? null,
      location_pretty: body.location_pretty ?? null,
      tier: "Monitor",
      action_taken: "flagged",
      user_response: null,
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent
    });
    return json(
      {
        monitor: true,
        message:
          "This phone number has been flagged due to repeated use in this form. Please re-enter your number carefully.",
        count: 10,
        phone: body.phone_formatted ?? phone
      },
      200
    );
  }

  if (tierToCheck === "Warn" && !body.user_confirmed) {
    await logPhoneUsage(sb, {
      phone,
      phone_formatted: body.phone_formatted ?? phone,
      usage_count_at_time: existingUses + 1,
      location_code: body.location ?? null,
      location_pretty: body.location_pretty ?? null,
      tier: "Warn",
      action_taken: "warned",
      user_response: null,
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent
    });
    return json(
      {
        warning: true,
        message: `Warning - Phone number ${body.phone_formatted ?? phone} has been submitted ${existingUses} times before. Please verify this is a valid phone number.`,
        count: existingUses + 1,
        phone: body.phone_formatted ?? phone
      },
      200
    );
  }

  if (tierToCheck === "Monitor" && !body.monitor_acknowledged) {
    await logPhoneUsage(sb, {
      phone,
      phone_formatted: body.phone_formatted ?? phone,
      usage_count_at_time: existingUses + 1,
      location_code: body.location ?? null,
      location_pretty: body.location_pretty ?? null,
      tier: "Monitor",
      action_taken: "flagged",
      user_response: null,
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent
    });
    return json(
      {
        monitor: true,
        message:
          "This phone number has been flagged due to repeated use in this form. Please re-enter your number carefully.",
        count: existingUses + 1,
        phone: body.phone_formatted ?? phone
      },
      200
    );
  }




  if (tierToCheck) {
    await updateUsageCount(sb, phone, existingUses + 1);
  }

  const confirmationToken = crypto.randomUUID();


  const insertRow: MaxpassSignupInsert = {
    confirmation_token: confirmationToken,
    location_code: body.location,
    location_pretty: body.location_pretty,
    package_code: body.package,
    package_pretty: body.package_pretty,
    today_price: typeof body.today_price === "number" ? body.today_price : Number.parseFloat(String(body.today_price)),
    monthly_price: typeof body.monthly_price === "number" ? body.monthly_price : Number.parseFloat(String(body.monthly_price)),
    phone,
    phone_formatted: body.phone_formatted ?? phone,
    terms_text: body.terms ?? "",
    terms_agreed: !!body.terms_agreed,
    submitted_at: body.timestamp ?? new Date().toISOString(),
    ip_address: ctx.ipAddress,
    user_agent: ctx.userAgent,
    country: ctx.country,
    city: ctx.city,
    region: ctx.region,
    email: body.email ?? null
  };

  try {
    await insertSignup(sb, insertRow);
  } catch (err) {
    console.error("maxpass_signups insert failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "submission failed");
  }

  const userResponseLog = body.monitor_acknowledged
    ? ("monitor_confirmed" as const)
    : body.user_confirmed
      ? ("warn_confirmed" as const)
      : ("submitted" as const);

  const tierForLog =
    body.user_confirmed || body.monitor_acknowledged ? tierToCheck : null;

  await logPhoneUsage(sb, {
    phone,
    phone_formatted: body.phone_formatted ?? phone,
    usage_count_at_time: existingUses + 1,
    location_code: body.location ?? null,
    location_pretty: body.location_pretty ?? null,
    tier: tierForLog,
    action_taken: "allowed",
    user_response: userResponseLog,
    ip_address: ctx.ipAddress,
    user_agent: ctx.userAgent
  });

  return json(
    {
      success: true,
      confirmation_token: confirmationToken
    },
    200
  );
}
