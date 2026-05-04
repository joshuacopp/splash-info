// Performance-tracker types.
// Source: legacy/performancetracker.js — apiCreateSubmission and apiListSubmissions.

/**
 * Row inserted into `performance_tracking`.
 * Source: legacy/performancetracker.js:232-253 row build.
 */
export interface PerformanceTrackingInsert {
  /** ISO timestamp; defaults to now() in the worker if not supplied. */
  visit_at: string;
  location_id: number;
  capture_rate: number | null;
  opportunities: number | null;
  greeter_1_name: string | null;
  greeter_2_name: string | null;
  greeter_3_name: string | null;
  /** Time strings (HH:MM); legacy passes through as-is. */
  greeter_1_shift_start: string | null;
  greeter_1_shift_end: string | null;
  greeter_2_shift_start: string | null;
  greeter_2_shift_end: string | null;
  greeter_3_shift_start: string | null;
  greeter_3_shift_end: string | null;
  gm_on_site: boolean;
  gm_name: string | null;
  agm_on_site: boolean;
  agm_name: string | null;
  comments: string | null;
  /** UUID of the auth user submitting the entry. */
  submitted_by: string;
  submitted_by_email: string;
}

/**
 * Full row shape (insert + auto-generated columns).
 * Source: legacy/performancetracker.js:276 list select.
 */
export interface PerformanceTrackingRow extends PerformanceTrackingInsert {
  id: number;
  created_at: string;
}
