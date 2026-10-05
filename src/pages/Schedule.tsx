// src/pages/Schedule.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const sel = "h-12 w-full rounded-xl bg-sunken px-4 outline-none";
const hm = (t: string) => t.slice(0, 5);
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const nice = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const fourMonths = () => { const d = new Date(); d.setMonth(d.getMonth() + 4); return iso(d); };

type DayRow = { day: string; start: string; end: string };
type RunForm = { id: string; course: string; start: string; end: string };

export default function Schedule() {
  const { run, confirm, toast } = useFeedback();
  const [admin, setAdmin] = useState<boolean>();
  const [centres, setCentres] = useState<any[]>();
  const [courses, setCourses] = useState<any[]>([]);
  const [centre, setCentre] = useState("");
  const [days, setDays] = useState<any[]>();
  const [runs, setRuns] = useState<any[]>();
  const [last, setLast] = useState<Record<string, { n: number; last: string; staffed: number }>>({});
  const [loadErr, setLoadErr] = useState("");
  const [dayForm, setDayForm] = useState<DayRow[] | null>(null);
  const [rf, setRf] = useState<RunForm | null>(null);
  const [err, setErr] = useState("");
  const today = iso(new Date());

  useEffect(() => {
    supabase.rpc("am_i_admin").then((r) => setAdmin(Boolean(r.data)));
    supabase.from("centres").select("id,name,city,address").eq("is_active", true).order("city").then((r) => {
      setCentres(r.data ?? []); if (r.data?.length) setCentre((c) => c || r.data![0].id);
    });
    supabase.from("courses").select("id,title,total_sessions").eq("is_active", true).order("sort_order").then((r) => setCourses(r.data ?? []));
  }, []);

  const load = useCallback(async () => {
    if (!centre) return;
    setLoadErr("");
    const [d, r] = await Promise.all([
      supabase.from("centre_class_days").select("id,day_of_week,start_time,end_time").eq("centre_id", centre).order("day_of_week"),
      supabase.from("course_runs").select("id,course_id,start_date,end_date,status,cancel_reason,courses(title)").eq("centre_id", centre).order("start_date", { ascending: false }),
    ]);
    if (d.error || r.error) { setLoadErr(friendly(d.error ?? r.error)); setDays([]); setRuns([]); return; }
    setDays(d.data ?? []); setRuns(r.data ?? []);
    const ids = (r.data ?? []).filter((x: any) => x.status === "scheduled").map((x: any) => x.id);
    if (!ids.length) return setLast({});
    const s = await supabase.from("class_sessions").select("run_id,session_date,instructor_id").in("run_id", ids).neq("status", "cancelled");
    const m: Record<string, { n: number; last: string; staffed: number }> = {};
    (s.data ?? []).forEach((x: any) => { const c = m[x.run_id] ?? { n: 0, last: "", staffed: 0 }; c.n++; if (x.instructor_id) c.staffed++; if (x.session_date > c.last) c.last = x.session_date; m[x.run_id] = c; });
    setLast(m);
  }, [centre]);
  useEffect(() => { setDays(undefined); setRuns(undefined); load(); }, [load]);

  const state = (x: any) => x.status === "cancelled" ? "Cancelled" : (last[x.id]?.last ?? x.end_date) < today ? "Ended" : x.start_date <= today ? "Running" : "Upcoming";

  // A course whose latest run is about to finish, with nothing scheduled after it
  const ending = useMemo(() => {
    const live = (runs ?? []).filter((x) => x.status === "scheduled");
    const byCourse = new Map<string, any>();
    live.forEach((x) => { const c = byCourse.get(x.course_id); if (!c || x.start_date > c.start_date) byCourse.set(x.course_id, x); });
    return [...byCourse.values()].map((x) => ({ x, end: last[x.id]?.last ?? x.end_date }))
      .filter(({ end }) => end >= today && end <= addDays(today, 14));
  }, [runs, last, today]);

  const openNew = (courseId = "", start = "") => { setErr(""); setRf({ id: "", course: courseId, start, end: "" }); };
  const openEdit = (x: any) => { setErr(""); setRf({ id: x.id, course: x.course_id, start: x.start_date, end: x.end_date }); };

  const suggest = async () => {
    if (!rf?.course || !rf.start) return setErr("Pick the course and start date first.");
    setErr("");
    const r = await supabase.rpc("suggest_run_end", { p_centre_id: centre, p_course_id: rf.course, p_start: rf.start });
    if (r.error) return setErr(friendly(r.error));
    if (r.data) setRf({ ...rf, end: r.data as string });
  };

  const saveRun = async () => {
    if (!rf) return; setErr("");
    const r = await run(rf.id ? "Saving run…" : "Scheduling…", async () => {
      const { data, error } = await supabase.rpc("save_course_run", {
        p_run_id: rf.id || null, p_centre_id: centre, p_course_id: rf.course, p_instructor_id: null, p_start: rf.start, p_end: rf.end });
      if (error) throw error;
      await load(); return data as any;
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setRf(null);
    toast(r.data.short_by > 0 ? `Saved, but only ${r.data.planned} of ${r.data.expected} classes fit. Extend the end date.` : "Saved", r.data.short_by > 0 ? "bad" : "ok");
  };

  const cancelRun = async (x: any) => {
    const yes = await confirm({ title: "Cancel this run?", message: `${x.courses?.title}, ${nice(x.start_date)} to ${nice(x.end_date)}. Upcoming classes are cancelled and enrolled students are told.`, confirmLabel: "Cancel run", danger: true });
    if (!yes) return;
    const r = await run("Cancelling…", async () => { const { error } = await supabase.rpc("cancel_course_run", { p_run_id: x.id, p_reason: null }); if (error) throw error; await load(); }, { success: "Run cancelled" });
    if (!r.ok) return;
  };

  const saveDays = async () => {
    if (!dayForm) return; setErr("");
    const r = await run("Saving class days…", async () => {
      const { error } = await supabase.rpc("save_centre_class_days", { p_centre_id: centre, p_days: dayForm.map((d) => ({ day: Number(d.day), start: d.start, end: d.end })) });
      if (error) throw error; await load();
    }, { success: "Class days saved", quiet: true });
    if (!r.ok) return setErr(r.message);
    setDayForm(null);
  };

  const ctr = centres?.find((c) => c.id === centre);
  const editable = (x: any) => x.status === "scheduled" && (last[x.id]?.last ?? x.end_date) >= today;

  if (!centres) return <div className="space-y-3"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-32" /></div>;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl">Schedule</h1>
      {centres.length === 0 ? <Card className="text-center text-muted">No centres yet.</Card> : <>
        <select value={centre} onChange={(e) => setCentre(e.target.value)} className={sel}>{centres.map((c) => <option key={c.id} value={c.id}>{place(c)}</option>)}</select>
        {loadErr && <div className="space-y-2"><Err>{loadErr}</Err><Button variant="secondary" onClick={load}>Try again</Button></div>}

        <section className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-lg">Class days</h2>
            {admin && <button className="text-sm font-medium text-accent" onClick={() => { setErr(""); setDayForm(days?.length ? days.map((d) => ({ day: String(d.day_of_week), start: hm(d.start_time), end: hm(d.end_time) })) : [{ day: "1", start: "10:00", end: "13:00" }]); }}>{days?.length ? "Edit" : "Set up"}</button>}</div>
          {!days ? <Skeleton className="h-16" /> : days.length === 0 ? <Card className="text-sm text-muted">{admin ? `No class days for ${place(ctr ?? { name: "this centre" })} yet. Set them up before scheduling courses.` : "This centre has no class days yet. Ask an admin to set them."}</Card>
            : <Card className="divide-y divide-line py-1">{days.map((d) => <div key={d.id} className="flex justify-between py-2.5"><span className="font-medium">{DAY[d.day_of_week]}</span><span className="num text-muted">{hm(d.start_time)} to {hm(d.end_time)}</span></div>)}</Card>}
        </section>

        {ending.map(({ x, end }) => (
          <Card key={x.id} className="space-y-2 border border-warn/40 bg-warn/10">
            <p className="font-medium">{x.courses?.title} ends {nice(end)}</p>
            <p className="text-sm text-muted">Nothing is scheduled after it. Set when it begins next.</p>
            <Button className="h-10 w-full" onClick={() => openNew(x.course_id, addDays(end, 1) > today ? addDays(end, 1) : today)} disabled={!days?.length}>Schedule next run</Button>
          </Card>))}

        <section className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-lg">Course runs</h2><Button className="h-10" disabled={!days?.length} onClick={() => openNew()}>+ New run</Button></div>
          {!runs ? <Skeleton className="h-24" /> : runs.length === 0 ? <Card className="text-center text-sm text-muted">No runs yet. A run says when a course begins and ends here.</Card>
            : runs.map((x) => { const s = state(x); const l = last[x.id]; return (
              <Card key={x.id} className="space-y-2">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium">{x.courses?.title}</p>
                  <p className="num text-sm text-muted">{nice(x.start_date)} to {nice(l?.last ?? x.end_date)}{l ? ` · ${l.n} classes` : ""}</p>
                  {admin && l && x.status === "scheduled" && <p className={l.staffed === l.n ? "text-sm text-ok" : "text-sm text-muted"}>{l.staffed === 0 ? "No instructors yet" : l.staffed === l.n ? "Every class has an instructor" : `${l.staffed} of ${l.n} classes have an instructor`}</p>}</div>
                  <Badge tone={s === "Running" ? "ok" : s === "Upcoming" ? "warn" : "muted"}>{s}</Badge></div>
                {admin && editable(x) && <Link to={`/roster?centre=${centre}&course=${x.course_id}`} className="block text-sm font-medium text-accent">{(l?.staffed ?? 0) === (l?.n ?? 0) && l ? "Open roster" : "Assign instructors"}</Link>}
                {editable(x) && <div className="flex gap-2"><Button variant="secondary" className="h-10 flex-1" onClick={() => openEdit(x)}>Edit</Button><Button variant="ghost" className="h-10 flex-1 text-bad" onClick={() => cancelRun(x)}>Cancel run</Button></div>}
              </Card>); })}
        </section>
      </>}

      <Sheet open={!!dayForm} onClose={() => setDayForm(null)} title={`Class days · ${ctr ? place(ctr) : ""}`}>
        {dayForm && <div className="space-y-3">
          <p className="text-sm text-muted">Every course here meets on these days and times.</p>
          {dayForm.map((d, i) => (
            <div key={i} className="space-y-2 rounded-xl bg-sunken p-3">
              <div className="flex gap-2"><select value={d.day} onChange={(e) => setDayForm(dayForm.map((x, j) => j === i ? { ...x, day: e.target.value } : x))} className="h-11 flex-1 rounded-xl bg-surface px-3 outline-none">
                {DAY.slice(1).map((n, k) => <option key={n} value={k + 1}>{n}</option>)}</select>
                {dayForm.length > 1 && <button className="px-3 text-bad" aria-label="Remove day" onClick={() => setDayForm(dayForm.filter((_, j) => j !== i))}>✕</button>}</div>
              <div className="grid grid-cols-2 gap-2"><Field label="Starts" type="time" value={d.start} onChange={(e) => setDayForm(dayForm.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} />
                <Field label="Ends" type="time" value={d.end} onChange={(e) => setDayForm(dayForm.map((x, j) => j === i ? { ...x, end: e.target.value } : x))} /></div>
            </div>))}
          {dayForm.length < 7 && <Button variant="secondary" className="w-full" onClick={() => setDayForm([...dayForm, { day: String((Math.max(...dayForm.map((d) => Number(d.day))) % 7) + 1), start: dayForm[dayForm.length - 1].start, end: dayForm[dayForm.length - 1].end }])}>+ Add a day</Button>}
          <Err>{err}</Err>
          <Button className="w-full" disabled={dayForm.some((d) => !d.start || !d.end)} onClick={saveDays}>Save class days</Button>
        </div>}
      </Sheet>

      <Sheet open={!!rf} onClose={() => setRf(null)} title={rf?.id ? "Edit run" : "New run"}>
        {rf && <div className="space-y-3">
          <p className="text-sm text-muted">{ctr ? place(ctr) : ""}{days?.length ? ` · ${days.map((d) => DAY[d.day_of_week].slice(0, 3)).join(", ")}` : ""}</p>
          <select value={rf.course} disabled={!!rf.id} onChange={(e) => setRf({ ...rf, course: e.target.value, end: "" })} className={sel}>
            <option value="">Choose course…</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <Field label="Begins" type="date" min={rf.id ? undefined : today} max={fourMonths()} value={rf.start} onChange={(e) => setRf({ ...rf, start: e.target.value, end: "" })} />
          <Field label="Ends" type="date" min={rf.start || today} value={rf.end} onChange={(e) => setRf({ ...rf, end: e.target.value })} />
          <button className="text-sm font-medium text-accent" onClick={suggest}>Suggest the end date</button>
          <p className="text-xs text-muted">You can schedule up to four months ahead. A run can't last longer than four months. Instructors are assigned class by class on the Roster.</p>
          <Err>{err}</Err>
          <Button className="w-full" disabled={!rf.course || !rf.start || !rf.end} onClick={saveRun}>{rf.id ? "Save" : "Schedule run"}</Button>
        </div>}
      </Sheet>
    </div>
  );
}
