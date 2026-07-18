-- Binghamton (location_code 'binghamton') legacy damage-claim backfill — 22 claims, Jan–Jun 2026.
--
-- Same design as cicero-backfill.sql: each claim is INSERTed DIRECTLY in its
-- terminal state (or, for the one Open claim, at 'Pending RM Review'). It
-- bypasses /claims-api/submit-claim and the /manage status endpoints, so NO
-- side effects fire (no emails, no webhooks, no MaintainX work order, no
-- check-request PDF). Raw INSERTs are inert — there are no DB triggers.
--
-- PREREQUISITE: run migration-incident-date.sql first (adds incident_date).
--
-- MAPPING NOTES (from the source sheet 'Binghamton Migration.xlsx'):
--   * Responsibility 'DM Review' means RM (Regional Manager) review — the one
--     Open claim (1222026001 Maxine Wright) lands lifecycle='Open',
--     claim_status='Pending RM Review' so it can be worked in the dashboard.
--     Closed review rows carry determination='RM Review'; 'no' rows carry
--     determination='No Responsibility'.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set);
--     1222026003 Connor Lindsay -> 'Closed — Approved/No Response' (sheet note:
--     no reply from customer with estimate); all other closed rows -> 'Closed — Denied'.
--   * damage_type / damage_other come straight from the sheet's columns.
--   * The sheet's JOT#, the Box paperwork link, and any Notes text are preserved
--     in staff_notes (there is no dedicated document-URL column).
--
-- COST/RECEIPTS: the 5 paid claims (total $1316.17) get their reporting cost
-- from real Receipt uploads via the dashboard (type=Receipt, amount entered),
-- NOT from this file. Do NOT add placeholder claim_photos rows here — that would
-- double-count once the receipts are uploaded. Paid claims + amounts:
--   1222026002 Autumn Hoover   370.31
--   1222026008 Rhys Jones      297.93
--   1222026010 Patty Blair     269.93
--   1222026011 Mark Smith      243.00
--   1222026013 Kyle Frazier    135.00
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=binghamton-backfill.sql
-- Drop --remote to dry-run against the local replica first.

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1222026001','binghamton','Binghamton','Maxine Wright',
   2017,'Ford','Subn','Excellent',
   'rear wiper','Wiper',NULL,'Legacy backfill — JOT# 202600047 · Paperwork: https://splashcarwashes.app.box.com/file/2100254980342','RM Review',
   'Open','Pending RM Review',NULL,
   'backfill','2026-01-12','2026-01-12 00:00:00'),

  ('1222026002','binghamton','Binghamton','Autumn Hoover',
   2016,'Nissan','Frontier','Fair',
   'Drivers mirror got knocked off','DS Mirror',NULL,'Legacy backfill — JOT# 202600094 · Paperwork: https://splashcarwashes.app.box.com/file/2111856849477','RM Review',
   'Closed','Closed — Paid',370.31,
   'backfill','2026-01-22','2026-01-22 00:00:00'),

  ('1222026003','binghamton','Binghamton','Connor Lindsay',
   2023,'Honda','Accord','Excellent',
   'wash stopped and was hit by vehicle behind','Collision',NULL,'Legacy backfill — JOT# 202600128 · Paperwork: https://splashcarwashes.app.box.com/file/2121737509744 · no reply from customer with estimate','RM Review',
   'Closed','Closed — Approved/No Response',NULL,
   'backfill','2026-01-30','2026-01-30 00:00:00'),

  ('1222026004','binghamton','Binghamton','John Williams',
   2015,'Dodge','Challenger','Excellent',
   'car was struck from behind damaging rear bumper license plate and holder','Collision',NULL,'Legacy backfill — JOT# 202600131 · Paperwork: https://splashcarwashes.app.box.com/file/2121735892561','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-01-30','2026-01-30 00:00:00'),

  ('1222026005','binghamton','Binghamton','Michael Heath',
   2003,'Toyota','Tacoma','Good',
   'license plate cover damaged','License Plate',NULL,'Legacy backfill — JOT# 202600187 · Paperwork: https://splashcarwashes.app.box.com/file/2129291390236','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-02-08','2026-02-08 00:00:00'),

  ('1222026006','binghamton','Binghamton','Danie Matias',
   2015,'Dodge','Ram','Good',
   'got off track','Other','Jumped Conveyor','Legacy backfill — JOT# 202600195 · Paperwork: https://splashcarwashes.app.box.com/file/2129575374630','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-02-09','2026-02-09 00:00:00'),

  ('1222026007','binghamton','Binghamton','Penny Eldred',
   2018,'Buick','Envision','Good',
   'Track stopped, vehicle behind rolled into causing damage to bumper','Collision',NULL,'Legacy backfill — JOT# 20200241 · Paperwork: https://splashcarwashes.app.box.com/file/2136454766103','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-02-15','2026-02-15 00:00:00'),

  ('1222026008','binghamton','Binghamton','Rhys Jones',
   2022,'Chevrolet','Trailblazer','Excellent',
   'top brush snapped off antenna','Antenna',NULL,'Legacy backfill — JOT# 20200247 · Paperwork: https://splashcarwashes.app.box.com/file/2136664995966 · no reply from customer with estimate','RM Review',
   'Closed','Closed — Paid',297.93,
   'backfill','2026-02-16','2026-02-16 00:00:00'),

  ('1222026009','binghamton','Binghamton','Zoe Nelson',
   2022,'Hyundai','Venue','Good',
   'scratches all over car','Paint Damage',NULL,'Legacy backfill — JOT# 20200256 · Paperwork: https://splashcarwashes.app.box.com/file/2138078476036','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-02-17','2026-02-17 00:00:00'),

  ('1222026010','binghamton','Binghamton','Patty Blair',
   2021,'GMC','Denali','Excellent',
   'Part on the door near passenger mirror broken','PS Mirror',NULL,'Legacy backfill — JOT# 20200289 · Paperwork: https://splashcarwashes.app.box.com/file/2144310668894','RM Review',
   'Closed','Closed — Paid',269.93,
   'backfill','2026-02-20','2026-02-23 00:00:00'),

  ('1222026011','binghamton','Binghamton','Mark Smith',
   2025,'Chevrolet','Silverado','Excellent',
   'top rack didn''t retract properly and damaged roof rack','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 20200300 · Paperwork: https://splashcarwashes.app.box.com/file/2146661385528','RM Review',
   'Closed','Closed — Paid',243.00,
   'backfill','2026-02-04','2026-02-25 00:00:00'),

  ('1222026012','binghamton','Binghamton','Tobby Dugbins',
   2019,'Dodge','Durango','Excellent',
   'black marks on truck','Paint Damage',NULL,'Legacy backfill — JOT# 20200313 · Paperwork: https://splashcarwashes.app.box.com/file/2149046911033','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-02-27','2026-02-27 00:00:00'),

  ('1222026013','binghamton','Binghamton','Kyle Frazier',
   2012,'Chevrolet','Camero','Good',
   'front plate bracket broken off from side brushes','License Plate',NULL,'Legacy backfill — JOT# 20200538 · Paperwork: https://splashcarwashes.app.box.com/file/2193038776775','RM Review',
   'Closed','Closed — Paid',135.00,
   'backfill','2026-03-14','2026-04-09 00:00:00'),

  ('1222026014','binghamton','Binghamton','Stella Ohl',
   2025,'Subaru','Outback','Excellent',
   'scratch on back of car','Paint Damage',NULL,'Legacy backfill — JOT# 20200558 · Paperwork: https://splashcarwashes.app.box.com/file/2197929829955','RM Review',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-04-07','2026-04-14 00:00:00'),

  ('1222026015','binghamton','Binghamton','Ameshia Prevalus',
   2011,'Chrysler','200','Good',
   'scratches on hood and sides','Paint Damage',NULL,'Legacy backfill — JOT# 20200703 · Paperwork: https://splashcarwashes.app.box.com/file/2234472152674','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-05-16','2026-05-16 00:00:00'),

  ('1222026016','binghamton','Binghamton','Linda Robi',
   2025,'Honda','CRV','Excellent',
   'scratch on passenger door','Paint Damage',NULL,'Legacy backfill — JOT# 20200725 · Paperwork: https://splashcarwashes.app.box.com/file/2236096688710','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-05-19','2026-05-19 00:00:00'),

  ('1222026017','binghamton','Binghamton','Steven Hunt',
   2017,'GMC','Sierra','Good',
   'brushes removed paint on bottom panel on both sides','Paint Damage',NULL,'Legacy backfill — JOT# 20200750 · Paperwork: https://splashcarwashes.app.box.com/file/2246332451665','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-05-12','2026-05-25 00:00:00'),

  ('1222026018','binghamton','Binghamton','Patrick Smith',
   2013,'Subaru','Outback','Good',
   'several black marks on passenger''s side along with deep scratches on rear bumper and passenger''s fender','Paint Damage',NULL,'Legacy backfill — JOT# 20200757 · Paperwork: https://splashcarwashes.app.box.com/file/2246656509199','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-05-26','2026-05-26 00:00:00'),

  ('1222026019','binghamton','Binghamton','John Fulton',
   2026,'Hyundai','Tucson','Excellent',
   'minor collision','Collision',NULL,'Legacy backfill — JOT# 20200776 · Paperwork: https://splashcarwashes.app.box.com/file/2254827856241','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-05-29','2026-05-29 00:00:00'),

  ('1222026020','binghamton','Binghamton','Joshua Howell',
   2019,'Subaru','Crosstrek','Good',
   'roller scratched hood and chipped paint','Paint Damage',NULL,'Legacy backfill — JOT# 20200844 · Paperwork: https://splashcarwashes.app.box.com/file/2266847889391','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-06-04','2026-06-05 00:00:00'),

  ('1222026021','binghamton','Binghamton','Vickie Shaver',
   2025,'Nissan','Murano','Excellent',
   'cracked windshield','Window',NULL,'Legacy backfill — JOT# 20200851 · Paperwork: https://splashcarwashes.app.box.com/file/2272240832662','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-06-06','2026-06-06 00:00:00'),

  ('1222026022','binghamton','Binghamton','Saquan Smith',
   2015,'Volkswagon','Sedan','Good',
   'broken valve stem and caused left front tire to go flat','Tires',NULL,'Legacy backfill — JOT# 20200881 · Paperwork: https://splashcarwashes.app.box.com/file/2286724292401','No Responsibility',
   'Closed','Closed — Denied',NULL,
   'backfill','2026-06-13','2026-06-13 00:00:00');
