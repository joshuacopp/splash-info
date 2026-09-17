-- mt-connecteam-job-01.sql
--
-- The Connecteam job catalogue: what each jobId IS, from the API rather than
-- from behaviour. Supersedes inference for every job listed here.
--
-- ===========================================================================
-- WHY THIS EXISTS, AND WHAT IT REPLACES
-- ===========================================================================
-- mt_connecteam_job_site recovers a job's site from where the vehicle sat,
-- because the jobs API was unavailable. The operator retrieved the full list
-- on 2026-09-17 (640 jobs, GET /jobs/v1/jobs?limit=500, paged on offset).
-- The derivation tested WELL against it -- every CONFIDENT row was right --
-- but a stated fact beats a good inference, and the list also answers a
-- question the inference structurally could not.
--
-- THE BLIND SPOT, WHICH IS THE REAL REASON THIS TABLE EXISTS
--   The modal-site method ALWAYS returns a site. It has no way to say "this
--   job is not a site at all", so every overhead job silently acquired one:
--   "CC Management" -> site 122, "Management-011" -> site 60 (New Haven),
--   "CC-Management" -> site 221. Nothing was mis-billed, because all three
--   graded INCONSISTENT or TOO_FEW_SHIFTS and are excluded from cost
--   attribution -- but that is luck, not design. An overhead job whose holder
--   happens to sit at one depot grades CONFIDENT and bills there, and no
--   check would fire.
--
-- `code` IS A COST-CENTRE CODE, NOT A SITE NUMBER. This matters and was not
-- obvious: "Auburn" carries 159, a real wash, but "Management-011" carries
-- 011 and THERE IS NO SITE 11. The codes therefore carry the site-vs-overhead
-- distinction directly, which is exactly what the behavioural method could
-- not supply. Do not join `code` to locations.site_number without checking
-- the row exists.
--
-- ONLY JOBS WORKED BY TRACKED MECHANICS ARE LOADED (124 of 640). The other
-- 516 are wash-floor roles (Greeter, Closer, Prepper), other departments, or
-- deleted duplicates, and none carries a single mechanic shift.
--
-- CRD IS NOT IN THIS TABLE AND THAT IS THE POINT. It is the single largest
-- job in connecteam_shifts (359 shifts) and it is Customer Relations -- ZERO
-- mechanic shifts. It was briefly treated here as the tracker's biggest
-- unattributed gap, which was wrong: mt_shift_job spans all 40 Connecteam
-- users while the tracker concerns only the 13 with vehicles. Same for
-- Office (138), SMG Admin (150), SMG (88) and HR (50). Before calling a job
-- a gap, check whether a mechanic ever punched it.
--
-- kind:
--   SITE      operating maintenance at a wash -- bills to that site
--   CAPX      capital project at a wash. Every site has a "<name> CapX" twin;
--             this is the "exactly two jobs per site" pattern that
--             corroborated the behavioural crosswalk, now named rather than
--             inferred. Capital work is not ordinarily a charge against a
--             site's OPERATING budget, so separating it is a COST-TREATMENT
--             DECISION for the operator -- flagged here, not applied.
--   OVERHEAD  management / admin -- never a site charge
--   PTO       paid leave. Not work, and not "unattributed" either.

create table if not exists public.mt_connecteam_job (
  job_id       text primary key,
  title        text not null,
  code         text,
  kind         text not null check (kind in ('SITE','CAPX','OVERHEAD','PTO')),
  loaded_at    timestamptz not null default now()
);
alter table public.mt_connecteam_job enable row level security;

truncate public.mt_connecteam_job;
insert into public.mt_connecteam_job (job_id, title, code, kind) values
('d2d22c91-3bf2-4ee3-a818-c4f8157ee6c1','CC Management',null,'OVERHEAD'),
('55afd07f-ba98-4450-aaee-de0610d1c9e3','Management-011','011','OVERHEAD'),
('874f1b26-95fd-4b6e-8ceb-12e25209b289','CC-Management',null,'OVERHEAD'),
('1860fe05-95ba-42e5-8323-8a87c83f671e','PTO',null,'PTO'),
('b84d6509-14c9-4fec-b948-ca9472fedac6','PTO',null,'PTO'),
('c3b7518e-1c53-405d-95c3-1a6a6824b4ad','Batavia Veterans',null,'SITE'),
('d61bd8a7-9b6b-4d90-b049-4e0f212a2a5b','Williston',null,'SITE'),
('7294f7f4-8558-f9ad-f126-4664520aa977','Auburn','159','SITE'),
('d23fadfd-6412-455c-ac41-f490a117a896','WP Tarrytown',null,'SITE'),
('27720599-bf6d-4cfa-9b11-27aebf65894b','PT Bohemia',null,'SITE'),
('9664e9bf-4ee6-4931-aba3-5603b8a22393','Milford-090','090','SITE'),
('ed7689dd-599b-408b-b9a2-d4598a062a30','Rutland',null,'SITE'),
('886876b4-fe1b-43e9-b653-ab64305b9643','Binghamton',null,'SITE'),
('666d410e-2645-2f5a-fc8e-6de2b7461eb4','Batavia II','157','SITE'),
('8caacc59-a533-4271-ad9f-4ac0bc3eb096','East Haven',null,'SITE'),
('de68cc29-b21b-4844-9e98-84ed915ce66e','4S Oswego Road',null,'SITE'),
('6b615eae-3650-653c-0078-1382b36381ef','Shelburne',null,'SITE'),
('260da864-eea2-4c93-9470-0d529cdc914f','Derby-089','089','SITE'),
('f58deda4-f4bd-44ff-8178-ff61bff9c925','Cortland',null,'SITE'),
('70cd98be-3cfe-5a31-b660-8ed85de55713','Fayetteville',null,'SITE'),
('a62d2982-a2bb-4dc4-b3c9-f88cb52d2d61','Watertown',null,'SITE'),
('93a2c6e1-575a-4166-9ac5-bedceb477e8b','Plattsburgh',null,'SITE'),
('8042997b-6265-4303-b13a-9b611048381d','Norwalk',null,'SITE'),
('6bd06a35-8fb5-451f-8aab-e2760ae182d3','Elmira',null,'SITE'),
('abcf9e9a-a680-49cb-be96-3f3924045188','Oswego',null,'SITE'),
('442d433a-6994-9766-68dd-9471393a0a33','Johnson City',null,'SITE'),
('c505e960-0248-25b4-bd40-ed49358d9d45','Clay',null,'SITE'),
('7b3d3fdb-ccaf-c7dc-a881-aa4f29a62a1b','E.Northport-187','187','SITE'),
('3164ca31-7253-2b82-6523-234d1ef1b156','Farmington','160','SITE'),
('4a0dbc6a-7995-4480-a180-be11118e3de5','Brockport 2',null,'SITE'),
('a28295c4-d64f-4b79-b91e-45f30ceb994a','Spencerport',null,'SITE'),
('38d23a5e-a7ce-e36e-3535-ab7cb9d76f27','Henrietta',null,'SITE'),
('3b781b2e-27fc-4c6b-b8d1-4a7635c2c27b','LeRay',null,'SITE'),
('db59a890-ff4f-4552-9b9d-3d286a2fe641','Fairport',null,'SITE'),
('12108396-469b-47ae-b2e7-60ab5f2cea61','Vestal',null,'SITE'),
('eba38226-5150-466a-9aa0-fda5235cf575','West Haven',null,'SITE'),
('e05354a6-cef9-4086-a3ec-0e4fec41389d','Westport',null,'SITE'),
('c9f75440-25c8-4fc9-9bcc-11f24df85ca7','Shelton',null,'SITE'),
('b0842bd9-9e5e-1391-18aa-aac1c986adf5','Commack-186','186','SITE'),
('6c4d9032-dc17-436e-aafc-cdc2b3137415','Rensselaer',null,'SITE'),
('b804760d-86d3-548e-1545-427dffd627a9','Hamburg',null,'SITE'),
('6d07ada7-8e54-49cb-95da-b482355c85d9','Long Pond',null,'SITE'),
('c7ef0aa9-beff-454c-bc55-423636a92c4c','Canandaigua',null,'SITE'),
('5eb79a5d-10e7-470b-bb12-92f1fe17e127','Cicero',null,'SITE'),
('853b7210-549b-4410-9631-6937eefdada6','Bedford','019','SITE'),
('75cdb458-8c24-4e45-b84e-296643465275','Newark',null,'SITE'),
('11c93bfe-f685-4291-8122-b05849c2d62f','WP Kensico',null,'SITE'),
('6778eebd-a150-4d1c-913d-e383721d767c','Seneca Falls',null,'SITE'),
('07458982-9da5-4a87-a3f1-15c262413acd','Chili',null,'SITE'),
('ab92142e-b64f-490d-bfe4-f66cfa69b976','Cromwell',null,'SITE'),
('5c27b847-2aa4-4914-a23a-1ff78649f17e','Darien',null,'SITE'),
('a6d611bf-60a4-4d08-8932-c4523854b03e','Geneva 2',null,'SITE'),
('5cc8b239-3d39-4d0c-a9ef-5e02f385460b','Batavia Liberty',null,'SITE'),
('640f503b-51fd-4bdc-bc59-eb93d438ac49','PT Lindenhurst',null,'SITE'),
('a6e99329-6d1b-4193-8d91-8856f7e60b17','Cheshire',null,'SITE'),
('597109af-96f4-4aff-89b6-76f8d33bc66f','Williamsville',null,'SITE'),
('694877ad-f99a-2da4-7a59-a5a9d0ac5d34','Hempstead','185','SITE'),
('0d5dcc86-ef09-4f08-abe1-9cb328de30bf','WP Central',null,'SITE'),
('1e04cfcf-bf58-4f9c-ba25-f8f7b0b3f330','Montgomery',null,'SITE'),
('e4405a6c-927c-470e-b10d-8b6bbd2c0af5','Hamden',null,'SITE'),
('f10b1a1b-6788-4b28-a99d-8cea5b8d3a16','Randolph',null,'SITE'),
('8c621665-d586-4961-a6c9-87acef5358e2','Fairfield',null,'SITE'),
('c013772c-5181-7125-96eb-7eebba96edee','Newburgh',null,'SITE'),
('6bd57433-8159-48a1-bbb4-c0bd5e0ee8a4','New Haven',null,'SITE'),
('46a856e3-4a48-4ff8-bf6e-f15a4690fcad','Greenwich',null,'SITE'),
('55508831-4c61-5403-570a-2c6a45480fcb','Falmouth','092','SITE'),
('c9b2fd37-f54d-4605-9cb8-286b0f1c9c42','PT Elwood-Northport',null,'SITE'),
('84463fd4-94d9-4f5b-be54-253162d55069','Middletown',null,'SITE'),
('65dacfe2-4988-421e-b17e-aaa37a618625','Southeast',null,'SITE'),
('55552fbd-17e8-938b-666e-2697f2e2ee4e','Springfield',null,'SITE'),
('2b05d81c-325a-4e8e-aaa6-2e8bb88bd928','Wilton',null,'SITE'),
('fdf9e022-a85a-4b1c-b8c2-5ef42303de48','Brockport 1',null,'SITE'),
('7479f237-ad65-488a-bf5f-83f420dd4eb2','Cos Cob',null,'SITE'),
('3062206a-2756-4911-806e-ada7dcc02a3a','Bridgeport',null,'SITE'),
('677221ca-9ff8-4638-9622-1059e1dd8483','Stamford',null,'SITE'),
('99f1d4b8-4a1e-ee62-66b2-cf6fe29eb5c5','Blackwood-231','231','SITE'),
('7d85dd50-9c8b-0ead-331e-d447d8e9335e','Cherry Hill-232','232','SITE'),
('ca048d5d-0499-41d2-db64-a24a479ecd8a','Wilmington-252',null,'SITE'),
('ff6f9965-9328-4d0b-a2db-17170116b185','Cortland',null,'SITE'),
('d5197c1f-5b68-4bc6-8211-f8119c1e80ad','Brewster',null,'SITE'),
('8b1dea1e-85fc-4ba9-b910-f86ea2421199','Liverpool',null,'SITE'),
('6bbd8278-b5fe-4c8b-a593-9be7850f9e89','Geneva 1',null,'SITE'),
('7509dfa1-d9fb-26c9-0449-f55b83356530','Port Jefferson','188','SITE'),
('1c4092df-1fd8-4c42-b483-394faa23e59e','Rensselaer',null,'SITE'),
('8ebbb1b9-b8b8-4d25-954e-dd26639e42f7','Newark',null,'SITE'),
('5ce9edca-c0d3-4531-cca9-b18651cd4b2a','Brighton-155','155','SITE'),
('c20dfb97-0ce6-44b2-9cb9-76f3f38158f5','Cicero',null,'SITE'),
('200f9e55-d264-4a9a-9aa0-f0009633293e','Seneca Falls CAPX',null,'CAPX'),
('1e4e2682-5a83-4c9d-a0ac-5217ca0963ed','Shelton CapX',null,'CAPX'),
('ffc642e5-8aea-46b2-aeb2-6f5604c91c89','Batavia Veterans CAPX',null,'CAPX'),
('ab9baf8c-90f6-ee60-1c34-082df5578a15','Brighton-155 CapX','155','CAPX'),
('58e989ae-0a21-93dc-31b5-b29779dcb737','Farmington CapX','160','CAPX'),
('4bd8b085-4176-8de2-01f0-49e8e7421a0b','Auburn CapX','159','CAPX'),
('6f0d6e54-60af-47a3-8fb0-bc56dcc97263','Randolph CapX',null,'CAPX'),
('946060e6-8fcb-4f20-bafe-324d7e6253cb','Darien CapX',null,'CAPX'),
('cda0d3d8-05cb-4d95-8097-d1b87ec80d44','West Haven CapX',null,'CAPX'),
('3f04e99c-27c1-480b-9791-db18bad0abc3','Middletown CapX',null,'CAPX'),
('3665977b-17bf-47fb-a557-b4cfb2415982','Norwalk CapX',null,'CAPX'),
('419813cd-1a08-446e-b8ae-06bb90424c98','East Haven CapX',null,'CAPX'),
('f6b27706-3a26-427b-a7af-c4b3a1236129','Batavia Veterans CapX',null,'CAPX'),
('81379c0d-70f2-6a16-0c45-08f2f22f31ac','Johnson City CapX',null,'CAPX'),
('c923f1bd-696d-4703-af96-f3f114eaba17','Cromwell CapX',null,'CAPX'),
('b102f1ff-7e33-4402-8ddc-29c4a753077f','Derby CapX','089','CAPX'),
('e9f755c7-81f0-4bd5-ab0a-0a2b5bb26967','New Haven CapX',null,'CAPX'),
('c32b85cb-ce57-43f7-984a-34fa55b9b678','Hamden CapX',null,'CAPX'),
('851a3e6b-2e16-a809-451b-39445738b60e','Springfield CapX',null,'CAPX'),
('9d95c970-27f9-5073-33f4-af37deb6ab4e','Blackwood-231 CapX','231','CAPX'),
('eeece76e-cca0-42d7-bf4e-bbb8e22196e7','Binghamton CapX',null,'CAPX'),
('cbf07b90-3409-4b9e-ab59-f4f46ca28612','Cheshire CapX',null,'CAPX'),
('23b3be60-6993-43af-b0b8-360e17c5b7c7','Vestal CapX',null,'CAPX'),
('e21274d7-7b03-43a1-9b54-1a00874de5f5','Greenwich CapX',null,'CAPX'),
('8599cc4e-f4c4-060a-02ee-1fa6b6a43885','Cherry Hill CapX',null,'CAPX'),
('dc30b3fe-4a8c-477e-9835-9c8753579c8f','Geneva 2 CAPX',null,'CAPX'),
('cb8402a8-9749-48f9-a29c-64ff8f7e09b8','Brockport 2 CAPX',null,'CAPX'),
('41a20af0-8ac3-4a37-36d2-a86b5dfd2268','Henrietta CapX',null,'CAPX'),
('5931c122-f7b7-4c3b-840a-89d56997267d','Westport CapX',null,'CAPX'),
('7da2346d-1a76-474d-8c71-7ea50f7c59cd','Cos Cob CapX',null,'CAPX'),
('f5f7485f-d312-4920-b653-89b09003dc1a','PT Bohemia CapX',null,'CAPX'),
('aa9b5151-0431-64f0-04f0-63fe58fc4bd2','E.Northport CapX','187','CAPX'),
('e732343e-3388-b972-844f-370c56ba2e5c','Commack CapX','186','CAPX'),
('4217e537-2d55-4163-98a3-e3706a6f8b38','Fairfield CapX',null,'CAPX'),
('b7e945dc-fc37-4709-96ad-84894442d71e','WP Tarrytown CapX',null,'CAPX'),
('e7731793-9872-4d0d-8afb-6e22a74c0487','Batavia Liberty CAPX',null,'CAPX');

-- ===========================================================================
-- MEASURED ON LOAD, 2026-09-17 -- MECHANIC TIME BY WHAT THE JOB CLAIMS
-- ===========================================================================
--   SITE      82 jobs  1,047 shifts  3,702 h  67.7%
--   CAPX      36 jobs    163 shifts  1,054 h  19.3%
--   OVERHEAD   3 jobs    133 shifts    506 h   9.3%
--   PTO        2 jobs     30 shifts    205 h   3.8%
-- Coverage is complete: zero mechanic-worked jobs are missing from this table.
--
-- MIND THE DENOMINATOR. These 5,467 h are every mechanic PUNCH (13 people,
-- including the one IT staffer with a vehicle). mt_punch_allocation totals
-- 4,610 h because it is the GPS-overlapping paid window for the 12-person
-- field crew. The two are different measures and must not be mixed in one
-- sentence: this table says what the punch CLAIMED, the allocation says where
-- the vehicle WAS.
--
-- NEARLY A FIFTH OF CLAIMED MECHANIC TIME IS CAPITAL WORK, and the tracker
-- currently charges it to sites identically to operating maintenance. That is
-- the single largest consequence of loading this table, and it is a decision
-- for the operator rather than a bug to fix.
