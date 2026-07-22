-- Oswego (location_code 'oswego') legacy damage-claim backfill — 24 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'Oswego(147)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 10 paid claim(s), total $4243.86. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1472026001  Oswego Auto (Dyana Hohle)  707.62
--     1472026002  Don Cannon  19.98
--     1472026003  Oswego Auto (Michael Bradshaw)  352.39
--     1472026004  Thomas Oreilly  638.73
--     1472026005  Timothy Fitzpatric  33.20
--     1472026010  Oswego Auto & Tire (Jennifer Scaringi)  539.50
--     1472026016  Oswego Auto (Larry Hatter)  345.87
--     1472026017  Oswego Auto & Tire (Natalia Ososkalo)  292.96
--     1472026018  Elizabeth Bond  20.89
--     1472025036  Michael Andrews  1292.72
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=oswego-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1472026001','oswego','Oswego','Oswego Auto (Dyana Hohle)',
   2023,'Chevrolet','Traverse','Excellent',
   'top of rear liftgate cracked and ripped off','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 202600038 · Paperwork: https://splashcarwashes.app.box.com/file/2099512751245','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',707.62,
   'backfill','2026-01-10','2026-01-10 00:00:00'),

  ('1472026002','oswego','Oswego','Don Cannon',
   2024,'Chevrolet','Silverado','Excellent',
   'broken antenna','Antenna',NULL,'Legacy backfill — JOT# 202600048 · Paperwork: https://splashcarwashes.app.box.com/file/2100268818843','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',19.98,
   'backfill','2026-01-12','2026-01-12 00:00:00'),

  ('1472026003','oswego','Oswego','Oswego Auto (Michael Bradshaw)',
   2022,'Mitsubishi','Eclipse Cross','Excellent',
   'vinyl strip/trim on top of roof line from front window to back window came off','Other','Trim','Legacy backfill — JOT# 202600082 · Paperwork: https://splashcarwashes.app.box.com/file/2107489292972','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',352.39,
   'backfill','2026-01-18','2026-01-19 00:00:00'),

  ('1472026004','oswego','Oswego','Thomas Oreilly',
   2018,'Ford','F150','Excellent',
   'No retract;evo shine ripped off the light bar','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 202600092 · Paperwork: https://splashcarwashes.app.box.com/file/2110845390212','RM Review',
   'Employee Error','Closed','Closed — Paid',638.73,
   'backfill','2026-01-21','2026-01-22 00:00:00'),

  ('1472026005','oswego','Oswego','Timothy Fitzpatric',
   2017,'Volkswagen','Gti SE','Good',
   'Passenger mirror came off near dryer','PS Mirror',NULL,'Legacy backfill — JOT# 202600126 · Paperwork: https://splashcarwashes.app.box.com/file/2121730845526 · Divvy','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',33.20,
   'backfill','2026-01-15','2026-01-30 00:00:00'),

  ('1472026006','oswego','Oswego','Robert Spinelli',
   2025,'Nissan','Kicks','Excellent',
   'gate malfunctioned and scratched side of vehicle','Paint Damage',NULL,'Legacy backfill — JOT# 20200216 · Paperwork: https://splashcarwashes.app.box.com/file/2132936389669','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-09','2026-02-12 00:00:00'),

  ('1472026007','oswego','Oswego','John DeLapp',
   2022,'Dodge','Ram','Good',
   'scratch across hood of vehicle','Paint Damage',NULL,'Legacy backfill — JOT# 20200271 · Paperwork: https://splashcarwashes.app.box.com/file/2140780312642','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-17','2026-02-19 00:00:00'),

  ('1472026008','oswego','Oswego','Gonzalo Aguiar',
   2019,'Subaru','Forrester','Excellent',
   'Antenna fin was ripped off','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 20200277 · Paperwork: https://splashcarwashes.app.box.com/file/2141720468574','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-19','2026-02-19 00:00:00'),

  ('1472026009','oswego','Oswego','Andrew Scheg',
   2024,'Ford','Maverick','Good',
   'something caught in brush damaged paint','Paint Damage',NULL,'Legacy backfill — JOT# 20200380 · Paperwork: https://splashcarwashes.app.box.com/file/2158673907812','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-08','2026-03-08 00:00:00'),

  ('1472026010','oswego','Oswego','Oswego Auto & Tire (Jennifer Scaringi)',
   2020,'Jeep','Gladiator','Excellent',
   'light bar damaged','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 20200430 · Paperwork: https://splashcarwashes.app.box.com/file/2167767155939','RM Review',
   'Employee Error','Closed','Closed — Paid',539.50,
   'backfill','2026-03-09','2026-03-16 00:00:00'),

  ('1472026011','oswego','Oswego','Tyler Joseph',
   2022,'Dodge','Ram 1500','Good',
   'large scratches across hood','Paint Damage',NULL,'Legacy backfill — JOT# 20200457 · Paperwork: https://splashcarwashes.app.box.com/file/2175231043033','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-01','2026-03-24 00:00:00'),

  ('1472026012','oswego','Oswego','Dominic Castaldo',
   2023,'BMW','M340','Excellent',
   'scratches and trim came off','Paint Damage',NULL,'Legacy backfill — JOT# 20200469 · Paperwork: https://splashcarwashes.app.box.com/file/2178731005342','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-24','2026-03-27 00:00:00'),

  ('1472026013','oswego','Oswego','Carrie Burdick',
   2019,'Cadillac','Xt4','Good',
   'Bent license plate and gouge on right side fender','License Plate',NULL,'Legacy backfill — JOT# 20200583 · Paperwork: https://splashcarwashes.app.box.com/file/2206608196352','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-15','2026-04-22 00:00:00'),

  ('1472026014','oswego','Oswego','Brandon Lagoe',
   2022,'Chevrolet','Z71','Excellent',
   'scratches on right side from front to rear','Paint Damage',NULL,'Legacy backfill — JOT# 20200600 · Paperwork: https://splashcarwashes.app.box.com/file/2209876302384','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-24','2026-04-24 00:00:00'),

  ('1472026015','oswego','Oswego','Rayshel Cardinell',
   2015,'Nissan','Pathfinder','Fair',
   'scratches and license plate bent','Paint Damage',NULL,'Legacy backfill — JOT# 20200608 · Paperwork: https://splashcarwashes.app.box.com/file/2211540630950','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-27','2026-04-27 00:00:00'),

  ('1472026016','oswego','Oswego','Oswego Auto (Larry Hatter)',
   2021,'Chevrolet','pickup','Excellent',
   'fuel door cover is broken','Other','Fuel door','Legacy backfill — JOT# 20200612 · Paperwork: https://splashcarwashes.app.box.com/file/2211642942144','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',345.87,
   'backfill','2026-04-27','2026-04-27 00:00:00'),

  ('1472026017','oswego','Oswego','Oswego Auto & Tire (Natalia Ososkalo)',
   2016,'Toyota','Corolla','Fair',
   'passenger mirror broken','PS Mirror',NULL,'Legacy backfill — JOT# 20200623 · Paperwork: https://splashcarwashes.app.box.com/file/2214772818910','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',292.96,
   'backfill','2026-04-29','2026-04-29 00:00:00'),

  ('1472026018','oswego','Oswego','Elizabeth Bond',
   2020,'Honda','pickup','Excellent',
   'passenger mirror','PS Mirror',NULL,'Legacy backfill — JOT# 20200668 · Paperwork: https://splashcarwashes.app.box.com/file/2226267774618','No Responsibility',
   'Not Employee/Equipment','Closed','Closed — Paid',20.89,
   'backfill','2026-05-11','2026-05-11 00:00:00'),

  ('1472026019','oswego','Oswego','Scott Baker',
   2025,'Toyota','Tacoma','Excellent',
   'clear coat on bottom of cab','Paint Damage',NULL,'Legacy backfill — JOT# 20200709 · Paperwork: https://splashcarwashes.app.box.com/file/2234500187310','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-17','2026-05-17 00:00:00'),

  ('1472026020','oswego','Oswego','Tina Lee Spriggs',
   2025,'Subaru','Outback','Excellent',
   'hatch and tailgate scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200778 · Paperwork: https://splashcarwashes.app.box.com/file/2257717280818','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-27','2026-05-29 00:00:00'),

  ('1472026021','oswego','Oswego','Jessica Kolb',
   2025,'Mazda','Cx5','Excellent',
   'left side panel above tire, trunk near tailgate and sides scratched','Paint Damage',NULL,'Legacy backfill — JOT# 20200779 · Paperwork: https://splashcarwashes.app.box.com/file/2257788724066','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-29','2026-05-29 00:00:00'),

  ('1472026022','oswego','Oswego','Carolyn Reitano',
   2009,'Lincoln','Town Car','Good',
   'white marks, scratches paint missing','Paint Damage',NULL,'Legacy backfill — JOT# 20200797 · Paperwork: https://splashcarwashes.app.box.com/file/2257896090302','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-31','2026-05-31 00:00:00'),

  ('1472026023','oswego','Oswego','Tammy Kadle',
   2006,'Toyota','Tacoma','Good',
   'broken antenna','Antenna',NULL,'Legacy backfill — JOT# 20200928 · Paperwork: https://splashcarwashes.app.box.com/file/2308831067095','RM Review',
   'Not Employee/Equipment','Open','Pending RM Review',NULL,
   'backfill','2026-06-25','2026-06-25 00:00:00'),

  ('1472025036','oswego','Oswego','Michael Andrews',
   2020,'Hyundai','Santa Fe','Poor',
   'evo shine came down and ripped off kayak rack',NULL,NULL,'Legacy backfill — JOT# 202500635 · Paperwork: https://splashcarwashes.app.box.com/file/2037373746756','RM Review',
   NULL,'Closed','Closed — Paid',1292.72,
   'backfill','2025-11-04','2025-11-04 00:00:00');
