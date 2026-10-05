import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Avatar, Card, Field, Skeleton } from "../components/ui";
import { monthStart, today } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Instructors() {
  const [from, setFrom] = useState(monthStart(today())); const [to, setTo] = useState(today());
  const [rows, setRows] = useState<any[]>();
  useEffect(() => { setRows(undefined); supabase.rpc("admin_instructor_summary", { p_from: from, p_to: to }).then((r) => setRows(r.data ?? [])); }, [from, to]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Instructors</h1>
      <div className="grid grid-cols-2 gap-3"><Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      {!rows ? <Skeleton className="h-24" /> : rows.length === 0 ? <Card className="text-center text-muted">No instructors yet. Promote someone on the Users page.</Card> : rows.map((r) => (
        <Card key={r.instructor_id} className="space-y-3"><div className="flex items-center gap-3"><Avatar name={r.full_name} size={40} /><div><p className="font-medium">{r.full_name}</p><p className="text-xs text-muted capitalize">{String(r.pay_model).replace("_", " ")}</p></div></div>
          <div className="grid grid-cols-3 gap-2 text-center"><div><p className="num text-xl font-semibold">{r.sessions_taught}</p><p className="text-xs text-muted">classes</p></div>
            <div><p className="num text-xl font-semibold">{r.student_attendances}</p><p className="text-xs text-muted">students taught</p></div>
            <div><p className="num text-xl font-semibold">{r.avg_students_per_class}</p><p className="text-xs text-muted">avg / class</p></div></div></Card>))}
    </div>
  );
}
