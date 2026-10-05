import { useEffect, useState } from "react";
import RunReminder from "../components/RunReminder";
import { Link } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { Card, Skeleton } from "../components/ui";
import { Stat } from "./InstructorHome";

import Icon from "../components/Icon";
export default function AdminHome() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d, setD] = useState<any>();
  const [off, setOff] = useState<{ open: number; with_receipt: number }>({ open: 0, with_receipt: 0 });
  useEffect(() => { supabase.rpc("admin_overview").then((r) => setD(r.data ?? {})); supabase.rpc("offline_payment_counts").then((r) => r.data && setOff(r.data as { open: number; with_receipt: number })); }, []);
  if (!d) return <div className="space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  const st = d.enrolments_by_status ?? {};
  return (
    <div className="space-y-6">
      <h1 className="text-2xl">Overview</h1>
      {off.open > 0 && <Link to="/offline-payments"><Card onClick={() => {}} className="flex items-center justify-between gap-3 ring-2 ring-warn/40"><div><p className="font-medium">{off.open} offline {off.open === 1 ? "payment" : "payments"} to review</p><p className="text-sm text-muted">{off.with_receipt} with a receipt uploaded</p></div><Icon name="chevronRight" size={18} className="shrink-0 text-muted" /></Card></Link>}
      <RunReminder />
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Revenue this month" value={naira(d.revenue_this_month ?? 0)} />
        <Stat label="Outstanding balances" value={naira(d.outstanding_balances ?? 0)} />
        <Stat label="Students" value={d.students_total ?? 0} sub={`${st.active ?? 0} active · ${st.pending_payment ?? 0} unpaid`} />
        <Stat label="Owed to centres" value={naira(d.owed_to_centres ?? 0)} />
        <Stat label="Classes today" value={d.sessions_today ?? 0} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/users"><Card onClick={() => {}} className="flex items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sunken text-accent"><Icon name="users" size={20} /></span><div className="min-w-0 flex-1"><p className="font-medium">Users</p><p className="text-sm text-muted">Search people and change their roles.</p></div><Icon name="chevronRight" size={18} className="shrink-0 text-muted" /></Card></Link>
        <Link to="/announce"><Card onClick={() => {}} className="flex items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sunken text-accent"><Icon name="announce" size={20} /></span><div className="min-w-0 flex-1"><p className="font-medium">Announcements</p><p className="text-sm text-muted">Message a person, centre, cohort or course.</p></div><Icon name="chevronRight" size={18} className="shrink-0 text-muted" /></Card></Link>
      </div>
    </div>
  );
}
