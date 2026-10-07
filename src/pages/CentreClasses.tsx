// src/pages/CentreClasses.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useStaffCentres } from "../lib/useStaffCentres";
import { Avatar, Badge, Chip, ChipRow, Empty, Err, List, PageHeader, Section, Skeleton } from "../components/ui";
import { addDays, fmtClock, fmtWhen, now, today } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS: Record<string, { label: string; tone: "ok" | "info" | "bad" | "muted" }> = {
  scheduled: { label: "Scheduled", tone: "muted" }, in_progress: { label: "Live", tone: "info" }, completed: { label: "Held", tone: "ok" }, cancelled: { label: "Cancelled", tone: "bad" },
};
const dayLabel = (iso: string) => fmtWhen(iso, { weekday: "short", day: "numeric", month: "short" });

// Who teaches what, and when, at the centre. Read-only: scheduling and staffing stay with IQ Academy.
export default function CentreClasses() {
  const { shown, centres, sel, setSel, ids } = useStaffCentres();
  const [classes, setClasses] = useState<any[]>(); const [team, setTeam] = useState<any[]>(); const [err, setErr] = useState(""); const [allPast, setAllPast] = useState(false);

  useEffect(() => {
    if (!shown.length) { setClasses(centres ? [] : undefined); setTeam(centres ? [] : undefined); return; }
    setClasses(undefined); setTeam(undefined); setErr("");
    const from = addDays(today(), -14), to = addDays(today(), 21);
    supabase.from("v_session_details")
      .select("id,centre_id,start_at,end_at,status,session_date,course_title,lesson_title,instructor_id,instructor_name,students_enrolled,students_present,is_emergency")
      .in("centre_id", shown).gte("session_date", from).lte("session_date", to).order("start_at")
      .then((r) => { if (r.error) setErr(friendly(r.error)); setClasses(r.data ?? []); });
    Promise.all(shown.map((id) => supabase.rpc("centre_team", { p_centre_id: id }))).then((rs) => setTeam(rs.flatMap((r) => (r.data as any[]) ?? [])));
  }, [shown, centres]);

  const instructors = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    (classes ?? []).filter((c) => c.instructor_id && c.status !== "cancelled").forEach((c) => { const x = m.get(c.instructor_id) ?? { id: c.instructor_id, name: c.instructor_name ?? "Instructor", n: 0 }; x.n++; m.set(c.instructor_id, x); });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [classes]);
  const t = now();
  const coming = (classes ?? []).filter((c) => new Date(c.end_at).getTime() >= t && c.status !== "cancelled");
  const past = (classes ?? []).filter((c) => new Date(c.end_at).getTime() < t || c.status === "cancelled").reverse();
  const centreName = (id: string) => { const c = centres?.find((x) => x.id === id); return c ? place(c) : ""; };

  const row = (c: any) => { const s = STATUS[c.status] ?? { label: c.status, tone: "muted" as const };
    const count = c.status === "completed" ? `${c.students_present} of ${c.students_enrolled} present` : c.status === "scheduled" ? `${c.students_enrolled} expected` : "";
    return (
    <div key={c.id} className="space-y-0.5 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate font-medium">{c.course_title}{c.is_emergency ? " · custom" : ""}</p><Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="truncate text-[13px] text-muted">{c.lesson_title ?? "Class"}</p>
      <p className="text-[13px]">{dayLabel(c.start_at)} · {fmtClock(c.start_at)} to {fmtClock(c.end_at)}{ids.length > 1 && sel === "all" ? ` · ${centreName(c.centre_id)}` : ""}</p>
      <p className="text-[13px] text-muted">{c.instructor_name ?? "Instructor to be assigned"}{count ? ` · ${count}` : ""}</p>
    </div>); };
  const PAST_SHOWN = 5;

  return (
    <div className="space-y-5">
      <PageHeader title="Classes & staff" sub="Who teaches what at your centre" />
      {ids.length > 1 && <ChipRow>
        {[{ id: "all", name: "All branches" }, ...(centres ?? []).map((c) => ({ id: c.id, name: place(c) }))].map((c) => (
          <Chip key={c.id} on={sel === c.id} onClick={() => setSel(c.id)}>{c.name}</Chip>))}</ChipRow>}
      <Err>{err}</Err>
      {!classes || !team ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-40" /></div> : <>
        <Section title="Staff on site">
          {instructors.length === 0 && team.length === 0 ? <Empty icon="instructor" title="No staff listed yet." /> : <List>
            {instructors.map((i) => <div key={i.id} className="flex items-center gap-3 px-4 py-2.5"><Avatar name={i.name} size={32} /><div className="min-w-0 flex-1"><p className="truncate font-medium leading-tight">{i.name}</p><p className="text-xs text-muted">{i.n} {i.n === 1 ? "class" : "classes"} in this window</p></div><Badge tone="info">Instructor</Badge></div>)}
            {team.map((m) => <div key={m.user_id + m.role} className="flex items-center gap-3 px-4 py-2.5"><Avatar name={m.full_name} url={m.avatar_url} size={32} /><p className="min-w-0 flex-1 truncate font-medium">{m.full_name}</p><Badge tone={m.role === "centre_director" ? "ok" : "muted"}>{m.role === "centre_director" ? "Director" : "Coordinator"}</Badge></div>)}
          </List>}
        </Section>
        <Section title="Coming up" aside={<span className="num">{coming.length}</span>}>
          {coming.length === 0 ? <Empty icon="classes" title="No classes scheduled in the next three weeks." /> : <List>{coming.map(row)}</List>}
        </Section>
        <Section title="Last two weeks" aside={<span className="num">{past.length}</span>}>
          {past.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : <>
            <List>{(allPast ? past : past.slice(0, PAST_SHOWN)).map(row)}</List>
            {past.length > PAST_SHOWN && <button onClick={() => setAllPast(!allPast)} className="block w-full rounded-xl py-2 text-center text-sm font-medium text-accent transition active:scale-[.98]">{allPast ? "Show fewer" : `Show all ${past.length}`}</button>}
          </>}
        </Section>
      </>}
    </div>
  );
}
