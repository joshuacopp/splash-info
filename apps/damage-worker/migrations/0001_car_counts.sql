CREATE TABLE IF NOT EXISTS car_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  location_code TEXT NOT NULL,
  start_date    TEXT NOT NULL,               -- 'YYYY-MM-DD' inclusive
  end_date      TEXT NOT NULL,               -- 'YYYY-MM-DD' inclusive; == start_date for a single day
  cars          INTEGER NOT NULL CHECK (cars >= 0),
  note          TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_car_counts_loc_dates ON car_counts (location_code, start_date, end_date);
