// Supabase client + typed query helpers for the Splash MaxPass system.
//
// Will wrap:
//   - pricing_simple / pricing_simple_resolved queries (signup, sysadmin)
//   - maxpass_signups inserts (signup)
//   - user_permissions reads (auth, all workers)
//   - suspicious_phones / phone_usage_log fraud queries (signup)
//   - claims metadata that mirrors D1 (damage)
//
// To be ported in Step 5 from the existing worker files.

export {};
