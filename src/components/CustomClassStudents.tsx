// src/components/CustomClassStudents.tsx
// Choosing who is invited to a custom class.
//
// Nobody is added for the instructor: eligibility is an explicit invitation, never "everyone at the centre" and never
// automatic (see the header of supabase/migrations/47_custom_classes.sql for why). The instructor finds students by name,
// or adds a group: a centre, a course, or a course run, in any mix. Every student chosen stays listed so they can be
// taken off again.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { placeLabel } from "../lib/centre";
import { fmtDay } from "../lib/time";
import Icon from "./Icon";

export type Student = { id: string; name: string; centre: string | null; /** already checked in: can't be taken off */ locked?: boolean };
type Found = { student_id: string; full_name: string | null; centre_name: string | null; courses: string | null };
type Centre = { id: string; name: string; city: string | null; address: string | null };
type Course = { id: string; title: string };
type Run = { id: string; centre_name: string; course_title: string; start_date: string; end_date: string };

const sel = "h-11 w-full rounded-xl bg-sunken px-3.5 text-[15px] outline-none ring-accent/40 transition focus:ring-2";
const toStudent = (f: Found): Student => ({ id: f.student_id, name: f.full_name?.trim() || "Student", centre: f.centre_name });
const dayRange = (r: Run) => `${fmtDay(r.start_date, { day: "numeric", month: "short" })} – ${fmtDay(r.end_date, { day: "numeric", month: "short" })}`;

export default function CustomClassStudents({ selected, onAdd, onRemove, centres, courses }: {
  selected: Student[]; onAdd: (s: Student[]) => void; onRemove: (id: string) => void; centres: Centre[]; courses: Course[];
}) {
  const ids = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  // ── by name ──
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Found[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState(false);
  useEffect(() => {
    const term = q.trim();
    setSearchErr(false);
    if (term.length < 2) { setHits([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await supabase.rpc("search_students_for_custom_class", { p_query: term, p_limit: 30 });
      if (!alive) return;
      setSearching(false);
      if (r.error) { setSearchErr(true); setHits([]); } else setHits((r.data as Found[]) ?? []);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  // ── by group ──
  const [groupOpen, setGroupOpen] = useState(false);
  const [gCentre, setGCentre] = useState(""); const [gCourse, setGCourse] = useState(""); const [gRun, setGRun] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [group, setGroup] = useState<Found[] | null>(null);
  const [groupErr, setGroupErr] = useState(false);

  useEffect(() => {
    setGRun(""); setRuns([]);
    if (!gCentre && !gCourse) return;
    let alive = true;
    supabase.rpc("custom_class_runs", { p_centre_id: gCentre || null, p_course_id: gCourse || null })
      .then((r) => { if (alive && !r.error) setRuns((r.data as Run[]) ?? []); });
    return () => { alive = false; };
  }, [gCentre, gCourse]);

  useEffect(() => {
    setGroup(null); setGroupErr(false);
    if (!gCentre && !gCourse && !gRun) return;
    let alive = true;
    supabase.rpc("search_students_for_custom_class", { p_centre_id: gCentre || null, p_course_id: gCourse || null, p_run_id: gRun || null, p_limit: 500 })
      .then((r) => { if (!alive) return; if (r.error) setGroupErr(true); else setGroup((r.data as Found[]) ?? []); });
    return () => { alive = false; };
  }, [gCentre, gCourse, gRun]);

  const fresh = (group ?? []).filter((f) => !ids.has(f.student_id));

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted">Students</span>
        <span className="num text-sm text-muted">{selected.length} invited</span>
      </div>

      {/* by name */}
      <div className="relative">
        <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
        <input className={`${sel} pl-10`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search students by name" autoComplete="off" />
      </div>
      {q.trim().length >= 2 && (
        <div className="overflow-hidden rounded-xl ring-1 ring-line">
          {searching ? <p className="px-3.5 py-3 text-sm text-muted">Searching…</p>
            : searchErr ? <p className="px-3.5 py-3 text-sm text-bad">Couldn't search. Try again.</p>
            : hits.length === 0 ? <p className="px-3.5 py-3 text-sm text-muted">No students found.</p>
            : <ul className="max-h-60 divide-y divide-line overflow-y-auto">
              {hits.map((f) => {
                const on = ids.has(f.student_id);
                return (
                  <li key={f.student_id}>
                    <button type="button" disabled={on} onClick={() => onAdd([toStudent(f)])}
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition hover:bg-sunken disabled:opacity-60">
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-medium">{f.full_name?.trim() || "Student"}</span>
                        <span className="block truncate text-sm text-muted">{[f.centre_name, f.courses].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent">{on ? <><Icon name="check" size={16} />Added</> : "Add"}</span>
                    </button>
                  </li>);
              })}
            </ul>}
        </div>
      )}

      {/* by group */}
      <button type="button" onClick={() => setGroupOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
        Add a group<Icon name={groupOpen ? "chevronUp" : "chevronDown"} size={16} />
      </button>
      {groupOpen && (
        <div className="space-y-2.5 rounded-xl bg-sunken/60 p-3 ring-1 ring-line">
          <select className={sel} value={gCentre} onChange={(e) => setGCentre(e.target.value)} aria-label="Centre">
            <option value="">Any centre</option>
            {centres.map((c) => <option key={c.id} value={c.id}>{placeLabel(c)}</option>)}
          </select>
          <select className={sel} value={gCourse} onChange={(e) => setGCourse(e.target.value)} aria-label="Course">
            <option value="">Any course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          {(gCentre || gCourse) && runs.length > 0 && (
            <select className={sel} value={gRun} onChange={(e) => setGRun(e.target.value)} aria-label="Course run">
              <option value="">Any run</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.course_title} · {r.centre_name} · {dayRange(r)}</option>)}
            </select>
          )}
          {!gCentre && !gCourse ? <p className="text-sm text-muted">Choose a centre or a course to see who is in it.</p>
            : groupErr ? <p className="text-sm text-bad">Couldn't load that group. Try again.</p>
            : group === null ? <p className="text-sm text-muted">Finding students…</p>
            : group.length === 0 ? <p className="text-sm text-muted">No active students match.</p>
            : <div className="flex items-center justify-between gap-3">
              <p className="num text-sm text-muted">{group.length} {group.length === 1 ? "student" : "students"}{fresh.length < group.length ? `, ${fresh.length} not added yet` : ""}{group.length >= 500 ? " (first 500)" : ""}</p>
              <button type="button" disabled={fresh.length === 0} onClick={() => onAdd(fresh.map(toStudent))}
                className="h-10 shrink-0 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink transition hover:opacity-90 active:scale-95 disabled:opacity-40">
                Add {fresh.length === group.length ? "all" : fresh.length}
              </button>
            </div>}
        </div>
      )}

      {/* who is invited */}
      {selected.length === 0 ? <p className="text-sm text-muted">No one yet. Search for a student or add a group.</p>
        : <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl ring-1 ring-line">
          {selected.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium">{s.name}</span>
                {s.centre && <span className="block truncate text-sm text-muted">{s.centre}</span>}
              </span>
              {s.locked ? <span className="shrink-0 text-sm text-muted">Checked in</span>
                : <button type="button" aria-label={`Remove ${s.name}`} onClick={() => onRemove(s.id)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-sunken"><Icon name="close" size={18} /></button>}
            </li>))}
        </ul>}
    </div>
  );
}
