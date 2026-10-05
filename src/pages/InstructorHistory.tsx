import { useCallback, useEffect, useState } from "react";
import Place from "../components/Place";
import { supabase } from "../lib/supabase";
import { Badge, Button, Card, Skeleton } from "../components/ui";

type H = { id: string; start_at: string; centre_name: string; centre_city: string | null; centre_address: string | null; course_title: string; lesson_title: string | null; students_present: number; students_enrolled: number; auto_closed: boolean };
const PAGE = 20;

export default function InstructorHistory() {
  const [rows, setRows] = useState<H[]>(); const [more, setMore] = useState(true); const [busy, setBusy] = useState(false);
  const load = useCallback(async (from: number) => {
    setBusy(true);
    const { data } = await supabase.from("v_session_details").select("id,start_at,centre_name,centre_city,centre_address,course_title,lesson_title,students_present,students_enrolled,auto_closed")
      .eq("status", "completed").order("start_at", { ascending: false }).range(from, from + PAGE - 1);
    setRows((p) => (from === 0 ? [] : p ?? []).concat((data as H[]) ?? [])); setMore((data?.length ?? 0) === PAGE); setBusy(false);
  }, []);
  useEffect(() => { load(0); }, [load]);
  if (!rows) return <div className="space-y-3"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Teaching history</h1>
      {rows.length === 0 && <Card className="text-center text-muted">Classes you teach will appear here.</Card>}
      {rows.map((r) => (
        <Card key={r.id} className="anim-fade flex items-center gap-3">
          <div className="min-w-0 flex-1"><p className="truncate font-medium">{r.course_title}</p>
            <p className="truncate text-sm text-muted">{new Date(r.start_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · <Place centre={{ name: r.centre_name, city: r.centre_city, address: r.centre_address }} nameOnly /></p>
            {r.auto_closed && <Badge tone="warn">Auto-closed</Badge>}</div>
          <div className="text-right"><p className="num text-xl font-semibold">{r.students_present}</p><p className="text-xs text-muted">of {r.students_enrolled}</p></div>
        </Card>))}
      {more && <Button variant="secondary" className="w-full" loading={busy} onClick={() => load(rows.length)}>Load more</Button>}
    </div>
  );
}
