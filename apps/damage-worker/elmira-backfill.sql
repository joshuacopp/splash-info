-- Elmira Heights (location_code 'elmira_heights') legacy damage-claim backfill — 7 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'Elmira(127)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 3 paid claim(s), total $5936.51. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1272026003  Perri Sincock  3200.00
--     1272026006  Natasha Sadakova  2430.00
--     1272026007  Christine Brown  306.51
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=elmira-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1272026001','elmira_heights','Elmira Heights','Lindzey Goyette',
   2025,'Ford','Escape','Excellent',
   'rear door closed on spoiler @ exit','Paint Damage',NULL,'Legacy backfill — JOT# 202500111 · Paperwork: https://splashcarwashes.app.box.com/file/2115510582465','RM Review',
   'Equipment Malfunction','Closed','Closed — Denied',NULL,
   'backfill','2026-01-26','2026-01-26 00:00:00'),

  ('1272026002','elmira_heights','Elmira Heights','Timothy Richter',
   2015,'Dodge','Charger','Good',
   'vehicle rolled into another','Collision',NULL,'Legacy backfill — JOT# 202600133 · Paperwork: https://splashcarwashes.app.box.com/file/2121745086624','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-31','2026-01-31 00:00:00'),

  ('1272026003','elmira_heights','Elmira Heights','Perri Sincock',
   2024,'Hyundai','Tuscon','Good',
   'Exit gate malfunctioned causing backup of cars and rollers pushed into another vehicle','Collision',NULL,'Legacy backfill — JOT# 202600179 · Paperwork: https://splashcarwashes.app.box.com/file/2126621555363','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',3200.00,
   'backfill','2026-02-05','2026-02-05 00:00:00'),

  ('1272026004','elmira_heights','Elmira Heights','Jim Cook',
   2019,'Toyota','Highlander','Good',
   'bumped into vehicle in front of;conveyor stopped & restarted','Collision',NULL,'Legacy backfill — JOT# 202600212 · Paperwork: https://splashcarwashes.app.box.com/file/2131812964074','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-04','2026-02-11 00:00:00'),

  ('1272026005','elmira_heights','Elmira Heights','Jeff Davis',
   2022,'Nissan','Versa','Good',
   'Heard a loud thump;found a crack on top of bumper and a hole','Paint Damage',NULL,'Legacy backfill — JOT# 20200253 · Paperwork: https://splashcarwashes.app.box.com/file/2137860404872','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-11','2026-02-17 00:00:00'),

  ('1272026006','elmira_heights','Elmira Heights','Natasha Sadakova',
   2020,'Lincoln','Aviator','Excellent',
   'passenger mirror','PS Mirror',NULL,'Legacy backfill — JOT# 20200763 · Paperwork: https://splashcarwashes.app.box.com/file/2248970205552','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',2430.00,
   'backfill','2026-05-27','2026-05-27 00:00:00'),

  ('1272026007','elmira_heights','Elmira Heights','Christine Brown',
   2025,'Honda','Accord','Excellent',
   'flat tire','Tires',NULL,'Legacy backfill — JOT# 20200968 · Paperwork: https://splashcarwashes.app.box.com/file/2332843165836','RM Review',
   'Employee Error','Closed','Closed — Paid',306.51,
   'backfill','2026-06-21','2026-07-06 00:00:00');
