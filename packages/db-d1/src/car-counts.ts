// car_counts queries — manually-entered tunnel (car) counts stored as
// inclusive date ranges per location. Denominator for the cost-per-car
// reporting metric.
//
// Ranges for a given location must not overlap; the worker enforces that on
// write via findOverlappingCarCount before calling upsertCarCount. There is
// no soft-delete column — deleteCarCount is a hard delete.

import type { CarCountRow } from "@splash/types/claims";

/**
 * All car-count rows, optionally filtered to a set of location codes.
 * Empty `locationCodes` array → no rows (scoped-to-nothing).
 *
 * ORDER BY start_date DESC, location_code so the most recent ranges surface
 * first in the management grid.
 */
export async function listCarCounts(
  db: D1Database,
  locationCodes?: string[]
): Promise<CarCountRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (locationCodes) {
    if (locationCodes.length === 0) return [];
    where.push(`location_code IN (${locationCodes.map(() => "?").join(",")})`);
    params.push(...locationCodes);
  }

  const sql = `
    SELECT id, location_code, start_date, end_date, cars, note, updated_by, updated_at
    FROM car_counts
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY start_date DESC, location_code
  `;

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<CarCountRow>();
  return result.results ?? [];
}

/**
 * Find an existing row for the same location whose range overlaps
 * [startDate, endDate] (inclusive): `start_date <= endDate AND end_date >=
 * startDate`. Excludes `excludeId` so an edit doesn't collide with itself.
 *
 * Returns the first overlapping row (there should be at most one, since
 * overlaps are rejected on write) or null. Used to reject overlapping writes.
 */
export async function findOverlappingCarCount(
  db: D1Database,
  locationCode: string,
  startDate: string,
  endDate: string,
  excludeId?: number
): Promise<CarCountRow | null> {
  const where: string[] = [
    "location_code = ?",
    "start_date <= ?",
    "end_date >= ?"
  ];
  const params: unknown[] = [locationCode, endDate, startDate];

  if (excludeId !== undefined) {
    where.push("id != ?");
    params.push(excludeId);
  }

  const row = await db
    .prepare(
      `SELECT id, location_code, start_date, end_date, cars, note, updated_by, updated_at
       FROM car_counts
       WHERE ${where.join(" AND ")}
       ORDER BY start_date
       LIMIT 1`
    )
    .bind(...params)
    .first<CarCountRow>();
  return row ?? null;
}

/**
 * Insert (no id) or update (id given) a car-count row. Returns the row id.
 *
 * Overlap enforcement is the caller's responsibility — call
 * findOverlappingCarCount first and reject before invoking this.
 */
export async function upsertCarCount(
  db: D1Database,
  args: {
    id?: number;
    locationCode: string;
    startDate: string;
    endDate: string;
    cars: number;
    note: string | null;
    updatedBy: string | null;
  }
): Promise<{ id: number }> {
  if (args.id !== undefined) {
    await db
      .prepare(
        `UPDATE car_counts
         SET location_code = ?, start_date = ?, end_date = ?, cars = ?, note = ?,
             updated_by = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(
        args.locationCode,
        args.startDate,
        args.endDate,
        args.cars,
        args.note,
        args.updatedBy,
        args.id
      )
      .run();
    return { id: args.id };
  }

  const result = await db
    .prepare(
      `INSERT INTO car_counts (location_code, start_date, end_date, cars, note, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      args.locationCode,
      args.startDate,
      args.endDate,
      args.cars,
      args.note,
      args.updatedBy
    )
    .run();
  return { id: Number(result.meta?.last_row_id ?? 0) };
}

/**
 * Hard-delete a car-count row by id. There is no soft-delete column.
 */
export async function deleteCarCount(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM car_counts WHERE id = ?").bind(id).run();
}

/**
 * Per-location apportioned car total whose ranges overlap [from, to].
 *
 * Each row is apportioned as `cars * overlap_days / range_days`, where
 *   range_days   = julianday(end_date) - julianday(start_date) + 1
 *   overlap_days = max(0, julianday(min(end_date, to))
 *                          - julianday(max(start_date, from)) + 1)
 *
 * so a range straddling the window edge contributes only its in-window share.
 * `from`/`to` are date strings; julianday() truncates any time component so a
 * 'YYYY-MM-DD' or full ISO timestamp both resolve to whole-day boundaries.
 *
 * Filtered to `location_code IN (...) AND end_date >= from AND start_date <= to`
 * so non-overlapping rows never reach the SUM. Returns cars as a float — the
 * caller rounds.
 */
export async function sumCarsInWindow(
  db: D1Database,
  locationCodes: string[],
  from: string,
  to: string
): Promise<Array<{ location_code: string; cars: number }>> {
  if (locationCodes.length === 0) return [];

  const placeholders = locationCodes.map(() => "?").join(",");
  const sql = `
    SELECT
      location_code,
      SUM(
        cars * (
          MAX(
            0,
            julianday(MIN(end_date, date(?))) - julianday(MAX(start_date, date(?))) + 1
          )
        ) / (julianday(end_date) - julianday(start_date) + 1)
      ) AS cars
    FROM car_counts
    WHERE location_code IN (${placeholders})
      AND end_date >= date(?)
      AND start_date <= date(?)
    GROUP BY location_code
  `;

  // from/to arrive as full ISO timestamps; date() snaps them to whole days so
  // the inclusive day-count apportioning stays exact and a range ending on the
  // window's first day isn't dropped by a lexical prefix comparison.
  // Bind order: MIN(end_date, date(to)), MAX(start_date, date(from)), IN-list,
  // end_date >= date(from), start_date <= date(to).
  const result = await db
    .prepare(sql)
    .bind(to, from, ...locationCodes, from, to)
    .all<{ location_code: string; cars: number }>();
  return result.results ?? [];
}
