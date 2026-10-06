import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { supabase, friendly, rawMessage } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Empty, Field, Sheet, Skeleton, cx } from "../components/ui";

import Icon from "../components/Icon";
// Admin: create courses and build each one class by class.
// A course has details (name, summary, visibility), prerequisites, and an outline: the admin picks how many
// classes it has and writes a topic and a short description for each. Instructors teach from the outline and
// students see it as their checklist.
// Everything is saved in ONE call (save_course) so a course is never left half-written, and after every save the
// page re-reads the database and checks that what is stored is what was typed. A save that didn't land is reported.
const MAX_CLASSES = 40;
const field = "w-full rounded-xl bg-sunken px-4 text-[15px] outline-none ring-accent/40 transition focus:ring-2";

type Row = { k: number; title: string; description: string };
type Details = { code: string; title: string; summary: string; active: boolean };
type Snapshot = { details: Details; rows: Row[]; groups: string[][] };
type Other = { id: string; title: string; code: string };
type Loaded = { snap: Snapshot; others: Other[] };
type Problem = { message: string; detail: string } | null;
type CourseRow = { id: string; code: string; title: string; total_sessions: number; is_active: boolean; course_lessons: { id: string; summary: string | null }[] };

let keySeq = 0;
const blankRow = (): Row => ({ k: ++keySeq, title: "", description: "" });
const hasText = (r: Row) => !!(r.title.trim() || r.description.trim());

// What actually matters when comparing "on screen" with "in the database".
const essence = (s: Snapshot) => JSON.stringify({
  t: s.details.title.trim(), s: s.details.summary.trim(), a: s.details.active,
  l: s.rows.map((r) => [r.title.trim(), r.description.trim()]),
  p: s.groups.filter((g) => g.length).map((g) => [...g].sort().join(",")).sort(),
});
const same = (a: Snapshot, b: Snapshot) => essence(a) === essence(b);

async function fetchCourse(id: string): Promise<Loaded> {
  const [c, l, p, all] = await Promise.all([
    supabase.from("courses").select("code,title,summary,is_active,total_sessions").eq("id", id).maybeSingle(),
    supabase.from("course_lessons").select("lesson_no,title,summary").eq("course_id", id).order("lesson_no"),
    supabase.from("course_prerequisites").select("prerequisite_id,group_no").eq("course_id", id).order("group_no"),
    supabase.from("courses").select("id,title,code").neq("id", id).order("sort_order"),
  ]);
  if (c.error) throw c.error;
  if (!c.data) throw new Error("course_not_found");
  if (l.error) throw l.error;
  if (p.error) throw p.error;
  if (all.error) throw all.error;

  const have = new Map((l.data ?? []).map((x) => [x.lesson_no as number, x]));
  const total = Math.max(1, c.data.total_sessions as number);
  const rows: Row[] = Array.from({ length: total }, (_, i) => {
    const x = have.get(i + 1);
    return { k: ++keySeq, title: x?.title ?? "", description: x?.summary ?? "" };
  });
  const byGroup = new Map<number, string[]>();
  (p.data ?? []).forEach((x) => byGroup.set(x.group_no as number, [...(byGroup.get(x.group_no as number) ?? []), x.prerequisite_id as string]));
  return {
    snap: { details: { code: c.data.code, title: c.data.title, summary: c.data.summary ?? "", active: c.data.is_active }, rows, groups: [...byGroup.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) },
    others: (all.data ?? []) as Other[],
  };
}

function useIsAdmin() {
  const { roles } = useAuth();
  return roles.some((r) => r.role === "admin" || r.role === "super_admin");
}

const ErrBox = ({ e }: { e: Problem }) => e ? (
  <div role="alert" className="space-y-1 rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">
    <p>{e.message}</p>
    {e.detail && e.detail !== e.message && <details className="text-xs opacity-80"><summary className="cursor-pointer">Technical details</summary><p className="mt-1 break-words font-mono">{e.detail}</p></details>}
  </div>) : null;

const IconBtn = ({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
    className={cx("grid h-9 w-9 place-items-center rounded-full text-sm transition active:scale-95 disabled:opacity-30", danger ? "text-bad hover:bg-bad/10" : "text-muted hover:bg-sunken")}>{children}</button>
);

// ───────────────────────────── course list ─────────────────────────────
function CourseList() {
  const nav = useNavigate(); const { run } = useFeedback();
  const [rows, setRows] = useState<CourseRow[]>(); const [loadErr, setLoadErr] = useState("");
  const [nf, setNf] = useState<{ title: string; code: string; summary: string } | null>(null);
  const [show, setShow] = useState(false); const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoadErr(""); setRows(undefined);
    const r = await supabase.from("courses").select("id,code,title,total_sessions,is_active,course_lessons(id,summary)").order("sort_order");
    if (r.error) { setLoadErr(friendly(r.error)); return setRows([]); }
    setRows((r.data as unknown as CourseRow[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const codeOk = !!nf && /^[A-Za-z0-9_-]{2,20}$/.test(nf.code.trim());
  const create = async () => {
    if (!nf) return; setShow(true); setErr("");
    if (!nf.title.trim() || !codeOk) return;
    const r = await run("Creating course…", async () => {
      const { data, error } = await supabase.rpc("save_course", {
        p_course_id: null, p_code: nf.code.trim(), p_title: nf.title.trim(), p_summary: nf.summary.trim() || null,
        p_is_active: false, p_lessons: null, p_prerequisites: null,
      });
      if (error) throw error;
      return data as string;
    }, { success: "Course created. Add its classes next.", quiet: true });
    if (!r.ok) return setErr(r.message);
    setNf(null); nav(`/courses/${r.data}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div><h1 className="text-[26px] leading-tight">Course builder</h1>
          <p className="text-sm text-muted">Create courses, set how many classes each has and what every class covers.</p></div>
        <Button className="h-10 shrink-0" onClick={() => { setErr(""); setShow(false); setNf({ title: "", code: "", summary: "" }); }}>+ New</Button>
      </div>
      {loadErr && <div className="space-y-2"><p className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{loadErr}</p><Button variant="secondary" onClick={load}>Try again</Button></div>}
      {!rows ? <><Skeleton className="h-20" /><Skeleton className="h-20" /></> : rows.length === 0 && !loadErr ? <Empty title="No courses yet. Tap “+ New” to create the first one." /> : rows.map((c) => {
        const described = c.course_lessons.filter((l) => l.summary && l.summary.trim()).length;
        return (
          <Link key={c.id} to={`/courses/${c.id}`} className="block">
            <Card onClick={() => {}} className="flex items-center justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{c.title}</p>
                <p className="text-sm text-muted">{c.code} · {c.total_sessions} {c.total_sessions === 1 ? "class" : "classes"} · {described} of {c.course_lessons.length} described</p></div>
              <div className="flex shrink-0 items-center gap-2">{!c.is_active && <Badge>Hidden</Badge>}<Icon name="chevronRight" size={18} className="shrink-0 text-muted" /></div>
            </Card>
          </Link>);
      })}

      <Sheet open={!!nf} onClose={() => setNf(null)} title="New course">
        {nf && <div className="space-y-3">
          <Field label="Course name" value={nf.title} maxLength={120} onChange={(e) => setNf({ ...nf, title: e.target.value })} placeholder="e.g. AI-Powered Web Development" />
          <Field label="Short code (can't be changed later)" value={nf.code} maxLength={20} placeholder="e.g. WEB" onChange={(e) => setNf({ ...nf, code: e.target.value.toUpperCase() })} />
          <label className="block"><span className="mb-1.5 block text-sm text-muted">Summary (shown to students)</span>
            <textarea className={cx(field, "min-h-[88px] py-3")} maxLength={500} value={nf.summary} onChange={(e) => setNf({ ...nf, summary: e.target.value })} /></label>
          <p className="text-sm text-muted">The new course starts hidden. You'll add its classes next, then turn on “Visible to students”.</p>
          {show && (!nf.title.trim() || !codeOk) && <ul className="space-y-1 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">
            {!nf.title.trim() && <li>• Give the course a name.</li>}{!codeOk && <li>• Add a short code (2–20 letters or numbers).</li>}</ul>}
          {err && <p role="alert" className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{err}</p>}
          <Button className="w-full" onClick={create}>Create course</Button>
        </div>}
      </Sheet>
    </div>
  );
}

// ───────────────────────────── course editor ─────────────────────────────
function Editor({ id }: { id: string }) {
  const nav = useNavigate(); const { run, confirm } = useFeedback();
  const [base, setBase] = useState<Snapshot>();   // what the database holds
  const [d, setD] = useState<Snapshot>();         // what is on screen
  const [others, setOthers] = useState<Other[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [show, setShow] = useState(false); const [err, setErr] = useState<Problem>(null);
  const [countText, setCountText] = useState("");

  const apply = useCallback((l: Loaded) => { setBase(l.snap); setD(l.snap); setOthers(l.others); setCountText(String(l.snap.rows.length)); }, []);
  const load = useCallback(async () => {
    setLoadErr(""); setBase(undefined); setD(undefined);
    try { apply(await fetchCourse(id)); } catch (e) { setLoadErr(friendly(e)); }
  }, [id, apply]);
  useEffect(() => { load(); }, [load]);

  const dirty = !!d && !!base && !same(d, base);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    addEventListener("beforeunload", h); return () => removeEventListener("beforeunload", h);
  }, [dirty]);

  const back = async () => {
    if (!dirty || await confirm({ title: "Leave without saving?", message: "Your changes to this course haven't been saved.", confirmLabel: "Leave", cancelLabel: "Keep editing", danger: true })) nav("/courses");
  };

  if (loadErr) return (
    <div className="space-y-3"><button onClick={() => nav("/courses")} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />All courses</span></button>
      <p role="alert" className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{loadErr}</p><Button variant="secondary" onClick={load}>Try again</Button></div>);
  if (!d || !base) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;

  // ---- editing ----
  const setDetail = (p: Partial<Details>) => setD({ ...d, details: { ...d.details, ...p } });
  const setRows = (rows: Row[]) => { setD({ ...d, rows }); setCountText(String(rows.length)); };
  const setRow = (i: number, p: Partial<Row>) => setD({ ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const move = (i: number, to: number) => { if (to < 0 || to >= d.rows.length) return; const rows = [...d.rows]; const [x] = rows.splice(i, 1); rows.splice(to, 0, x); setRows(rows); };
  const addRow = () => { if (d.rows.length < MAX_CLASSES) setRows([...d.rows, blankRow()]); };
  const removeRow = async (i: number) => {
    if (d.rows.length <= 1) return;
    if (hasText(d.rows[i]) && !(await confirm({ title: `Remove class ${i + 1}?`, message: "Its topic and description are removed when you save.", confirmLabel: "Remove class", danger: true }))) return;
    setRows(d.rows.filter((_, j) => j !== i));
  };
  const changeCount = async (n: number) => {
    if (!(n >= 1 && n <= MAX_CLASSES)) return setCountText(String(d.rows.length));   // not a usable number: put the old one back
    if (n === d.rows.length) return setCountText(String(n));
    if (n < d.rows.length) {
      const lost = d.rows.slice(n);
      if (lost.some(hasText) && !(await confirm({
        title: lost.length === 1 ? `Remove class ${n + 1}?` : `Remove classes ${n + 1}–${d.rows.length}?`,
        message: "What you've written for them is removed when you save.", confirmLabel: "Remove", danger: true,
      }))) return setCountText(String(d.rows.length));
      return setRows(d.rows.slice(0, n));
    }
    setRows([...d.rows, ...Array.from({ length: n - d.rows.length }, blankRow)]);
  };
  const setGroup = (gi: number, ids: string[]) => setD({ ...d, groups: d.groups.map((g, j) => (j === gi ? ids : g)) });
  const toggleIn = (gi: number, cid: string) => setGroup(gi, d.groups[gi].includes(cid) ? d.groups[gi].filter((x) => x !== cid) : [...d.groups[gi], cid]);

  // ---- save ----
  const problems: string[] = [];
  if (!d.details.title.trim()) problems.push("Give the course a name.");
  d.rows.forEach((r, i) => { if (!r.title.trim()) problems.push(`Class ${i + 1} needs a topic.`); });

  const save = async () => {
    setShow(true); setErr(null);
    if (problems.length) return;
    const sent = d;
    const r = await run("Saving course…", async () => {
      const { error } = await supabase.rpc("save_course", {
        p_course_id: id, p_code: sent.details.code, p_title: sent.details.title.trim(), p_summary: sent.details.summary.trim() || null, p_is_active: sent.details.active,
        p_lessons: sent.rows.map((x) => ({ title: x.title.trim(), description: x.description.trim() })),
        p_prerequisites: sent.groups.filter((g) => g.length),
      });
      if (error) throw error;
      // Read it back: only call it saved if the database really holds what was typed.
      const fresh = await fetchCourse(id);
      if (!same(fresh.snap, sent)) throw new Error("not_saved");
      return fresh;
    }, { success: "Course saved", quiet: true });
    if (!r.ok) return setErr({ message: r.message, detail: rawMessage(r.error) });
    apply(r.data); setShow(false);
  };

  const remove = async () => {
    const yes = await confirm({
      title: `Delete “${base.details.title}”?`,
      message: "This permanently deletes the course, every class outline in it and its project briefs, and removes it from learning pathways. It can't be deleted while students, classes or runs use it, or another course requires it. Hide it instead.",
      confirmLabel: "Delete course", danger: true,
    });
    if (!yes) return; setErr(null);
    const r = await run("Deleting course…", async () => {
      const { error } = await supabase.rpc("delete_course", { p_course_id: id }); if (error) throw error;
    }, { success: "Course deleted", quiet: true });
    if (!r.ok) return setErr({ message: r.message, detail: rawMessage(r.error) });
    nav("/courses", { replace: true });
  };

  const described = d.rows.filter((r) => r.description.trim()).length;
  return (
    <div className="space-y-5 pb-24">
      <button onClick={back} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />All courses</span></button>
      <div><h1 className="text-[26px] leading-tight">{base.details.title}</h1><p className="text-sm text-muted">{base.details.code} · {d.rows.length} {d.rows.length === 1 ? "class" : "classes"} · {described} described</p></div>

      <Card className="space-y-3">
        <h2 className="text-lg">Details</h2>
        <label className="block"><span className="mb-1.5 block text-sm text-muted">Course name</span>
          <input className={cx(field, "h-12", show && !d.details.title.trim() && "ring-2 ring-bad/50")} maxLength={120} value={d.details.title} onChange={(e) => setDetail({ title: e.target.value })} /></label>
        <label className="block"><span className="mb-1.5 block text-sm text-muted">Summary (shown to students)</span>
          <textarea className={cx(field, "min-h-[88px] py-3")} maxLength={500} value={d.details.summary} onChange={(e) => setDetail({ summary: e.target.value })} /></label>
        <label className="flex items-start gap-3 rounded-xl bg-sunken p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[rgb(var(--accent))]" checked={d.details.active} onChange={(e) => setDetail({ active: e.target.checked })} />
          <span><span className="font-medium">Visible to students</span><span className="block text-muted">Students can pick this course when they enrol. Turn it off to hide it without deleting anything.</span></span>
        </label>
      </Card>

      <Card className="space-y-3">
        <div><h2 className="text-lg">Prerequisites</h2>
          <p className="text-sm text-muted">Students must have finished <b className="font-medium text-ink">one course from every requirement</b> below before they can take this course.</p></div>
        {d.groups.length === 0 && <p className="text-sm text-muted">No prerequisites. Anyone can take this course.</p>}
        {d.groups.map((g, gi) => (
          <div key={gi} className="space-y-2 rounded-xl bg-sunken/60 p-3">
            <div className="flex items-center justify-between"><p className="text-sm font-medium">Requirement {gi + 1}: any one of</p>
              <button type="button" className="text-sm text-bad" onClick={() => setD({ ...d, groups: d.groups.filter((_, j) => j !== gi) })}>Remove</button></div>
            {others.length === 0 ? <p className="text-sm text-muted">There are no other courses yet.</p> : <div className="flex flex-wrap gap-2">{others.map((o) => (
              <button key={o.id} type="button" aria-pressed={g.includes(o.id)} onClick={() => toggleIn(gi, o.id)}
                className={cx("rounded-full px-3 py-1.5 text-sm transition active:scale-95", g.includes(o.id) ? "bg-accent text-accent-ink" : "bg-surface ring-1 ring-line")}>{o.title}</button>))}</div>}
            {g.length === 0 && <p className="text-xs text-warn">Pick at least one course, or remove this requirement. Empty requirements are ignored.</p>}
          </div>))}
        <Button type="button" variant="secondary" className="h-10 w-full text-sm" disabled={others.length === 0} onClick={() => setD({ ...d, groups: [...d.groups, []] })}>+ Add a requirement</Button>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg">Classes</h2>
        <Card className="flex items-center justify-between gap-3">
          <div><p className="font-medium">Number of classes</p><p className="text-sm text-muted">Students are expected to attend most of them.</p></div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Fewer classes" disabled={d.rows.length <= 1} onClick={() => changeCount(d.rows.length - 1)} className="grid h-10 w-10 place-items-center rounded-full bg-sunken text-lg disabled:opacity-40">−</button>
            <input aria-label="Number of classes" inputMode="numeric" value={countText} onChange={(e) => setCountText(e.target.value.replace(/\D/g, "").slice(0, 2))}
              onBlur={() => changeCount(Number(countText))} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="num h-10 w-12 rounded-xl bg-surface ring-1 ring-line text-center font-semibold outline-none transition focus:ring-2 focus:ring-accent/60" />
            <button type="button" aria-label="More classes" disabled={d.rows.length >= MAX_CLASSES} onClick={() => changeCount(d.rows.length + 1)} className="grid h-10 w-10 place-items-center rounded-full bg-sunken text-lg disabled:opacity-40">+</button>
          </div>
        </Card>

        <ol className="space-y-3">
          {d.rows.map((r, i) => (
            <li key={r.k}>
              <Card className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="num grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-sm font-semibold text-accent">{i + 1}</span>
                  <span className="flex-1 text-sm font-medium">Class {i + 1}</span>
                  <IconBtn label={`Move class ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chevronUp" size={18} /></IconBtn>
                  <IconBtn label={`Move class ${i + 1} down`} disabled={i === d.rows.length - 1} onClick={() => move(i, i + 1)}><Icon name="chevronDown" size={18} /></IconBtn>
                  <IconBtn label={`Remove class ${i + 1}`} danger disabled={d.rows.length <= 1} onClick={() => removeRow(i)}><Icon name="close" size={18} /></IconBtn>
                </div>
                <input className={cx(field, "h-12", show && !r.title.trim() && "ring-2 ring-bad/50")} placeholder="Topic" maxLength={120} value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} />
                <textarea className={cx(field, "min-h-[88px] py-3")} placeholder="What will be covered in this class?" maxLength={1000} value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                {r.description.length > 800 && <p className="num text-right text-xs text-muted">{r.description.length}/1000</p>}
              </Card>
            </li>))}
        </ol>
        <Button type="button" variant="secondary" className="w-full" disabled={d.rows.length >= MAX_CLASSES} onClick={addRow}>+ Add a class</Button>
        <p className="text-xs text-muted">Classes are numbered in order. Moving or removing a class changes which topic each class number covers, including for students already part-way through.</p>
      </section>

      <Card className="space-y-2 ring-bad/30">
        <h2 className="text-lg text-bad">Delete this course</h2>
        <p className="text-sm text-muted">Permanently removes the course, its outline and project briefs. Not possible while students, classes or runs use it, or another course requires it. Hide it instead.</p>
        <Button variant="secondary" className="w-full text-bad" onClick={remove}>Delete course…</Button>
      </Card>

      {show && problems.length > 0 && <ul className="space-y-1 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{problems.map((p) => <li key={p}>• {p}</li>)}</ul>}
      <ErrBox e={err} />
      <div className="sticky bottom-20 z-20 space-y-1.5 lg:bottom-4">
        {dirty && <p className="text-center text-xs font-medium text-warn">You have unsaved changes</p>}
        <Button className="w-full" disabled={!dirty} onClick={save}>{dirty ? "Save course" : "All changes saved"}</Button>
      </div>
    </div>
  );
}

export default function CourseBuilder() {
  const isAdmin = useIsAdmin();
  const { id } = useParams();
  if (!isAdmin) return <Navigate to="/" replace />;
  return id ? <Editor key={id} id={id} /> : <CourseList />;
}
