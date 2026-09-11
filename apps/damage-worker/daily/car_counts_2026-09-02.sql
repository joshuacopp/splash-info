-- car_counts daily load for 2026-09-02
-- note tag: '2026-09-02 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-02' AND end_date >= '2026-09-02';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-02 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-02','2026-09-02',198,'2026-09-02 daily'),
  ('batavia_ii','2026-09-02','2026-09-02',255,'2026-09-02 daily'),
  ('batavia_liberty','2026-09-02','2026-09-02',90,'2026-09-02 daily'),
  ('batavia_veterans','2026-09-02','2026-09-02',214,'2026-09-02 daily'),
  ('bedford','2026-09-02','2026-09-02',123,'2026-09-02 daily'),
  ('binghamton','2026-09-02','2026-09-02',104,'2026-09-02 daily'),
  ('blackwood','2026-09-02','2026-09-02',34,'2026-09-02 daily'),
  ('bohemia','2026-09-02','2026-09-02',310,'2026-09-02 daily'),
  ('brewster','2026-09-02','2026-09-02',29,'2026-09-02 daily'),
  ('bridgeport','2026-09-02','2026-09-02',130,'2026-09-02 daily'),
  ('brockport_ii','2026-09-02','2026-09-02',201,'2026-09-02 daily'),
  ('canandaigua','2026-09-02','2026-09-02',131,'2026-09-02 daily'),
  ('cherry_hill','2026-09-02','2026-09-02',28,'2026-09-02 daily'),
  ('cheshire','2026-09-02','2026-09-02',103,'2026-09-02 daily'),
  ('chili','2026-09-02','2026-09-02',214,'2026-09-02 daily'),
  ('cicero','2026-09-02','2026-09-02',159,'2026-09-02 daily'),
  ('clay','2026-09-02','2026-09-02',285,'2026-09-02 daily'),
  ('commack','2026-09-02','2026-09-02',83,'2026-09-02 daily'),
  ('cortland','2026-09-02','2026-09-02',198,'2026-09-02 daily'),
  ('coscob','2026-09-02','2026-09-02',108,'2026-09-02 daily'),
  ('cromwell','2026-09-02','2026-09-02',91,'2026-09-02 daily'),
  ('darien','2026-09-02','2026-09-02',101,'2026-09-02 daily'),
  ('derby','2026-09-02','2026-09-02',277,'2026-09-02 daily'),
  ('easthaven','2026-09-02','2026-09-02',474,'2026-09-02 daily'),
  ('eastnorthport','2026-09-02','2026-09-02',185,'2026-09-02 daily'),
  ('elmira_heights','2026-09-02','2026-09-02',181,'2026-09-02 daily'),
  ('exton','2026-09-02','2026-09-02',23,'2026-09-02 daily'),
  ('fairfield','2026-09-02','2026-09-02',80,'2026-09-02 daily'),
  ('fairport','2026-09-02','2026-09-02',176,'2026-09-02 daily'),
  ('falmouth','2026-09-02','2026-09-02',228,'2026-09-02 daily'),
  ('farmington','2026-09-02','2026-09-02',138,'2026-09-02 daily'),
  ('fayetteville','2026-09-02','2026-09-02',282,'2026-09-02 daily'),
  ('geneva_ii','2026-09-02','2026-09-02',356,'2026-09-02 daily'),
  ('greenwich','2026-09-02','2026-09-02',264,'2026-09-02 daily'),
  ('guilderland','2026-09-02','2026-09-02',423,'2026-09-02 daily'),
  ('hamburg','2026-09-02','2026-09-02',92,'2026-09-02 daily'),
  ('hamden','2026-09-02','2026-09-02',175,'2026-09-02 daily'),
  ('hempstead','2026-09-02','2026-09-02',140,'2026-09-02 daily'),
  ('henrietta','2026-09-02','2026-09-02',223,'2026-09-02 daily'),
  ('johnson_city','2026-09-02','2026-09-02',176,'2026-09-02 daily'),
  ('leray','2026-09-02','2026-09-02',347,'2026-09-02 daily'),
  ('lindenhurst','2026-09-02','2026-09-02',206,'2026-09-02 daily'),
  ('liverpool','2026-09-02','2026-09-02',127,'2026-09-02 daily'),
  ('maple_shade','2026-09-02','2026-09-02',19,'2026-09-02 daily'),
  ('middletown','2026-09-02','2026-09-02',261,'2026-09-02 daily'),
  ('milford','2026-09-02','2026-09-02',446,'2026-09-02 daily'),
  ('montogomery','2026-09-02','2026-09-02',96,'2026-09-02 daily'),
  ('newark','2026-09-02','2026-09-02',191,'2026-09-02 daily'),
  ('newark_ii','2026-09-02','2026-09-02',20,'2026-09-02 daily'),
  ('newburgh','2026-09-02','2026-09-02',99,'2026-09-02 daily'),
  ('newhaven','2026-09-02','2026-09-02',88,'2026-09-02 daily'),
  ('northport','2026-09-02','2026-09-02',233,'2026-09-02 daily'),
  ('norwalk','2026-09-02','2026-09-02',116,'2026-09-02 daily'),
  ('oswego','2026-09-02','2026-09-02',204,'2026-09-02 daily'),
  ('plattsburgh','2026-09-02','2026-09-02',425,'2026-09-02 daily'),
  ('randolph','2026-09-02','2026-09-02',482,'2026-09-02 daily'),
  ('rensselear','2026-09-02','2026-09-02',322,'2026-09-02 daily'),
  ('rochester','2026-09-02','2026-09-02',246,'2026-09-02 daily'),
  ('rutland','2026-09-02','2026-09-02',370,'2026-09-02 daily'),
  ('seneca_falls','2026-09-02','2026-09-02',302,'2026-09-02 daily'),
  ('shelburne','2026-09-02','2026-09-02',315,'2026-09-02 daily'),
  ('shelton','2026-09-02','2026-09-02',153,'2026-09-02 daily'),
  ('southeast','2026-09-02','2026-09-02',100,'2026-09-02 daily'),
  ('spencerport','2026-09-02','2026-09-02',254,'2026-09-02 daily'),
  ('springfield','2026-09-02','2026-09-02',238,'2026-09-02 daily'),
  ('stamford','2026-09-02','2026-09-02',114,'2026-09-02 daily'),
  ('tarrytown','2026-09-02','2026-09-02',450,'2026-09-02 daily'),
  ('vestal','2026-09-02','2026-09-02',160,'2026-09-02 daily'),
  ('watertown','2026-09-02','2026-09-02',290,'2026-09-02 daily'),
  ('westhaven','2026-09-02','2026-09-02',186,'2026-09-02 daily'),
  ('westport','2026-09-02','2026-09-02',141,'2026-09-02 daily'),
  ('whiteplainscentral','2026-09-02','2026-09-02',125,'2026-09-02 daily'),
  ('whiteplainskensico','2026-09-02','2026-09-02',176,'2026-09-02 daily'),
  ('williamsville','2026-09-02','2026-09-02',195,'2026-09-02 daily'),
  ('williston','2026-09-02','2026-09-02',333,'2026-09-02 daily'),
  ('wilmington','2026-09-02','2026-09-02',24,'2026-09-02 daily'),
  ('wilton','2026-09-02','2026-09-02',104,'2026-09-02 daily');

-- 77 rows, 15,040 cars total

-- Totals by winning source:
--   DRB: 745
--   ICS: 711
--   splashdb: 12,931
--   spot_ai: 653

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=70 (splashdb) + Splash Bedford Handwash & Lube-019=53 (splashdb)
--   greenwich: Splash Greenwich Express-040=96 (splashdb) + Splash Greenwich Handwash-040=168 (splashdb)
--   shelton: Splash Shelton Express-068=98 (splashdb) + Splash Shelton Handwash-068=55 (splashdb)

-- Deliberately not inserted:
--   Corporate -- ICS non-store
--   Online Portal -- not a store
--   Splash Bayville-234 -- site 234 not in pricing_simple
--   Splash Bridgeport Lube-023 -- site 023 has no location_code
--   Splash Brighton-155 -- site 155 not in pricing_simple
--   Splash Management-011 -- not a store
--   Splash Nanuet-087 -- site 087 not in pricing_simple
--   Splash Port Jefferson-188 -- site 188 not in pricing_simple
--   Splash USA Car Wash Bronx-096 -- site 096 has no location_code
--   Splash24 Brockport-123 -- blank splashdb
