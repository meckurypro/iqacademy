// src/lib/time.ts
// One place for "what time is it" and "how do we show it".
//
// Two rules the whole app follows:
//   1. The clock is the server's, not the phone's. A phone set a few minutes (or hours) wrong must not change which
//      classes count as today, whether check-in looks open, or what "5 min ago" says. syncClock() measures the gap once
//      and now() applies it.
//   2. Every day and time is shown in the centre's timezone (Lagos), whatever timezone the phone is set to. The database
//      does the same, so a class that starts at 9:00 in Lagos reads 9:00 everywhere. Calendar dates ("2026-10-05", used for
//      class days, runs and start dates) are plain dates with no timezone, so they are formatted as-is, never shifted.
import { supabase } from "./supabase";

export const TZ = "Africa/Lagos";

// ---------- the clock ----------
let skew = 0; // server time minus phone time, in ms
/** The real time in ms since epoch (server-corrected). Use this instead of Date.now() for anything the user sees or decides on. */
export const now = () => Date.now() + skew;
export const clockSkewMs = () => skew;

/** Measure the phone's clock against the server's. Splits the round trip so a slow connection doesn't add error. Returns the skew in ms, or null if offline. */
export async function syncClock(): Promise<number | null> {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc("server_now");
  const t1 = Date.now();
  const server = typeof data === "string" ? Date.parse(data) : NaN;
  if (error || Number.isNaN(server)) return null;
  skew = server - (t0 + t1) / 2;
  return skew;
}

// ---------- formatting (always in TZ) ----------
const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(o: Intl.DateTimeFormatOptions, tz: string = TZ, locale?: string) {
  const k = `${locale ?? ""}|${tz}|${JSON.stringify(o)}`;
  let f = cache.get(k); if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...o }); cache.set(k, f); }
  return f;
}
type D = string | number | Date;
const asDate = (d: D) => (d instanceof Date ? d : new Date(d));

/** 9:30 AM, in centre time. */
export const fmtClock = (d: D) => fmt({ hour: "numeric", minute: "2-digit" }).format(asDate(d));
/** A moment (timestamp) as a date or date and time, in centre time. */
export const fmtWhen = (d: D, o: Intl.DateTimeFormatOptions) => fmt(o).format(asDate(d));
/** A calendar date ("2026-10-05") as text. Never shifted by any timezone. */
export const fmtDay = (isoDate: string, o: Intl.DateTimeFormatOptions) => fmt(o, "UTC").format(new Date(`${isoDate.slice(0, 10)}T12:00:00Z`));

// ---------- calendar dates (YYYY-MM-DD) ----------
const ymd = (d: D) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }, TZ, "en-CA").format(asDate(d));
/** The centre-time calendar date of a moment. */
export const dayOf = (d: D) => ymd(d);
/** Today's date at the centre, from the server-corrected clock. */
export const today = () => ymd(now());
export const addDays = (isoDate: string, n: number) => { const d = new Date(`${isoDate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (isoDate: string, n: number) => {
  const [y, m, dd] = isoDate.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  t.setUTCDate(Math.min(dd, last)); return t.toISOString().slice(0, 10);
};
export const monthStart = (isoDate: string) => `${isoDate.slice(0, 7)}-01`;
/** Monday of the week containing the date. */
export const mondayOf = (isoDate: string) => addDays(isoDate, -((new Date(`${isoDate}T12:00:00Z`).getUTCDay() + 6) % 7));

/** "Today", "Yesterday", or the date, for a timestamp. */
export const relativeDay = (d: D, o: Intl.DateTimeFormatOptions) => {
  const k = dayOf(d), t = today();
  if (k === t) return "Today"; if (k === addDays(t, -1)) return "Yesterday"; if (k === addDays(t, 1)) return "Tomorrow";
  return fmtWhen(d, { ...o, ...(k.slice(0, 4) === t.slice(0, 4) ? {} : { year: "numeric" }) });
};

// ---------- wall-clock input <-> moment ----------
// <input type="datetime-local"> has no timezone: its text is the time on the wall at the centre. These convert it
// to and from a real moment without involving the phone's timezone.
const parts = (ms: number) => {
  const p = Object.fromEntries(fmt({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }, TZ, "en-CA").formatToParts(ms).map((x) => [x.type, x.value]));
  return p as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
};
/** A moment as "YYYY-MM-DDTHH:mm" on the centre's wall clock. */
export const toWallInput = (ms: number) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
/** "YYYY-MM-DDTHH:mm" on the centre's wall clock, as a moment (ms since epoch). */
export function fromWallInput(v: string): number {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = (ms: number) => { const p = parts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
  let t = asUtc - off(asUtc); t = asUtc - off(t); return t;
}
/** Start of a centre-time calendar day, as a moment. */
export const dayStart = (isoDate: string) => fromWallInput(`${isoDate}T00:00`);
