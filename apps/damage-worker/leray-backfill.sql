-- LeRay (location_code 'leray') legacy damage-claim backfill — 16 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'LeRay(148)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 1 paid claim(s), total $500.00. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1482025040  Baptiste Weasel Bear  500.00
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=leray-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1482026001','leray','LeRay','Aimoni Hughes',
   2021,'Kia','Forte','Good',
   'vehicle in front of slipped off rail causing collision and dented front license plate','Other','Jumped Rail','Legacy backfill — JOT# 202600035 · Paperwork: https://splashcarwashes.app.box.com/file/2099510058240 · bartered w/6 mos BB','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-09','2026-01-09 00:00:00'),

  ('1482026002','leray','LeRay','Yarivelys Gonzalez',
   2021,'Kia','Soul','Good',
   'hubcap damaged/made contact with rail','Rims',NULL,'Legacy backfill — JOT# 202600095 · Paperwork: https://splashcarwashes.app.box.com/file/2111872603069 · bartered w/2 mos BB',NULL,
   'Equipment Malfunction','Closed','Closed — Denied',NULL,
   'backfill','2026-01-22','2026-01-22 00:00:00'),

  ('1482026003','leray','LeRay','Stephanie Forsyth',
   2014,'Toyota','Scion','Fair',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 202600153 · Paperwork: https://splashcarwashes.app.box.com/file/2123117152534','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-02','2026-02-02 00:00:00'),

  ('1482026004','leray','LeRay','Oriana Clark',
   2026,'Hyundai','Pallasade','Excellent',
   'long scratch on hood','Paint Damage',NULL,'Legacy backfill — JOT# 202600156 · Paperwork: https://splashcarwashes.app.box.com/file/2123096279666','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-02','2026-02-02 00:00:00'),

  ('1482026005','leray','LeRay','James Upchurch',
   2016,'Jeep','Cherokee','Good',
   'Broken antenna','Antenna',NULL,'Legacy backfill — JOT# 20200231 · Paperwork: https://splashcarwashes.app.box.com/file/2136430238014','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-13','2026-02-13 00:00:00'),

  ('1482026006','leray','LeRay','Amanda Craig',
   2022,'Honda','CRV','Good',
   'Vehicle was hit from behind denting tailgate and front license plate is torn up','Collision',NULL,'Legacy backfill — JOT# 20200233 · Paperwork: https://splashcarwashes.app.box.com/file/2136408059636','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-13','2026-02-13 00:00:00'),

  ('1482026007','leray','LeRay','Heidi England',
   2021,'Chevrolet','Tahoe','Excellent',
   'collided with vehicle in front of','Collision',NULL,'Legacy backfill — JOT# 20200232 · Paperwork: https://splashcarwashes.app.box.com/file/2136433132784','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-13','2026-02-13 00:00:00'),

  ('1482026008','leray','LeRay','Khoa Lam',
   2017,'Tesla','S','Excellent',
   'vehicle in front of applied brake causing collision','Collision',NULL,'Legacy backfill — JOT# 20200349 · Paperwork: https://splashcarwashes.app.box.com/file/2152759084424','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-02','2026-03-02 00:00:00'),

  ('1482026009','leray','LeRay','Sara Filippi',
   2023,'Toyota','Rav4','Excellent',
   'scratches on trunk','Paint Damage',NULL,'Legacy backfill — JOT# 20200509 · Paperwork: https://splashcarwashes.app.box.com/file/2190496285503','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-06','2026-04-06 00:00:00'),

  ('1482026010','leray','LeRay','Ian Barrette',
   2024,'Volkswagon','Atlas','Excellent',
   'large scratches on hood and roof','Paint Damage',NULL,'Legacy backfill — JOT# 20200531 · Paperwork: https://splashcarwashes.app.box.com/file/2192736668663','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-08','2026-04-08 00:00:00'),

  ('1482026011','leray','LeRay','Edson Guanlao',
   2021,'Toyota','Tundra','Excellent',
   'collision with vehicle behind','Collision',NULL,'Legacy backfill — JOT# 20200707 · Paperwork: https://splashcarwashes.app.box.com/file/2234487371076','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-15','2026-05-16 00:00:00'),

  ('1482026012','leray','LeRay','Gaurav Adhikari',
   2017,'Kia','Sportage','Fair',
   'collision with vehicle behind','Collision',NULL,'Legacy backfill — JOT# 20200738 · Paperwork: https://splashcarwashes.app.box.com/file/2242106152524 · [backfill note: source sheet listed duplicate incident # 1482026011; reassigned to 1482026012]','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-22','2026-05-22 00:00:00'),

  ('1482026013','leray','LeRay','Gabbie Deleon',
   2023,'Kia','Sportage','Excellent',
   'collision with vehicle behind','Collision',NULL,'Legacy backfill — JOT# 20200866 · Paperwork: https://splashcarwashes.app.box.com/file/2276785487498','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-09','2026-06-09 00:00:00'),

  ('1482026014','leray','LeRay','Kiandra Love-Werts',
   2017,'Chevrolet','Trax','Good',
   'vehicle was hit from behind','Collision',NULL,'Legacy backfill — JOT# 20200945 · Paperwork: https://splashcarwashes.app.box.com/file/2318620773087','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-29','2026-06-29 00:00:00'),

  ('1482026015','leray','LeRay','Maria Osorio',
   2019,'BMW','X3','Excellent',
   'cracked windshield','Window',NULL,'Legacy backfill — JOT# 20200976 · Paperwork: https://splashcarwashes.app.box.com/file/2339112098064','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-07-09','2026-07-09 00:00:00'),

  ('1482025040','leray','LeRay','Baptiste Weasel Bear',
   2017,'Kia','Sportage','Fair',
   'vehicle in front of stopped causing contact to front bumper','Collision',NULL,'Legacy backfill — JOT# 202500823 · Paperwork: https://splashcarwashes.app.box.com/file/2090513752222','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',500.00,
   'backfill','2025-12-31','2025-12-31 00:00:00');
