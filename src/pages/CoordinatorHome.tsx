import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Card, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CoordinatorHome() {
  const { roles, name } = useAuth();
  const centreId = roles.find((r) => r.role === "coordinator")?.centre_id;
  const [centre, setCentre] = useState<any>(); const [today, setToday] = useState<any[]>(); const [roster, setRoster] = useState<any[]>();
  useEffect(() => {
    if (!centreId) return;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); const d1 = new Date(d0.getTime() + 864e5);
    supabase.from("centres").select("name,address").eq("id", centreId).single().then((r) => setCentre(r.data));
    supabase.from("v_session_details").select("id,start_at,end_at,course_title,teacher:instructor_name,status,students_present,students_enrolled").eq("centre_id", centreId).gte("start_at", d0.toISOString()).lt("start_at", d1.toISOString()).order("start_at").then((r) => setToday(r.data ?? []));
    supabase.from("enrolments").select("id,status,cohorts(name),students(profiles(full_name,avatar_url))").eq("centre_id", centreId).in("status", ["active", "pending_payment"]).order("created_at", { ascending: false }).limit(100).then((r) => setRoster(r.data ?? []));
  }, [centreId]);
  const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (!centre || !today || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl">Hi {name.split(" ")[0]} 👋</h1><p className="text-muted">{centre.name}</p></div>
      <Card className="flex items-center gap-4"><div className="rounded-xl bg-white p-2"><QRCodeSVG value={location.origin} size={96} /></div>
        <div><p className="font-medium">Invite students</p><p className="text-sm text-muted">Let them scan this to open the app, create an account and enrol themselves.</p></div></Card>
      <section className="space-y-2"><h2 className="text-lg">Classes today</h2>
        {today.length === 0 ? <Card className="text-center text-muted">No classes at this centre today.</Card> : today.map((s) => (
          <Card key={s.id} className="space-y-0.5"><div className="flex justify-between"><p className="font-medium">{s.course_title}</p><Badge tone={s.status === "completed" ? "ok" : s.status === "in_progress" ? "warn" : "muted"}>{s.status === "in_progress" ? "Live" : s.status}</Badge></div>
            <p className="text-sm text-muted">{t(s.start_at)} – {t(s.end_at)}{s.teacher ? ` · ${s.teacher}` : ""}</p>
            {s.status === "completed" && <p className="num text-sm">{s.students_present} of {s.students_enrolled} attended</p>}</Card>))}</section>
      <section className="space-y-2"><h2 className="text-lg">Students <span className="num text-muted">({roster.length})</span></h2>
        {roster.map((e) => { const p = e.students?.profiles; return (
          <Card key={e.id} className="flex items-center gap-3 py-3"><Avatar name={p?.full_name ?? "?"} url={p?.avatar_url} size={36} />
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{p?.full_name}</p><p className="truncate text-sm text-muted">{e.cohorts?.name}</p></div>
            <Badge tone={e.status === "active" ? "ok" : "warn"}>{e.status === "active" ? "Active" : "Unpaid"}</Badge></Card>); })}</section>
    </div>
  );
}
