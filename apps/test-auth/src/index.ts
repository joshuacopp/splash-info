import { createServiceClient, getAuthContext } from "@splash/db-supabase";

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? ""
};

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars first.");
  process.exit(1);
}

const sb = createServiceClient(env);

const lookup = await sb
  .from("auth_unified")
  .select("user_id")
  .eq("email", "josh.copp@splashcarwashes.com")
  .maybeSingle();

if (lookup.error) {
  console.error("Lookup failed:", lookup.error);
  process.exit(1);
}
if (!lookup.data) {
  console.error("No auth_unified row for josh.copp@splashcarwashes.com");
  process.exit(1);
}

const userId = lookup.data.user_id as string;
console.log("Found user_id:", userId);

const session = await getAuthContext(sb, userId);
console.log("\ngetAuthContext result:");
console.log(JSON.stringify(session, null, 2));