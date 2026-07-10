"use client";

// Interactive week-grid calendar for a single location's Beekeeper shifts.
//
// Seven Mon–Sun day columns; shifts render as chips bucketed by their ET
// `startDate` (the worker already hands back ET calendar/clock parts, so the
// grid needs no UTC math). Clicking a chip opens the editor; each column's
// "+ Add" prefills that day's date. Create/update/delete post same-origin to
// /schedule/api/loc/{code}/... — Cloudflare routes /schedule/api/* to
// beekeeper-worker, which enforces auth, overlap validation, and audit.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RosterMember, ShiftView } from "../_lib/worker-fetch";

/* ============================================================
 * Pure date helpers (no server imports — safe in a client island).
 * ============================================================ */

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function queryWindow(monday: string): { startIso: string; endIso: string } {
  return {
    startIso: `${addDays(monday, -1)}T00:00:00Z`,
    endIso: `${addDays(monday, 8)}T00:00:00Z`
  };
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function dayHeader(dateStr: string): { weekday: string; label: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun
  const weekday = WEEKDAY[(dow + 6) % 7]!;
  return { weekday, label: `${m}/${d}` };
}

function weekRangeLabel(monday: string): string {
  const [, sm, sd] = monday.split("-").map(Number);
  const sunday = addDays(monday, 6);
  const [, em, ed] = sunday.split("-").map(Number);
  return `${sm}/${sd} – ${em}/${ed}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function fmt12(h: number, m: number): string {
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "AM" : "PM";
  return m === 0 ? `${h12} ${ap}` : `${h12}:${pad(m)} ${ap}`;
}

const MINUTE_STEPS = [0, 15, 30, 45];

/** Snap an arbitrary minute to the nearest quarter for the dropdowns. */
function snapMinute(m: number): number {
  if (MINUTE_STEPS.includes(m)) return m;
  return m < 8 ? 0 : m < 23 ? 15 : m < 38 ? 30 : m < 53 ? 45 : 0;
}

/* ============================================================
 * Component
 * ============================================================ */

interface FormState {
  mode: "add" | "edit";
  editingId: string | null;
  userId: string;
  date: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  title: string;
}

interface Props {
  locationCode: string;
  locationName: string;
  roster: RosterMember[];
  initialMonday: string;
  initialShifts: ShiftView[];
  initialShiftsError: string | null;
}

export function ScheduleWeekGrid({
  locationCode,
  locationName,
  roster,
  initialMonday,
  initialShifts,
  initialShiftsError
}: Props) {
  const [monday, setMonday] = useState(initialMonday);
  const [shifts, setShifts] = useState<ShiftView[]>(initialShifts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialShiftsError);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const apiBase = `/schedule/api/loc/${encodeURIComponent(locationCode)}`;
  const days = useMemo(() => weekDates(monday), [monday]);

  const api = useCallback(
    async (path: string, opts?: RequestInit): Promise<Record<string, unknown>> => {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        ...opts
      });
      if (res.status === 401)
        throw new Error("Not signed in — sign in on the dashboard, then reload.");
      if (res.status === 403)
        throw new Error("You don't have access to this location's schedule.");
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const details = data.details as { message: string }[] | undefined;
        if (Array.isArray(details))
          throw new Error(details.map((d) => d.message).join("; "));
        throw new Error((data.error as string) || `Error ${res.status}`);
      }
      return data;
    },
    []
  );

  const loadShifts = useCallback(
    async (mon: string) => {
      setLoading(true);
      setError(null);
      try {
        const { startIso, endIso } = queryWindow(mon);
        const data = await api(
          `${apiBase}/shifts?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`
        );
        setShifts((data.shifts as ShiftView[]) || []);
      } catch (e) {
        setShifts([]);
        setError(e instanceof Error ? e.message : "Failed to load shifts.");
      } finally {
        setLoading(false);
      }
    },
    [api, apiBase]
  );

  // Refetch whenever the visible week changes (skip the SSR'd initial week).
  useEffect(() => {
    if (monday === initialMonday) return;
    void loadShifts(monday);
  }, [monday, initialMonday, loadShifts]);

  const shiftsByDay = useMemo(() => {
    const map = new Map<string, ShiftView[]>();
    for (const d of days) map.set(d, []);
    for (const s of shifts) {
      const bucket = map.get(s.startDate);
      if (bucket) bucket.push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute));
    }
    return map;
  }, [days, shifts]);

  const rosterName = useCallback(
    (id: string) => roster.find((r) => r.id === id)?.name ?? id,
    [roster]
  );

  function openAdd(date: string) {
    setOkMsg(null);
    setError(null);
    setForm({
      mode: "add",
      editingId: null,
      userId: roster[0]?.id ?? "",
      date,
      startHour: 9,
      startMinute: 0,
      endHour: 17,
      endMinute: 0,
      title: ""
    });
  }

  function openEdit(s: ShiftView) {
    setOkMsg(null);
    setError(null);
    setForm({
      mode: "edit",
      editingId: s.id,
      userId: s.userId,
      date: s.startDate,
      startHour: s.startHour,
      startMinute: snapMinute(s.startMinute),
      endHour: s.endHour,
      endMinute: snapMinute(s.endMinute),
      title: s.title || ""
    });
  }

  async function saveForm() {
    if (!form) return;
    if (!form.userId) {
      setError("Pick an employee.");
      return;
    }
    if (!form.date) {
      setError("Pick a date.");
      return;
    }
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      userId: form.userId,
      date: form.date,
      startHour: form.startHour,
      startMinute: form.startMinute,
      endHour: form.endHour,
      endMinute: form.endMinute,
      title: form.title.trim() || undefined
    });
    try {
      if (form.mode === "edit" && form.editingId) {
        await api(`${apiBase}/shifts/${encodeURIComponent(form.editingId)}`, {
          method: "PUT",
          body
        });
        setOkMsg("Shift updated.");
      } else {
        await api(`${apiBase}/shifts`, { method: "POST", body });
        setOkMsg("Shift added.");
      }
      setForm(null);
      await loadShifts(monday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteForm() {
    if (!form || !form.editingId) return;
    if (!window.confirm("Delete this shift?")) return;
    setSaving(true);
    setError(null);
    try {
      await api(`${apiBase}/shifts/${encodeURIComponent(form.editingId)}`, {
        method: "DELETE"
      });
      setOkMsg("Shift deleted.");
      setForm(null);
      await loadShifts(monday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setSaving(false);
    }
  }

  const overnight =
    form != null &&
    form.endHour * 60 + form.endMinute <= form.startHour * 60 + form.startMinute;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
            Beekeeper · {roster.length} employee{roster.length === 1 ? "" : "s"}
          </p>
          <h1 className="text-2xl font-bold text-splash-navy">
            Schedule · {locationName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonday(addDays(monday, -7))}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            ← Prev
          </button>
          <button
            type="button"
            onClick={() => setMonday(initialMonday)}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setMonday(addDays(monday, 7))}
            className="rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40"
          >
            Next →
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-splash-navy">
          Week of {weekRangeLabel(monday)}
        </span>
        {loading ? (
          <span className="text-sm text-splash-navy/60">Loading…</span>
        ) : null}
        <button
          type="button"
          onClick={() => openAdd(days[0]!)}
          className="ml-auto rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          + Add shift
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded-splash-md border border-splash-deny/50 bg-splash-deny/10 px-4 py-3 text-sm text-splash-deny">
          {error}
        </div>
      ) : null}
      {okMsg ? (
        <div className="mb-4 rounded-splash-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800">
          {okMsg}
        </div>
      ) : null}

      {roster.length === 0 ? (
        <div className="mb-4 rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-4 text-sm text-yellow-900">
          No assignable employees are cached for this location yet. A super_admin
          can refill the cache with the manual sync, after which employees appear
          here.
        </div>
      ) : null}

      {/* Seven-column week grid. Horizontal scroll on narrow viewports keeps
          the day columns readable rather than squashing them. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[900px] grid-cols-7 gap-2">
          {days.map((date) => {
            const { weekday, label } = dayHeader(date);
            const list = shiftsByDay.get(date) ?? [];
            return (
              <div
                key={date}
                className="flex min-h-[260px] flex-col rounded-splash-lg border border-gray-light bg-white"
              >
                <div className="flex items-baseline justify-between border-b border-gray-light px-3 py-2">
                  <span className="text-sm font-bold text-splash-navy">
                    {weekday}
                  </span>
                  <span className="text-xs text-splash-navy/60">{label}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => openEdit(s)}
                      className="rounded-splash-md border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-2 py-1.5 text-left transition-colors hover:border-splash-blue hover:bg-sudsy-blue-soft/70"
                    >
                      <span className="block truncate text-xs font-semibold text-splash-navy">
                        {s.userName}
                      </span>
                      <span className="block text-xs text-splash-navy/70">
                        {fmt12(s.startHour, s.startMinute)} –{" "}
                        {fmt12(s.endHour, s.endMinute)}
                        {s.endDate !== s.startDate ? (
                          <span className="text-splash-blue"> +1</span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => openAdd(date)}
                    className="mt-auto rounded-splash-md border border-dashed border-gray-light px-2 py-1 text-xs font-medium text-splash-navy/50 hover:border-splash-blue hover:text-splash-blue"
                  >
                    + Add
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {form ? (
        <EditorModal
          form={form}
          roster={roster}
          overnight={overnight}
          saving={saving}
          rosterName={rosterName}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={saveForm}
          onDelete={deleteForm}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
 * Editor modal
 * ============================================================ */

function EditorModal({
  form,
  roster,
  overnight,
  saving,
  rosterName,
  onChange,
  onClose,
  onSave,
  onDelete
}: {
  form: FormState;
  roster: RosterMember[];
  overnight: boolean;
  saving: boolean;
  rosterName: (id: string) => string;
  onChange: (f: FormState) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    onChange({ ...form, [k]: v });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-splash-navy/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-bold text-splash-navy">
          {form.mode === "edit" ? "Edit shift" : "Add shift"}
        </h2>

        <div className="space-y-4">
          <Field label="Employee">
            <select
              value={form.userId}
              onChange={(e) => set("userId", e.target.value)}
              className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            >
              {roster.length === 0 ? (
                <option value="">No employees available</option>
              ) : (
                roster.map((r) => (
                  <option key={r.id} value={r.id}>
                    {rosterName(r.id)}
                  </option>
                ))
              )}
            </select>
          </Field>

          <Field label="Date">
            <input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Start">
              <TimeSelect
                hour={form.startHour}
                minute={form.startMinute}
                onHour={(h) => set("startHour", h)}
                onMinute={(m) => set("startMinute", m)}
              />
            </Field>
            <Field label="End">
              <TimeSelect
                hour={form.endHour}
                minute={form.endMinute}
                onHour={(h) => set("endHour", h)}
                onMinute={(m) => set("endMinute", m)}
              />
            </Field>
          </div>

          {overnight ? (
            <p className="text-xs font-medium text-splash-blue">
              → Overnight shift (ends the next day)
            </p>
          ) : null}

          <Field label="Title (optional)">
            <input
              type="text"
              value={form.title}
              maxLength={80}
              placeholder="Auto-generated from the times"
              onChange={(e) => set("title", e.target.value)}
              className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            />
          </Field>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <div>
            {form.mode === "edit" ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={saving}
                className="rounded-splash-md border border-splash-deny/50 px-4 py-2 text-sm font-semibold text-splash-deny hover:bg-splash-deny/10 disabled:opacity-50"
              >
                Delete
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-splash-md border border-gray-light px-4 py-2 text-sm font-semibold text-splash-navy hover:bg-gray-light/40 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="rounded-splash-md bg-splash-navy px-5 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-50"
            >
              {saving ? "Saving…" : form.mode === "edit" ? "Save changes" : "Add shift"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold text-splash-navy">
        {label}
      </label>
      {children}
    </div>
  );
}

function TimeSelect({
  hour,
  minute,
  onHour,
  onMinute
}: {
  hour: number;
  minute: number;
  onHour: (h: number) => void;
  onMinute: (m: number) => void;
}) {
  const selCls =
    "rounded-splash-md border border-gray-light bg-white px-2 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
  return (
    <div className="flex gap-2">
      <select
        value={hour}
        onChange={(e) => onHour(Number(e.target.value))}
        className={`${selCls} flex-1`}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {fmt12(h, 0).replace(" ", "")}
          </option>
        ))}
      </select>
      <select
        value={minute}
        onChange={(e) => onMinute(Number(e.target.value))}
        className={selCls}
      >
        {MINUTE_STEPS.map((m) => (
          <option key={m} value={m}>
            :{pad(m)}
          </option>
        ))}
      </select>
    </div>
  );
}
