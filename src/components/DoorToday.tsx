// src/components/DoorToday.tsx
// Today's classes at the centre(s) a coordinator or director looks after, with a way into each class's check-in screen.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { doorState, opensAt } from "../lib/checkin";
import { Badge, Card, Skeleton } from "./ui";
import Icon from "./Icon";

type S = { id: string; centre_id: string; centre_name: string; start_at: string; end_at: string; course_title: string; instructor_name: string | null; status: string; students_present: number | null; students_enrolled: number | null; is_emergency: boolean };
const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function DoorToday({ centreIds, showCentre }: { centreIds: string[]; showCentre?: boolean }) {
  const [rows, setRows] = useState<S[]>(); const [now, setNow] = useState(Date.now());
  const key = centreIds.join(",");
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!centreIds.length) { setRows([]); return; }
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); const d1 = new Date(d0.getTime() + 864e5);
    const load = () => supabase.from("v_session_details").select("id,centre_id,centre_name,start_at,end_at,course_title,instructor_name,status,students_present,students_enrolled,is_emergency")
      .in("centre_id", centreIds).gte("start_at", d0.toISOString()).lt("start_at", d1.toISOString()).neq("status", "cancelled").order("start_at").then((r) => setRows((r.data as S[]) ?? []));
    load();
    const ch = supabase.channel(`door-today-${key}`).on("postgres_changes", { event: "*", schema: "public", table: "class_sessions" }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!rows) return <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  return (
    <section className="space-y-2"><h2 className="text-lg">Classes today</h2>
      {rows.length === 0 ? <Card className="text-center text-muted">No classes today.</Card> : rows.map((s) => {
        const st = s.status === "completed" ? "done" : doorState(s.start_at, s.end_at, now);
        return (
          <Link key={s.id} to={`/class/${s.id}`}><Card onClick={() => {}} className="mb-2 space-y-1">
            <div className="flex items-center justify-between gap-3"><p className="font-medium">{s.course_title}{s.is_emergency && <span className="ml-2 text-xs font-normal text-warn">Emergency</span>}</p>
              <Badge tone={s.status === "completed" ? "ok" : st === "open" ? "warn" : "muted"}>{s.status === "completed" ? "Done" : s.status === "in_progress" ? "Live" : st === "open" ? "Check-in open" : "Scheduled"}</Badge></div>
            <p className="text-sm text-muted">{t(s.start_at)} – {t(s.end_at)}{showCentre ? ` · ${s.centre_name}` : ""}{s.instructor_name ? ` · ${s.instructor_name}` : ""}</p>
            {s.status === "completed"
              ? <p className="num text-sm">{s.students_present} of {s.students_enrolled} attended</p>
              : st === "open" ? <p className="flex items-center gap-1.5 text-sm font-medium text-accent"><Icon name="scan" size={16} />Open the class code</p>
              : st === "early" ? <p className="text-sm text-muted">Check-in opens at {opensAt(s.start_at)}</p> : null}
          </Card></Link>);
      })}
    </section>
  );
}
