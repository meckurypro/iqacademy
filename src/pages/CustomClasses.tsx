// src/pages/CustomClasses.tsx
// Custom classes: create one, choose who is invited, and see the ones that are coming up or recently held.
// Admins see every custom class and choose the instructor; instructors see and create their own.
// An instructor can change a class and its invitations until 30 minutes before it starts; the database enforces that
// (app_settings.custom_class_edit_lock_minutes), this page only hides the Edit button once the time has passed.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import Place from "../components/Place";
import CustomClassSheet, { type CustomClassRow } from "../components/CustomClassSheet";
import { Badge, Button, Card, Empty, PageHeader, Section, Skeleton } from "../components/ui";
import { fmtClock, fmtWhen, now as clockNow } from "../lib/time";

/** Matches app_settings.custom_class_edit_lock_minutes. */
const EDIT_LOCK_MIN = 30;

const when = (d: string) => fmtWhen(d, { weekday: "short", day: "numeric", month: "short" }) + " · " + fmtClock(d);
const tone = { in_progress: "warn", scheduled: "muted", completed: "ok", cancelled: "bad" } as const;
const text = { in_progress: "Live", scheduled: "Scheduled", completed: "Held", cancelled: "Cancelled" } as const;

export default function CustomClasses() {
  const { roles } = useAuth();
  const admin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const [rows, setRows] = useState<CustomClassRow[]>();
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<null | "new" | CustomClassRow>(null);

  const load = useCallback(async () => {
    const r = await supabase.rpc("custom_classes_overview");
    if (r.error) { setFailed(true); setRows((old) => old ?? []); return; }
    setFailed(false); setRows((r.data as CustomClassRow[]) ?? []);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel("custom-classes-live").on("postgres_changes", { event: "*", schema: "public", table: "class_sessions" }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const now = clockNow();
  const current = (rows ?? []).filter((s) => (s.status === "scheduled" || s.status === "in_progress") && Date.parse(s.end_at) >= now).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const past = (rows ?? []).filter((s) => !current.includes(s));
  // the server decides; the clock only hides the button once the cut-off has passed while this page is open
  const editable = (s: CustomClassRow) => s.can_edit && (admin || now <= Date.parse(s.start_at) - EDIT_LOCK_MIN * 60000);

  const item = (s: CustomClassRow) => (
    <Card key={s.id} className="anim-fade space-y-2">
      <Link to={`/class/${s.id}`} className="block space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium">{s.course_title}</p>
          <Badge tone={tone[s.status as keyof typeof tone] ?? "muted"}>{text[s.status as keyof typeof text] ?? s.status}</Badge>
        </div>
        {s.lesson_title && <p className="text-sm text-muted">{s.lesson_title}</p>}
        <p className="num text-sm">{when(s.start_at)}</p>
        <p className="text-sm text-muted"><Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly />{admin && s.instructor_name ? ` · ${s.instructor_name}` : ""}</p>
      </Link>
      <div className="flex items-center justify-between gap-3">
        <p className="num text-sm text-muted">
          {s.students_invited} {s.students_invited === 1 ? "student" : "students"} invited{s.status === "completed" ? ` · ${s.students_present} attended` : ""}
        </p>
        {editable(s) && <button onClick={() => setSheet(s)} className="h-9 shrink-0 rounded-lg bg-sunken px-3.5 text-sm font-medium transition hover:opacity-90 active:scale-95">Edit</button>}
      </div>
    </Card>);

  return (
    <div className="space-y-5">
      <PageHeader title="Custom classes" />
      <Button className="w-full" onClick={() => setSheet("new")}>New custom class</Button>

      {!rows ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : failed && rows.length === 0 ? <Card className="space-y-1 text-center text-sm text-muted"><p>Couldn't load custom classes.</p><button className="font-medium text-accent" onClick={load}>Try again</button></Card>
        : <>
          <Section title="Coming up">
            {current.length === 0 ? <Empty icon="calendarPlus" title="No custom classes coming up" /> : current.map(item)}
          </Section>
          {past.length > 0 && <Section title="Recent">{past.map(item)}</Section>}
        </>}

      {sheet && <CustomClassSheet key={sheet === "new" ? "new" : sheet.id} admin={admin} edit={sheet === "new" ? undefined : sheet} onClose={() => setSheet(null)} onSaved={load} />}
    </div>
  );
}
