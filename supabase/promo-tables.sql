-- Promotions workflow schema — foundation tables for the Promotion
-- Creation feature (replaces today's ad-hoc email/phone process).
--
-- Operator runs this in the Supabase SQL editor before any worker /
-- apps/web brief that touches `promotions`, `promo_*` tables, or the
-- `auth_unified` view extension at the bottom of this file.
--
-- All nine tables are new; the only modification to an existing object
-- is the (operator-side) `auth_unified` view extension to surface
-- `promo_role` — that DDL is at the bottom and must be reconciled
-- against the live view via `pg_get_viewdef('auth_unified'::regclass,
-- true)` before running.
--
-- Conventions follow forms-tables.sql (Brief 89):
--   - `uuid NOT NULL` for actor columns; no FK to auth.users (Supabase
--     Auth owns that schema; FKs across schema boundaries are brittle).
--   - `text` + `CHECK (col IN (...))` for status / role / enum-shaped
--     fields. Postgres ENUM types are avoided so we can add values
--     without ALTER TYPE.
--   - `timestamptz NOT NULL DEFAULT now()` for created_at.
--   - Audit columns (`{field}_updated_at`, `{field}_updated_by`) on
--     mutable fields where the operator needs to know "who last touched
--     X and when" without scanning the activity log.
--   - Indexes co-located with their table.

-- 1. promotions — the main entity. One row per promo. Created via the
--    /promotions/new form (apps/web); read by the live view, dashboard,
--    and IT ticket queue.
CREATE TABLE IF NOT EXISTS promotions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    text NOT NULL,
  promo_type               text NOT NULL CHECK (promo_type IN ('Same', 'BOGO', 'Add-ons', 'Discount', 'Other')),
  pos_behavior             text,                                                 -- nullable: UI-side gate enforces required vs. optional based on promo_type
  proposed_start_date      date NOT NULL,
  proposed_end_date        date NOT NULL,
  requested_go_live_date   date NOT NULL,
  priority                 text NOT NULL CHECK (priority IN ('High', 'Medium', 'Low')),
  status                   text NOT NULL DEFAULT 'Submitted'
                             CHECK (status IN ('Submitted', 'Scoped', 'Building', 'Tested', 'Live', 'Ended')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL,                                        -- auth.users.id
  updated_at               timestamptz NOT NULL DEFAULT now(),
  status_updated_at        timestamptz,
  status_updated_by        uuid                                                  -- auth.users.id
);
CREATE INDEX IF NOT EXISTS idx_promotions_status              ON promotions (status);
CREATE INDEX IF NOT EXISTS idx_promotions_priority            ON promotions (priority);
CREATE INDEX IF NOT EXISTS idx_promotions_go_live             ON promotions (requested_go_live_date);
CREATE INDEX IF NOT EXISTS idx_promotions_created_by          ON promotions (created_by);
CREATE INDEX IF NOT EXISTS idx_promotions_created_at          ON promotions (created_at DESC);

-- 2. promo_locations — many-to-many between promos and locations,
--    + per-location completion tracking (replaces the JSONB blob the
--    mockup used). `location_code` matches pricing_simple.location_code
--    convention; no FK because pricing_simple's PK is composite
--    (location_code, pkg) and won't accept a single-column reference.
CREATE TABLE IF NOT EXISTS promo_locations (
  promo_id        uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  location_code   text NOT NULL,                                                 -- matches pricing_simple.location_code; no FK (composite PK upstream)
  is_complete     boolean NOT NULL DEFAULT false,
  completed_at    timestamptz,
  completed_by    uuid,                                                          -- auth.users.id
  PRIMARY KEY (promo_id, location_code)
);
CREATE INDEX IF NOT EXISTS idx_promo_locations_location_code  ON promo_locations (location_code);
CREATE INDEX IF NOT EXISTS idx_promo_locations_incomplete     ON promo_locations (promo_id) WHERE is_complete = false;

-- 3. promo_tickets — 1:1 with promotions. Split from `promotions`
--    because the audience differs (IT-only fields like internal_note
--    must not be readable from the live-view query path) and so the
--    audit lifecycle for ticket fields (ready_by, assignment) can be
--    captured separately from the promo's own status churn.
--
--    NOTE: assignment is multi-user via promo_ticket_assignees (table
--    #4 below). No assigned_to_user_id column on this row.
CREATE TABLE IF NOT EXISTS promo_tickets (
  promo_id                 uuid PRIMARY KEY REFERENCES promotions(id) ON DELETE CASCADE,
  ready_by_date            date,
  roadblocks               text,                                                 -- visible on live view (ops/marketing/IT)
  internal_note            text,                                                 -- IT-only; gated server-side by promo_user_roles.promo_role
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  ready_by_updated_at      timestamptz,
  ready_by_updated_by      uuid                                                  -- auth.users.id
);
CREATE INDEX IF NOT EXISTS idx_promo_tickets_ready_by         ON promo_tickets (ready_by_date);

-- 4. promo_ticket_assignees — multi-assign join table. Mirrors
--    damage_claim_user_locations pattern: composite PK + ON DELETE
--    CASCADE both directions, with light audit on who added the
--    assignment.
CREATE TABLE IF NOT EXISTS promo_ticket_assignees (
  promo_id     uuid NOT NULL REFERENCES promo_tickets(promo_id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,                                                    -- auth.users.id (no FK to auth schema)
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by  uuid,                                                             -- auth.users.id; NULL when assignment was self-claimed
  PRIMARY KEY (promo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_ticket_assignees_user    ON promo_ticket_assignees (user_id);

-- 5. promo_materials — digital assets attached to a promo. R2-only at
--    v1 (Brief 89 form_submission_files pattern). R2 path convention:
--    promo-materials/{promo_id}/{material_id}.{ext}
CREATE TABLE IF NOT EXISTS promo_materials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id        uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('image', 'video', 'copy_messaging', 'signage', 'email_asset', 'other')),
  r2_key          text UNIQUE NOT NULL,
  file_mime       text,
  file_size_bytes bigint,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     uuid NOT NULL                                                  -- auth.users.id
);
CREATE INDEX IF NOT EXISTS idx_promo_materials_promo_id       ON promo_materials (promo_id);

-- 6. promo_ptp — Purpose / Tools / Process doc per promo (1:1, enforced
--    by PK on promo_id). Empty-string defaults so a freshly-created PTP
--    row is always valid; the UI can save partial drafts without
--    triggering NOT NULL violations.
CREATE TABLE IF NOT EXISTS promo_ptp (
  promo_id    uuid PRIMARY KEY REFERENCES promotions(id) ON DELETE CASCADE,
  purpose     text NOT NULL DEFAULT '',
  tools       text NOT NULL DEFAULT '',
  process     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid                                                               -- auth.users.id
);

-- 7. promo_announcements — per-send snapshot of every announcement
--    email composed via the live-view "Announcement email" surface.
--    Delivery still flows through the Brief 127 outbound_emails queue
--    (one queue row per recipient with source_kind='promo-announcement',
--    source_id={promo_id}). This table is the operator-facing audit:
--    "for promo X, here are the 3 announcements sent and what was in
--    each." The included_material_ids / included_ptp columns snapshot
--    the operator's attachment selection at send time, so a later
--    material edit or PTP rewrite doesn't change historical records.
CREATE TABLE IF NOT EXISTS promo_announcements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id              uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  sent_at               timestamptz NOT NULL DEFAULT now(),
  sent_by               uuid NOT NULL,                                           -- auth.users.id
  subject               text NOT NULL,
  body_text             text NOT NULL,
  body_html             text,                                                    -- nullable: rendered at send time if announcement template supports HTML
  recipient_emails      text[] NOT NULL DEFAULT '{}',
  included_material_ids uuid[] NOT NULL DEFAULT '{}',
  included_ptp          boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_promo_announcements_promo_sent ON promo_announcements (promo_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_announcements_sent_at    ON promo_announcements (sent_at DESC);

-- 8. promo_activity_log — append-only audit trail (mirrors
--    claim_activity_log). One row per discrete change. Free-form
--    details JSONB carries the per-activity payload (e.g.,
--    {from_status: 'Scoped', to_status: 'Building'} for
--    activity_type='status_changed'; {user_id, action:'added'} for
--    'assignment_changed'; {location_code} for the location-mark
--    activities). Adding a new activity_type is a CHECK constraint
--    relax — keep this list closed so the worker code and this DDL
--    stay in sync.
CREATE TABLE IF NOT EXISTS promo_activity_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id       uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  actor_user_id  uuid,                                                           -- auth.users.id; NULL when actor is the system (cron, etc.)
  activity_type  text NOT NULL CHECK (activity_type IN (
    'created',
    'status_changed',
    'assignment_changed',
    'ticket_updated',
    'roadblocks_updated',
    'internal_note_updated',
    'material_added',
    'material_removed',
    'ptp_updated',
    'location_marked_complete',
    'location_marked_incomplete',
    'announcement_sent'
  )),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_promo_activity_log_promo_created ON promo_activity_log (promo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_activity_log_actor          ON promo_activity_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_promo_activity_log_type           ON promo_activity_log (activity_type);

-- 9. promo_user_roles — new permission domain, parallel to
--    damage_claim_user_roles. One row per user that has any role in
--    the promo system. Surfaced via the auth_unified view extension at
--    the bottom of this file.
--
--    Role meanings:
--      super_admin — bypass all gates; can edit any field on any promo
--                    + see internal_note across the org.
--      it          — edit ticket fields (ready_by, roadblocks,
--                    internal_note, assignment); appears in the
--                    assignee dropdown; sees internal_note column on
--                    the IT queue.
--      marketing   — create promos, edit materials + PTP, send
--                    announcements; does NOT see internal_note.
--      ops         — read-only on live view + dashboard.
CREATE TABLE IF NOT EXISTS promo_user_roles (
  user_id     uuid PRIMARY KEY,                                                  -- auth.users.id
  promo_role  text NOT NULL CHECK (promo_role IN ('super_admin', 'it', 'marketing', 'ops')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid                                                               -- auth.users.id; NULL for self-grants / migration seeds
);
CREATE INDEX IF NOT EXISTS idx_promo_user_roles_role          ON promo_user_roles (promo_role);

------------------------------------------------------------------------
-- auth_unified view extension
------------------------------------------------------------------------
-- Surface promo_role on the unified read path so workers and apps/web
-- can fetch {email, role, dc_role, promo_role} in one query (matches
-- the Brief 11b / 64 pattern).
--
-- This DDL is a TEMPLATE — the live view definition is operator-side
-- and not checked into this repo. Before running:
--
--   1. Capture the live view definition:
--
--        SELECT pg_get_viewdef('auth_unified'::regclass, true);
--
--   2. Add this two-line addition to it:
--
--        LEFT JOIN promo_user_roles pur ON pur.user_id = u.id
--
--      and in the SELECT list:
--
--        pur.promo_role
--
--   3. Run the reconciled CREATE OR REPLACE VIEW statement.
--
-- Live shape captured 2026-06-05 via pg_get_viewdef. Three additions
-- for this migration: (1) `pur.promo_role` in the SELECT list, (2) the
-- LEFT JOIN to promo_user_roles, (3) `pur.promo_role` appended to the
-- GROUP BY (it's 1:1 with user_id via PK so it groups cleanly,
-- mirroring dcur.dc_role).
--
-- CREATE OR REPLACE VIEW auth_unified AS
-- SELECT u.id AS user_id,
--     u.email,
--     max(up.role) AS role,
--     COALESCE(array_agg(DISTINCT up.location_code) FILTER (WHERE up.location_code IS NOT NULL), ARRAY[]::text[]) AS locations,
--     COALESCE(bool_or(up.must_change_password), false) AS must_change_password,
--     COALESCE(array_agg(DISTINCT uta.tool) FILTER (WHERE uta.tool IS NOT NULL), ARRAY[]::text[]) AS tools,
--     dcur.dc_role,
--     COALESCE(array_agg(DISTINCT dcul.location_code) FILTER (WHERE dcul.location_code IS NOT NULL), ARRAY[]::text[]) AS dc_locations,
--     pur.promo_role                                                            -- NEW from this migration
--    FROM auth.users u
--      LEFT JOIN user_permissions up ON up.user_id = u.id
--      LEFT JOIN user_tool_access uta ON uta.user_id = u.id
--      LEFT JOIN damage_claim_user_roles dcur ON dcur.user_id = u.id
--      LEFT JOIN damage_claim_user_locations dcul ON dcul.user_id = u.id
--      LEFT JOIN promo_user_roles pur ON pur.user_id = u.id                     -- NEW
--   GROUP BY u.id, u.email, dcur.dc_role, pur.promo_role;                       -- NEW: pur.promo_role appended
