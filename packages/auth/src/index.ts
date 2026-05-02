// Auth + permission helpers for the Splash MaxPass system.
//
// Will wrap:
//   - Supabase Auth session validation (sb-access-token, sb-refresh-token cookies)
//   - user_permissions role lookups (super_admin, location_admin, rm, am, site)
//   - Location access scoping (resolve which location_codes a user can see
//     based on rm_email / am_email / site_email matches)
//   - Password reset via Supabase Admin API
//   - Session cookie helpers
//
// To be ported in Step 5 from sysadmin.js and damagemanager.js auth blocks.

export {};
