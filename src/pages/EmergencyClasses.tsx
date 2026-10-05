// src/pages/EmergencyClasses.tsx
// Emergency classes: start one, and see the ones that are coming up or recently held.
// Admins see every centre and choose the instructor; instructors see and start their own.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import Place from "../components/Place";
import EmergencyClassSheet from "../components/EmergencyClassSheet";
import { Badge, Button, Card, Skeleton } from "../components/ui";
import { fmtClock, fmtWhen } from "../lib/time";
import { now as clockNow } from "../lib/time";

type E = {
  id: string; start_at: string; end_at: string; status: string; course_title: string; lesson_title: string | null;
  centre_name: string; centre_city: string | null; centre_address: string | null; instructor_name: string | null; students_present: number;
};

const when = (d: string) => fmtWhen(d, { weekday: "short", day: "numeric", month: "short" }) + " · " + fmtClock(d);
const tone = { in_progress: "warn", scheduled: "muted", completed: "ok", cancelled: "bad" } as const;
const text = { in_progress: "Live", scheduled: "Scheduled", completed: "Held", cancelled: "Cancelled" } as const;

export default function EmergencyClasses() {
  const { roles } = useAuth();
  const admin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const [rows, setRows] = useState<E[]>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await supabase.from("v_session_details")
      .select("id,start_at,end_at,status,course_title,lesson_title,centre_name,centre_city,centre_address,instructor_name,students_present")
      .eq("is_emergency", true).order("start_at", { ascending: false }).limit(40);
    if (r.error) { setFailed(true); setRows((old) => old ?? []); return; }
    setFailed(false); setRows((r.data as E[]) ?? []);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel("emergency-classes-live").on("postgres_changes", { event: "*", schema: "public", table: "class_sessions" }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const now = clockNow();
  const current = (rows ?? []).filter((s) => (s.status === "scheduled" || s.status === "in_progress") && Date.parse(s.end_at) >= now).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const past = (rows ?? []).filter((s) => !current.includes(s));

  const item = (s: E) => (
    <Link key={s.id} to={`/class/${s.id}`} className="block">
      <Card onClick={() => {}} className="anim-fade space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium">{s.course_title}</p>
          <Badge tone={tone[s.status as keyof typeof tone] ?? "muted"}>{text[s.status as keyof typeof text] ?? s.status}</Badge>
        </div>
        {s.lesson_title && <p className="text-sm text-muted">{s.lesson_title}</p>}
        <p className="num text-sm">{when(s.start_at)}</p>
        <p className="text-sm text-muted"><Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly />{admin && s.instructor_name ? ` · ${s.instructor_name}` : ""}</p>
        {s.status === "completed" && <p className="num text-sm">{s.students_present} {s.students_present === 1 ? "student" : "students"} attended</p>}
      </Card>
    </Link>);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">Emergency classes</h1>
        <p className="text-muted">A one-off class at a centre for a course and topic you choose. {admin ? "You choose who teaches it." : "You teach it yourself."}</p>
      </div>
      <Button className="w-full" onClick={() => setOpen(true)}>New emergency class</Button>

      {!rows ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : failed && rows.length === 0 ? <Card className="space-y-1 text-center text-sm text-muted"><p>Couldn't load emergency classes.</p><button className="font-medium text-accent" onClick={load}>Try again</button></Card>
        : <>
          <section className="space-y-2"><h2 className="text-lg">Coming up</h2>
            {current.length === 0 ? <Card className="text-center text-sm text-muted">No emergency classes are scheduled.</Card> : current.map(item)}
          </section>
          {past.length > 0 && <section className="space-y-2"><h2 className="text-lg">Recent</h2>{past.map(item)}</section>}
        </>}

      {open && <EmergencyClassSheet admin={admin} onClose={() => setOpen(false)} onCreated={load} />}
    </div>
  );
}
