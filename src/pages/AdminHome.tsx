import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { Card, Skeleton } from "../components/ui";
import { Stat } from "./InstructorHome";

export default function AdminHome() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d, setD] = useState<any>();
  useEffect(() => { supabase.rpc("admin_overview").then((r) => setD(r.data ?? {})); }, []);
  if (!d) return <div className="space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  const st = d.enrolments_by_status ?? {};
  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Overview</h1>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Revenue this month" value={naira(d.revenue_this_month ?? 0)} />
        <Stat label="Outstanding balances" value={naira(d.outstanding_balances ?? 0)} />
        <Stat label="Students" value={d.students_total ?? 0} sub={`${st.active ?? 0} active · ${st.pending_payment ?? 0} unpaid`} />
        <Stat label="Owed to centres" value={naira(d.owed_to_centres ?? 0)} />
        <Stat label="Classes today" value={d.sessions_today ?? 0} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/users"><Card onClick={() => {}} className="space-y-1"><p className="font-medium">Users 👥</p><p className="text-sm text-muted">Search people and change their roles.</p></Card></Link>
        <Link to="/announce"><Card onClick={() => {}} className="space-y-1"><p className="font-medium">Announcements 📣</p><p className="text-sm text-muted">Message a person, centre, cohort or course.</p></Card></Link>
      </div>
    </div>
  );
}
