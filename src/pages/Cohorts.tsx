import { useCallback, useEffect, useState } from "react";
import { supabase, friendly, rawMessage } from "../lib/supabase";
import { mapDuplicate, ok, touched } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const sel = "h-12 w-full rounded-xl bg-sunken px-4 outline-none";
const hm = (t: string) => t.slice(0, 5);
type CohortForm = { id: string; centre: string; centreName: string; name: string; code: string; start: string; cap: string };
type SlotForm = { id: string; course: string; instr: string; day: string; start: string; end: string; room: string };

export default function Cohorts() {
  const { run, confirm } = useFeedback();
  const [cohorts, setCohorts] = useState<any[]>(); const [loadErr, setLoadErr] = useState(""); const [centres, setCentres] = useState<any[]>([]); const [courses, setCourses] = useState<any[]>([]); const [instr, setInstr] = useState<any[]>([]);
  const [cur, setCur] = useState<any>(null); const [slots, setSlots] = useState<any[]>([]);
  const [nc, setNc] = useState<CohortForm | null>(null); const [ns, setNs] = useState<SlotForm | null>(null); const [err, setErr] = useState(""); const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("cohorts").select("id,name,code,status,start_date,capacity,centre_id,centres(name)").order("start_date", { ascending: false });
    if (error) { setLoadErr(friendly(error)); setCohorts([]); return [] as any[]; }
    setLoadErr(""); setCohorts(data ?? []); return data ?? [];
  }, []);
  const loadSlots = useCallback(async (id: string) => {
    const { data, error } = await supabase.from("timetable_slots").select("id,course_id,instructor_id,day_of_week,start_time,end_time,room,courses(title),instructor:profiles!timetable_slots_instructor_id_fkey(full_name)").eq("cohort_id", id).eq("is_active", true).order("day_of_week").order("start_time");
    if (error) throw error;
    setSlots(data ?? []);
  }, []);
  useEffect(() => {
    load();
    supabase.from("centres").select("id,name").eq("is_active", true).order("name").then((r) => setCentres(r.data ?? []));
    supabase.from("courses").select("id,title").order("sort_order").then((r) => setCourses(r.data ?? []));
    supabase.from("user_roles").select("user_id,profiles!user_roles_user_id_fkey(full_name)").eq("role", "instructor").eq("is_active", true).then((r) => setInstr(r.data ?? []));
  }, [load]);

  const openCohort = async (c: any) => {
    setCur(c); setNote(""); setSlots([]);
    try { await loadSlots(c.id); } catch (e) { setNote(""); setErr(friendly(e)); }
  };

  // ---- cohorts: create / edit / delete ----
  const saveCohort = async () => {
    if (!nc) return; setErr("");
    const r = await run(nc.id ? "Saving cohort…" : "Creating cohort…", async () => {
      const fields = { name: nc.name.trim(), code: nc.code.trim().toUpperCase(), start_date: nc.start, capacity: nc.cap ? Number(nc.cap) : null };
      try {
        if (nc.id) touched(await supabase.from("cohorts").update(fields).eq("id", nc.id).select("id"));
        else ok(await supabase.from("cohorts").insert({ ...fields, centre_id: nc.centre, status: "open", enrol_open_from: new Date().toISOString().slice(0, 10) }));
      } catch (e) { throw mapDuplicate(e, "cohort_code_taken"); }
      const rows = await load();
      if (nc.id && cur?.id === nc.id) setCur(rows.find((x: any) => x.id === nc.id) ?? cur);
    }, { success: nc.id ? "Cohort saved" : "Cohort created. Enrolment is open.", quiet: true });
    if (!r.ok) return setErr(r.message);
    setNc(null);
  };
  const removeCohort = async () => {
    if (!cur) return;
    const yes = await confirm({
      title: `Delete ${cur.name}?`,
      message: "This removes the cohort and its weekly timetable. A cohort that students have enrolled in can't be deleted. Close enrolment instead.",
      confirmLabel: "Delete cohort", danger: true,
    });
    if (!yes) return;
    const r = await run("Deleting cohort…", async () => { const { error } = await supabase.rpc("delete_cohort", { p_cohort_id: cur.id }); if (error) throw error; await load(); }, { success: "Cohort deleted" });
    if (r.ok) setCur(null);
  };
  const setStatus = async (status: string) => {
    const r = await run(status === "closed" ? "Closing enrolment…" : "Reopening enrolment…", async () => {
      touched(await supabase.from("cohorts").update({ status }).eq("id", cur.id).select("id")); await load();
    }, { success: status === "closed" ? "Enrolment closed" : "Enrolment reopened" });
    if (r.ok) setCur({ ...cur, status });
  };

  // ---- timetable slots: add / edit / remove ----
  const saveSlot = async () => {
    if (!ns || !cur) return; setErr("");
    if (ns.start >= ns.end) return setErr("A class has to end after it starts.");
    const r = await run(ns.id ? "Saving class slot…" : "Adding class slot…", async () => {
      try {
        if (ns.id) {
          const { error } = await supabase.rpc("update_timetable_slot", { p_slot_id: ns.id, p_course_id: ns.course, p_instructor_id: ns.instr || null, p_day: Number(ns.day), p_start: ns.start, p_end: ns.end, p_room: ns.room || null });
          if (error) throw error;
        } else {
          const row = { cohort_id: cur.id, course_id: ns.course, instructor_id: ns.instr || null, day_of_week: Number(ns.day), start_time: ns.start, end_time: ns.end, room: ns.room || null, effective_from: cur.start_date };
          // Slots belong to a centre directly (migration 20). Fall back gracefully if that column isn't there yet.
          let ins = await supabase.from("timetable_slots").insert({ ...row, centre_id: cur.centre_id }).select("id").single();
          if (ins.error && /centre_id/.test(ins.error.message)) ins = await supabase.from("timetable_slots").insert(row).select("id").single();
          const slot = ok(ins) as { id: string };
          const g = await supabase.rpc("generate_class_sessions", { p_slot_id: slot.id, p_until: new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10) });
          if (g.error) throw g.error;
        }
      } catch (e) { throw /clash/i.test(rawMessage(e)) ? new Error("timetable_no_") : e; }
      await loadSlots(cur.id);
    }, { success: ns.id ? "Class slot saved" : "Class slot added", quiet: true });
    if (!r.ok) return setErr(r.message);
    setNs(null);
  };
  const removeSlot = async (s: any) => {
    const yes = await confirm({
      title: "Remove this class slot?",
      message: `${s.courses?.title ?? "This class"} on ${DAYS[s.day_of_week]}s, ${hm(s.start_time)}–${hm(s.end_time)} comes off the weekly timetable, and its upcoming classes are removed.`,
      confirmLabel: "Remove slot", danger: true,
    });
    if (!yes) return;
    await run("Removing class slot…", async () => { const { error } = await supabase.rpc("remove_timetable_slot", { p_slot_id: s.id }); if (error) throw error; await loadSlots(cur.id); }, { success: "Class slot removed" });
  };
  const generate = async () => {
    setNote("");
    const r = await run("Creating classes…", async () => { const { data, error } = await supabase.rpc("generate_upcoming_sessions", { p_weeks_ahead: 4 }); if (error) throw error; return (data as number) ?? 0; });
    if (r.ok) setNote(`${r.data} new classes created for the next 4 weeks.`);
  };

  const cohortSheet = (
    <Sheet open={!!nc} onClose={() => setNc(null)} title={nc?.id ? "Edit cohort" : "New cohort"}>
      {nc && <div className="space-y-3">
        {nc.id ? <p className="rounded-xl bg-sunken px-4 py-3 text-sm text-muted">Centre: <span className="font-medium text-ink">{nc.centreName}</span></p>
          : <select className={sel} value={nc.centre} onChange={(e) => setNc({ ...nc, centre: e.target.value })}><option value="">Centre…</option>{centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        <Field label="Name" value={nc.name} placeholder="e.g. November Intake" onChange={(e) => setNc({ ...nc, name: e.target.value })} /><Field label="Code" value={nc.code} placeholder="e.g. YABA-NOV26" onChange={(e) => setNc({ ...nc, code: e.target.value })} />
        <div className="grid grid-cols-2 gap-3"><Field label="Start date" type="date" value={nc.start} onChange={(e) => setNc({ ...nc, start: e.target.value })} /><Field label="Capacity" type="number" value={nc.cap} onChange={(e) => setNc({ ...nc, cap: e.target.value })} /></div>
        <Err>{err}</Err><Button className="w-full" disabled={!nc.centre || !nc.name || !nc.code || !nc.start} onClick={saveCohort}>{nc.id ? "Save changes" : "Create and open enrolment"}</Button></div>}
    </Sheet>
  );

  if (cur) return (
    <div className="space-y-4">
      <button onClick={() => { setCur(null); setNote(""); }} className="text-sm text-muted">← All cohorts</button>
      <div className="flex items-start justify-between"><div><h1 className="text-2xl">{cur.name}</h1><p className="text-muted">{cur.centres?.name} · starts {new Date(cur.start_date).toLocaleDateString()}</p></div><Badge tone={cur.status === "open" ? "ok" : "muted"}>{cur.status}</Badge></div>
      <div className="flex gap-2"><Button className="flex-1" onClick={() => { setErr(""); setNs({ id: "", course: "", instr: "", day: "1", start: "10:00", end: "12:30", room: "" }); }}>+ Add class slot</Button>
        <Button variant="secondary" onClick={generate}>Create classes</Button></div>
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
      <section className="space-y-2"><h2 className="text-lg">Weekly timetable</h2>
        {slots.length === 0 ? <Card className="text-center text-muted">No classes scheduled yet.</Card> : slots.map((s) => (
          <Card key={s.id} className="space-y-2 py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="font-medium">{s.courses?.title}</p><p className="text-sm text-muted">{DAYS[s.day_of_week]} · {hm(s.start_time)}–{hm(s.end_time)}{s.room ? ` · ${s.room}` : ""}</p></div>
            <p className="shrink-0 text-sm">{s.instructor?.full_name ?? <span className="text-warn">No instructor</span>}</p></div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" className="h-9 text-sm" onClick={() => { setErr(""); setNs({ id: s.id, course: s.course_id, instr: s.instructor_id ?? "", day: String(s.day_of_week), start: hm(s.start_time), end: hm(s.end_time), room: s.room ?? "" }); }}>Edit</Button>
              <Button variant="secondary" className="h-9 text-sm text-bad" onClick={() => removeSlot(s)}>Remove</Button></div></Card>))}</section>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => { setErr(""); setNc({ id: cur.id, centre: cur.centre_id, centreName: cur.centres?.name ?? "", name: cur.name, code: cur.code ?? "", start: cur.start_date, cap: cur.capacity ? String(cur.capacity) : "" }); }}>Edit cohort</Button>
        <Button variant="secondary" onClick={() => setStatus(cur.status === "open" ? "closed" : "open")}>{cur.status === "open" ? "Close enrolment" : "Reopen enrolment"}</Button></div>
      <Button variant="ghost" className="w-full text-bad" onClick={removeCohort}>Delete this cohort…</Button>
      {cohortSheet}
      <Sheet open={!!ns} onClose={() => setNs(null)} title={ns?.id ? "Edit class slot" : "New class slot"}>
        {ns && <div className="space-y-3"><select className={sel} value={ns.course} onChange={(e) => setNs({ ...ns, course: e.target.value })}><option value="">Course…</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <select className={sel} value={ns.instr} onChange={(e) => setNs({ ...ns, instr: e.target.value })}><option value="">Instructor (assign later)…</option>{instr.map((i) => <option key={i.user_id} value={i.user_id}>{i.profiles?.full_name}</option>)}</select>
          <select className={sel} value={ns.day} onChange={(e) => setNs({ ...ns, day: e.target.value })}>{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
          <div className="grid grid-cols-2 gap-3"><Field label="Starts" type="time" value={ns.start} onChange={(e) => setNs({ ...ns, start: e.target.value })} /><Field label="Ends" type="time" value={ns.end} onChange={(e) => setNs({ ...ns, end: e.target.value })} /></div>
          <Field label="Room" placeholder="Optional" value={ns.room} onChange={(e) => setNs({ ...ns, room: e.target.value })} />
          {ns.id && <p className="text-sm text-muted">Upcoming classes in this slot are moved to match.</p>}<Err>{err}</Err>
          <Button className="w-full" disabled={!ns.course} onClick={saveSlot}>{ns.id ? "Save changes" : "Add and create classes"}</Button></div>}
      </Sheet>
    </div>);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Cohorts</h1><Button className="h-10" onClick={() => { setErr(""); setNc({ id: "", centre: "", centreName: "", name: "", code: "", start: "", cap: "" }); }}>+ New</Button></div>
      {loadErr && <div className="space-y-2"><Err>{loadErr}</Err><Button variant="secondary" onClick={load}>Try again</Button></div>}
      {!cohorts ? <Skeleton className="h-24" /> : cohorts.length === 0 && !loadErr ? <Card className="text-center text-muted">Create your first cohort to open enrolment.</Card> : cohorts.map((c) => (
        <Card key={c.id} onClick={() => openCohort(c)} className="flex items-center justify-between"><div><p className="font-medium">{c.name}</p><p className="text-sm text-muted">{c.centres?.name} · {new Date(c.start_date).toLocaleDateString()}</p></div><Badge tone={c.status === "open" ? "ok" : "muted"}>{c.status}</Badge></Card>))}
      {cohortSheet}
    </div>
  );
}
