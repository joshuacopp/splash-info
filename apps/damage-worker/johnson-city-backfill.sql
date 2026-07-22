-- Johnson City (location_code 'johnson_city') legacy damage-claim backfill — 22 claims.
--
-- Same design as cicero-backfill.sql / binghamton-backfill.sql: each claim is
-- INSERTed DIRECTLY in its terminal state (Open claims land 'Pending RM Review').
-- Raw INSERTs are inert — no triggers, so NO emails/webhooks/MaintainX/PDFs fire.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (source sheet 'Johnson City(156)' in CoppNotBingNotCiceroMigration.xlsx):
--   * Responsibility: 'DM Review' -> determination 'RM Review'; 'no' -> 'No
--     Responsibility'; 'yes'/blank -> determination NULL.
--   * Disposition: cost present -> 'Closed — Paid' (approved_amount set); sheet
--     note 'no reply from customer' -> 'Closed — Approved/No Response'; any other
--     closed row -> 'Closed — Denied'; Open row -> 'Pending RM Review'.
--   * fault_category from the sheet's Fault/Cause column; 'Equipment Related'
--     is normalized to 'Equipment Malfunction' (the CAUSE dropdown value).
--   * JOT#, Box paperwork link, and Notes text -> staff_notes.
--
-- COST/RECEIPTS: 1 paid claim(s), total $131.76. Reporting cost comes
--   from real Receipt uploads via the dashboard (type=Receipt), NOT this file.
--   No placeholder claim_photos rows here (would double-count). Paid claims:
--     1562026018  Brandon Rogers  131.76
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=johnson-city-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1562026001','johnson_city','Johnson City','Kayla Burns',
   2019,'Hyundai','Santa Fe','Good',
   'paint chunk came off passenger''s side of hood','Paint Damage',NULL,'Legacy backfill — JOT# 202600040 · Paperwork: https://splashcarwashes.app.box.com/file/2099515182845','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-10','2026-01-10 00:00:00'),

  ('1562026002','johnson_city','Johnson City','Matthew Rosics',
   2015,'Cadillac','SRX','Good',
   'rear wiper blade cover was blown off during drying and crushed','Wiper',NULL,'Legacy backfill — JOT# 202600066 · Paperwork: https://splashcarwashes.app.box.com/file/2103998994617 · no reply from customer','RM Review',
   'No Fault','Closed','Closed — Approved/No Response',NULL,
   'backfill','2026-01-15','2026-01-15 00:00:00'),

  ('1562026003','johnson_city','Johnson City','Kamalpreet Singh',
   2023,'Toyota','Camry','Excellent',
   'Piece of body kit on front drivers side bumper got knocked off','Other','Trim','Legacy backfill — JOT# 202600089 · Paperwork: https://splashcarwashes.app.box.com/file/2108605004695','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-20','2026-01-20 00:00:00'),

  ('1562026004','johnson_city','Johnson City','Deborah Payne',
   2024,'Jeep','Compass','Good',
   'scratch on passenger and rear drivers door','Paint Damage',NULL,'Legacy backfill — JOT# 202600161 · Paperwork: https://splashcarwashes.app.box.com/file/2123139383823','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-01-31','2026-02-03 00:00:00'),

  ('1562026005','johnson_city','Johnson City','Joe Abbott',
   2023,'Toyota','Sienna','Good',
   'sunroof seals leaking inside vehicle','Roof Rack/Roof Accessory',NULL,'Legacy backfill — JOT# 202600172 · Paperwork: https://splashcarwashes.app.box.com/file/2124407438016','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-04','2026-02-04 00:00:00'),

  ('1562026006','johnson_city','Johnson City','Michael Bohn',
   2025,'Toyota','Carolla','Excellent',
   'scratches on drivers door jamb and trunk deck','Paint Damage',NULL,'Legacy backfill — JOT# 20200276 · Paperwork: https://splashcarwashes.app.box.com/file/2141706909001','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-16','2026-02-19 00:00:00'),

  ('1562026007','johnson_city','Johnson City','Mark Perry',
   2025,'Ford','Explorer','Excellent',
   'cracked passenger side accessory tail light','Other','Rear Tailight','Legacy backfill — JOT# 20200310 · Paperwork: https://splashcarwashes.app.box.com/file/2149040737802','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-27','2026-02-27 00:00:00'),

  ('1562026008','johnson_city','Johnson City','Craig Anderson',
   2026,'Dodge','Ram','Excellent',
   'scratches on bed of truck','Paint Damage',NULL,'Legacy backfill — JOT# 20200314 · Paperwork: https://splashcarwashes.app.box.com/file/2149044784022','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-27','2026-02-27 00:00:00'),

  ('1562026009','johnson_city','Johnson City','Kathleen Johnson',
   1999,'Toyota','Camry','Fair',
   'paint chips','Paint Damage',NULL,'Legacy backfill — JOT# 20200345 · Paperwork: https://splashcarwashes.app.box.com/file/2151835705552','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-17','2026-03-02 00:00:00'),

  ('1562026010','johnson_city','Johnson City','Drew Stevens',
   2016,'Nissan','Rouge','Good',
   'hood scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200347 · Paperwork: https://splashcarwashes.app.box.com/file/2151838307053','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-02','2026-03-02 00:00:00'),

  ('1562026011','johnson_city','Johnson City','Zenna Stickle',
   2021,'Chevrolet','Suburban','Excellent',
   'multiple scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200374 · Paperwork: https://splashcarwashes.app.box.com/file/2157870486606','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-07','2026-03-07 00:00:00'),

  ('1562026012','johnson_city','Johnson City','Jerry Eberhart',
   2016,'BMW','528i','Good',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200420 · Paperwork: https://splashcarwashes.app.box.com/file/2166541866822','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-15','2026-03-15 00:00:00'),

  ('1562026013','johnson_city','Johnson City','Nathan Sokol',
   2017,'Honda','Civic','Good',
   'window','Window',NULL,'Legacy backfill — JOT# 20200481 · Paperwork: https://splashcarwashes.app.box.com/file/2180376787030','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-24','2026-03-27 00:00:00'),

  ('1562026014','johnson_city','Johnson City','Katy bell Brozzetti',
   2017,'Cadillac','Suburban','Good',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200493 · Paperwork: https://splashcarwashes.app.box.com/file/2182758814971','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-30','2026-03-30 00:00:00'),

  ('1562026015','johnson_city','Johnson City','Linda Gretz',
   2024,'Honda','Suburban','Excellent',
   'melted marks on moldings','Other','Trim damage','Legacy backfill — JOT# 20200512 · Paperwork: https://splashcarwashes.app.box.com/file/2190786947835','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-07','2026-04-07 00:00:00'),

  ('1562026016','johnson_city','Johnson City','Jeneen Wiggins',
   2015,'Lincoln','Suburban','Good',
   'dash traction light on and license plate bent','Other','Electrical','Legacy backfill — JOT# 20200693 · Paperwork: https://splashcarwashes.app.box.com/file/2230078434812','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-14','2026-05-14 00:00:00'),

  ('1562026017','johnson_city','Johnson City','Jeremy Onishea',
   2021,'Chevrolet','Silverado','Good',
   'passenger mirror folded inwards cracking housing','PS Mirror',NULL,'Legacy backfill — JOT# 20200737 · Paperwork: https://splashcarwashes.app.box.com/file/2242109392215','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-22','2026-05-22 00:00:00'),

  ('1562026018','johnson_city','Johnson City','Brandon Rogers',
   2022,'Volkswagen','Tiguan','Excellent',
   'hood guard damaged','Other','Bug Shield','Legacy backfill — JOT# 20200746 · Paperwork: https://splashcarwashes.app.box.com/file/2242158556413','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',131.76,
   'backfill','2026-05-20','2026-05-22 00:00:00'),

  ('1562026019','johnson_city','Johnson City','Christopher Koedatich',
   2008,'Toyota','Camry','Good',
   'passenger rear door scratched','Paint Damage',NULL,'Legacy backfill — JOT# 20200793 · Paperwork: https://splashcarwashes.app.box.com/file/2257918425560','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-30','2026-05-31 00:00:00'),

  ('1562026020','johnson_city','Johnson City','Steven Tammariello',
   2023,'Mazda','Cx5','Excellent',
   'paint chips','Paint Damage',NULL,'Legacy backfill — JOT# 20200828','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-03','2026-06-03 00:00:00'),

  ('1562026021','johnson_city','Johnson City','Leland Cook',
   2014,'Cadillac','Xts4','Good',
   'product steaks','Paint Damage',NULL,'Legacy backfill — JOT# 20200850 · Paperwork: https://splashcarwashes.app.box.com/file/2272233825007','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-05','2026-06-06 00:00:00'),

  ('1562026022','johnson_city','Johnson City','Holly Benninger',
   2018,'Nissan',NULL,'Good',
   'front bumper cracked','License Plate',NULL,'Legacy backfill — JOT# 20200899 · Paperwork: https://splashcarwashes.app.box.com/file/2296492067681','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-17','2026-06-19 00:00:00');
