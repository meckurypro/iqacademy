// src/lib/classClock.ts
// The class clock on the client. The server (class_clock_tick, every minute) is what actually opens check-in,
// starts and ends classes and sends reminders. This file only *shows* it, and it does so from the class's own
// timestamps and the server-corrected clock in time.ts, never from a counter that is decremented:
//   * a phone that sleeps or a tab that is throttled in the background is exactly right the moment it wakes
//   * the countdown flips to the next class the instant a class ends, without waiting for the server's next run
//   * if the cron run is a few seconds late, the screen is still right; it just re-reads the server shortly after
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { now as serverNow } from "./time";
import { CHECKIN_OPENS_MIN } from "./checkin";

export type ClockClass = {
  id: string; start_at: string; end_at: string; status: string; as_role: "student" | "instructor" | "staff";
  is_emergency: boolean; course_title: string; lesson_title: string | null; room: string | null;
  centre_id: string; centre_name: string; centre_city: string | null; centre_address: string | null;
  instructor_name: string | null; checkin_opens_at: string;
};

/** upcoming: more than 30 min away. checkin: door open, class not started. live: in progress. over: finished. */
export type Phase = "upcoming" | "checkin" | "live" | "over";
export function phaseOf(c: Pick<ClockClass, "start_at" | "end_at">, at: number): Phase {
  const start = Date.parse(c.start_at), end = Date.parse(c.end_at);
  if (at >= end) return "over";
  if (at >= start) return "live";
  if (at >= start - CHECKIN_OPENS_MIN * 60000) return "checkin";
  return "upcoming";
}

/** Split a duration into whole days, hours, minutes and seconds (never negative). */
export function splitMs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

/** "2 days 4 hours", "35 minutes": for screen readers, which should hear a calm sentence, not a ticking number. */
export function spoken(ms: number) {
  const { d, h, m } = splitMs(ms);
  const u = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (d > 0) return [u(d, "day"), h ? u(h, "hour") : ""].filter(Boolean).join(" ");
  if (h > 0) return [u(h, "hour"), m ? u(m, "minute") : ""].filter(Boolean).join(" ");
  return m > 0 ? u(m, "minute") : "less than a minute";
}

/** Server-corrected "now", re-read every second while the page is visible and immediately when it becomes visible. */
export function useTicker(intervalMs = 1000) {
  const [t, setT] = useState(serverNow());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = () => setT(serverNow());
    const start = () => { stop(); tick(); id = setInterval(tick, intervalMs); };
    const stop = () => { if (id) clearInterval(id); id = undefined; };
    const vis = () => (document.visibilityState === "visible" ? start() : stop());
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => { stop(); document.removeEventListener("visibilitychange", vis); };
  }, [intervalMs]);
  return t;
}

/**
 * The caller's live and upcoming classes (as a student, instructor or the centre's coordinator/director), soonest
 * first, from the server. Re-reads on realtime changes, when the tab comes back, and shortly after a class
 * crosses a boundary (door opens, starts, ends) so the server's own state catches up with what the clock shows.
 */
export function useClassClock(limit = 3, fallbackStudent = false) {
  const [rows, setRows] = useState<ClockClass[] | null>(null);
  const [failed, setFailed] = useState(false);
  const now = useTicker(1000);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("my_class_clock", { p_limit: limit });
    if (error) {
      setFailed(true);
      // Until migration 45 is applied the function doesn't exist. A student must never lose their Check-in button over
      // that, so fall back to what the app showed before: the next class visible to them.
      if (fallbackStudent) {
        const f = await supabase.from("v_session_details").select("id,start_at,end_at,status,is_emergency,course_title,lesson_title,room,centre_id,centre_name,centre_city,centre_address,instructor_name")
          .in("status", ["scheduled", "in_progress"]).gte("end_at", new Date(serverNow()).toISOString()).order("start_at").limit(limit);
        setRows(((f.data ?? []) as Omit<ClockClass, "as_role" | "checkin_opens_at">[]).map((r) => ({ ...r, as_role: "student" as const, checkin_opens_at: new Date(Date.parse(r.start_at) - CHECKIN_OPENS_MIN * 60000).toISOString() })));
      } else setRows((r) => r ?? []);
      return;
    }
    setFailed(false); setRows((data as ClockClass[]) ?? []);
  }, [limit, fallbackStudent]);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(load, 400); }, [load]);

  useEffect(() => {
    load();
    const ch = supabase.channel(`class-clock-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "class_sessions" }, soon).subscribe();
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearTimeout(timer.current); supabase.removeChannel(ch); document.removeEventListener("visibilitychange", vis); };
  }, [load, soon]);

  // What the screen shows: classes that haven't finished by the clock, even if the server hasn't marked them so yet.
  const upcoming = useMemo(() => (rows ?? []).filter((c) => phaseOf(c, now) !== "over"), [rows, now]);
  const current = upcoming[0] ?? null;
  const next = current && phaseOf(current, now) === "live" ? upcoming[1] ?? null : null;

  // When the current class changes phase, or one finishes, re-read the server a few seconds later so its state
  // (class_clock_tick runs once a minute) catches up with what the clock already shows. Not on first load.
  const key = current ? `${current.id}:${phaseOf(current, now)}` : "none";
  const prev = useRef<{ key: string; len: number } | null>(null);
  useEffect(() => {
    if (rows === null) return;
    const p = prev.current; prev.current = { key, len: upcoming.length };
    if (p && ((p.key !== key && p.key !== "none") || upcoming.length < p.len)) { const id = setTimeout(load, 3000); return () => clearTimeout(id); }
  }, [rows, key, upcoming.length, load]);

  return { loading: rows === null, failed, current, next, now, reload: load };
}
