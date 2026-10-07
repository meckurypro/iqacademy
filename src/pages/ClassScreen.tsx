// src/pages/ClassScreen.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import Place from "../components/Place";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PinInput, PIN_LENGTH } from "../components/PinInput";
import DoorPinSheet from "../components/DoorPinSheet";
import { needsDoorPin, useDoorUnlocked } from "../lib/doorLock";
import { QRCodeSVG } from "qrcode.react";
import { supabase, friendly } from "../lib/supabase";
import { Avatar, Badge, Button, Card, cx, Empty, Err, Field, NavRow, Sheet, Skeleton, Section } from "../components/ui";
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
type Sess = { id: string; centre_id: string; start_at: string; end_at: string; status: string; centre_name: string; centre_city: string | null; centre_address: string | null; course_title: string; lesson_title: string | null; lesson_summary: string | null; room: string | null; is_emergency: boolean };
const tone = { present: "ok", absent: "bad", excused: "warn" } as const;
const HOW: Record<string, string> = { qr_scan: "Scanned", centre_staff: "By centre staff", instructor: "By instructor", admin: "By admin" };

export default function ClassScreen() {
  const { id } = useParams(); const nav = useNavigate(); const [params, setParams] = useSearchParams(); const { run, confirm } = useFeedback();
  const { session, roles } = useAuth(); const [teacher, setTeacher] = useState<string | null>(null);
  const [s, setS] = useState<Sess>(); const [roster, setRoster] = useState<Row[]>();
  const [code, setCode] = useState(""); const [showCode, setShowCode] = useState(false);
  const [pick, setPick] = useState<Row | null>(null); const [err, setErr] = useState("");
  const [sent, setSent] = useState<ClassMessage[]>([]);
  // ending a class that is running needs a reason
  const [endOpen, setEndOpen] = useState(false); const [endWhy, setEndWhy] = useState(""); const [endErr, setEndErr] = useState("");
  // checking someone in by hand needs the student's own PIN (or, for an admin only, a written reason)
  const [pinFor, setPinFor] = useState<Row | null>(null); const [pinVal, setPinVal] = useState(""); const [pinErr, setPinErr] = useState("");
  const [override, setOverride] = useState(false); const [overrideWhy, setOverrideWhy] = useState("");
  const [ended, setEnded] = useState<{ reason: string; at: string } | null>(null);
  const [denied, setDenied] = useState<Denied[]>([]); const [now, setNow] = useState(tNow());
  useEffect(() => { const i = setInterval(() => setNow(tNow()), 30000); return () => clearInterval(i); }, []);
  // Instructors and coordinators type their own door PIN before the class code is shown or anyone is checked in by hand (admins are not asked).
  const unlocked = useDoorUnlocked(session?.user.id); const locked = needsDoorPin(roles) && !unlocked;
  const [gateOpen, setGateOpen] = useState(false); const afterUnlock = useRef<(() => void) | null>(null);
  const requireDoor = (then?: () => void) => { if (!locked) return then?.(); afterUnlock.current = then ?? null; setGateOpen(true); };

  const loadSent = useCallback(async () => {
    const { data } = await supabase.from("class_messages").select("id,session_id,sender_label,body,media_path,media_name,media_mime,media_size,created_at").eq("session_id", id!).order("created_at");
    setSent((data as ClassMessage[]) ?? []);
  }, [id]);
  const status = s?.status;
  useEffect(() => {
    supabase.from("class_sessions").select("instructor_id,end_reason,ended_early_at").eq("id", id!).maybeSingle().then((r) => {
      setTeacher((r.data?.instructor_id as string) ?? null);
      setEnded(r.data?.end_reason && r.data?.ended_early_at ? { reason: r.data.end_reason as string, at: r.data.ended_early_at as string } : null);
    });
  }, [id, status]);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from("v_session_details").select("id,centre_id,start_at,end_at,status,centre_name,centre_city,centre_address,course_title,lesson_title,lesson_summary,room,is_emergency").eq("id", id!).single(),
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

  // Door staff (this centre's coordinator, or an admin) open check-in and see who was turned away. Directors do not: they only see income and student numbers.
  // The instructor teaching a custom class opens its check-in too: there may be no staff at the centre for a short-notice class.
  const isDoor = !!s && (roles.some((r) => r.role === "admin" || r.role === "super_admin" || (r.role === "coordinator" && r.centre_id === s.centre_id)) || (s.is_emergency && !!teacher && teacher === session?.user.id));
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
    if (!isDoor || locked || door0 !== "open" || status0 === "completed" || status0 === "cancelled") { setCode(""); setShowCode(false); return; }
    let alive = true;
    (async () => {
      const { data } = await supabase.from("session_checkin_tokens").select("token").eq("session_id", id!).maybeSingle();
      if (data?.token) { if (alive) setCode(data.token as string); return; }
      const r = await supabase.rpc("generate_checkin_token", { p_session_id: id, p_rotate: false });
      if (alive && !r.error) setCode(r.data as string);
    })();
    return () => { alive = false; };
  }, [isDoor, locked, door0, status0, id]);

  // "Reveal code" on the dashboard lands here with ?reveal=1: show the QR full screen as soon as the code is ready
  useEffect(() => {
    if (params.get("reveal") && code) { setShowCode(true); setParams({}, { replace: true }); }
  }, [params, code, setParams]);
  useEffect(() => { if (params.get("reveal") && isDoor && locked && door0 === "open") setGateOpen(true); }, [params, isDoor, locked, door0]);

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

  const isAdmin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const askPin = (r: Row) => { setPick(null); setPinVal(""); setPinErr(""); setOverride(false); setOverrideWhy(""); setPinFor(r); };
  const checkInByHand = async () => {
    if (!pinFor) return;
    const first = pinFor.full_name.split(" ")[0];
    if (override ? overrideWhy.trim().length < 5 : pinVal.length !== PIN_LENGTH) return setPinErr(override ? "Give a reason, in a few words." : "Enter the 4-digit PIN.");
    setPinErr(""); let code = "";
    const r = await run("Checking in…", async () => {
      const { data, error } = await supabase.rpc("mark_attendance", { p_session_id: id, p_student_id: pinFor.student_id, p_status: "present", ...(override ? { p_override_reason: overrideWhy.trim() } : { p_pin: pinVal }) });
      if (error) throw error;
      if (data !== "ok") { code = String(data); throw new Error(code); }
      await load();
    }, { success: `${first} checked in`, quiet: true });
    if (r.ok) return setPinFor(null);
    setPinVal("");
    if (code === "already_present") { setPinFor(null); setPinErr(""); await load(); return; }   // nothing was changed; the list now shows them present
    if (code === "pin_not_set" && isAdmin) { setOverride(true); setPinErr(`${first} hasn't set a PIN. You can check them in with a reason. They'll be told, and can dispute it.`); }
    else setPinErr(r.message);
  };
  const REASONS = ["Emergency", "Technical problem", "Not feeling well", "Finished early"];
  const openEnd = () => { setEndWhy(""); setEndErr(""); setEndOpen(true); };
  const endClass = async () => {
    const why = endWhy.trim();
    if (why.length < 5) return setEndErr("Give a reason, in a few words, so we know why the class ended early.");
    setEndErr("");
    const r = await run("Ending class…", async () => {
      const { error } = await supabase.rpc("end_class_early", { p_session_id: id, p_reason: why }); if (error) throw error;
      await load();
    }, { success: "Class ended", quiet: true });
    if (!r.ok) return setEndErr(r.message);
    setEndOpen(false);
  };

  // Only the instructor of this class (or an admin) can message it; coordinators and directors can view the class but not send.
  const isTeacher = !!teacher && teacher === session?.user.id;
  const canMark = isDoor || isTeacher;
  const canSend = roles.some((r) => r.role === "admin" || r.role === "super_admin") || (!!teacher && teacher === session?.user.id);
  if (!s || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;
  const present = roster.filter((r) => r.status === "present").length;
  const joined = present; // every checked-in student, however they were checked in, is in the class channel
  const closed = s.status === "completed" || s.status === "cancelled";
  const door = doorState(s.start_at, s.end_at, now);
  const t = (d: string) => fmtClock(d);
  // Checking someone in by hand works only while the class code is live: 30 minutes before the start until the class ends.
  const handOpen = !closed && door === "open";

  return (
    <div className="space-y-5">
      <button onClick={() => nav(-1)} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Back</span></button>
      <div><h1 className="text-[26px] leading-tight">{s.course_title}</h1>
        <p className="text-muted">{s.is_emergency ? "Custom class · " : ""}{s.lesson_title ? `${s.lesson_title} · ` : ""}{t(s.start_at)} – {t(s.end_at)} · <Place centre={{ name: s.centre_name, city: s.centre_city, address: s.centre_address }} nameOnly />{s.room ? ` · ${s.room}` : ""}</p></div>

      {ended && s.status === "completed" && <Card className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-warn/10 text-warn"><Icon name="alert" size={18} /></span>
        <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">Ended early at {fmtClock(ended.at)}</p><p className="mt-0.5 break-words text-sm text-muted">{ended.reason}</p></div>
      </Card>}

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
        {door === "open" && (locked ? <>
          <p className="text-sm text-muted">Enter your PIN to show the class code.</p>
          <Button className="w-full" onClick={() => requireDoor()}><span className="inline-flex items-center gap-2"><Icon name="lock" size={18} />Enter PIN</span></Button>
        </> : code ? <>
          <button onClick={() => setShowCode(true)} className="mx-auto block w-fit rounded-2xl bg-white p-3 transition active:scale-[.98]" aria-label="Show the class code full screen"><QRCodeSVG value={code} size={176} /></button>
          <p className="num text-center text-3xl font-semibold tracking-[.25em]">{code}</p>
          <p className="text-center text-sm text-muted">Students scan the QR or type this code. It stops working when the class ends.</p>
          <div className="grid grid-cols-2 gap-3"><Button onClick={() => setShowCode(true)}><span className="inline-flex items-center gap-2"><Icon name="scan" size={18} />Full screen</span></Button><Button variant="secondary" onClick={() => newCode(true)}>New code</Button></div>
        </> : <p className="text-sm text-muted">Getting the class code…</p>)}
      </Card>}
      {!closed && !isDoor && isTeacher && <Card className="text-sm text-muted">{door === "early" ? "The centre's check-in code appears 30 minutes before the class. The class starts and ends by itself." : "Check-in is open. Students appear below as they arrive. The class ends by itself at its scheduled time."}</Card>}
      <Err>{err}</Err>

      <Section title="Students">
        {canMark && !closed && (handOpen
          ? roster.some((r) => !r.status) && <p className="px-1 text-sm text-muted">Tap Check in for anyone who can't scan the code. Tap a name to mark absent or excused.</p>
          : door === "early" && <p className="px-1 text-sm text-muted">Checking students in by hand opens at {opensAt(s.start_at)}, when the class code does.</p>)}
        {roster.length === 0 && <Empty title="No students are enrolled in this class yet." />}
        {roster.map((r) => (
          <Card key={r.student_id} onClick={!canMark || s.status === "cancelled" ? undefined : () => setPick(r)} className="flex items-center gap-3 py-3">
            <Avatar name={r.full_name} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{r.full_name}</p>{r.status === "present" && r.method && HOW[r.method] && <p className="text-xs text-muted">{HOW[r.method]}</p>}</div>
            {canMark && handOpen && !r.status
              ? <Button className="h-9 px-4 text-sm" onClick={(e) => { e.stopPropagation(); requireDoor(() => askPin(r)); }}>Check in</Button>
              : <Badge tone={r.status ? tone[r.status] : "muted"}>{r.status ?? "Not yet"}</Badge>}</Card>))}
      </Section>
      {isDoor && denied.length > 0 && <Section title="Turned away" aside={<span className="num">{denied.length}</span>}>
        <p className="px-1 text-sm text-muted">People who tried the code but aren't cleared for this class.</p>
        {denied.map((d) => (
          <Card key={d.student_id} className="flex items-center gap-3 py-3">
            <Avatar name={d.full_name} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{d.full_name}</p><p className="text-xs text-muted">{REASON_LABEL[d.reason] ?? "Not cleared"}{d.attempts > 1 ? ` · ${d.attempts} tries` : ""} · {t(d.last_at)}</p></div>
            <Badge tone="bad">Red</Badge></Card>))}
      </Section>}
      {canSend && s.status !== "cancelled" && (() => {
        const open = s.status === "in_progress" || s.status === "completed" || door === "open";
        // the teaching instructor opens the channel as a chat; an admin who isn't teaching it keeps the inline composer
        if (isTeacher) return open
          ? <NavRow to={`/messages/${id}`} icon="messages" title="Class channel" hint={sent.length ? `${sent.length} message${sent.length === 1 ? "" : "s"} sent · open chat` : "Message your students"} />
          : <Card className="text-sm text-muted">This class's channel opens with check-in, at {opensAt(s.start_at)}. After the class ends you can still post to it.</Card>;
        return <section className="space-y-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">Class channel</h2>
          {open ? <ClassComposer sessionId={id!} joined={joined} onSent={loadSent} /> : <Card className="text-sm text-muted">This class's channel opens with check-in, at {opensAt(s.start_at)}.</Card>}
          {sent.length > 0 && <div className="space-y-4 pt-2"><p className="px-1 text-sm text-muted">Sent in this class</p>{sent.map((m) => <MessageBubble key={m.id} m={m} />)}</div>}
        </section>;
      })()}
      {!closed && (isTeacher || roles.some((r) => r.role === "admin" || r.role === "super_admin")) && (s.status === "in_progress"
        ? <Button variant="ghost" className="w-full text-bad" onClick={openEnd}>End class early</Button>
        : <Button variant="ghost" className="w-full text-bad" onClick={cancelClass}>Cancel this class</Button>)}

      <Sheet open={endOpen} onClose={() => setEndOpen(false)} title="End this class early?">
        <div className="space-y-4">
          <p className="text-sm text-muted">The class closes now and anyone who hasn't checked in is marked absent. Its chat stays open. A reason is needed, and admins can read it.</p>
          <div className="flex flex-wrap gap-2">{REASONS.map((r) => (
            <button key={r} onClick={() => { setEndWhy(r); setEndErr(""); }} className={cx("rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition active:scale-95", endWhy === r ? "bg-accent/10 text-accent ring-accent/40" : "bg-surface text-muted ring-line")}>{r}</button>))}</div>
          <label className="block">
            <span className="mb-1.5 flex items-baseline justify-between text-sm font-medium">Reason <span className="text-xs font-normal text-muted">{endWhy.length}/300</span></span>
            <textarea value={endWhy} onChange={(e) => { setEndWhy(e.target.value); setEndErr(""); }} maxLength={300} rows={3} placeholder="Why is the class ending early?"
              className="w-full resize-none rounded-xl bg-surface p-3 text-[15px] leading-relaxed outline-none ring-1 ring-line transition placeholder:text-muted/60 focus:ring-2 focus:ring-accent/60" />
          </label>
          <Err>{endErr}</Err>
          <div className="grid grid-cols-2 gap-2"><Button variant="secondary" onClick={() => setEndOpen(false)}>Keep going</Button><Button variant="danger" onClick={endClass}>End class</Button></div>
        </div>
      </Sheet>

      <Sheet open={showCode} onClose={() => setShowCode(false)} title="Class code">
        <div className="space-y-4 text-center">
          <div className="mx-auto w-fit rounded-2xl bg-white p-4"><QRCodeSVG value={code} size={260} /></div>
          <p className="num text-4xl font-semibold tracking-[.25em]">{code}</p>
          <p className="text-sm text-muted">Students scan the QR or type this code in their app. It stops working when the class ends.</p>
        </div>
      </Sheet>

      <DoorPinSheet open={gateOpen} onClose={() => { setGateOpen(false); afterUnlock.current = null; if (params.get("reveal")) setParams({}, { replace: true }); }}
        onUnlocked={() => { setGateOpen(false); const f = afterUnlock.current; afterUnlock.current = null; f?.(); }} />

      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.full_name}>
        <div className="space-y-2"><p className="text-sm text-muted">Set attendance by hand (for example if a phone died). Marking someone present needs the student to enter their own PIN, and only works while check-in is open.</p>
          {(["present", "absent", "excused"] as const).filter((st) => st !== "present" || (handOpen && pick?.status !== "present")).map((st) => (
            <Button key={st} variant={pick?.status === st ? "primary" : "secondary"} className="w-full capitalize"
              onClick={() => st === "present" ? (() => { const r = pick!; setPick(null); requireDoor(() => askPin(r)); })() : act("Updating attendance…", () => supabase.rpc("mark_attendance", { p_session_id: id, p_student_id: pick!.student_id, p_status: st }), () => setPick(null), "Attendance updated")}>{st}</Button>))}
        </div>
      </Sheet>

      <Sheet open={!!pinFor} onClose={() => setPinFor(null)} title={pinFor ? `Check in ${pinFor.full_name.split(" ")[0]}` : undefined}>
        {pinFor && (override ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">Admin override. {pinFor.full_name.split(" ")[0]} is told right away that you checked them in without their PIN, and can say it wasn't them. It's recorded with your reason.</p>
            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between text-sm font-medium">Reason <span className="text-xs font-normal text-muted">{overrideWhy.length}/300</span></span>
              <textarea value={overrideWhy} onChange={(e) => { setOverrideWhy(e.target.value); setPinErr(""); }} maxLength={300} rows={3} placeholder="Why can't they enter their PIN?"
                className="w-full resize-none rounded-xl bg-surface p-3 text-[15px] leading-relaxed outline-none ring-1 ring-line transition placeholder:text-muted/60 focus:ring-2 focus:ring-accent/60" />
            </label>
            <Err>{pinErr}</Err>
            <Button className="w-full" disabled={overrideWhy.trim().length < 5} onClick={checkInByHand}>Check in with a reason</Button>
            <Button variant="ghost" className="w-full" onClick={() => { setOverride(false); setPinErr(""); }}>Use their PIN instead</Button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-muted">Hand the phone to {pinFor.full_name.split(" ")[0]}. They type their own 4-digit PIN. Don't ask them to say it out loud.</p>
            <PinInput value={pinVal} onChange={(v) => { setPinVal(v); setPinErr(""); }} autoFocus invalid={!!pinErr} />
            <Err>{pinErr}</Err>
            <Button className="w-full" disabled={pinVal.length !== PIN_LENGTH} onClick={checkInByHand}>Check in</Button>
            {isAdmin && <button onClick={() => { setOverride(true); setPinErr(""); }} className="block w-full text-center text-sm text-muted underline underline-offset-2">Can't enter a PIN? Check in with a reason</button>}
          </div>))}
      </Sheet>
    </div>
  );
}
