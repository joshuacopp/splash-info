// Promotions domain types (Brief 153).
//
// `promo_role` is a new permission domain parallel to `dc_role` (damage
// claims). One row per user in `promo_user_roles`; surfaced on the
// `auth_unified` view alongside `role` + `dc_role`. Workers gate
// promo endpoints via this role going forward.
//
// Role meanings (mirrors supabase/promo-tables.sql):
//   super_admin — bypass all gates; edit any field on any promo;
//                 see internal_note across the org.
//   it          — edit ticket fields (ready_by, roadblocks,
//                 internal_note, assignment); appear in the assignee
//                 dropdown; see internal_note column on the IT queue.
//   marketing   — create promos, edit materials + PTP, send
//                 announcements; does NOT see internal_note.
//   ops         — read-only on live view + dashboard.

export type PromoRole = "super_admin" | "it" | "marketing" | "ops";
