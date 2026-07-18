-- Cicero legacy damage-claim backfill (7 claims, Jan–Apr 2026).
--
-- Written to land each claim DIRECTLY in its terminal Closed state via a
-- single INSERT. It deliberately bypasses /claims-api/submit-claim and the
-- /manage status-transition endpoints, so NONE of the side effects fire:
-- no customer email, no internal new-claim email, no note/status webhooks,
-- no MaintainX work order, no check-request PDF. There are no DB triggers,
-- so a raw INSERT is inert beyond the row itself.
--
-- PREREQUISITE: run migration-incident-date.sql first (adds the
-- incident_date column this script populates).
--
-- Date mapping (both come from the source sheet):
--   incident_date = "Incident Date" — when the damage is claimed to have
--                   occurred. Stored as 'YYYY-MM-DD' (calendar date).
--   submitted_at  = "Incident Rec'd" — when the claim entered the system.
--
-- Only fields present in the source are populated. System-required columns:
--   location_pretty = 'Cicero' (real location name)
--   submitted_by    = 'backfill' (provenance marker — no source value exists;
--                     change to your email or another marker if preferred)
-- Other audit timestamps (created_at / updated_at / status_updated_at) are
-- left to their DEFAULT (actual insert time).
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=cicero-backfill.sql
-- Drop --remote to dry-run against the local replica first.

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, determination,
   lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1252026001','cicero','Cicero','Fran Coudriet',
   2020,'Lexus','ES350','Good',
   'vehicle in front of jumped roller and was hit','DM Review',
   'Closed','Closed — Paid',1812.99,
   'backfill','2026-01-28','2026-02-06 00:00:00'),

  ('1252026002','cicero','Cicero','Purna Tamang',
   2026,'Honda','Civic','Excellent',
   'rear bumper hit by another vehicle','DM Review',
   'Closed','Closed — Paid',1029.24,
   'backfill','2026-03-04','2026-03-04 00:00:00'),

  ('1252026003','cicero','Cicero','Ku Moo',
   2015,'Honda','Accord','Good',
   'trunk damaged','No',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-03-10','2026-03-10 00:00:00'),

  ('1252026004','cicero','Cicero','David Bliss',
   2015,'Kia','Sorento','Fair',
   'front grille and trim damaged','DM Review',
   'Closed','Closed — Paid',110.00,
   'backfill','2026-03-12','2026-03-19 00:00:00'),

  ('1252026005','cicero','Cicero','Kenny Cloinger',
   2019,'GMC','Sierra','Excellent',
   'vehicle in front of stopped and collision-damaged license plate','No',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-03-30','2026-03-30 00:00:00'),

  ('1252026006','cicero','Cicero','Summer Odell',
   2025,'Toyota','Grand Highlander','Excellent',
   'multiple scratches','No',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-04-06','2026-04-07 00:00:00'),

  ('1252026007','cicero','Cicero','Jennifer Clark',
   2013,'BMW','X3','Good',
   'roof rack and crossbars ripped off due to top brushes not being retracted','DM Review',
   'Closed','Closed — Paid',1314.26,
   'backfill','2026-04-24','2026-05-07 00:00:00');
