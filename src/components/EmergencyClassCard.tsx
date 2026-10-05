// src/components/EmergencyClassCard.tsx
// Shown on a student's home screen while an emergency class is open at a centre they are registered at.
// The Check in button opens the same code sheet as a normal class.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import Place from "./Place";
import { Badge, Card } from "./ui";

type E = {
  id: string; start_at: string; end_at: string; status: string; course_title: string; lesson_title: string | null;
  centre_name: string; centre_city: string | null; centre_address: string | null; instructor_first_name: string | null; note: string | null; checked_in: boolean;
};
const CHECKIN_OPENS_MIN = 30; // matches app_settings.checkin_opens_minutes_before

export default function EmergencyClassCard({ onCheckIn, refreshKey }: { onCheckIn: () => void; refreshKey?: unknown }) {
  const { session } = useAuth();
  const [rows, setRows] = useState<E[]>([]);
  const load = useCallback(() => { supabase.rpc("emergency_classes_for_me").then((r) => setRows((r.data as E[]) ?? [])); }, []);

  useEffect(() => {
    load();
    if (!session) return;
    // a new emergency class arrives as a notification
    const ch = supabase.channel("my-emergency-classes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, load, refreshKey]);

  if (rows.length === 0) return null;
  const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <>
      {rows.map((s) => {
        const opens = Date.parse(s.start_at) - CHECKIN_OPENS_MIN * 60000;
        const canCheckIn = Date.now() >= opens && !s.checked_in;
        return (
          <Card key={s.id} className="anim-rise space-y-2 ring-2 ring-warn/40">
            <div className="flex items-center justify-between gap-3"><p className="font-medium">Emergency class</p>{s.checked_in ? <Badge tone="ok">You're in</Badge> : <Badge tone="warn">{s.status === "in_progress" ? "Live" : "Coming up"}</Badge>}</div>
            <div><p className="text-lg font-semibold">{s.course_title}</p>{s.lesson_title && <p className="text-sm text-muted">{s.lesson_title}</p>}</div>
            <p className="text-sm text-muted">{new Date(s.start_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · {t(s.start_at)} – {t(s.end_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} />{s.instructor_first_name ? ` · with ${s.instructor_first_name}` : ""}</p>
            {s.note && <p className="text-sm">{s.note}</p>}
            {canCheckIn && <button onClick={onCheckIn} className="h-12 w-full rounded-xl bg-accent font-semibold text-accent-ink shadow-card transition active:scale-[.98]">Check in</button>}
            {!s.checked_in && !canCheckIn && <p className="text-sm text-muted">Check-in opens {CHECKIN_OPENS_MIN} minutes before the start. Ask the centre for the class code.</p>}
          </Card>);
      })}
    </>
  );
}
