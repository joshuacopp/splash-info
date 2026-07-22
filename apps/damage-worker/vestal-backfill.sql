-- Vestal (location_code 'vestal') legacy damage-claim backfill — 30 claims.
--
-- Same design as cicero/binghamton backfills: each claim INSERTed DIRECTLY in its
-- terminal state (Open -> 'Pending RM Review'). Raw INSERTs are inert — no side effects.
--
-- PREREQUISITE: migration-incident-date.sql must already be applied.
--
-- MAPPING (sheet 'Vestal(134)' in CoppNotBingNotCiceroMigration.xlsx; damage_type &
--   fault for rows 001-017 per Josh's corrected paste):
--   * Responsibility 'DM Review'->determination 'RM Review'; 'no'->'No Responsibility'.
--   * cost->'Closed — Paid'; 'no reply from customer'->'Closed — Approved/No Response';
--     else closed->'Closed — Denied'.
--   * 'Equipment Related' fault normalized to 'Equipment Malfunction'.
--   * 0 row(s) still have NULL damage_type/fault (rows 018-021 not in corrected paste).
--
-- COST/RECEIPTS: 4 paid claim(s), total $5080.45. Reporting cost from Receipt
--   uploads via dashboard, NOT this file. Paid claims:
--     1342026010  Robert Vicioso  297.00
--     1342026011  Phillip Harkness  1124.99
--     1342026015  Tyler Wegmann  401.74
--     1342026029  Mike Miles  3256.72
--
-- Run (from apps/damage-worker):
--   wrangler d1 execute splash-damage-claims --remote --file=vestal-backfill.sql

INSERT INTO claims
  (claim_id, location_code, location_pretty, customer_name,
   vehicle_year, vehicle_make, vehicle_model, vehicle_condition,
   damage_description, damage_type, damage_other, staff_notes, determination,
   fault_category, lifecycle_state, claim_status, approved_amount,
   submitted_by, incident_date, submitted_at)
VALUES
  ('1342026001','vestal','Vestal','Stephanie Fuller',
   2015,'GMC','Acadia','Good',
   'vehicle was misguided in and resulted in running board getting caught','Running Board',NULL,'Legacy backfill — JOT# 202600071 · Paperwork: https://splashcarwashes.app.box.com/file/2107317791663 · no reply from customer','RM Review',
   'No Fault','Closed','Closed — Approved/No Response',NULL,
   'backfill','2026-01-17','2026-01-17 00:00:00'),

  ('1342026002','vestal','Vestal','James Pendergast',
   2021,'Toyota','Tacoma','Good',
   'applied brake causing collision with vehicle from behind','Collision',NULL,'Legacy backfill — JOT# 202600150 · Paperwork: https://splashcarwashes.app.box.com/file/2121844070128','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-01','2026-02-01 00:00:00'),

  ('1342026003','vestal','Vestal','Roland Toussaint',
   2016,'Ford','F150','Good',
   'vehicle in front of braked causing collision','Collision',NULL,'Legacy backfill — JOT# 202600151 · Paperwork: https://splashcarwashes.app.box.com/file/2121841330912','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-01','2026-02-01 00:00:00'),

  ('1342026004','vestal','Vestal','Adrianne Simmons',
   2016,'Jeep','Patriot','Good',
   'passenger mirror pushed forward','PS Mirror',NULL,'Legacy backfill — JOT# 202600176 · Paperwork: https://splashcarwashes.app.box.com/file/2125623949435','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-05','2026-02-05 00:00:00'),

  ('1342026005','vestal','Vestal','Erwin Manwarren',
   2017,'Ford','F150','Fair',
   'customer drove into the back of another vehicle','Collision',NULL,'Legacy backfill — JOT# 202600178 · Paperwork: https://splashcarwashes.app.box.com/file/2126622410349','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-05','2026-02-05 00:00:00'),

  ('1342026006','vestal','Vestal','Mark Meleski',
   2025,'Toyota','Highlander','Good',
   'customer drove into the back of another vehicle','Collision',NULL,'Legacy backfill — JOT# 202600180 · Paperwork: https://splashcarwashes.app.box.com/file/2126626100899','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-05','2026-02-05 00:00:00'),

  ('1342026007','vestal','Vestal','Dan Crimmins',
   2026,'Dodge','Ram 1500','Excellent',
   'brush got stuck on running board and tore off','Running Board',NULL,'Legacy backfill — JOT# 202600185 · Paperwork: https://splashcarwashes.app.box.com/file/2129287319424','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-07','2026-02-07 00:00:00'),

  ('1342026008','vestal','Vestal','Raymond Meyers',
   2022,'Dodge','Ram','Excellent',
   'After entering wash, customer placed running boards down and hit wheel boss','Running Board',NULL,'Legacy backfill — JOT# 202600234 · Paperwork: https://splashcarwashes.app.box.com/file/2136413682988','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-13','2026-02-13 00:00:00'),

  ('1342026009','vestal','Vestal','Andrew Solak',
   2024,'Toyota','Tacoma','Good',
   'Cover came off passenger mirror','PS Mirror',NULL,'Legacy backfill — JOT# 20200252 · Paperwork: https://splashcarwashes.app.box.com/file/2137862191157','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-17','2026-02-17 00:00:00'),

  ('1342026010','vestal','Vestal','Robert Vicioso',
   2006,'Chrysler','300','Good',
   'passenger mirror snapped off','PS Mirror',NULL,'Legacy backfill — JOT# 20200279 · Paperwork: https://splashcarwashes.app.box.com/file/2143443191653','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',297.00,
   'backfill','2026-02-20','2026-02-20 00:00:00'),

  ('1342026011','vestal','Vestal','Phillip Harkness',
   2024,'Toyota','Tacoma','Excellent',
   'Brush took cover off and cracked plastic on arm of assembly','PS Mirror',NULL,'Legacy backfill — JOT# 20200303 · Paperwork: https://splashcarwashes.app.box.com/file/2147597876846','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',1124.99,
   'backfill','2026-02-26','2026-02-26 00:00:00'),

  ('1342026012','vestal','Vestal','Theresa Behn',
   2022,'GMC','Sierra','Good',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200319 · Paperwork: https://splashcarwashes.app.box.com/file/2151389852459','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-02-28','2026-02-28 00:00:00'),

  ('1342026013','vestal','Vestal','Andy Wozniak',
   2021,'Ford','F150','Good',
   'was pushed into vehicle ahead of with trailer hitch','Collision',NULL,'Legacy backfill — JOT# 20200358 · Paperwork: https://splashcarwashes.app.box.com/file/2154161135634 · comp''d 2 mos UL','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-04','2026-03-04 00:00:00'),

  ('1342026014','vestal','Vestal','Bryan Chaffee',
   2023,'Dodge','Ram','Good',
   'running boards went down and got ripped off','Running Board',NULL,'Legacy backfill — JOT# 20200362 · Paperwork: https://splashcarwashes.app.box.com/file/2155019567642','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-04','2026-03-04 00:00:00'),

  ('1342026015','vestal','Vestal','Tyler Wegmann',
   2024,'Chevrolet','Silverado','Excellent',
   'passenger mirror snapped off','PS Mirror',NULL,'Legacy backfill — JOT# 20200414 · Paperwork: https://splashcarwashes.app.box.com/file/2166532170803','RM Review',
   'Equipment Malfunction','Closed','Closed — Paid',401.74,
   'backfill','2026-03-14','2026-03-14 00:00:00'),

  ('1342026016','vestal','Vestal','Shawn Frampton',
   2019,'Ford','F150','Good',
   'vehicle in front of braked causing collision','Collision',NULL,'Legacy backfill — JOT# 20200421 · Paperwork: https://splashcarwashes.app.box.com/file/2166542680179','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-15','2026-03-15 00:00:00'),

  ('1342026017','vestal','Vestal','Garrett Veruto',
   2021,'Chevrolet','Silverado','Good',
   'vehicle in front of braked causing collision','Collision',NULL,'Legacy backfill — JOT# 20200422 · Paperwork: https://splashcarwashes.app.box.com/file/2166539910646','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-15','2026-03-15 00:00:00'),

  ('1342026018','vestal','Vestal','Ed Dutkowsky',
   2023,'Honda','Ridgeline','Excellent',
   'multiple scratches w/blue marks','Paint Damage',NULL,'Legacy backfill — JOT# 20200424 · Paperwork: https://splashcarwashes.app.box.com/file/2166548339254','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-15','2026-03-15 00:00:00'),

  ('1342026019','vestal','Vestal','Sawyer Burns',
   2018,'Honda','Odyssey','Good',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200451 · Paperwork: https://splashcarwashes.app.box.com/file/2172837858118','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-21','2026-03-22 00:00:00'),

  ('1342026020','vestal','Vestal','Scott Costello',
   2025,'GMC','Denali','Excellent',
   'passenger mirror cover broke','PS Mirror',NULL,'Legacy backfill — JOT# 20200475 · Paperwork: https://splashcarwashes.app.box.com/file/2178895679975','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-03-14','2026-03-27 00:00:00'),

  ('1342026021','vestal','Vestal','Shawn Bevan',
   2024,'Chevrolet','2500','Good',
   'scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200551 · Paperwork: https://splashcarwashes.app.box.com/file/2195633413627 · courtesy buffed out','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-11','2026-04-11 00:00:00'),

  ('1342026022','vestal','Vestal','Justin Vymislicky',
   2015,'Dodge','Durango','Excellent',
   'scuff marks','Paint Damage',NULL,'Legacy backfill — JOT# 20200562 · Paperwork: https://splashcarwashes.app.box.com/file/2200311359653','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-15','2026-04-15 00:00:00'),

  ('1342026023','vestal','Vestal','Mike Bacon',
   2007,'Toyota','Tacoma','Good',
   'Antenna broke off','Antenna',NULL,'Legacy backfill — JOT# 20200589 · Paperwork: https://splashcarwashes.app.box.com/file/2206801057832 · extended UL as courtesy','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-22','2026-04-22 00:00:00'),

  ('1342026024','vestal','Vestal','Joe Hudy',
   2022,'Buick','Encore','Good',
   'antenna broken','Antenna',NULL,'Legacy backfill — JOT# 20200597 · Paperwork: https://splashcarwashes.app.box.com/file/2209089558357 · extended UL as courtesy','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-22','2026-04-24 00:00:00'),

  ('1342026025','vestal','Vestal','Danielle Knittle',
   2024,'Mazda','Cx5','Excellent',
   'dryer removed weather stripping','Other','Trim blew off','Legacy backfill — JOT# 20200617 · Paperwork: https://splashcarwashes.app.box.com/file/2213528192628 · extended UL as courtesy','RM Review',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-04-28','2026-04-28 00:00:00'),

  ('1342026026','vestal','Vestal','Marina Yakupova',
   2016,'Chevrolet','Colorado','Fair',
   'scratch on drivers side','Paint Damage',NULL,'Legacy backfill — JOT# 20200654 · Paperwork: https://splashcarwashes.app.box.com/file/2221964262205','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-04','2026-05-07 00:00:00'),

  ('1342026027','vestal','Vestal','Harriet Janneh',
   2016,'Ford','Escape','Good',
   'drivers mirror pushed backwards and glass panel damaged','DS Mirror',NULL,'Legacy backfill — JOT# 20200718 · Paperwork: https://splashcarwashes.app.box.com/file/2235739771078','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-18','2026-05-18 00:00:00'),

  ('1342026028','vestal','Vestal','Kim Majka',
   2021,'Dodge','Durango','Good',
   'hood scratches','Paint Damage',NULL,'Legacy backfill — JOT# 20200812 · Paperwork: https://splashcarwashes.app.box.com/file/2260130672481 · customer did not meet w/GM 2X;may reopen','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-05-31','2026-06-02 00:00:00'),

  ('1342026029','vestal','Vestal','Mike Miles',
   2024,'Chevrolet','Silverado','Excellent',
   'antenna broke off, chipped and scratched vehicle','Antenna',NULL,'Legacy backfill — JOT# 20200856 · Paperwork: https://splashcarwashes.app.box.com/file/2272284731904','RM Review',
   'Not Employee/Equipment','Closed','Closed — Paid',3256.72,
   'backfill','2026-06-07','2026-06-08 00:00:00'),

  ('1342026030','vestal','Vestal','Amber Taylor',
   2023,'Chrysler','Pacifica','Good',
   'Dent','Paint Damage',NULL,'Legacy backfill — JOT# 20200921 · Paperwork: https://splashcarwashes.app.box.com/file/2304237519863','No Responsibility',
   'No Fault','Closed','Closed — Denied',NULL,
   'backfill','2026-06-23','2026-06-23 00:00:00');
