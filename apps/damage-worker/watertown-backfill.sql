-- Watertown (location_code 'watertown') legacy damage-claim backfill — 14 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'Watertown(135)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 6 paid claim(s), total $2856.23. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1352026004  Ryan Keddy  900.00
--     1352026007  Jose Lazcares  365.89
--     1352026011  Joshua Thurston  469.80
--     1352026012  Teresa Intorcia  331.90
--     1352025008  Matt Clark  240.00
--     1352025012  Roy Holeman  548.64
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=watertown-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1352026001','watertown','Watertown','Hussein Binns',
   2024,'Jeep','Compass','Excellent',
   'paint chipped','Paint Damage',NULL,'Legacy backfill — JOT# 202600026 · Paperwork: https://splashcarwashes.app.box.com/file/2095749246413','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-05','2026-01-07 00:00:00'),

  ('1352026002','watertown','Watertown','Aaron Druesedow',
   2020,'Ford','F350','Excellent',
   'drivers side front fender from headlight to above center of tire has hard rub and scratches','Paint Damage',NULL,'Legacy backfill — JOT# 202600033 · Paperwork: https://splashcarwashes.app.box.com/file/2098254822825 · no reply from customer','RM Review',
   'No Fault','Closed','Closed — Approved/No Response',NULL,
   'backfill','2026-01-09','2026-01-09 00:00:00'),

  ('1352026003','watertown','Watertown','Paul Sabel',
   2018,'Chevrolet','Equinox','Excellent',
   'front bumper popped out','Other','broken clips','Legacy backfill — JOT# 202600061 · Paperwork: https://splashcarwashes.app.box.com/file/2103793814168','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-14','2026-01-14 00:00:00'),

  ('1352026004','watertown','Watertown','Ryan Keddy',
   2024,'GMC','Sierra','Excellent',
   'Broken running board','Running Board',NULL,'Legacy backfill — JOT# 20200239 · Paperwork: https://splashcarwashes.app.box.com/file/2136452646133','RM Review',
   'Employee Error','Closed','Closed — Paid',900.00,
   'backfill','2026-02-14','2026-02-14 00:00:00'),

  ('1352026005','watertown','Watertown','Alex Calixto',
   2022,'BMW','230i','Excellent',
   'chipped rim','Rims',NULL,'Legacy backfill — JOT# 20200290 · Paperwork: https://splashcarwashes.app.box.com/file/2145243718938','RM Review',
   'Equipment Malfunction','Closed','Closed — Denied',NULL,
   'backfill','2026-02-23','2026-02-23 00:00:00'),

  ('1352026006','watertown','Watertown','Denise Johannessen',
   2020,'Buick','Encore','Good',
   'antenna broke','Antenna',NULL,'Legacy backfill — JOT# 20200365 · Paperwork: https://splashcarwashes.app.box.com/file/2155287503219','No Responsibility',
   'Not Employee/Equipment','Closed','Closed — Denied',NULL,
   'backfill','2026-03-04','2026-03-05 00:00:00'),

  ('1352026007','watertown','Watertown','Jose Lazcares',
   2008,'Toyota','Tundra','Good',
   'drivers front tire was punctured by equipment','Tires',NULL,'Legacy backfill — JOT# 20200537 · Paperwork: https://splashcarwashes.app.box.com/file/2192844685858','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',365.89,
   'backfill','2026-04-09','2026-04-09 00:00:00'),

  ('1352026008','watertown','Watertown','Angelina Winder',
   2015,'Honda','Accord','Good',
   'vehicle in front of applied brakes damaging license plate dented','Collision',NULL,'Legacy backfill — JOT# 20200548 · Paperwork: https://splashcarwashes.app.box.com/file/2195635703022','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-11','2026-04-11 00:00:00'),

  ('1352026009','watertown','Watertown','Brendan Semperger',
   2018,'Lincoln','Navigator','Excellent',
   'dryer blew sunroof inward/won''t open','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 20200639 · Paperwork: https://splashcarwashes.app.box.com/file/2218649780978','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-02','2026-05-02 00:00:00'),

  ('1352026010','watertown','Watertown','Kimberly Bond',
   2023,'Subaru','Wrx','Excellent',
   'rim damaged','Rims',NULL,'Legacy backfill — JOT# 20200728 · Paperwork: https://splashcarwashes.app.box.com/file/2237128657386','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-20','2026-05-20 00:00:00'),

  ('1352026011','watertown','Watertown','Joshua Thurston',
   2015,'Acura','Tlx','Fair',
   'popped drivers side front tire','Tires',NULL,'Legacy backfill — JOT# 20200855 · Paperwork: https://splashcarwashes.app.box.com/file/2272264513275','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',469.80,
   'backfill','2025-06-07','2026-06-07 00:00:00'),

  ('1352026012','watertown','Watertown','Teresa Intorcia',
   2025,'Hyundai','Tuscon','Excellent',
   'popped drivers side front tire','Tires',NULL,'Legacy backfill — JOT# 20200857 · Paperwork: https://splashcarwashes.app.box.com/file/2272269210862','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',331.90,
   'backfill','2026-06-07','2026-06-07 00:00:00'),

  ('1352025008','watertown','Watertown','Matt Clark',
   2025,'Volkswagen','Atlas','Excellent',
   'scratches/gouges on alloy wheels','Rims',NULL,'Legacy backfill — JOT# 202500559 · Paperwork: https://splashcarwashes.app.box.com/file/2014921655438','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',240.00,
   'backfill','2025-10-13','2025-10-13 00:00:00'),

  ('1352025012','watertown','Watertown','Roy Holeman',
   2021,'Dodge','Ram 2500','Good',
   'both mirrors flipped forward, passenger mirror broke off','PS Mirror',NULL,'Legacy backfill — JOT# 20200213 · Paperwork: https://splashcarwashes.app.box.com/file/2131816042858','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',548.64,
   'backfill','2025-12-12','2026-02-11 00:00:00');
