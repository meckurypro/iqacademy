// src/pages/MyClasses.tsx
// What an instructor teaches: the classes an admin assigned to them, with topic, time and venue.
// It updates by itself when the roster changes, so a new assignment appears without a refresh.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import Place from "../components/Place";
import { Badge, Card, Skeleton } from "../components/ui";
import { fmtClock, fmtWhen } from "../lib/time";
import { dayOf, relativeDay, today } from "../lib/time";

type C = {
  id: string; session_no: number; start_at: string; end_at: string; status: string;
  course_id: string; course_title: string; total_sessions: number; lesson_title: string | null;
  centre_id: string; centre_name: string; centre_city: string | null; centre_address: string | null; is_emergency?: boolean;
};

const time = (d: string) => fmtClock(d);
const short = (d: string) => fmtWhen(d, { day: "numeric", month: "short" });
const dayKey = (d: string) => dayOf(d);
const dayLabel = (d: string) => relativeDay(d, { weekday: "long", day: "numeric", month: "short" });
const centreOf = (c: C) => ({ name: c.centre_name, city: c.centre_city, address: c.centre_address });

export default function MyClasses() {
  const { session } = useAuth();
  const [rows, setRows] = useState<C[]>();
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const r = await supabase.rpc("my_classes");
    if (r.error) { setFailed(true); setRows((old) => old ?? []); return; }
    setFailed(false); setRows((r.data as C[]) ?? []);
  }, []);

  useEffect(() => {
    load();
    if (!session) return;
    // A change to my classes (assigned, removed, moved) or a notice about it: reload the list.
    const ch = supabase.channel("my-classes-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "class_sessions", filter: `instructor_id=eq.${session.user.id}` }, load)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, load]);

  // One line per course and centre: what you teach and where
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; title: string; centre: C; n: number; first: string; last: string }>();
    (rows ?? []).forEach((c) => {
      const k = `${c.course_id}:${c.centre_id}`; const g = m.get(k);
      if (!g) m.set(k, { key: k, title: c.course_title, centre: c, n: 1, first: c.start_at, last: c.start_at });
      else { g.n++; if (c.start_at > g.last) g.last = c.start_at; }
    });
    return [...m.values()];
  }, [rows]);

  const days = useMemo(() => {
    const m = new Map<string, C[]>();
    (rows ?? []).forEach((c) => m.set(dayKey(c.start_at), [...(m.get(dayKey(c.start_at)) ?? []), c]));
    return [...m.values()];
  }, [rows]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl">My classes</h1>
      {!rows ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        : failed && rows.length === 0 ? <Card className="space-y-1 text-center text-sm text-muted"><p>Couldn't load your classes.</p><button className="font-medium text-accent" onClick={load}>Try again</button></Card>
        : rows.length === 0 ? <Card className="space-y-1 py-8 text-center"><p className="font-medium">Nothing assigned yet</p><p className="text-sm text-muted">When an admin assigns you classes you'll be notified, and they'll show up here.</p></Card>
        : <>
          <section className="space-y-2">
            <h2 className="text-lg">You teach</h2>
            <Card className="divide-y divide-line py-1">
              {groups.map((g) => (
                <div key={g.key} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0"><p className="font-medium">{g.title}</p><p className="text-sm text-muted"><Place centre={centreOf(g.centre)} /></p></div>
                  <div className="shrink-0 text-right"><p className="num text-sm font-medium">{g.n} {g.n === 1 ? "class" : "classes"}</p><p className="num text-xs text-muted">{g.n > 1 ? `${short(g.first)} to ${short(g.last)}` : short(g.first)}</p></div>
                </div>))}
            </Card>
          </section>

          <section className="space-y-4">
            <h2 className="-mb-2 text-lg">Coming up</h2>
            {days.map((list) => (
              <div key={dayKey(list[0].start_at)} className="space-y-2">
                <p className="text-sm font-medium text-muted">{dayLabel(list[0].start_at)}</p>
                {list.map((c) => {
                  const live = c.status === "in_progress";
                  const openable = live || dayKey(c.start_at) === today();
                  const body = (
                    <Card key={c.id} className="anim-fade space-y-1" onClick={openable ? () => {} : undefined}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{c.course_title}</p>
                        <span className="flex shrink-0 gap-1">{c.is_emergency && <Badge tone="bad">Emergency</Badge>}{live ? <Badge tone="warn">Live</Badge> : openable ? <Badge tone="ok">Today</Badge> : null}</span>
                      </div>
                      <p className="text-sm text-muted">{c.is_emergency ? "Emergency class" : `Class ${c.session_no} of ${c.total_sessions}`}{c.lesson_title ? ` · ${c.lesson_title}` : ""}</p>
                      <p className="num text-sm">{time(c.start_at)} – {time(c.end_at)}</p>
                      <p className="text-sm text-muted"><Place centre={centreOf(c)} /></p>
                    </Card>);
                  return openable ? <Link key={c.id} to={`/class/${c.id}`} className="block">{body}</Link> : <div key={c.id}>{body}</div>;
                })}
              </div>))}
          </section>
        </>}
    </div>
  );
}
