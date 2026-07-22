-- Cortland (location_code 'cortland') legacy damage-claim backfill — 8 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'Cortland(126)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 4 paid claim(s), total $3960.36. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1262026001  Fran Gutman  64.71
--     1262026002  Duane Randall  140.40
--     1262026004  Michael Barylski  3713.12
--     1262026006  Mariam Barry  42.13
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=cortland-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1262026001','cortland','Cortland','Fran Gutman',
   2016,'Honda','Pilot','Good',
   'back of drivers mirror is missing','DS Mirror',NULL,'Legacy backfill — JOT# 202600055 · Paperwork: https://splashcarwashes.app.box.com/file/2101432304537','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',64.71,
   'backfill','2026-01-05','2026-01-13 00:00:00'),

  ('1262026002','cortland','Cortland','Duane Randall',
   2022,'Dodge','Ram 1500','Good',
   'Top brush not retracted caught on ladder rack causing him to jer back and forth;bending rack','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 202600074 · Paperwork: https://splashcarwashes.app.box.com/file/2107309018894','RM Review',
   'Employee Error','Closed','Closed — Paid',140.40,
   'backfill','2026-01-18','2026-01-18 00:00:00'),

  ('1262026003','cortland','Cortland','Jennifer Vernooy',
   2025,'Toyota','Rav4','Excellent',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 202600157 · Paperwork: https://splashcarwashes.app.box.com/file/2123113687172','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-01','2026-02-02 00:00:00'),

  ('1262026004','cortland','Cortland','Michael Barylski',
   2022,'Subaru','Outback','Good',
   'Dryer swivle cone fell off and hit vehicle causing  damage','Paint Damage',NULL,'Legacy backfill — JOT# 20200288 · Paperwork: https://splashcarwashes.app.box.com/file/2144241870239','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',3713.12,
   'backfill','2026-02-23','2026-02-23 00:00:00'),

  ('1262026005','cortland','Cortland','Darlene Stap',
   2013,'Ford','Explorer','Fair',
   'Antenna','Antenna',NULL,'Legacy backfill — JOT# 20200298 · Paperwork: https://splashcarwashes.app.box.com/file/2146658262793 · no reply from customer','RM Review',
   'No Fault','Closed','Closed — Approved/No Response',NULL,
   'backfill','2026-02-16','2026-02-25 00:00:00'),

  ('1262026006','cortland','Cortland','Mariam Barry',
   2011,'Honda','Accord','Fair',
   'hubcap cracked and clips broken','Rims',NULL,'Legacy backfill — JOT# 20200453 · Paperwork: https://splashcarwashes.app.box.com/file/2173787970448','RM Review',
   'Employee Error','Closed','Closed — Paid',42.13,
   'backfill','2026-03-22','2026-03-22 00:00:00'),

  ('1262026007','cortland','Cortland','David Edwards',
   2016,'Chrysler','Town n Country','Good',
   'Passenger mirror was pushed in, cracked window guard','PS Mirror',NULL,'Legacy backfill — JOT# 20200466 · Paperwork: https://splashcarwashes.app.box.com/file/2177547157403 · extended UL','RM Review',
   'Not Employee/Equipment','Closed','Closed — Denied',NULL,
   'backfill','2026-03-26','2026-03-26 00:00:00'),

  ('1262026008','cortland','Cortland','Recep Iriz',
   2012,'Toyota','Prius','Good',
   'brush broke rear wiper','Wiper',NULL,'Legacy backfill — JOT# 20200688 · Paperwork: https://splashcarwashes.app.box.com/file/2229878545383','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-10','2026-05-13 00:00:00');
