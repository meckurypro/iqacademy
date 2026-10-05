// src/lib/roster.ts
// Pure helpers and types for the Roster board. No React, no Supabase: easy to test.
import { place } from "./centre";

export type S = {
  id: string; session_date: string; start_at: string; end_at: string; status: string; session_no: number;
  centre_id: string; centre_name: string; centre_city: string | null; centre_address: string | null;
  course_id: string; course_title: string; instructor_id: string | null; lesson_title: string | null; run_id: string | null;
};
export type P = { id: string; name: string; avatar: string | null };
export type Scope = "class" | "later" | "centre" | "all";

export const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00`);
export const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const mondayOf = (s: string) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
export const label = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
export const short = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
export const clock = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const classes = (n: number) => `${n} ${n === 1 ? "class" : "classes"}`;
export const first = (n: string) => n.split(" ")[0];
export const where = (s: S) => place({ name: s.centre_name, city: s.centre_city, address: s.centre_address });
export const locked = (s: S) => s.status !== "scheduled" || Date.parse(s.start_at) <= Date.now();
export const overlap = (a: S, b: S) => Date.parse(a.start_at) < Date.parse(b.end_at) && Date.parse(b.start_at) < Date.parse(a.end_at);
export const byStart = (a: S, b: S) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id.localeCompare(b.id);

/** The classes a choice of scope would touch (never classes that already started). */
export const pick = (ses: S[], a: S, scope: Scope) => ses.filter((s) => !locked(s) && (
  scope === "class" ? s.id === a.id
    : scope === "later" ? !!a.run_id && s.run_id === a.run_id && s.session_no >= a.session_no
    : scope === "centre" ? s.course_id === a.course_id && s.centre_id === a.centre_id
    : s.course_id === a.course_id)).sort(byStart);

/** What would happen if `who` took `targets`: which go through, which clash with something they already teach. */
export function plan(ses: S[], who: string, targets: S[]) {
  const mine = ses.filter((s) => s.instructor_id === who);
  const ok: S[] = [], clash: S[] = []; let same = 0;
  for (const t of targets) {
    if (t.instructor_id === who) { same++; continue; }
    if (mine.some((m) => m.id !== t.id && overlap(m, t))) { clash.push(t); continue; }
    ok.push(t); mine.push(t);
  }
  return { ok, clash, same };
}
