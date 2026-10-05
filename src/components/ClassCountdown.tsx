// src/components/ClassCountdown.tsx
// The "next class" card for students, instructors, coordinators and directors.
//   * more than a day away: days and hours (seconds would only be noise)
//   * under a day: hours, minutes, seconds
//   * check-in open: the same countdown to the start, with the door shown as open
//   * live: how long is left in the class; the moment it ends, the countdown to the following class begins
// Time comes from the server-corrected clock and the class's own timestamps (lib/classClock.ts).
import { Link } from "react-router-dom";
import Place from "./Place";
import Icon from "./Icon";
import { Card, Skeleton, cx } from "./ui";
import { phaseOf, spoken, splitMs, useClassClock, type ClockClass } from "../lib/classClock";
import { CHECKIN_OPENS_MIN } from "../lib/checkin";
import { fmtClock, fmtWhen, relativeDay } from "../lib/time";

const two = (n: number) => String(n).padStart(2, "0");

function Unit({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-[3.6rem] rounded-xl bg-sunken px-2 py-2.5 text-center">
      <p className="num text-3xl font-semibold leading-none tracking-tight text-ink">{value}</p>
      <p className="mt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}

function Digits({ ms }: { ms: number }) {
  const { d, h, m, s } = splitMs(ms);
  return (
    <div className="flex items-start gap-2" aria-hidden="true">
      {d > 0 ? <><Unit value={String(d)} label={d === 1 ? "day" : "days"} /><Unit value={two(h)} label="hrs" /><Unit value={two(m)} label="min" /></>
        : h > 0 ? <><Unit value={String(h)} label="hrs" /><Unit value={two(m)} label="min" /><Unit value={two(s)} label="sec" /></>
        : <><Unit value={two(m)} label="min" /><Unit value={two(s)} label="sec" /></>}
    </div>
  );
}

const roleCopy = {
  student: { early: (c: ClockClass) => `Check-in opens at ${fmtClock(Date.parse(c.start_at) - CHECKIN_OPENS_MIN * 60000)}`, open: "Check in", live: "Check in" },
  instructor: { early: () => "", open: "Open class", live: "Open class" },
  staff: { early: (c: ClockClass) => `Class code appears at ${fmtClock(Date.parse(c.start_at) - CHECKIN_OPENS_MIN * 60000)}`, open: "Open class code", live: "Open class code" },
} as const;

export default function ClassCountdown({ onCheckIn, student }: { onCheckIn?: (c: ClockClass) => void; student?: boolean }) {
  const { loading, current: c, next, now } = useClassClock(3, !!student);
  if (loading) return <Skeleton className="h-48 rounded-2xl" />;
  if (!c) return null;   // nothing coming up: the rest of the dashboard speaks for itself

  const phase = phaseOf(c, now);
  const start = Date.parse(c.start_at), end = Date.parse(c.end_at);
  const toStart = start - now, toEnd = end - now;
  const copy = roleCopy[c.as_role];
  const doorOpen = phase === "checkin" || phase === "live";
  const label = phase === "live" ? "In progress" : phase === "checkin" ? "Check-in is open" : `Next class · ${relativeDay(c.start_at, { weekday: "long", day: "numeric", month: "short" })}`;
  const progress = phase === "live" ? (now - start) / Math.max(end - start, 1)
    : phase === "checkin" ? 1 - toStart / (CHECKIN_OPENS_MIN * 60000) : 0;
  // a calm sentence for screen readers, changing once a minute rather than every second
  const sr = phase === "live" ? `Class in progress, ${spoken(toEnd)} left` : `Class starts in ${spoken(toStart)}`;

  const action = c.as_role === "student"
    ? (doorOpen
        ? <button onClick={() => onCheckIn?.(c)} className="h-12 w-full rounded-xl bg-accent font-semibold text-accent-ink transition active:scale-[.98]">Check in</button>
        : <p className="rounded-xl bg-sunken px-3 py-3 text-center text-sm font-medium text-ink">{copy.early(c)}</p>)
    : (doorOpen
        ? <Link to={`/class/${c.id}`} className="grid h-12 w-full place-items-center rounded-xl bg-accent font-semibold text-accent-ink transition active:scale-[.98]">{copy.open}</Link>
        : <Link to={`/class/${c.id}`} className="grid h-11 w-full place-items-center rounded-xl bg-sunken text-sm font-medium text-ink transition active:scale-[.98]">{copy.early(c) || "View class"}</Link>);

  return (
    <Card className="anim-rise space-y-4 bg-surface bg-[radial-gradient(70%_60%_at_0%_0%,rgb(var(--accent)/0.10),transparent)] ring-1 ring-line">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium text-muted">
          {phase === "live" && <span className="h-2 w-2 rounded-full bg-ok animate-pulse motion-reduce:animate-none" />}
          {label}{c.is_emergency && " · Emergency"}
        </p>
        {phase === "checkin" && <span className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold text-ink"><span className="h-1.5 w-1.5 rounded-full bg-ok" /><Icon name="scan" size={14} />Door open</span>}
      </div>

      <div role="timer" className="space-y-2">
        <p className="text-sm text-muted">{phase === "live" ? "Ends in" : "Starts in"}</p>
        <Digits ms={phase === "live" ? toEnd : toStart} />
        <span className="sr-only" aria-live="polite" key={Math.floor((phase === "live" ? toEnd : toStart) / 60000)}>{sr}</span>
      </div>

      {doorOpen && <div className="h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true"><div className="h-full rounded-full bg-accent transition-all duration-1000 ease-linear" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} /></div>}

      <div>
        <h2 className="text-xl text-ink">{c.course_title}</h2>
        {c.lesson_title && <p className="text-muted">{c.lesson_title}</p>}
        <p className="mt-1 text-sm text-muted">{fmtClock(c.start_at)} – {fmtClock(c.end_at)} · <Place centre={{ name: c.centre_name, city: c.centre_city, address: c.centre_address }} />{c.room ? ` · ${c.room}` : ""}</p>
        {c.as_role !== "instructor" && c.instructor_name && <p className="text-sm text-muted">With {c.instructor_name}</p>}
      </div>

      {action}

      {next && <p className={cx("border-t border-line pt-3 text-sm text-muted")}>Then: {next.course_title} · {fmtWhen(next.start_at, { weekday: "short", day: "numeric", month: "short" })}, {fmtClock(next.start_at)}</p>}
    </Card>
  );
}
