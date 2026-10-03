import { useCallback, useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const sel = "h-12 w-full rounded-xl bg-sunken px-4 outline-none";
const hm = (t: string) => t.slice(0, 5);

export default function Cohorts() {
  const [cohorts, setCohorts] = useState<any[]>(); const [centres, setCentres] = useState<any[]>([]); const [courses, setCourses] = useState<any[]>([]); const [instr, setInstr] = useState<any[]>([]);
  const [cur, setCur] = useState<any>(null); const [slots, setSlots] = useState<any[]>([]);
  const [nc, setNc] = useState<any>(null); const [ns, setNs] = useState<any>(null); const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");

  const load = useCallback(async () => { const { data } = await supabase.from("cohorts").select("id,name,code,status,start_date,capacity,centres(name)").order("start_date", { ascending: false }); setCohorts(data ?? []); }, []);
  const loadSlots = useCallback(async (id: string) => { const { data } = await supabase.from("timetable_slots").select("id,day_of_week,start_time,end_time,room,courses(title),instructor:profiles!timetable_slots_instructor_id_fkey(full_name)").eq("cohort_id", id).eq("is_active", true).order("day_of_week").order("start_time"); setSlots(data ?? []); }, []);
  useEffect(() => {
    load();
    supabase.from("centres").select("id,name").eq("is_active", true).order("name").then((r) => setCentres(r.data ?? []));
    supabase.from("courses").select("id,title").order("sort_order").then((r) => setCourses(r.data ?? []));
    supabase.from("user_roles").select("user_id,profiles!user_roles_user_id_fkey(full_name)").eq("role", "instructor").eq("is_active", true).then((r) => setInstr(r.data ?? []));
  }, [load]);

  const createCohort = async () => {
    setBusy("c"); setErr(""); const { error } = await supabase.from("cohorts").insert({ centre_id: nc.centre, name: nc.name.trim(), code: nc.code.trim().toUpperCase(), start_date: nc.start, capacity: nc.cap ? Number(nc.cap) : null, status: "open", enrol_open_from: new Date().toISOString().slice(0, 10) });
    setBusy(""); if (error) return setErr(error.message.includes("duplicate") ? "That cohort code is already used." : friendly(error)); setNc(null); load();
  };
  const addSlot = async () => {
    setBusy("s"); setErr("");
    const { data, error } = await supabase.from("timetable_slots").insert({ cohort_id: cur.id, course_id: ns.course, instructor_id: ns.instr || null, day_of_week: Number(ns.day), start_time: ns.start, end_time: ns.end, room: ns.room || null, effective_from: cur.start_date }).select("id").single();
    if (error) { setBusy(""); return setErr(error.message.includes("clash") ? friendly({ message: "timetable_no_" }) : friendly(error)); }
    await supabase.rpc("generate_class_sessions", { p_slot_id: data.id, p_until: new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10) });
    setBusy(""); setNs(null); loadSlots(cur.id);
  };
  const generate = async () => { setBusy("g"); const { data } = await supabase.rpc("generate_upcoming_sessions", { p_weeks_ahead: 4 }); setBusy(""); setNote(`${data ?? 0} new classes created for the next 4 weeks.`); };
  const setStatus = async (status: string) => { await supabase.from("cohorts").update({ status }).eq("id", cur.id); setCur({ ...cur, status }); load(); };

  if (cur) return (
    <div className="space-y-4">
      <button onClick={() => { setCur(null); setNote(""); }} className="text-sm text-muted">← All cohorts</button>
      <div className="flex items-start justify-between"><div><h1 className="text-2xl">{cur.name}</h1><p className="text-muted">{cur.centres?.name} · starts {new Date(cur.start_date).toLocaleDateString()}</p></div><Badge tone={cur.status === "open" ? "ok" : "muted"}>{cur.status}</Badge></div>
      <div className="flex gap-2"><Button className="flex-1" onClick={() => { setErr(""); setNs({ course: "", instr: "", day: "1", start: "10:00", end: "12:30", room: "" }); }}>+ Add class slot</Button>
        <Button variant="secondary" loading={busy === "g"} onClick={generate}>Create classes</Button></div>
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
      <section className="space-y-2"><h2 className="text-lg">Weekly timetable</h2>
        {slots.length === 0 ? <Card className="text-center text-muted">No classes scheduled yet.</Card> : slots.map((s) => (
          <Card key={s.id} className="flex items-center justify-between py-3"><div><p className="font-medium">{s.courses?.title}</p><p className="text-sm text-muted">{DAYS[s.day_of_week]} · {hm(s.start_time)}–{hm(s.end_time)}{s.room ? ` · ${s.room}` : ""}</p></div>
            <p className="text-sm">{s.instructor?.full_name ?? <span className="text-warn">No instructor</span>}</p></Card>))}</section>
      <Button variant="ghost" className="w-full" onClick={() => setStatus(cur.status === "open" ? "closed" : "open")}>{cur.status === "open" ? "Close enrolment" : "Reopen enrolment"}</Button>
      <Sheet open={!!ns} onClose={() => setNs(null)} title="New class slot">
        {ns && <div className="space-y-3"><select className={sel} value={ns.course} onChange={(e) => setNs({ ...ns, course: e.target.value })}><option value="">Course…</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select className={sel} value={ns.instr} onChange={(e) => setNs({ ...ns, instr: e.target.value })}><option value="">Instructor (assign later)…</option>{instr.map((i) => <option key={i.user_id} value={i.user_id}>{i.profiles?.full_name}</option>)}</select>
          <select className={sel} value={ns.day} onChange={(e) => setNs({ ...ns, day: e.target.value })}>{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
          <div className="grid grid-cols-2 gap-3"><Field label="Starts" type="time" value={ns.start} onChange={(e) => setNs({ ...ns, start: e.target.value })} /><Field label="Ends" type="time" value={ns.end} onChange={(e) => setNs({ ...ns, end: e.target.value })} /></div>
          <Field label="Room" placeholder="Optional" value={ns.room} onChange={(e) => setNs({ ...ns, room: e.target.value })} /><Err>{err}</Err>
          <Button className="w-full" loading={busy === "s"} disabled={!ns.course} onClick={addSlot}>Add and create classes</Button></div>}
      </Sheet>
    </div>);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Cohorts</h1><Button className="h-10" onClick={() => { setErr(""); setNc({ centre: "", name: "", code: "", start: "", cap: "" }); }}>+ New</Button></div>
      {!cohorts ? <Skeleton className="h-24" /> : cohorts.length === 0 ? <Card className="text-center text-muted">Create your first cohort to open enrolment.</Card> : cohorts.map((c) => (
        <Card key={c.id} onClick={() => { setCur(c); loadSlots(c.id); }} className="flex items-center justify-between"><div><p className="font-medium">{c.name}</p><p className="text-sm text-muted">{c.centres?.name} · {new Date(c.start_date).toLocaleDateString()}</p></div><Badge tone={c.status === "open" ? "ok" : "muted"}>{c.status}</Badge></Card>))}
      <Sheet open={!!nc} onClose={() => setNc(null)} title="New cohort">
        {nc && <div className="space-y-3"><select className={sel} value={nc.centre} onChange={(e) => setNc({ ...nc, centre: e.target.value })}><option value="">Centre…</option>{centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <Field label="Name" value={nc.name} placeholder="e.g. November Intake" onChange={(e) => setNc({ ...nc, name: e.target.value })} /><Field label="Code" value={nc.code} placeholder="e.g. YABA-NOV26" onChange={(e) => setNc({ ...nc, code: e.target.value })} />
          <div className="grid grid-cols-2 gap-3"><Field label="Start date" type="date" value={nc.start} onChange={(e) => setNc({ ...nc, start: e.target.value })} /><Field label="Capacity" type="number" value={nc.cap} onChange={(e) => setNc({ ...nc, cap: e.target.value })} /></div>
          <Err>{err}</Err><Button className="w-full" loading={busy === "c"} disabled={!nc.centre || !nc.name || !nc.code || !nc.start} onClick={createCohort}>Create and open enrolment</Button></div>}
      </Sheet>
    </div>
  );
}
