import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Badge, Card } from "./ui";

// Free make-up classes: once a student's time is up they get two months and up to six classes to catch up on
// anything they missed. The numbers come from my_makeup_status(), so the rules live in one place (the database).
type Lesson = { course: string; lesson_no: number; title: string };
type Status = { enrolment_id: string; state: "pending" | "before" | "open" | "closed"; closes_at: string | null; missed: number; used: number; allowance: number; slots_left: number; lessons: Lesson[] };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });

export default function MakeupCard() {
  const [rows, setRows] = useState<Status[]>([]);
  useEffect(() => { supabase.rpc("my_makeup_status").then((r) => setRows((r.data as Status[]) ?? [])); }, []);
  const shown = rows.filter((r) => r.missed > 0 || (r.state === "open" && r.used > 0));
  if (shown.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-lg">Make-up classes</h2>
      {shown.map((r) => {
        const left = Math.min(r.slots_left, r.missed);
        return (
          <Card key={r.enrolment_id} className="space-y-2">
            {r.state === "open" && <>
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{left > 0 ? `${left} make-up ${left === 1 ? "class" : "classes"} left` : r.missed > 0 ? "No make-up classes left" : "All caught up"}</p>
                {r.closes_at && <Badge tone="warn">until {day(r.closes_at)}</Badge>}
              </div>
              <p className="text-sm text-muted">
                {r.missed > r.allowance - r.used && r.missed > 0
                  ? `You missed ${r.missed + r.used} classes. You can make up ${r.allowance} of them, free, before ${r.closes_at ? day(r.closes_at) : "the window closes"}.`
                  : `Attend the classes you missed, free, before ${r.closes_at ? day(r.closes_at) : "the window closes"}.`}
                {r.used > 0 && ` You've made up ${r.used} so far.`}
              </p>
            </>}
            {r.state === "closed" && <>
              <p className="font-medium">Make-up window closed</p>
              <p className="text-sm text-muted">You missed {r.missed} {r.missed === 1 ? "class" : "classes"} that weren't made up. You can still take the course again below.</p>
            </>}
            {(r.state === "before" || r.state === "pending") && <>
              <p className="font-medium">You've missed {r.missed} {r.missed === 1 ? "class" : "classes"} so far</p>
              <p className="text-sm text-muted">When your classes end you get two months to make up to six of them, free. Keep attending the rest.</p>
            </>}
            {r.lessons.length > 0 && r.state !== "before" && r.state !== "pending" && (
              <ul className="space-y-1 pt-1 text-sm">{r.lessons.map((l) => <li key={`${l.course}-${l.lesson_no}`} className="flex gap-2"><span className="text-bad">✕</span><span className="min-w-0"><span className="text-muted">{l.course} · </span>{l.title}</span></li>)}</ul>)}
          </Card>);
      })}
    </section>
  );
}
