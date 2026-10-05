import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Card, Skeleton } from "../components/ui";
import DoorToday from "../components/DoorToday";
import ClassCountdown from "../components/ClassCountdown";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CoordinatorHome() {
  const { roles, name } = useAuth();
  const centreId = roles.find((r) => r.role === "coordinator")?.centre_id;
  const [centre, setCentre] = useState<any>(); const [roster, setRoster] = useState<any[]>();
  useEffect(() => {
    if (!centreId) return;
    supabase.from("centres").select("name,address").eq("id", centreId).single().then((r) => setCentre(r.data));
    supabase.from("enrolments").select("id,status,students(profiles(full_name,avatar_url))").eq("centre_id", centreId).in("status", ["active", "pending_payment"]).order("created_at", { ascending: false }).limit(100).then((r) => setRoster(r.data ?? []));
  }, [centreId]);
  if (!centre || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl">Hi {name.split(" ")[0]}</h1><p className="text-muted">{centre.name}</p></div>
      <ClassCountdown />
      <Card className="flex items-center gap-4"><div className="rounded-xl bg-white p-2"><QRCodeSVG value={location.origin} size={96} /></div>
        <div><p className="font-medium">Invite students</p><p className="text-sm text-muted">Let them scan this to open the app, create an account and enrol themselves.</p></div></Card>
      <DoorToday centreIds={[centreId!]} />
      <section className="space-y-2"><h2 className="text-lg">Students <span className="num text-muted">({roster.length})</span></h2>
        {roster.map((e) => { const p = e.students?.profiles; return (
          <Card key={e.id} className="flex items-center gap-3 py-3"><Avatar name={p?.full_name ?? "?"} url={p?.avatar_url} size={36} />
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{p?.full_name}</p></div>
            <Badge tone={e.status === "active" ? "ok" : "warn"}>{e.status === "active" ? "Active" : "Unpaid"}</Badge></Card>); })}</section>
    </div>
  );
}
