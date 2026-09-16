-- mt-device-person-01.sql
--
-- Gaps G2 and G3 from apps/maintenance-tracker/PLAN.md, closed together as one
-- table because they are one question: which human is this vehicle, and what is
-- he called in each of the three systems.
--
-- APPLIED 2026-09-16 via MCP apply_migration (migrations mt_device_person_01
-- and mt_device_person_02_maintainx). 13 devices, 13 distinct Connecteam users,
-- 13 distinct MaintainX users, no collisions.
--
-- WHY A SEED TABLE AND NOT A JOIN
--
--   Geotab names devices after whoever drives them, so a name join looks
--   adequate. It is not, and the live data says so three different ways:
--     b8   "Chuck Zimmer"   is Charles Zimmer      nickname
--     b36F "Tom Mezzo"      is Thomas Mezzo        nickname
--     b36D "Dylan Keith"    is "Dylan  Keith"      DOUBLE SPACE in Connecteam
--   Four more carry a trailing space on the Geotab side. And there are two
--   Joshes. The third case is the instructive one: not a nickname, not a
--   trailing space, just invisible whitespace in the middle of a string that no
--   normalisation rule would have been written in advance to catch.
--
-- G3: THE EMAIL JOIN GETS 8 OF 13, AND THE MISSES ARE NOT RANDOM
--
--   PLAN.md hoped an email join would close G3 outright. Measured: 8 match.
--   The 5 that do not are exactly the 5 whose Connecteam address is personal
--   rather than @splashcarwashes.com -- the two systems genuinely hold
--   different addresses for those people, so no normalisation fixes it. All 5
--   resolve unambiguously on full name against maintainx_users.
--
--   Resolved once and STORED. A name join that works today breaks silently the
--   first time a name changes in one system and not the other, and it breaks in
--   the direction of attributing a mechanic's hours to nobody.
--
-- MAINTENANCE: this is hand-maintained on purpose. When a transponder is
-- reassigned, edit the row. Nothing derives it automatically.
--
-- NOT SEEDED HERE: the spares (b3, b38C "EXTRA TRANSPONDER", bA "Spare - Not
-- working", bDC/bDD/b254 "Splash New"). They are excluded from mechanic
-- reporting but should NOT be excluded from monitoring -- a spare transponder
-- showing sustained movement is its own alert. Add them with
-- is_mechanic = false if that alert is ever built.

begin;

create table if not exists mt_device_person (
  device_id           text primary key,
  connecteam_user_id  bigint not null,
  maintainx_user_id   bigint,
  display_name        text   not null,
  -- Straight from geotab_devices. Geotab uses 2050-01-01 as its "no end"
  -- sentinel; stored as NULL so "currently assigned" is `active_to is null`
  -- rather than a magic date everyone has to know.
  active_from         timestamptz,
  active_to           timestamptz,
  is_mechanic         boolean not null default true,
  note                text,
  created_at          timestamptz not null default now()
);

insert into mt_device_person
  (device_id, connecteam_user_id, maintainx_user_id, display_name, active_from, active_to, is_mechanic, note) values
  ('b1',   2229900,  452446,  'Dana Wilson',     '2023-01-16 14:27:24.228+00', null, true, null),
  ('b2',   14250258, 1255847, 'Josh Cifuentes',  '2023-01-16 14:27:24.229+00', null, true, 'Connecteam spells the surname lower-case'),
  ('b4',   8552864,  750392,  'Josh Conley',     '2023-01-16 14:27:24.229+00', null, true, 'second Josh - the reason a name join is not safe; personal email, matched by name'),
  ('b5',   1122039,  452450,  'Chris DeClercq',  '2026-06-30 14:29:18.929+00', null, true, null),
  ('b6',   3324247,  452449,  'Ryan Parry',      '2023-01-16 14:27:24.229+00', null, true, 'personal email, matched by name'),
  ('b7',   13333061, 1167458, 'David Robinson',  '2026-02-17 19:30:21.101+00', null, true, 'trailing space on the Geotab name; personal email, matched by name'),
  ('b8',   2217732,  452445,  'Charles Zimmer',  '2026-02-17 19:29:56.638+00', null, true, 'Geotab says Chuck'),
  ('b9',   5855509,  477066,  'Phillip Ritter',  '2023-01-16 14:27:24.229+00', null, true, 'personal email, matched by name'),
  ('b36B', 12242553, 1068175, 'Derrick Grauer',  '2026-02-25 16:34:33.536+00', null, true, 'trailing space on the Geotab name'),
  ('b36C', 3146122,  426577,  'Scott Butler',    '2026-02-25 16:34:33.535+00', null, true, 'trailing space on the Geotab name'),
  ('b36D', 9611831,  854949,  'Dylan Keith',     '2026-02-25 16:34:33.536+00', null, true, 'DOUBLE SPACE inside the Connecteam name; personal email, matched by name'),
  ('b36E', 2229901,  452448,  'Oscar Hernandez', '2026-02-25 16:34:33.536+00', null, true, 'trailing space on the Geotab name'),
  ('b36F', 18805857, 1459125, 'Thomas Mezzo',    '2026-02-25 16:34:33.536+00', null, true, 'Geotab says Tom')
on conflict (device_id) do nothing;

alter table mt_device_person enable row level security;

commit;
