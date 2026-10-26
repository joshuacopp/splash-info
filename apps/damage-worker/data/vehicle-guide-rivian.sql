-- Vehicle Guide: Rivian R1T + R1S car wash mode (from Dave Jones's email of
-- 2023-12-26). Both models launched as model year 2022 and still have Car Wash
-- Mode, so the range is 2022 "and newer" (year_to NULL).
--
-- Apply after migrations/0003_vehicle_issue_youtube.sql:
--   pnpm --filter @splash/damage-worker exec wrangler d1 execute splash-damage-claims --remote --file=data/vehicle-guide-rivian.sql
-- (If --file fails on upload as it has before, run each INSERT on its own with --command.)
--
-- Not idempotent: running it twice adds the entries twice.

INSERT INTO vehicle_issues (make, model, year_from, year_to, issue_type, issue, solution, created_by, updated_by) VALUES ('Rivian', 'R1T', 2022, NULL, 'neutral', 'Has to be put in Car Wash Mode to go through the tunnel in neutral. Once Car Wash Mode is on, the door handles will not pop out and the vehicle locks.', 'Once on the conveyor:' || char(10) || '1. Seat belt fastened' || char(10) || '2. Foot on brake' || char(10) || '3. Shift lightly to Neutral' || char(10) || '4. On the main screen, press the Vehicle button' || char(10) || '5. Enable Car Wash Mode' || char(10) || '6. Press the additional button to fold the mirrors' || char(10) || char(10) || 'At full service washes a driver must ride through the wash: the doors lock and the handles stay in while Car Wash Mode is on.', 'import:Dave Jones email 2023-12-26', 'import:Dave Jones email 2023-12-26');

INSERT INTO vehicle_issues (make, model, year_from, year_to, issue_type, issue, solution, created_by, updated_by) VALUES ('Rivian', 'R1S', 2022, NULL, 'neutral', 'Has to be put in Car Wash Mode to go through the tunnel in neutral. Once Car Wash Mode is on, the door handles will not pop out and the vehicle locks.', 'Once on the conveyor:' || char(10) || '1. Seat belt fastened' || char(10) || '2. Foot on brake' || char(10) || '3. Shift lightly to Neutral' || char(10) || '4. On the main screen, press the Vehicle button' || char(10) || '5. Enable Car Wash Mode' || char(10) || '6. Press the additional button to fold the mirrors' || char(10) || char(10) || 'At full service washes a driver must ride through the wash: the doors lock and the handles stay in while Car Wash Mode is on.', 'import:Dave Jones email 2023-12-26', 'import:Dave Jones email 2023-12-26');
