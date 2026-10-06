// src/components/CustomClassSheet.tsx
// Create or edit a custom class: centre, course, topic and time come from dropdowns, and the instructor chooses who is
// invited (see CustomClassStudents). An instructor teaches the class themselves; an admin also picks which instructor does.
// Editing changes the details and the invitations together, in one save.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { placeLabel } from "../lib/centre";
import { useFeedback } from "./feedback";
import { Button, Err, Sheet } from "./ui";
import CustomClassStudents, { type Student } from "./CustomClassStudents";
import { fromWallInput, now, toWallInput } from "../lib/time";

export type CustomClassRow = {
  id: string; start_at: string; end_at: string; status: string; course_id: string; course_title: string; lesson_id: string | null; lesson_title: string | null;
  centre_id: string; centre_name: string; centre_city: string | null; centre_address: string | null; instructor_id: string | null; instructor_name: string | null;
  notes: string | null; students_invited: number; students_present: number; can_edit: boolean;
};
type Centre = { id: string; name: string; city: string | null; address: string | null };
type Course = { id: string; title: string };
type Lesson = { id: string; lesson_no: number; title: string };
type Person = { id: string; name: string };

const sel = "h-12 w-full rounded-xl bg-sunken px-4 text-[15px] outline-none ring-accent/40 transition focus:ring-2";
const LENGTHS: [number, string][] = [[60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"]];

/** The next 5-minute mark at least a minute away, as a moment. */
const nextFive = () => Math.ceil((now() + 60000) / 300000) * 300000;
const byName = (a: Student, b: Student) => a.name.localeCompare(b.name);

const Label = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1.5 block text-sm text-muted">{text}</span>{children}</label>
);

export default function CustomClassSheet({ admin, edit, onClose, onSaved }: { admin: boolean; edit?: CustomClassRow; onClose: () => void; onSaved: () => void }) {
  const { run, toast } = useFeedback();
  const [centres, setCentres] = useState<Centre[]>();
  const [courses, setCourses] = useState<Course[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [centre, setCentre] = useState(edit?.centre_id ?? ""); const [course, setCourse] = useState(edit?.course_id ?? ""); const [lesson, setLesson] = useState(edit?.lesson_id ?? "");
  const [who, setWho] = useState("");
  const [start, setStart] = useState(() => toWallInput(edit ? Date.parse(edit.start_at) : nextFive()));
  const [minutes, setMinutes] = useState(() => edit ? Math.round((Date.parse(edit.end_at) - Date.parse(edit.start_at)) / 60000) : 120);
  const [note, setNote] = useState(edit?.notes ?? ""); const [err, setErr] = useState("");

  // who is invited. When editing, `initial` is who was invited when the sheet opened, so a save can send only the difference.
  const [selected, setSelected] = useState<Student[]>([]);
  const initial = useRef<Set<string>>(new Set());
  const [studentsReady, setStudentsReady] = useState(!edit);

  useEffect(() => {
    (async () => {
      const [c, k, p] = await Promise.all([
        supabase.from("centres").select("id,name,city,address").eq("is_active", true).order("city"),
        supabase.from("courses").select("id,title").eq("is_active", true).order("sort_order"),
        admin && !edit ? supabase.from("user_roles").select("user_id,profiles!user_roles_user_id_fkey(full_name)").eq("role", "instructor").eq("is_active", true) : Promise.resolve({ data: [], error: null }),
      ]);
      if (c.error || k.error || p.error) setLoadErr("Couldn't load the lists. Close this and try again.");
      setCentres((c.data as Centre[]) ?? []); setCourses((k.data as Course[]) ?? []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPeople(((p.data as any[]) ?? []).map((r) => ({ id: r.user_id as string, name: (r.profiles?.full_name as string) || "Instructor" })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, [admin, edit]);

  // the students already invited
  useEffect(() => {
    if (!edit) return;
    let alive = true;
    supabase.rpc("custom_class_students", { p_session_id: edit.id }).then((r) => {
      if (!alive) return;
      if (r.error) { setLoadErr("Couldn't load the invited students. Close this and try again."); return; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: Student[] = ((r.data as any[]) ?? []).map((x) => ({ id: x.student_id as string, name: (x.full_name as string)?.trim() || "Student", centre: x.centre_name as string | null, locked: x.status != null })).sort(byName);
      initial.current = new Set(list.map((s) => s.id)); setSelected(list); setStudentsReady(true);
    });
    return () => { alive = false; };
  }, [edit]);

  // The topic list follows the course
  useEffect(() => {
    setLessons([]);
    if (!course) return;
    let alive = true;
    supabase.from("course_lessons").select("id,lesson_no,title").eq("course_id", course).order("lesson_no").then((r) => { if (alive) setLessons((r.data as Lesson[]) ?? []); });
    return () => { alive = false; };
  }, [course]);

  const addStudents = (list: Student[]) => setSelected((cur) => { const m = new Map(cur.map((s) => [s.id, s])); list.forEach((s) => { if (!m.has(s.id)) m.set(s.id, s); }); return [...m.values()].sort(byName); });
  const removeStudent = (id: string) => setSelected((cur) => cur.filter((s) => s.id !== id));

  const min = useMemo(() => toWallInput(now()), []);
  const max = useMemo(() => toWallInput(now() + 29 * 864e5), []);
  const lengths = LENGTHS.some(([m]) => m === minutes) ? LENGTHS : [...LENGTHS, [minutes, `${minutes} min`] as [number, string]].sort((a, b) => a[0] - b[0]);
  const ready = !!centre && !!course && !!lesson && !!start && (!admin || !!edit || !!who) && studentsReady;

  const save = async () => {
    setErr("");
    const startIso = new Date(fromWallInput(start)).toISOString();
    if (!edit) {
      const r = await run("Creating class…", async () => {
        const { data, error } = await supabase.rpc("create_custom_class", {
          p_centre_id: centre, p_course_id: course, p_lesson_id: lesson, p_start: startIso, p_minutes: minutes,
          p_instructor_id: admin ? who : null, p_note: note.trim() || null, p_student_ids: selected.map((s) => s.id),
        });
        if (error) throw error;
        return data as string;
      }, { quiet: true });
      if (!r.ok) return setErr(r.message);
      const n = selected.length;
      toast(n === 0 ? "Custom class created." : `Custom class created. ${n} ${n === 1 ? "student" : "students"} invited.`);
      onSaved(); onClose(); return;
    }
    const add = selected.filter((s) => !initial.current.has(s.id)).map((s) => s.id);
    const remove = [...initial.current].filter((id) => !selected.some((s) => s.id === id));
    const r = await run("Saving…", async () => {
      const { data, error } = await supabase.rpc("edit_custom_class", {
        p_session_id: edit.id, p_centre_id: centre, p_course_id: course, p_lesson_id: lesson, p_start: startIso, p_minutes: minutes,
        p_note: note.trim(), p_add: add, p_remove: remove,
      });
      if (error) throw error;
      return data as { added: number; removed: number; not_eligible: number; kept: number };
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    const extra = [r.data.not_eligible > 0 ? `${r.data.not_eligible} couldn't be added.` : "", r.data.kept > 0 ? `${r.data.kept} already checked in, so they stay on the list.` : ""].filter(Boolean).join(" ");
    toast(["Saved.", extra].filter(Boolean).join(" "));
    onSaved(); onClose();
  };

  return (
    <Sheet open onClose={onClose} title={edit ? "Edit custom class" : "New custom class"}>
      <div className="space-y-4">
        <Err>{loadErr}</Err>
        <Label text="Centre">
          <select className={sel} value={centre} onChange={(e) => setCentre(e.target.value)} disabled={!centres}>
            <option value="">{centres ? "Choose a centre" : "Loading…"}</option>
            {(centres ?? []).map((c) => <option key={c.id} value={c.id}>{placeLabel(c)}</option>)}
          </select>
        </Label>
        <Label text="Course">
          <select className={sel} value={course} onChange={(e) => { setCourse(e.target.value); setLesson(""); }}>
            <option value="">Choose a course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </Label>
        <Label text="Topic">
          <select className={sel} value={lesson} onChange={(e) => setLesson(e.target.value)} disabled={!course}>
            <option value="">{course ? (lessons.length ? "Choose a topic" : "Loading…") : "Choose a course first"}</option>
            {lessons.map((l) => <option key={l.id} value={l.id}>{l.lesson_no}. {l.title}</option>)}
          </select>
        </Label>
        {admin && !edit && <Label text="Instructor">
          <select className={sel} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose an instructor</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Label>}
        <div className="grid grid-cols-5 gap-3">
          <div className="col-span-3"><Label text="Starts (centre time)">
            <input type="datetime-local" className={sel} value={start} min={edit ? undefined : min} max={max} onChange={(e) => setStart(e.target.value)} />
          </Label></div>
          <div className="col-span-2"><Label text="Length">
            <select className={sel} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {lengths.map(([m, t]) => <option key={m} value={m}>{t}</option>)}
            </select>
          </Label></div>
        </div>
        <Label text="Note for students (optional)">
          <input className={sel} value={note} maxLength={300} placeholder="For example: bring your laptop" onChange={(e) => setNote(e.target.value)} />
        </Label>
        {studentsReady
          ? <CustomClassStudents selected={selected} onAdd={addStudents} onRemove={removeStudent} centres={centres ?? []} courses={courses} />
          : <p className="text-sm text-muted">Loading students…</p>}
        <Err>{err}</Err>
        <Button className="w-full" disabled={!ready} onClick={save}>{edit ? "Save changes" : "Create custom class"}</Button>
      </div>
    </Sheet>
  );
}
