-- Beekeeper locations -> Splash sites, ALTER 02 (2026-11-13). APPLIED 2026-11-13 via psql.
--
-- From the operator's paste of Beekeeper's own location list (id, name,
-- unique_name). Supersedes the guesses in personnel-placements-01.sql: every
-- row here is matched_by = 'manual' and the sync never overwrites it.
--
-- Mapping: unique_name when it is a 3-digit site number, else the name
-- against locations.site. Results checked one-to-one against locations: 82
-- sites, every site has exactly one Beekeeper location except 123 Brockport,
-- 146 4S-Buckley Rd and 158 Geneva III (none in Beekeeper). Nanuet (087) is in
-- Beekeeper but not in locations, so it stays 'unknown'.
-- Corrections vs ALTER 01: "Bridgeport Oil Change" is 23 (Bridgeport Lube),
-- not 22. "Newark DE" is 251 (Newark II), not 132 Newark NY.
--
-- Management groups: "No Location" (Beekeeper's default) = 011 SMG;
-- "Corporate Headquarters" and "Mike G - Admin Team" = 101 (Grubka area);
-- "Jason's Admin Team" and "Todd Wood's Admin Team" = other.
--
-- Guarded; safe to re-run.

begin;
insert into public.beekeeper_locations (org_unit_id,name,kind,site_number,matched_by,updated_by) select v.id::uuid,v.name,v.kind,v.site,'manual','beekeeper locations list 2026-11-13' from (values
('be7b1bd4-8cc7-4248-8b55-6a78009289ab','No Location','office_011',null),
('fad4fa0b-e8e6-4764-a64e-bb72d226f2bf','Corporate Headquarters','office_101',null),
('7f0aa794-e92d-4e68-9071-f308313f044d','Jason''s Admin Team','other',null),
('cd4da8be-3987-4a9c-9524-f60377e285e7','Todd Wood''s Admin Team','other',null),
('f3444c5a-9e13-4301-ac28-81532e947843','Mike G - Admin Team','office_101',null),
('ea1e4f40-dff7-4357-b32b-211275798556','Shelton','site',68),
('e0044ed4-d328-4ec1-9df8-e8cec9f702c7','Wilton','site',80),
('7505123f-39dd-4e9b-9a7d-76b2b35a2bef','Fairfield','site',50),
('5da48889-b2e0-4c6d-ac01-1530b11478e2','Derby','site',89),
('56fd0c55-ca92-4cbe-a26b-d0aa72042146','Norwalk','site',65),
('464d0f14-44aa-4461-a0d1-fbf8befffae3','Cos Cob','site',32),
('36fa2f13-54ec-44d2-bd39-ebe121a10ca4','Stamford','site',53),
('1cee812c-5b0f-45ab-a8f8-a541345edcc8','Milford','site',90),
('17aefdff-1735-4da0-b825-6ac9cdb93749','Darien','site',49),
('12d4aa5d-19d1-49b8-ad56-adebc8746d5f','Westport','site',70),
('f9b660a8-9106-4247-80ea-953b090c1182','Bridgeport Oil Change','site',23),
('f830fb0c-36e0-4415-9c19-18ae01bf279e','Southbury','site',73),
('e9c3f383-5b03-406e-82d7-7db314a4a886','Hamden','site',51),
('dd52bfae-f7dc-4d93-bed3-573d6d6e7c4d','West Haven','site',74),
('c1f302ce-817f-4599-9961-733f33f4dc9f','Bridgeport','site',22),
('4e7a516e-1556-4655-93df-602adfd66a3e','Cromwell','site',82),
('32e254d3-eb41-4b2d-aee0-b7b71ba2f69f','Springfield, MA','site',95),
('28f15c0a-61a5-43c0-be79-2aa4668cc4b1','Cheshire','site',30),
('1a0a3681-ecec-4265-b3ba-87016a791164','Randolph','site',91),
('17a0d796-febd-44e4-98f8-37b8d1adb5bd','Falmouth','site',92),
('0d4ae192-573b-4282-aec8-b100fe1ba90e','East Haven','site',85),
('00258bd4-0279-4495-b8ad-cc6177191270','New Haven','site',60),
('e6c87c0f-043c-4c7b-abb9-a16660ca809b','Middletown','site',57),
('d50d2cf7-b62d-49bd-be6c-b15e6b75f628','Bedford Hills','site',19),
('b8c4d051-2864-46f4-a6e7-f5ae110f486a','Brewster','site',21),
('b854c411-ca76-42ef-9083-ddd44b9f6559','White Plains III Tarrytown','site',77),
('8254903d-05b8-4d57-8ff6-6927a0e6ce7e','Montgomery','site',191),
('74523093-fa89-472f-a176-8557262485d5','Southeast','site',88),
('709e735d-c53f-4ea4-9ff7-85b8617e60ed','White Plains I Kensico','site',75),
('3c99829c-fca4-4e7b-9cc6-8acf7afe5b4f','Newburgh NY','site',86),
('3572a94d-ac6c-442b-a83b-bffac3e8d73f','Greenwich','site',40),
('172c9604-e90b-4ead-adc3-01daed166a99','Nanuet','unknown',null),
('15068834-4b7f-4d51-ae29-c17d13da1197','White Plains II Central','site',76),
('497fd517-e85d-4538-914d-2f067ae31b20','Bayville','site',234),
('fcd23060-d951-487b-8b4a-2fa911e62264','Exton','site',241),
('de0e42bc-2a11-4194-816f-c763ef7508b7','Newark DE','site',251),
('cac60fa7-a718-41e1-b39f-1874b2235e90','Wilmington','site',252),
('95727215-251e-40a4-8d01-8039076d312b','Maple Shade','site',233),
('62012ba4-d9d8-4e40-b5d5-96f7cb00bc89','Blackwood','site',231),
('1f98d384-9ccb-4bdf-9bf9-188780499bdc','Cherry Hill','site',232),
('ef572a64-56b9-44d6-8bdf-4ee336e5b876','Lindenhurst','site',184),
('e57f61af-d54b-42e8-af4d-3f1db90648a6','Port Jeff','site',188),
('b7ca1613-5757-456e-89e6-e7a3d903711c','Hempstead, NY','site',185),
('6b342840-20d5-4a5c-a958-26e8fbe120a3','Northport','site',183),
('534cc4c2-ffef-4812-8997-6ee3bc0dbc06','Bohemia','site',182),
('3992fbde-b9f8-4d67-8578-1c161ff6e2f9','Commack','site',186),
('24b05bce-1823-4a2c-88ef-ec78c914a567','Bronx,NY','site',96),
('0e642773-f3aa-4419-9e35-919e5321ba5b','East Northport','site',187),
('fef0485e-cdaa-4c1a-a5e8-955e156d0174','Johnson City','site',156),
('f5e70203-3435-4d77-a0c8-bed57e27d7e4','LeRay','site',148),
('9f92c8d4-48fb-41f4-9a8b-5570b2e815f3','Cortland','site',126),
('929592aa-9b24-4b4b-85bd-ccb531f39da1','Oswego','site',147),
('9030f2c9-a51a-4771-b7d4-18d554823fdf','Binghamton','site',122),
('8e1ed61c-de9e-46d5-8634-219515a256a0','Elmira','site',127),
('8d4fbb4d-0137-48b3-a6f7-7e11dc45c0c4','Vestal','site',134),
('60da9db8-8f79-4c8a-9b1b-03a33d9215b0','Cicero','site',125),
('2ed06a0b-744a-4f0b-9836-eda6fd6245c8','Watertown','site',135),
('fb6ad9ea-6a94-49c7-93d6-8811fe883ec0','Chili','site',141),
('b9825ad8-6446-40f6-8915-507c86f35fed','Henrietta','site',151),
('b59f5127-9318-4ce8-b405-74c4e2ddffee','Fairport','site',138),
('a493c81e-6a6b-4ecb-95a8-55045d2e7e99','Spencerport','site',143),
('a342cb2f-0f4d-4c10-9940-e5e030c603a5','Batavia Liberty','site',131),
('8052a90f-0970-4b6a-8004-a352e7913336','Batavia II','site',157),
('7cd6c36c-65d5-4e68-9f56-8279f6a0d4cf','Hamburg','site',149),
('6c40c0d8-0534-4f3b-9720-e2ffdd8443c6','Batavia Veterans','site',121),
('2ae34b28-ef64-4e9b-907a-8acdcfc45d92','Long Pond (Rochester)','site',142),
('22e59c08-0b69-4ebf-8244-893edfbadc0d','Brockport','site',140),
('118b25ae-1030-4c02-a373-545ece4c8f6f','Williamsville','site',137),
('f9e9faf6-b2cd-4bef-be42-9bd4793591d2','Farmington','site',160),
('aaad3999-f72e-40f7-883b-d30e6507e0f3','Liverpool','site',145),
('9ea024ff-d216-47d8-ba8d-e53e10a4583a','Seneca Falls','site',133),
('9d1a252c-ef78-48e0-8baa-5fd052f7ba30','Canandaigua','site',124),
('623afc3f-cd1c-4b54-a713-3a1703dbc086','Clay','site',144),
('3c860f9e-e0b2-4bd6-977d-5be48f4da5f5','Fayetteville','site',150),
('35ab64b4-09b9-47f3-9600-4fdbf595e35a','Auburn','site',159),
('211ad040-3426-4a58-b260-313a1aee7a59','Geneva II','site',139),
('0919f250-1e44-4192-9477-bb1c2c8978bd','Newark','site',132),
('fe3520f6-8b32-428d-a67f-9de24e18834a','Shelburne','site',222),
('e479ca9d-2319-4517-b9b9-e09411fcbc89','Guilderland','site',197),
('af970fd0-4752-4c6d-b6bd-78b25e5e0125','Plattsburgh','site',83),
('a83014b8-2968-4f47-8cd3-ab15a89160b5','Rensselaer','site',196),
('8e27761d-08d6-4ebc-aae9-a670f0f71982','Rutland','site',221),
('30ff6b14-9145-4a92-b737-27958e99be09','Williston','site',84)
) v(id,name,kind,site) on conflict (org_unit_id) do update set name=excluded.name, kind=excluded.kind, site_number=excluded.site_number, matched_by='manual', updated_at=now(), updated_by=excluded.updated_by;
commit;

-- The beekeeper-worker sync (GET /api/2/orgunits/locations) maps a NEW
-- location whose unique_name is a 3-digit site code by itself, stamping
-- matched_by = 'beekeeper_code'. Widen the check to allow it.
alter table public.beekeeper_locations drop constraint if exists beekeeper_locations_matched_by_check;
alter table public.beekeeper_locations add constraint beekeeper_locations_matched_by_check
  check (matched_by in ('schedule_number','site_name','gm_name','manual','beekeeper_code'));
