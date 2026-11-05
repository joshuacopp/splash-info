-- IT Issue Tracker 04 (2026-11-05): device list renamed by the operator.
--   Tablet -> POS tablet, Gate -> Kiosk gate, LPR camera -> LPR,
--   Menu board -> Kiosk menu board,
--   Tunnel entrance board -> Entrance management screen,
--   Tunnel exit board -> Exit management screen; added Server PC.
-- The list lives in DEVICES (apps/workorders-worker/src/it-issues.ts); this
-- moves existing issues onto the new names so they still match the filter.

update public.it_issues set device = case device
  when 'Tablet' then 'POS tablet'
  when 'Gate' then 'Kiosk gate'
  when 'LPR camera' then 'LPR'
  when 'Menu board' then 'Kiosk menu board'
  when 'Tunnel entrance board' then 'Entrance management screen'
  when 'Tunnel exit board' then 'Exit management screen'
  else device end
where device in ('Tablet', 'Gate', 'LPR camera', 'Menu board', 'Tunnel entrance board', 'Tunnel exit board');
