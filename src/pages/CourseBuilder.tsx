import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Err, Skeleton, cx } from "../components/ui";

// Admin: build each course class by class. The admin picks how many classes the course has and writes a topic
// and a short description for each one. Instructors teach from it and students see it as their checklist.
// Saved in one call (save_course_outline), which also keeps the timetable and student progress in step.
type Lesson = { title: string; description: string };
type CourseRow = { id: string; code: string; title: string; total_sessions: number; is_active: boolean; course_lessons: { id: string; title: string; summary: string | null }[] };

const MAX_CLASSES = 40;
const field = "w-full rounded-xl bg-sunken px-4 text-[15px] outline-none ring-accent/40 transition focus:ring-2";

function useIsAdmin() {
  const { roles } = useAuth();
  return roles.some((r) => r.role === "admin" || r.role === "super_admin");
}

function CourseList() {
  const [rows, setRows] = useState<CourseRow[]>();
  useEffect(() => {
    supabase.from("courses").select("id,code,title,total_sessions,is_active,course_lessons(id,title,summary)").order("sort_order")
      .then((r) => setRows((r.data as unknown as CourseRow[]) ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl">Course builder</h1>
        <p className="text-sm text-muted">Set how many classes each course has and what every class covers. Instructors teach from this and students follow it.</p></div>
      {!rows ? <><Skeleton className="h-20" /><Skeleton className="h-20" /></> : rows.length === 0 ? <Card className="text-center text-muted">No courses yet.</Card> : rows.map((c) => {
        const described = c.course_lessons.filter((l) => l.summary && l.summary.trim()).length;
        return (
          <Link key={c.id} to={`/courses/${c.id}`} className="block">
            <Card onClick={() => {}} className="flex items-center justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{c.title}</p>
                <p className="text-sm text-muted">{c.total_sessions} classes · {described} of {c.course_lessons.length} described</p></div>
              <div className="flex shrink-0 items-center gap-2">{!c.is_active && <Badge>Hidden</Badge>}<span className="text-muted">›</span></div>
            </Card>
          </Link>);
      })}
    </div>
  );
}

function Editor({ id }: { id: string }) {
  const nav = useNavigate();
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Lesson[]>();
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(""); const [note, setNote] = useState(""); const [show, setShow] = useState(false);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([
      supabase.from("courses").select("title,total_sessions").eq("id", id).single(),
      supabase.from("course_lessons").select("lesson_no,title,summary").eq("course_id", id).order("lesson_no"),
    ]);
    if (c.error || !c.data) return setRows([]);
    setTitle(c.data.title);
    const have = new Map((l.data ?? []).map((x) => [x.lesson_no as number, x]));
    const total = c.data.total_sessions as number;
    const next = Array.from({ length: total }, (_, i) => { const x = have.get(i + 1); return { title: x?.title ?? "", description: x?.summary ?? "" }; });
    setRows(next); setSaved(JSON.stringify(next));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!rows) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /></div>;

  const dirty = JSON.stringify(rows) !== saved;
  const problems = rows.flatMap((r, i) => (r.title.trim() ? [] : [`Class ${i + 1} needs a topic.`]));
  const setRow = (i: number, patch: Partial<Lesson>) => { setNote(""); setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const setCount = (n: number) => {
    if (!(n >= 1 && n <= MAX_CLASSES) || n === rows.length) return;
    if (n < rows.length && rows.slice(n).some((r) => r.title.trim() || r.description.trim()) &&
      !confirm(`Remove class ${n + 1}${rows.length - n > 1 ? ` to ${rows.length}` : ""} and what you've written for ${rows.length - n > 1 ? "them" : "it"}?`)) return;
    setNote(""); setRows(n > rows.length ? [...rows, ...Array.from({ length: n - rows.length }, () => ({ title: "", description: "" }))] : rows.slice(0, n));
  };

  const save = async () => {
    setShow(true); setErr(""); setNote("");
    if (problems.length) return;
    setBusy(true);
    const { error } = await supabase.rpc("save_course_outline", { p_course_id: id, p_lessons: rows.map((r) => ({ title: r.title.trim(), description: r.description.trim() })) });
    setBusy(false);
    if (error) return setErr(friendly(error));
    setSaved(JSON.stringify(rows)); setShow(false);
    setNote("Saved. Upcoming classes and student progress now follow this outline.");
  };
  const back = () => { if (!dirty || confirm("Leave without saving your changes?")) nav("/courses"); };

  return (
    <div className="space-y-4">
      <button onClick={back} className="text-sm text-muted">← All courses</button>
      <div><h1 className="text-2xl">{title}</h1><p className="text-sm text-muted">One topic and a short description for each class.</p></div>

      <Card className="flex items-center justify-between gap-3">
        <div><p className="font-medium">Number of classes</p><p className="text-sm text-muted">Students are expected to attend most of them.</p></div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Fewer classes" disabled={rows.length <= 1} onClick={() => setCount(rows.length - 1)} className="grid h-10 w-10 place-items-center rounded-full bg-sunken text-lg disabled:opacity-40">−</button>
          <input aria-label="Number of classes" inputMode="numeric" value={rows.length} onChange={(e) => setCount(Number(e.target.value.replace(/\D/g, "")))} className="num h-10 w-12 rounded-xl bg-sunken text-center font-semibold outline-none" />
          <button type="button" aria-label="More classes" disabled={rows.length >= MAX_CLASSES} onClick={() => setCount(rows.length + 1)} className="grid h-10 w-10 place-items-center rounded-full bg-sunken text-lg disabled:opacity-40">+</button>
        </div>
      </Card>

      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={i}>
            <Card className="space-y-2">
              <div className="flex items-center gap-2"><span className="num grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{i + 1}</span><span className="text-sm font-medium">Class {i + 1}</span></div>
              <input className={cx(field, "h-12", show && !r.title.trim() && "ring-2 ring-bad/50")} placeholder="Topic" maxLength={120} value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} />
              <textarea className={cx(field, "min-h-[88px] py-3")} placeholder="What will be covered in this class?" maxLength={1000} value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
            </Card>
          </li>))}
      </ol>

      {show && problems.length > 0 && <ul className="space-y-1 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{problems.map((p) => <li key={p}>• {p}</li>)}</ul>}
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
      <Err>{err}</Err>
      <div className="sticky bottom-20 z-20"><Button className="w-full" loading={busy} disabled={!dirty} onClick={save}>{dirty ? "Save outline" : "Saved"}</Button></div>
    </div>
  );
}

export default function CourseBuilder() {
  const isAdmin = useIsAdmin();
  const { id } = useParams();
  if (!isAdmin) return <Navigate to="/" replace />;
  return id ? <Editor id={id} /> : <CourseList />;
}
