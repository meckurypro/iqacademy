// src/pages/InstructorHome.tsx
import { useEffect, useState } from "react";
import Place from "../components/Place";
import RunReminder from "../components/RunReminder";
import ClassCountdown from "../components/ClassCountdown";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Card, Empty, List, NavRow, PageHeader, Section, Skeleton, Stat } from "../components/ui";

import Icon from "../components/Icon";
import { fmtClock, fmtWhen } from "../lib/time";
type S = { id: string; start_at: string; end_at: string; status?: string; centre_name: string; centre_city?: string | null; centre_address?: string | null; course_title: string; students_present?: number; students_enrolled?: number };
const t = (d: string) => fmtClock(d);

export default function InstructorHome() {
  const { name } = useAuth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d, setD] = useState<any>();
  useEffect(() => { supabase.rpc("instructor_dashboard").then((r) => setD(r.data ?? {})); }, []);
  if (!d) return <div className="space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>;
  const today: S[] = d.today ?? [], up: S[] = d.upcoming ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title={`Hi ${name.split(" ")[0]}`} />
      <RunReminder />
      <ClassCountdown />
      <List><NavRow to="/emergency" icon="alert" tone="warn" title="Emergency class" hint="Start an extra class at a centre" /></List>
      <div className="grid grid-cols-2 gap-3">
        <Stat tone="info" label="Classes this month" value={d.sessions_taught ?? 0} sub={`${d.lifetime?.sessions_taught ?? 0} all time`} />
        <Stat tone="ok" label="Students taught" value={d.student_attendances ?? 0} sub={`${d.unique_students ?? 0} different people · avg ${d.avg_students_per_class ?? 0} per class`} />
      </div>
      <Section title="Today">
        {today.length === 0 ? <Empty icon="today" title="No classes today" hint="Enjoy the break." /> :
          today.map((s) => (
            <Link key={s.id} to={`/class/${s.id}`} className="block"><Card onClick={() => {}} className="anim-fade space-y-1">
              <div className="flex items-center justify-between"><p className="font-medium">{s.course_title}</p>
                <Badge tone={s.status === "completed" ? "ok" : s.status === "in_progress" ? "info" : "muted"}>{s.status === "in_progress" ? "Live" : s.status === "completed" ? "Done" : "Scheduled"}</Badge></div>
              <p className="text-sm text-muted">{t(s.start_at)} – {t(s.end_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly /></p>
              {s.status === "completed" && <p className="num text-sm">{s.students_present} of {s.students_enrolled} students attended</p>}
            </Card></Link>))}
      </Section>
      <Section title="Coming up">
        {up.length === 0 ? <Empty icon="schedule" title="Nothing in the next 7 days" /> : up.map((s) => (
          <Card key={s.id} className="space-y-0.5"><p className="font-medium">{s.course_title}</p>
            <p className="text-sm text-muted">{fmtWhen(s.start_at, { weekday: "short", day: "numeric", month: "short" })} · {t(s.start_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly /></p>
            {s.centre_address && <p className="text-xs text-muted">{s.centre_address}</p>}</Card>))}
      </Section>
    </div>
  );
}
