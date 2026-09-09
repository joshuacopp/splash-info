-- Seed car_counts — WashCo sites, Jan-Aug 2026 (one row per location-month).
-- Corporate row skipped (negative/zero adjustments, not a store).
-- White Plains NOT included yet — pending code choice (whiteplainscentral vs whiteplainskensico).
-- RUN ONCE ONLY: car_counts has no UNIQUE constraint; apply via --command, not --file.

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('middletown','2026-01-01','2026-01-31',41580,'2026 monthly seed'),
  ('middletown','2026-02-01','2026-02-28',43234,'2026 monthly seed'),
  ('middletown','2026-03-01','2026-03-31',35616,'2026 monthly seed'),
  ('middletown','2026-04-01','2026-04-30',34959,'2026 monthly seed'),
  ('middletown','2026-05-01','2026-05-31',39723,'2026 monthly seed'),
  ('middletown','2026-06-01','2026-06-30',37749,'2026 monthly seed'),
  ('middletown','2026-07-01','2026-07-31',31785,'2026 monthly seed'),
  ('middletown','2026-08-01','2026-08-31',30104,'2026 monthly seed');
