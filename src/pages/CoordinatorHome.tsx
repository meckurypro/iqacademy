// src/pages/CoordinatorHome.tsx
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Card, PageHeader, Section, Skeleton, Main, Rail, Split } from "../components/ui";
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
    supabase.rpc("centre_students", { p_centre_id: centreId }).then((r) => setRoster(((r.data as any[]) ?? []).filter((e) => e.status !== "completed")));
  }, [centreId]);
  if (!centre || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  return (
    <div className="space-y-6">
      <PageHeader title={`Hi ${name.split(" ")[0]}`} sub={centre.name} />
      <Split><Rail>
      <ClassCountdown />
      <Card className="flex items-center gap-4"><div className="rounded-xl bg-white p-2"><QRCodeSVG value={location.origin} size={96} /></div>
        <div><p className="font-medium">Invite students</p><p className="text-sm text-muted">Let them scan this to open the app, create an account and enrol themselves.</p></div></Card>
      <DoorToday centreIds={[centreId!]} />
      </Rail><Main>
      <Section title="Students" aside={<span className="num">{roster.length}</span>}>
        <div className="grid gap-3 xl:grid-cols-2">{roster.map((e) => (
          <Card key={e.enrolment_id} className="flex items-center gap-3 py-3"><Avatar name={e.full_name ?? "?"} url={e.avatar_url} size={36} />
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{e.full_name}</p><p className="truncate text-sm text-muted">{e.pack}{e.duration_weeks ? ` · ${e.duration_weeks} weeks` : ""}</p></div>
            <Badge tone={e.status === "active" ? "ok" : "warn"}>{e.status === "active" ? "Active" : "Unpaid"}</Badge></Card>))}</div></Section>
      </Main></Split>
    </div>
  );
}
