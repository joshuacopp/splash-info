-- car_counts daily load for 2026-09-09
-- note tag: '2026-09-09 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-09' AND end_date >= '2026-09-09';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-09 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-09','2026-09-09',94,'2026-09-09 daily'),
  ('batavia_ii','2026-09-09','2026-09-09',154,'2026-09-09 daily'),
  ('batavia_liberty','2026-09-09','2026-09-09',57,'2026-09-09 daily'),
  ('batavia_veterans','2026-09-09','2026-09-09',110,'2026-09-09 daily'),
  ('bedford','2026-09-09','2026-09-09',327,'2026-09-09 daily'),
  ('binghamton','2026-09-09','2026-09-09',219,'2026-09-09 daily'),
  ('blackwood','2026-09-09','2026-09-09',196,'2026-09-09 daily'),
  ('bohemia','2026-09-09','2026-09-09',467,'2026-09-09 daily'),
  ('brewster','2026-09-09','2026-09-09',80,'2026-09-09 daily'),
  ('bridgeport','2026-09-09','2026-09-09',179,'2026-09-09 daily'),
  ('brockport_ii','2026-09-09','2026-09-09',58,'2026-09-09 daily'),
  ('canandaigua','2026-09-09','2026-09-09',74,'2026-09-09 daily'),
  ('cherry_hill','2026-09-09','2026-09-09',175,'2026-09-09 daily'),
  ('cheshire','2026-09-09','2026-09-09',140,'2026-09-09 daily'),
  ('chili','2026-09-09','2026-09-09',58,'2026-09-09 daily'),
  ('cicero','2026-09-09','2026-09-09',75,'2026-09-09 daily'),
  ('clay','2026-09-09','2026-09-09',144,'2026-09-09 daily'),
  ('commack','2026-09-09','2026-09-09',189,'2026-09-09 daily'),
  ('cortland','2026-09-09','2026-09-09',137,'2026-09-09 daily'),
  ('coscob','2026-09-09','2026-09-09',206,'2026-09-09 daily'),
  ('cromwell','2026-09-09','2026-09-09',116,'2026-09-09 daily'),
  ('darien','2026-09-09','2026-09-09',225,'2026-09-09 daily'),
  ('derby','2026-09-09','2026-09-09',313,'2026-09-09 daily'),
  ('easthaven','2026-09-09','2026-09-09',506,'2026-09-09 daily'),
  ('eastnorthport','2026-09-09','2026-09-09',384,'2026-09-09 daily'),
  ('elmira_heights','2026-09-09','2026-09-09',208,'2026-09-09 daily'),
  ('exton','2026-09-09','2026-09-09',148,'2026-09-09 daily'),
  ('fairfield','2026-09-09','2026-09-09',151,'2026-09-09 daily'),
  ('fairport','2026-09-09','2026-09-09',53,'2026-09-09 daily'),
  ('falmouth','2026-09-09','2026-09-09',194,'2026-09-09 daily'),
  ('farmington','2026-09-09','2026-09-09',43,'2026-09-09 daily'),
  ('fayetteville','2026-09-09','2026-09-09',158,'2026-09-09 daily'),
  ('geneva_ii','2026-09-09','2026-09-09',94,'2026-09-09 daily'),
  ('greenwich','2026-09-09','2026-09-09',535,'2026-09-09 daily'),
  ('guilderland','2026-09-09','2026-09-09',322,'2026-09-09 daily'),
  ('hamburg','2026-09-09','2026-09-09',25,'2026-09-09 daily'),
  ('hamden','2026-09-09','2026-09-09',188,'2026-09-09 daily'),
  ('hempstead','2026-09-09','2026-09-09',209,'2026-09-09 daily'),
  ('henrietta','2026-09-09','2026-09-09',77,'2026-09-09 daily'),
  ('johnson_city','2026-09-09','2026-09-09',346,'2026-09-09 daily'),
  ('leray','2026-09-09','2026-09-09',95,'2026-09-09 daily'),
  ('lindenhurst','2026-09-09','2026-09-09',300,'2026-09-09 daily'),
  ('liverpool','2026-09-09','2026-09-09',44,'2026-09-09 daily'),
  ('maple_shade','2026-09-09','2026-09-09',120,'2026-09-09 daily'),
  ('middletown','2026-09-09','2026-09-09',994,'2026-09-09 daily'),
  ('milford','2026-09-09','2026-09-09',606,'2026-09-09 daily'),
  ('montogomery','2026-09-09','2026-09-09',348,'2026-09-09 daily'),
  ('newark','2026-09-09','2026-09-09',52,'2026-09-09 daily'),
  ('newark_ii','2026-09-09','2026-09-09',103,'2026-09-09 daily'),
  ('newburgh','2026-09-09','2026-09-09',245,'2026-09-09 daily'),
  ('newhaven','2026-09-09','2026-09-09',103,'2026-09-09 daily'),
  ('northport','2026-09-09','2026-09-09',440,'2026-09-09 daily'),
  ('norwalk','2026-09-09','2026-09-09',199,'2026-09-09 daily'),
  ('oswego','2026-09-09','2026-09-09',73,'2026-09-09 daily'),
  ('plattsburgh','2026-09-09','2026-09-09',174,'2026-09-09 daily'),
  ('randolph','2026-09-09','2026-09-09',316,'2026-09-09 daily'),
  ('rensselear','2026-09-09','2026-09-09',244,'2026-09-09 daily'),
  ('rochester','2026-09-09','2026-09-09',56,'2026-09-09 daily'),
  ('rutland','2026-09-09','2026-09-09',240,'2026-09-09 daily'),
  ('seneca_falls','2026-09-09','2026-09-09',82,'2026-09-09 daily'),
  ('shelburne','2026-09-09','2026-09-09',182,'2026-09-09 daily'),
  ('shelton','2026-09-09','2026-09-09',255,'2026-09-09 daily'),
  ('southeast','2026-09-09','2026-09-09',209,'2026-09-09 daily'),
  ('spencerport','2026-09-09','2026-09-09',72,'2026-09-09 daily'),
  ('springfield','2026-09-09','2026-09-09',182,'2026-09-09 daily'),
  ('stamford','2026-09-09','2026-09-09',251,'2026-09-09 daily'),
  ('tarrytown','2026-09-09','2026-09-09',818,'2026-09-09 daily'),
  ('vestal','2026-09-09','2026-09-09',333,'2026-09-09 daily'),
  ('watertown','2026-09-09','2026-09-09',77,'2026-09-09 daily'),
  ('westhaven','2026-09-09','2026-09-09',197,'2026-09-09 daily'),
  ('westport','2026-09-09','2026-09-09',221,'2026-09-09 daily'),
  ('whiteplainscentral','2026-09-09','2026-09-09',264,'2026-09-09 daily'),
  ('whiteplainskensico','2026-09-09','2026-09-09',333,'2026-09-09 daily'),
  ('williamsville','2026-09-09','2026-09-09',46,'2026-09-09 daily'),
  ('williston','2026-09-09','2026-09-09',160,'2026-09-09 daily'),
  ('wilmington','2026-09-09','2026-09-09',0,'2026-09-09 daily'),
  ('wilton','2026-09-09','2026-09-09',185,'2026-09-09 daily');

-- 77 rows, 16,053 cars total

-- Totals by winning source:
--   DRB: 566
--   ICS: 1,812
--   splashdb: 13,307
--   spot_ai: 368

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=159 (splashdb) + Splash Bedford Handwash & Lube-019=168 (splashdb)
--   greenwich: Splash Greenwich Express-040=208 (splashdb) + Splash Greenwich Handwash-040=327 (splashdb)
--   shelton: Splash Shelton Express-068=142 (splashdb) + Splash Shelton Handwash-068=113 (splashdb)

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
