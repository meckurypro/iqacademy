import { useEffect, useState } from "react";
import Place from "../components/Place";
import RunReminder from "../components/RunReminder";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Card, Skeleton } from "../components/ui";

type S = { id: string; start_at: string; end_at: string; status?: string; centre_name: string; centre_city?: string | null; centre_address?: string | null; course_title: string; students_present?: number; students_enrolled?: number };
const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
  <Card className="space-y-1"><p className="text-sm text-muted">{label}</p><p className="num text-2xl font-semibold tracking-tight">{value}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</Card>
);

export default function InstructorHome() {
  const { name } = useAuth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d, setD] = useState<any>();
  useEffect(() => { supabase.rpc("instructor_dashboard").then((r) => setD(r.data ?? {})); }, []);
  if (!d) return <div className="space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>;
  const today: S[] = d.today ?? [], up: S[] = d.upcoming ?? [];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Hi {name.split(" ")[0]} 👋</h1>
      <RunReminder />
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Classes taught" value={d.sessions_taught ?? 0} sub="this month" />
        <Stat label="Students taught" value={d.student_attendances ?? 0} sub={`${d.unique_students ?? 0} different people`} />
        <Stat label="Avg per class" value={d.avg_students_per_class ?? 0} />
        <Stat label="All time" value={d.lifetime?.sessions_taught ?? 0} sub={`${d.lifetime?.student_attendances ?? 0} student visits`} />
      </div>
      <section className="space-y-2"><h2 className="text-lg">Today</h2>
        {today.length === 0 ? <Card className="text-center text-muted">No classes today. Enjoy the break.</Card> :
          today.map((s) => (
            <Link key={s.id} to={`/class/${s.id}`}><Card onClick={() => {}} className="anim-fade mb-2 space-y-1">
              <div className="flex items-center justify-between"><p className="font-medium">{s.course_title}</p>
                <Badge tone={s.status === "completed" ? "ok" : s.status === "in_progress" ? "warn" : "muted"}>{s.status === "in_progress" ? "Live" : s.status}</Badge></div>
              <p className="text-sm text-muted">{t(s.start_at)} – {t(s.end_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly /></p>
              {s.status === "completed" && <p className="num text-sm">{s.students_present} of {s.students_enrolled} students attended</p>}
            </Card></Link>))}
      </section>
      <section className="space-y-2"><h2 className="text-lg">Coming up</h2>
        {up.length === 0 ? <p className="text-muted">Nothing scheduled in the next 7 days.</p> : up.map((s) => (
          <Card key={s.id} className="space-y-0.5"><p className="font-medium">{s.course_title}</p>
            <p className="text-sm text-muted">{new Date(s.start_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · {t(s.start_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly /></p>
            {s.centre_address && <p className="text-xs text-muted">{s.centre_address}</p>}</Card>))}
      </section>
    </div>
  );
}
