// src/pages/Roster.tsx
// The admin's staffing board: who teaches which class, where and when.
// Work at whatever size suits the moment: tap one class, give an instructor "this and every later class",
// or hand them a whole course at one centre or at every centre. Double-bookings are caught before saving.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import AssignSheet from "../components/AssignSheet";
import { Avatar, Badge, Button, Card, Err, Skeleton, cx } from "../components/ui";
import { addDays, byStart, classes, clock, first, iso, label, locked, mondayOf, short, where, type P, type S, type Scope } from "../lib/roster";

/* eslint-disable @typescript-eslint/no-explicit-any */

const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cx("shrink-0 rounded-full px-3.5 py-1.5 text-sm ring-1 transition active:scale-[.98]", on ? "bg-accent text-accent-ink ring-accent" : "bg-surface ring-line")}>{children}</button>
);

export default function Roster() {
  const [params] = useSearchParams();
  const deepCourse = params.get("course"), deepCentre = params.get("centre");
  const [ses, setSes] = useState<S[]>();
  const [people, setPeople] = useState<P[]>([]);
  const [view, setView] = useState<"week" | "course">(deepCourse ? "course" : "week");
  const [centre, setCentre] = useState(deepCentre ?? "");
  const [gaps, setGaps] = useState(false);
  const [week, setWeek] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(deepCourse && deepCentre ? [`${deepCourse}:${deepCentre}`] : []));
  const [edit, setEdit] = useState<{ anchor: S; scope: Scope } | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [peopleErr, setPeopleErr] = useState("");

  const load = useCallback(async () => {
    setLoadErr("");
    const r = await supabase.from("v_session_details")
      .select("id,session_date,start_at,end_at,status,session_no,centre_id,centre_name,centre_city,centre_address,course_id,course_title,instructor_id,lesson_title,run_id")
      .in("status", ["scheduled", "in_progress"]).gte("session_date", addDays(iso(new Date()), -1)).order("start_at").limit(1000);
    if (r.error) { setLoadErr(friendly(r.error)); setSes((o) => o ?? []); return; }
    setSes((r.data as S[]) ?? []);
  }, []);

  const loadPeople = useCallback(async () => {
    setPeopleErr("");
    const r = await supabase.from("user_roles")
      .select("user_id,profiles!user_roles_user_id_fkey(full_name,avatar_url)").eq("role", "instructor").eq("is_active", true);
    if (r.error) { setPeopleErr(friendly(r.error)); return; }
    const m = new Map<string, P>();
    (r.data ?? []).forEach((x: any) => m.set(x.user_id, { id: x.user_id, name: x.profiles?.full_name || "Instructor", avatar: x.profiles?.avatar_url ?? null }));
    setPeople([...m.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  useEffect(() => { load(); loadPeople(); }, [load, loadPeople]);

  const pmap = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const centres = useMemo(() => {
    const m = new Map<string, string>(); (ses ?? []).forEach((s) => m.set(s.centre_id, where(s)));
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [ses]);
  const inCentre = useMemo(() => (ses ?? []).filter((s) => !centre || s.centre_id === centre), [ses, centre]);
  const upcoming = useMemo(() => inCentre.filter((s) => !locked(s)), [inCentre]);
  const open = upcoming.filter((s) => !s.instructor_id).length;

  // Start on a week that has classes in it
  useEffect(() => {
    if (week || !ses) return;
    const today = iso(new Date()), thisWeek = mondayOf(today);
    const nextUp = ses.filter((s) => !locked(s)).sort(byStart)[0];
    const busy = ses.some((s) => s.session_date >= thisWeek && s.session_date < addDays(thisWeek, 7));
    setWeek(busy || !nextUp ? thisWeek : mondayOf(nextUp.session_date));
  }, [ses, week]);

  // `week` is "" until the effect above picks one. Computing addDays("", 7) throws RangeError and blanks the page,
  // so until a week is chosen the weekly view simply matches nothing.
  const weekEnd = useMemo(() => (week ? addDays(week, 7) : ""), [week]);
  const days = useMemo(() => {
    const list = gaps ? upcoming.filter((s) => !s.instructor_id)
      : inCentre.filter((s) => !!week && s.session_date >= week && s.session_date < weekEnd);
    const m = new Map<string, S[]>(); [...list].sort(byStart).forEach((s) => m.set(s.session_date, [...(m.get(s.session_date) ?? []), s]));
    return [...m];
  }, [gaps, upcoming, inCentre, week, weekEnd]);

  const courses = useMemo(() => {
    const m = new Map<string, { id: string; title: string; groups: Map<string, { id: string; name: string; list: S[] }> }>();
    upcoming.forEach((s) => {
      const c = m.get(s.course_id) ?? { id: s.course_id, title: s.course_title, groups: new Map() };
      const g = c.groups.get(s.centre_id) ?? { id: s.centre_id, name: where(s), list: [] };
      g.list.push(s); c.groups.set(s.centre_id, g); m.set(s.course_id, c);
    });
    return [...m.values()].map((c) => ({ ...c, groups: [...c.groups.values()].map((g) => ({ ...g, list: g.list.sort(byStart) })).filter((g) => !gaps || g.list.some((s) => !s.instructor_id)) }))
      .filter((c) => c.groups.length).sort((a, b) => a.title.localeCompare(b.title));
  }, [upcoming, gaps]);

  const toggle = (k: string) => setExpanded((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const nameOf = (id: string | null) => (id ? first(pmap.get(id)?.name ?? "Instructor") : "");

  const row = (s: S) => {
    const p = s.instructor_id ? pmap.get(s.instructor_id) : undefined; const lk = locked(s);
    return (
      <Card key={s.id} onClick={lk ? undefined : () => setEdit({ anchor: s, scope: "class" })} className={cx("anim-fade flex items-center gap-3 py-3", lk && "opacity-60")}>
        <div className="w-[4.25rem] shrink-0"><p className="num text-sm font-medium">{clock(s.start_at)}</p><p className="num text-xs text-muted">{clock(s.end_at)}</p></div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{s.course_title}</p>
          <p className="truncate text-sm text-muted">Class {s.session_no}{s.lesson_title ? ` · ${s.lesson_title}` : ""}</p>
          <p className="truncate text-xs text-muted">{where(s)}</p>
        </div>
        {s.instructor_id ? <div className="flex shrink-0 items-center gap-2"><Avatar name={p?.name ?? "?"} url={p?.avatar} size={28} /><span className="max-w-[5rem] truncate text-sm">{nameOf(s.instructor_id)}</span></div>
          : lk ? <Badge>{s.status === "in_progress" ? "Live" : "Started"}</Badge>
          : <span className="shrink-0 rounded-full border border-dashed border-warn/60 px-2.5 py-1 text-xs font-medium text-warn">Assign</span>}
      </Card>);
  };

  if (!ses) return <div className="space-y-3"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-10" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Roster</h1>
      {loadErr && <div className="space-y-2"><Err>{loadErr}</Err><Button variant="secondary" onClick={load}>Try again</Button></div>}
      {peopleErr && <div className="space-y-2"><Err>Couldn't load instructors: {peopleErr}</Err><Button variant="secondary" onClick={loadPeople}>Try again</Button></div>}

      {ses.length === 0 && !loadErr ? <Card className="space-y-2 py-8 text-center"><p className="font-medium">No classes to staff yet</p><p className="text-sm text-muted">Schedule a course run first. Its classes will appear here.</p><Link to="/schedule" className="text-sm font-medium text-accent">Open schedule</Link></Card> : <>
        {centres.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"><Chip on={!centre} onClick={() => setCentre("")}>All centres</Chip>{centres.map(([id, name]) => <Chip key={id} on={centre === id} onClick={() => setCentre(id)}>{name}</Chip>)}</div>}

        <div className="flex items-center gap-2">
          <div className="flex flex-1 rounded-xl bg-sunken p-1">
            {([["week", "By day"], ["course", "By course"]] as const).map(([k, t]) => (
              <button key={k} onClick={() => setView(k)} className={cx("h-9 flex-1 rounded-lg text-sm transition", view === k ? "bg-surface font-medium shadow-card" : "text-muted")}>{t}</button>))}
          </div>
          <button onClick={() => setGaps(!gaps)} disabled={!gaps && open === 0}
            className={cx("h-11 shrink-0 rounded-xl px-3.5 text-sm ring-1 transition active:scale-[.98] disabled:opacity-50", gaps ? "bg-warn/15 font-medium text-warn ring-warn/40" : "bg-surface ring-line")}>
            Needs instructor <span className="num">{open}</span>
          </button>
        </div>

        {view === "week" && !gaps && week && (
          <div className="flex items-center justify-between">
            <button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))} className="grid h-10 w-10 place-items-center rounded-full hover:bg-sunken">‹</button>
            <button onClick={() => setWeek(mondayOf(iso(new Date())))} className="text-sm font-medium"><span className="num">{short(week)} – {short(addDays(week, 6))}</span></button>
            <button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))} className="grid h-10 w-10 place-items-center rounded-full hover:bg-sunken">›</button>
          </div>)}

        {view === "week" && (days.length === 0
          ? <Card className="py-8 text-center text-sm text-muted">{gaps ? "Every upcoming class has an instructor." : "No classes this week."}</Card>
          : <div className="space-y-4">{days.map(([d, list]) => (
            <div key={d} className="space-y-2">
              <p className="text-sm font-medium text-muted">{d === iso(new Date()) ? "Today · " : ""}{label(d)}</p>
              {list.map(row)}
            </div>))}</div>)}

        {view === "course" && (courses.length === 0
          ? <Card className="py-8 text-center text-sm text-muted">{gaps ? "Every upcoming class has an instructor." : "No upcoming classes."}</Card>
          : <div className="space-y-4">{courses.map((c) => (
            <Card key={c.id} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="font-semibold leading-snug">{c.title}</p><p className="text-sm text-muted">{c.groups.length === 1 ? "1 centre" : `${c.groups.length} centres`}</p></div>
                {c.groups.length > 1 && <button className="shrink-0 text-sm font-medium text-accent" onClick={() => setEdit({ anchor: c.groups[0].list[0], scope: "all" })}>Assign everywhere</button>}
              </div>
              {c.groups.map((g) => {
                const key = `${c.id}:${g.id}`, isOpen = expanded.has(key);
                const staff = new Map<string, number>(); g.list.forEach((s) => s.instructor_id && staff.set(s.instructor_id, (staff.get(s.instructor_id) ?? 0) + 1));
                const gap = g.list.filter((s) => !s.instructor_id).length;
                return (
                  <div key={g.id} className="space-y-2 rounded-xl bg-sunken p-3">
                    <div className="flex items-start justify-between gap-2">
                      <button className="min-w-0 flex-1 text-left" onClick={() => toggle(key)}>
                        <p className="font-medium">{g.name}</p>
                        <p className="num text-xs text-muted">{short(g.list[0].session_date)} – {short(g.list[g.list.length - 1].session_date)} · {classes(g.list.length)}</p>
                      </button>
                      <Button variant="secondary" className="h-9 shrink-0 bg-surface px-3 text-sm" onClick={() => setEdit({ anchor: g.list[0], scope: "centre" })}>Assign all</Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {[...staff].sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                        <span key={id} className="inline-flex items-center gap-1.5 text-sm"><Avatar name={pmap.get(id)?.name ?? "?"} url={pmap.get(id)?.avatar} size={20} />{nameOf(id)} <span className="num text-muted">{n}</span></span>))}
                      {gap > 0 ? <Badge tone="warn">{gap === 1 ? "1 needs an instructor" : `${gap} need an instructor`}</Badge> : <Badge tone="ok">Fully staffed</Badge>}
                    </div>
                    <button className="text-xs font-medium text-accent" onClick={() => toggle(key)}>{isOpen ? "Hide classes" : "Show classes"}</button>
                    {isOpen && <div className="space-y-1 pt-1">{g.list.map((s) => (
                      <button key={s.id} onClick={() => setEdit({ anchor: s, scope: "class" })} className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-left text-sm transition active:scale-[.99]">
                        <span className="min-w-0 truncate"><span className="num text-muted">{s.session_no}.</span> {label(s.session_date)} · {clock(s.start_at)}</span>
                        <span className={cx("shrink-0", !s.instructor_id && "text-warn")}>{s.instructor_id ? nameOf(s.instructor_id) : "Assign"}</span>
                      </button>))}</div>}
                  </div>);
              })}
            </Card>))}</div>)}
      </>}

      {edit && <AssignSheet key={`${edit.anchor.id}:${edit.scope}`} anchor={edit.anchor} scope0={edit.scope} ses={ses} people={people} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
