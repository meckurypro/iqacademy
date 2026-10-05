// src/components/EmergencyClassSheet.tsx
// Start an emergency class: centre, course, topic and time come from dropdowns.
// An instructor teaches the class themselves; an admin also picks which instructor does.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { placeLabel } from "../lib/centre";
import { useFeedback } from "./feedback";
import { Button, Err, Sheet } from "./ui";

type Centre = { id: string; name: string; city: string | null; address: string | null };
type Course = { id: string; title: string };
type Lesson = { id: string; lesson_no: number; title: string };
type Person = { id: string; name: string };

const sel = "h-12 w-full rounded-xl bg-sunken px-4 text-[15px] outline-none ring-accent/40 transition focus:ring-2";
const LENGTHS = [[60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"]] as const;

/** A value for <input type="datetime-local">, in the device's own time. */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const nextFive = () => { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(Math.ceil((d.getMinutes() + 1) / 5) * 5); return d; };

const Label = ({ text, children }: { text: string; children: React.ReactNode }) => (
  <label className="block"><span className="mb-1.5 block text-sm text-muted">{text}</span>{children}</label>
);

export default function EmergencyClassSheet({ admin, onClose, onCreated }: { admin: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { run } = useFeedback();
  const [centres, setCentres] = useState<Centre[]>();
  const [courses, setCourses] = useState<Course[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [centre, setCentre] = useState(""); const [course, setCourse] = useState(""); const [lesson, setLesson] = useState("");
  const [who, setWho] = useState(""); const [start, setStart] = useState(() => local(nextFive())); const [minutes, setMinutes] = useState(120);
  const [note, setNote] = useState(""); const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const [c, k, p] = await Promise.all([
        supabase.from("centres").select("id,name,city,address").eq("is_active", true).order("city"),
        supabase.from("courses").select("id,title").eq("is_active", true).order("sort_order"),
        admin ? supabase.from("user_roles").select("user_id,profiles!user_roles_user_id_fkey(full_name)").eq("role", "instructor").eq("is_active", true) : Promise.resolve({ data: [], error: null }),
      ]);
      if (c.error || k.error || p.error) setLoadErr("Couldn't load the lists. Close this and try again.");
      setCentres((c.data as Centre[]) ?? []); setCourses((k.data as Course[]) ?? []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPeople(((p.data as any[]) ?? []).map((r) => ({ id: r.user_id as string, name: (r.profiles?.full_name as string) || "Instructor" })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, [admin]);

  // The topic list follows the course
  useEffect(() => {
    setLesson(""); setLessons([]);
    if (!course) return;
    supabase.from("course_lessons").select("id,lesson_no,title").eq("course_id", course).order("lesson_no").then((r) => setLessons((r.data as Lesson[]) ?? []));
  }, [course]);

  const min = useMemo(() => local(new Date()), []);
  const max = useMemo(() => local(new Date(Date.now() + 29 * 864e5)), []);
  const ready = !!centre && !!course && !!lesson && !!start && (!admin || !!who);

  const save = async () => {
    setErr("");
    const r = await run("Creating class…", async () => {
      const { data, error } = await supabase.rpc("create_emergency_class", {
        p_centre_id: centre, p_course_id: course, p_lesson_id: lesson, p_start: new Date(start).toISOString(),
        p_minutes: minutes, p_instructor_id: admin ? who : null, p_note: note.trim() || null,
      });
      if (error) throw error;
      return data as string;
    }, { quiet: true, success: "Emergency class created" });
    if (!r.ok) return setErr(r.message);
    onCreated(r.data); onClose();
  };

  return (
    <Sheet open onClose={onClose} title="New emergency class">
      <div className="space-y-4">
        <p className="text-sm text-muted">Students registered at the centre are told straight away. Centre staff or an admin open check-in with the class code when students arrive.</p>
        <Err>{loadErr}</Err>
        <Label text="Centre">
          <select className={sel} value={centre} onChange={(e) => setCentre(e.target.value)} disabled={!centres}>
            <option value="">{centres ? "Choose a centre" : "Loading…"}</option>
            {(centres ?? []).map((c) => <option key={c.id} value={c.id}>{placeLabel(c)}</option>)}
          </select>
        </Label>
        <Label text="Course">
          <select className={sel} value={course} onChange={(e) => setCourse(e.target.value)}>
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
        {admin && <Label text="Instructor">
          <select className={sel} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Choose an instructor</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Label>}
        <div className="grid grid-cols-5 gap-3">
          <div className="col-span-3"><Label text="Starts">
            <input type="datetime-local" className={sel} value={start} min={min} max={max} onChange={(e) => setStart(e.target.value)} />
          </Label></div>
          <div className="col-span-2"><Label text="Length">
            <select className={sel} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {LENGTHS.map(([m, t]) => <option key={m} value={m}>{t}</option>)}
            </select>
          </Label></div>
        </div>
        <Label text="Note for students (optional)">
          <input className={sel} value={note} maxLength={300} placeholder="For example: bring your laptop" onChange={(e) => setNote(e.target.value)} />
        </Label>
        <Err>{err}</Err>
        <Button className="w-full" disabled={!ready} onClick={save}>Create emergency class</Button>
      </div>
    </Sheet>
  );
}
