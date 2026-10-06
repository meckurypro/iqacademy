// src/components/MyCentres.tsx
// Where a student is registered: the centre's town, name and address, and where that registration stands.
// Shows nothing for people with no registration (staff, new accounts), so it can sit on any profile.
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import Icon from "./Icon";
import Place from "./Place";
import { Badge, Card, Section } from "./ui";

type Centre = { id: string; name: string; city: string | null; address: string | null };
type Row = { id: string; status: "active" | "pending_payment" | "completed"; centres: Centre | null };
const RANK = { active: 0, pending_payment: 1, completed: 2 } as const;
const STATE = { active: { tone: "ok", text: "Registered" }, pending_payment: { tone: "warn", text: "Awaiting payment" }, completed: { tone: "muted", text: "Completed" } } as const;

export default function MyCentres() {
  const [rows, setRows] = useState<Row[]>();
  useEffect(() => {
    supabase.from("enrolments").select("id,status,centres(id,name,city,address)").in("status", ["pending_payment", "active", "completed"])
      .order("created_at", { ascending: false }).then((r) => setRows((r.data as unknown as Row[]) ?? []));
  }, []);
  if (!rows) return null;
  // one card per centre; if a student has several registrations there, the most current one speaks for it
  const byCentre = new Map<string, Row>();
  for (const r of rows) if (r.centres && (!byCentre.has(r.centres.id) || RANK[r.status] < RANK[byCentre.get(r.centres.id)!.status])) byCentre.set(r.centres.id, r);
  const list = [...byCentre.values()].sort((a, b) => RANK[a.status] - RANK[b.status]);
  if (list.length === 0) return null;
  return (
    <Section title={list.length === 1 ? "Your centre" : "Your centres"}>
      {list.map((r) => (
        <Card key={r.centres!.id} className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sunken text-muted"><Icon name="pin" size={18} /></span>
          <div className="min-w-0 flex-1"><p className="font-medium"><Place centre={r.centres!} /></p></div>
          <Badge tone={STATE[r.status].tone}>{STATE[r.status].text}</Badge>
        </Card>))}
    </Section>
  );
}
