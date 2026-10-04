import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { Button, Card, Skeleton } from "./ui";

type Course = { id: string; title: string; summary: string | null };
type Pack = { id: string; name: string; course_count: number; price_full: number };

// What a new student sees first: what they'll learn, what it costs, then the way in.
export default function CourseOutline() {
  const [courses, setCourses] = useState<Course[]>();
  const [packs, setPacks] = useState<Pack[]>();

  useEffect(() => {
    supabase.from("courses").select("id,title,summary").eq("is_active", true).order("sort_order").then((r) => setCourses((r.data as Course[]) ?? []));
    supabase.from("packages").select("id,name,course_count,price_full").eq("is_active", true).order("sort_order").then((r) => setPacks((r.data as Pack[]) ?? []));
  }, []);

  const cta = <Link to="/enrol" className="block"><Button className="w-full">Enrol now</Button></Link>;

  return (
    <section className="anim-rise space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl">What you'll learn</h2>
        <p className="text-muted">Take one course or bundle them. Classes are in person.</p>
      </div>
      {cta}

      <ol className="space-y-2">
        {courses === undefined ? <><Skeleton className="h-16" /><Skeleton className="h-16" /></> : courses.map((c, i) => (
          <li key={c.id}>
            <Card className="flex gap-3 py-3">
              <span className="num grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{i + 1}</span>
              <div className="min-w-0"><p className="font-medium">{c.title}</p>{c.summary && <p className="mt-0.5 text-sm text-muted">{c.summary}</p>}</div>
            </Card>
          </li>))}
      </ol>

      {packs && packs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-lg">Packs</h3>
          <Card className="divide-y divide-line py-1">
            {packs.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="font-medium">{p.name}</p><p className="text-sm text-muted">{p.course_count} {p.course_count === 1 ? "course" : "courses"}</p></div>
                <span className="num font-medium">{naira(p.price_full)}</span>
              </div>))}
          </Card>
        </div>)}

      <Card className="space-y-1">
        <p className="font-medium">Pick a location</p>
        <p className="text-sm text-muted">We teach at several locations. Choose the one closest and most convenient for you.</p>
      </Card>
      {cta}
    </section>
  );
}
