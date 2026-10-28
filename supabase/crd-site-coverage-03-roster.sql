-- crd-site-coverage-03-roster.sql
--
-- APPLIED 2026-10-24 to rewokyofschtvqgxrxwl. Verified counts below and the
-- jotform_site_lookup view: Kathie site -> Julia as supervisor, Rosemarie site
-- -> Renee, Julia/Renee own sites -> supervisor NULL (no double email).
--
-- Full CRD roster from Josh, 2026-10-24. Two regions:
--   Julia Morrisroe  - Julia, Kathie Sutherland, Kayla Beerwa, Mallory Jarka
--   Renee Tinelli    - Renee, Rosemarie Mantello, Brianna Rodriguez
--
-- Changes from crd-site-coverage-02 data:
--   * new region "Renee Tinelli";
--   * Rosemarie moves from Julia's region to Renee's;
--   * Cortland 126, Watertown 135, LeRay 148, Johnson City 156 move from
--     Rosemarie to Mallory (still Julia's region).
--
-- NOT SET HERE (no single site_number match; waiting on Josh):
--   Geneva (139 Geneva II / 158 Geneva III), Brockport II 140,
--   Bridgeport Lube 23, Turnersville (no site row; Blackwood 231?),
--   Nanuet, Eager Beaver (Port Jefferson), Brighton (coming soon) - no rows,
--   146 "4S-Buckley Rd" - was Rosemarie, not on the new list; left as is.
--
-- Upserts on site_number, so re-running is harmless.

begin;

insert into public.crd_regions (region, supervisor_name, supervisor_email, updated_by)
values ('Renee Tinelli', 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'operator 2026-10-24: CRD roster')
on conflict (region) do update
  set supervisor_name = excluded.supervisor_name,
      supervisor_email = excluded.supervisor_email,
      updated_at = now(), updated_by = excluded.updated_by;

insert into public.crd_site_coverage (site_number, crd_name, crd_email, crd_region, updated_by)
select v.site_number, v.crd_name, v.crd_email, v.crd_region, 'operator 2026-10-24: CRD roster'
from (values
  -- Julia Morrisroe (her own sites)
  (121, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Batavia Veterans
  (123, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Brockport
  (141, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Chili
  (138, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Penfield/Fairport
  (142, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Long Pond/Rochester
  (149, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Hamburg
  (143, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Spencerport
  (151, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Henrietta
  (137, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Williamsville
  (157, 'Julia Morrisroe', 'julia.morrisroe@splashcarwashes.com', 'Julia Morrisroe'), -- Batavia II W Main
  -- Kathie Sutherland
  (131, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Batavia Liberty
  (124, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Canandaigua
  (145, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Liverpool
  (132, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Newark (NY)
  (133, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Seneca Falls
  (144, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Clay
  (150, 'Kathie Sutherland', 'kathie.sutherland@splashcarwashes.com', 'Julia Morrisroe'), -- Fayetteville
  -- Kayla Beerwa
  (22,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Bridgeport
  (30,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Cheshire
  (82,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Cromwell
  (85,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- East Haven
  (51,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Hamden
  (60,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- New Haven
  (91,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Randolph
  (73,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Southbury
  (74,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- West Haven
  (95,  'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- Springfield
  (252, 'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- White Glove Wilmington
  (251, 'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- White Glove Newark II (DE)
  (241, 'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- White Glove Exton
  (232, 'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- White Glove Cherry Hill
  (233, 'Kayla Beerwa', 'kayla.beerwa@splashcarwashes.com', 'Julia Morrisroe'), -- White Glove Maple Shade
  -- Mallory Jarka
  (126, 'Mallory Jarka', 'mallory.jarka@splashcarwashes.com', 'Julia Morrisroe'), -- Cortland
  (148, 'Mallory Jarka', 'mallory.jarka@splashcarwashes.com', 'Julia Morrisroe'), -- LeRay (Evans Mills)
  (135, 'Mallory Jarka', 'mallory.jarka@splashcarwashes.com', 'Julia Morrisroe'), -- Watertown
  (156, 'Mallory Jarka', 'mallory.jarka@splashcarwashes.com', 'Julia Morrisroe'), -- Johnson City
  -- Renee Tinelli (her own sites)
  (182, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Bohemia
  (185, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Hempstead
  (186, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Commack
  (183, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Northport
  (184, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Lindenhurst
  (187, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- East Northport
  (19,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Bedford Hills
  (21,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Brewster
  (57,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Middletown
  (191, 'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Montgomery
  (75,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- White Plains Kensico
  (76,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- White Plains Central
  (77,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- White Plains Tarrytown
  (88,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Southeast
  (86,  'Renee Tinelli', 'rtinelli@splashcarwashes.com', 'Renee Tinelli'), -- Newburgh
  -- Rosemarie Mantello
  (122, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Binghamton
  (125, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Cicero
  (127, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Elmira Heights
  (147, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Oswego
  (134, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Vestal
  (197, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Guilderland
  (83,  'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Plattsburgh
  (196, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Rensselaer
  (221, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Rutland
  (222, 'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Shelburne
  (84,  'Rosemarie Mantello', 'rosemarie.mantello@splashcarwashes.com', 'Renee Tinelli'), -- Williston
  -- Brianna Rodriguez
  (89,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Derby
  (50,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Fairfield
  (90,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Milford
  (65,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Norwalk
  (68,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Shelton
  (80,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Wilton
  (70,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Westport
  (49,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Darien
  (53,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Stamford
  (32,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli'), -- Cos Cob
  (40,  'Brianna Rodriguez', 'brianna.rodriguez@splashcarwashes.com', 'Renee Tinelli')  -- Greenwich
) as v(site_number, crd_name, crd_email, crd_region)
on conflict (site_number) do update
  set crd_name = excluded.crd_name,
      crd_email = excluded.crd_email,
      crd_region = excluded.crd_region,
      updated_at = now(), updated_by = excluded.updated_by;

commit;

-- VERIFY
-- select crd_region, crd_name, count(*) from crd_site_coverage group by 1,2 order by 1,2;
--   expect Julia: Julia 10, Kathie 7, Kayla 15, Mallory 4; Renee: Renee 15,
--   Rosemarie 11 (+146 still on Rosemarie under Julia), Brianna 11.

-- FOLLOW-UP, APPLIED 2026-10-24 by Josh in the SQL editor (answers to the
-- "not set" list above): 140 Brockport II -> Julia; 139 Geneva II -> Kathie
-- (158 Geneva III is closed); 23 Bridgeport Lube and 231 Blackwood (the
-- "Turnersville" White Glove site) -> Kayla; 146 4S-Buckley Rd deleted (closed).
-- Result: Brianna 11, Julia 11, Kathie 8, Kayla 17, Mallory 4, Renee 15, Rosemarie 11.
--
-- begin;
-- insert into crd_site_coverage (site_number, crd_name, crd_email, crd_region, updated_by) values
--  (140,'Julia Morrisroe','julia.morrisroe@splashcarwashes.com','Julia Morrisroe','operator 2026-10-24: CRD roster'),
--  (139,'Kathie Sutherland','kathie.sutherland@splashcarwashes.com','Julia Morrisroe','operator 2026-10-24: CRD roster'),
--  (23,'Kayla Beerwa','kayla.beerwa@splashcarwashes.com','Julia Morrisroe','operator 2026-10-24: CRD roster'),
--  (231,'Kayla Beerwa','kayla.beerwa@splashcarwashes.com','Julia Morrisroe','operator 2026-10-24: CRD roster')
-- on conflict (site_number) do update set crd_name=excluded.crd_name, crd_email=excluded.crd_email,
--   crd_region=excluded.crd_region, updated_at=now(), updated_by=excluded.updated_by;
-- delete from crd_site_coverage where site_number = 146;
-- commit;
--
-- FOLLOW-UP 2, APPLIED 2026-10-27 via MCP: 159 Auburn + 160 Farmington ->
-- Kathie; 92 Falmouth + 234 Bayville -> Kayla (same upsert shape as above,
-- updated_by 'operator 2026-10-27: CRD roster').
-- Result: Brianna 11, Julia 11, Kathie 10, Kayla 19, Mallory 4, Renee 15,
-- Rosemarie 11 (81 sites).
--
-- STILL OPEN: Nanuet (new build, Route 59) and Eager Beaver (Terryville NY,
-- Port Jefferson Station area, under renovation) [Renee], and Brighton
-- [Kathie], have no locations row / site number yet.
