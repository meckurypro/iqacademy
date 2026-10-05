import { useCallback, useEffect, useState } from "react";
import Place from "../components/Place";
import { useNavigate, useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { supabase, friendly } from "../lib/supabase";
import { Avatar, Badge, Button, Card, Empty, Err, Sheet, Skeleton, Section } from "../components/ui";
import { useFeedback } from "../components/feedback";
import { useAuth } from "../lib/auth";
import MessageBubble from "../components/MessageBubble";
import ClassComposer from "../components/ClassComposer";
import { type ClassMessage } from "../lib/messages";
import { doorState, opensAt, REASON_LABEL } from "../lib/checkin";

import Icon from "../components/Icon";
import { fmtClock } from "../lib/time";
import { now as tNow } from "../lib/time";
type Row = { student_id: string; full_name: string; status: "present" | "absent" | "excused" | null; method: string | null };
type Denied = { student_id: string; full_name: string; reason: string; attempts: number; last_at: string };
type Sess = { id: string; centre_id: string; start_at: string; end_at: string; status: string; centre_name: string; centre_city: string | null; centre_address: string | null; course_title: string; lesson_title: string | null; lesson_summary: string | null; room: string | null };
const tone = { present: "ok", absent: "bad", excused: "warn" } as const;
const HOW: Record<string, string> = { qr_scan: "Scanned", centre_staff: "By centre staff", instructor: "By instructor", admin: "By admin" };

export default function ClassScreen() {
  const { id } = useParams(); const nav = useNavigate(); const { run, confirm } = useFeedback();
  const { session, roles } = useAuth(); const [teacher, setTeacher] = useState<string | null>(null);
  const [s, setS] = useState<Sess>(); const [roster, setRoster] = useState<Row[]>();
  const [code, setCode] = useState(""); const [showCode, setShowCode] = useState(false);
  const [pick, setPick] = useState<Row | null>(null); const [err, setErr] = useState("");
  const [sent, setSent] = useState<ClassMessage[]>([]);
  const [denied, setDenied] = useState<Denied[]>([]); const [now, setNow] = useState(tNow());
  useEffect(() => { const i = setInterval(() => setNow(tNow()), 30000); return () => clearInterval(i); }, []);

  const loadSent = useCallback(async () => {
    const { data } = await supabase.from("class_messages").select("id,session_id,sender_label,body,media_path,media_name,media_mime,media_size,created_at").eq("session_id", id!).order("created_at");
    setSent((data as ClassMessage[]) ?? []);
  }, [id]);
  useEffect(() => { supabase.from("class_sessions").select("instructor_id").eq("id", id!).maybeSingle().then((r) => setTeacher((r.data?.instructor_id as string) ?? null)); }, [id]);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from("v_session_details").select("id,centre_id,start_at,end_at,status,centre_name,centre_city,centre_address,course_title,lesson_title,lesson_summary,room").eq("id", id!).single(),
      supabase.rpc("session_attendance_roster", { p_session_id: id }),
    ]);
    setS(a.data as Sess); setRoster((b.data as Row[]) ?? []);
  }, [id]);
  useEffect(() => {
    load(); loadSent();
    const ch = supabase.channel(`class-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `session_id=eq.${id}` }, load)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "class_sessions", filter: `id=eq.${id}` }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, load, loadSent]);

  // Door staff (this centre's coordinator or director, or an admin) open check-in and see who was turned away.
  const isDoor = !!s && roles.some((r) => r.role === "admin" || r.role === "super_admin" || ((r.role === "coordinator" || r.role === "centre_director") && r.centre_id === s.centre_id));
  const loadDenied = useCallback(async () => {
    const { data } = await supabase.rpc("session_denied_attempts", { p_session_id: id });
    setDenied((data as Denied[]) ?? []);
  }, [id]);
  useEffect(() => {
    if (!isDoor) return;
    loadDenied();
    const ch = supabase.channel(`door-${id}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "checkin_denials", filter: `session_id=eq.${id}` }, loadDenied).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [isDoor, id, loadDenied]);

  // The class code is made by the class clock 30 minutes before the class and removed when it ends. Door staff just read it.
  // If the clock hasn't run yet (it runs once a minute), ask for it directly rather than make staff wait.
  const door0 = s ? doorState(s.start_at, s.end_at, now) : "early";
  const status0 = s?.status;
  useEffect(() => {
    if (!isDoor || door0 !== "open" || status0 === "completed" || status0 === "cancelled") { setCode(""); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase.from("session_checkin_tokens").select("token").eq("session_id", id!).maybeSingle();
      if (data?.token) { if (alive) setCode(data.token as string); return; }
      const r = await supabase.rpc("generate_checkin_token", { p_session_id: id, p_rotate: false });
      if (alive && !r.error) setCode(r.data as string);
    })();
    return () => { alive = false; };
  }, [isDoor, door0, status0, id]);

  const act = async (label: string, fn: () => PromiseLike<{ error: unknown }>, after?: () => void, success?: string) => {
    setErr("");
    const r = await run(label, async () => { const { error } = await fn(); if (error) throw error; await load(); }, { success, quiet: true });
    if (!r.ok) return setErr(r.message);
    after?.();
  };
  const newCode = async (rotate = false) => {
    setErr("");
    const r = await run("Making a new code…", async () => {
      const { data, error } = await supabase.rpc("generate_checkin_token", { p_session_id: id, p_rotate: rotate }); if (error) throw error;
      await load(); return data as string;
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setCode(r.data);
  };
  const cancelClass = async () => {
    if (await confirm({ title: "Cancel this class?", message: "Students are told it's cancelled.", confirmLabel: "Cancel class", cancelLabel: "Keep class", danger: true }))
      act("Cancelling class…", () => supabase.rpc("cancel_session", { p_session_id: id, p_reason: "Cancelled by instructor" }), undefined, "Class cancelled");
  };

  // Only the instructor of this class (or an admin) can message it; coordinators and directors can view the class but not send.
  const isTeacher = !!teacher && teacher === session?.user.id;
  const canMark = isDoor || isTeacher;
  const canSend = roles.some((r) => r.role === "admin" || r.role === "super_admin") || (!!teacher && teacher === session?.user.id);
  if (!s || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;
  const present = roster.filter((r) => r.status === "present").length;
  const joined = roster.filter((r) => r.status === "present" && r.method === "qr_scan").length;
  const closed = s.status === "completed" || s.status === "cancelled";
  const door = doorState(s.start_at, s.end_at, now);
  const t = (d: string) => fmtClock(d);

  return (
    <div className="space-y-5">
      <button onClick={() => nav(-1)} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Back</span></button>
      <div><h1 className="text-[26px] leading-tight">{s.course_title}</h1>
        <p className="text-muted">{s.lesson_title ? `${s.lesson_title} · ` : ""}{t(s.start_at)} – {t(s.end_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly />{s.room ? ` · ${s.room}` : ""}</p></div>

      {(s.lesson_title || s.lesson_summary) && <Card className="space-y-1">
        <p className="text-sm text-muted">Today's topic</p>
        <p className="font-medium">{s.lesson_title ?? "No topic set for this class"}</p>
        {s.lesson_summary && <p className="text-sm text-muted">{s.lesson_summary}</p>}
      </Card>}

      <Card className="flex items-center gap-4">
        <div className="relative grid h-20 w-20 place-items-center rounded-full" style={{ background: `conic-gradient(rgb(var(--accent)) ${roster.length ? (present / roster.length) * 360 : 0}deg, rgb(var(--sunken)) 0)` }}>
          <div className="grid h-16 w-16 place-items-center rounded-full bg-surface"><span className="num text-xl font-semibold">{present}</span></div></div>
        <div><p className="font-medium">{present} of {roster.length} here</p><p className="text-sm text-muted">{closed ? (s.status === "cancelled" ? "Class cancelled" : "Class closed") : "Updates live as students check in"}</p></div>
      </Card>

      {!closed && isDoor && <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3"><p className="font-medium">Check-in</p><Badge tone={door === "open" ? "ok" : "muted"}>{door === "open" ? "Open" : door === "early" ? "Not yet" : "Ended"}</Badge></div>
        {door === "early" && <p className="text-sm text-muted">The class code is created automatically at {opensAt(s.start_at)}, 30 minutes before the class. Nothing to press.</p>}
        {door === "ended" && <p className="text-sm text-muted">This class has ended, so check-in is closed. The class closes by itself and absentees are logged.</p>}
        {door === "open" && (code ? <>
          <button onClick={() => setShowCode(true)} className="mx-auto block w-fit rounded-2xl bg-white p-3 transition active:scale-[.98]" aria-label="Show the class code full screen"><QRCodeSVG value={code} size={176} /></button>
          <p className="num text-center text-3xl font-semibold tracking-[.25em]">{code}</p>
          <p className="text-center text-sm text-muted">Students scan the QR or type this code. It stops working when the class ends.</p>
          <div className="grid grid-cols-2 gap-3"><Button onClick={() => setShowCode(true)}><span className="inline-flex items-center gap-2"><Icon name="scan" size={18} />Full screen</span></Button><Button variant="secondary" onClick={() => newCode(true)}>New code</Button></div>
        </> : <p className="text-sm text-muted">Getting the class code…</p>)}
      </Card>}
      {!closed && !isDoor && isTeacher && <Card className="text-sm text-muted">{door === "early" ? "The centre's check-in code appears 30 minutes before the class. The class starts and ends by itself." : "Check-in is open. Students appear below as they arrive. The class ends by itself at its scheduled time."}</Card>}
      <Err>{err}</Err>

      <Section title="Students">
        {roster.length === 0 && <Empty title="No students are enrolled in this class yet." />}
        {roster.map((r) => (
          <Card key={r.student_id} onClick={!canMark || s.status === "cancelled" ? undefined : () => setPick(r)} className="flex items-center gap-3 py-3">
            <Avatar name={r.full_name} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{r.full_name}</p>{r.status === "present" && r.method && HOW[r.method] && <p className="text-xs text-muted">{HOW[r.method]}</p>}</div>
            <Badge tone={r.status ? tone[r.status] : "muted"}>{r.status ?? "Not yet"}</Badge></Card>))}
      </Section>
      {isDoor && denied.length > 0 && <Section title="Turned away" aside={<span className="num">{denied.length}</span>}>
        <p className="px-1 text-sm text-muted">People who tried the code but aren't cleared for this class.</p>
        {denied.map((d) => (
          <Card key={d.student_id} className="flex items-center gap-3 py-3">
            <Avatar name={d.full_name} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{d.full_name}</p><p className="text-xs text-muted">{REASON_LABEL[d.reason] ?? "Not cleared"}{d.attempts > 1 ? ` · ${d.attempts} tries` : ""} · {t(d.last_at)}</p></div>
            <Badge tone="bad">Red</Badge></Card>))}
      </Section>}
      {canSend && (s.status === "in_progress" || sent.length > 0 || s.status === "scheduled") && <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">Messages</h2>
        {s.status === "in_progress" ? <ClassComposer sessionId={id!} joined={joined} onSent={loadSent} />
          : s.status === "scheduled" && <Card className="text-sm text-muted">You can message the class once it has started. It starts by itself at {t(s.start_at)}.</Card>}
        {sent.length > 0 && <div className="space-y-4 pt-2"><p className="px-1 text-sm text-muted">Sent in this class</p>{sent.map((m) => <MessageBubble key={m.id} m={m} />)}</div>}
      </section>}
      {!closed && (isTeacher || roles.some((r) => r.role === "admin" || r.role === "super_admin")) && <Button variant="ghost" className="w-full text-bad" onClick={cancelClass}>Cancel this class</Button>}

      <Sheet open={showCode} onClose={() => setShowCode(false)} title="Class code">
        <div className="space-y-4 text-center">
          <div className="mx-auto w-fit rounded-2xl bg-white p-4"><QRCodeSVG value={code} size={260} /></div>
          <p className="num text-4xl font-semibold tracking-[.25em]">{code}</p>
          <p className="text-sm text-muted">Students scan the QR or type this code in their app. It stops working when the class ends.</p>
        </div>
      </Sheet>

      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.full_name}>
        <div className="space-y-2"><p className="text-sm text-muted">Set attendance by hand (for example if a phone died). Students marked by hand don't receive class messages.</p>
          {(["present", "absent", "excused"] as const).map((st) => (
            <Button key={st} variant={pick?.status === st ? "primary" : "secondary"} className="w-full capitalize"
              onClick={() => act("Updating attendance…", () => supabase.rpc("mark_attendance", { p_session_id: id, p_student_id: pick!.student_id, p_status: st }), () => setPick(null), "Attendance updated")}>{st}</Button>))}
        </div>
      </Sheet>
    </div>
  );
}
