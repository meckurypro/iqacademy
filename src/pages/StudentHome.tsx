import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { sleep } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Err, Sheet, Skeleton } from "../components/ui";
import { startPayment } from "./Enrol";
import QrScanner from "../components/QrScanner";
import CourseOutline from "../components/CourseOutline";
import { place } from "../lib/centre";

type Inst = { id: string; number: number; amount: number; status: string; label: string };
type Enr = { id: string; status: string; balance: number; total_amount: number; centres: { name: string; city: string | null; address: string | null } | null; enrolment_instalments: Inst[] };
type Sess = { id: string; start_at: string; end_at: string; centre_name: string; course_title: string; lesson_title: string | null; room: string | null };
type Ref = { id: string; amount: number; status: string; created_at: string };
type Lesson = { enrolment_id: string; course_id: string; lesson_no: number; title: string; summary: string | null; state: "attended" | "missed" | "upcoming" };
type Prog = { enrolment_id: string; course_id: string; course_title: string; sessions_attended: number; sessions_needed: number; course_status: string };

export default function StudentHome() {
  const { name } = useAuth(); const { run } = useFeedback();
  const [refunds, setRefunds] = useState<Ref[]>([]); const [enr, setEnr] = useState<Enr[]>(); const [next, setNext] = useState<Sess | null>(); const [prog, setProg] = useState<Prog[]>([]); const [lessons, setLessons] = useState<Lesson[]>([]); const [openCourse, setOpenCourse] = useState("");
  const [open, setOpen] = useState(false); const [code, setCode] = useState("");
  const [scan, setScan] = useState(false); const [err, setErr] = useState(""); const [ok, setOk] = useState(false);

  const load = useCallback(async () => {
    supabase.from("refunds").select("id,amount,status,created_at").order("created_at", { ascending: false }).limit(5).then((r) => setRefunds((r.data as Ref[]) ?? []));
    const [e, s, p, ls] = await Promise.all([
      supabase.from("enrolments").select("id,status,balance,total_amount,centres(name,city,address),enrolment_instalments(id,number,amount,status,label)").in("status", ["pending_payment", "active", "completed"]).order("created_at", { ascending: false }),
      supabase.from("v_session_details").select("id,start_at,end_at,centre_name,course_title,lesson_title,room").in("status", ["scheduled", "in_progress"]).gte("end_at", new Date().toISOString()).order("start_at").limit(1),
      supabase.from("v_student_progress").select("enrolment_id,course_id,course_title,sessions_attended,sessions_needed,course_status").eq("enrolment_status", "active"),
      supabase.from("v_lesson_progress").select("enrolment_id,course_id,lesson_no,title,summary,state").eq("enrolment_status", "active").order("lesson_no"),
    ]);
    setEnr((e.data as unknown as Enr[]) ?? []); setNext((s.data?.[0] as Sess) ?? null); setProg((p.data as Prog[]) ?? []); setLessons((ls.data as Lesson[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const checkIn = async (c: string = code) => {
    setErr(""); setScan(false);
    const r = await run("Checking you in…", async () => {
      const { error } = await supabase.rpc("check_in", { p_token: c.trim() }); if (error) throw error;
      await load();
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setOk(true);
  };
  const pay = async (id: string) => {
    setErr("");
    // startPayment sends the browser to Paystack; the overlay stays up until the page actually leaves.
    const r = await run("Opening secure payment…", async () => { await startPayment(id); await sleep(10000); }, { quiet: true });
    if (!r.ok) setErr(r.message);
  };
  const closeSheet = () => { setOpen(false); setCode(""); setErr(""); setOk(false); setScan(false); };

  if (!enr) return <div className="space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-28" /></div>;
  const owing = enr.flatMap((e) => e.enrolment_instalments.filter((i) => i.status === "pending").sort((a, b) => a.number - b.number).slice(0, 1).map((i) => ({ e, i })));
  const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl">Hi {name.split(" ")[0]} 👋</h1>

      {enr.length === 0 && <CourseOutline />}

      {owing.map(({ e, i }) => (
        <Card key={i.id} className="anim-rise space-y-3">
          <div className="flex items-center justify-between"><p className="font-medium">{e.status === "pending_payment" ? "Finish your enrolment" : "Next instalment"}</p><Badge tone="warn">{naira(i.amount)} due</Badge></div>
          <p className="text-sm text-muted">{i.label}{e.centres ? ` · ${place(e.centres)}` : ""}</p>
          <Button className="w-full" onClick={() => pay(i.id)}>Pay {naira(i.amount)}</Button>
        </Card>))}
      <Err>{!open && err}</Err>

      {next && (
        <Card className="anim-rise space-y-3 bg-accent text-accent-ink ring-0">
          <p className="text-sm opacity-80">Next class · {new Date(next.start_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</p>
          <div><h2 className="text-xl">{next.course_title}</h2>{next.lesson_title && <p className="opacity-80">{next.lesson_title}</p>}</div>
          <p className="text-sm opacity-90">{t(next.start_at)} – {t(next.end_at)} · {next.centre_name}{next.room ? ` · ${next.room}` : ""}</p>
          <button onClick={() => setOpen(true)} className="h-12 w-full rounded-xl bg-white/20 font-medium backdrop-blur transition active:scale-[.98]">Check in</button>
        </Card>)}

      {prog.length > 0 && (
        <section className="space-y-2"><h2 className="text-lg">Your progress</h2>
          {prog.map((p, k) => { const pct = Math.min(100, Math.round((p.sessions_attended / Math.max(p.sessions_needed, 1)) * 100));
            const key = `${p.enrolment_id}:${p.course_id}`; const list = lessons.filter((l) => l.enrolment_id === p.enrolment_id && l.course_id === p.course_id); const isOpen = openCourse === key;
            return <Card key={k} className="space-y-2"><div className="flex justify-between"><p className="font-medium">{p.course_title}</p><span className="num text-sm text-muted">{p.sessions_attended}/{p.sessions_needed} classes</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-accent transition-all duration-700" style={{ width: `${pct}%` }} /></div>
              {list.length > 0 && <button onClick={() => setOpenCourse(isOpen ? "" : key)} className="text-sm text-accent">{isOpen ? "Hide classes" : `See all ${list.length} classes`}</button>}
              {isOpen && <ol className="space-y-2 pt-1">{list.map((l) => (
                <li key={l.lesson_no} className="flex gap-3">
                  <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${l.state === "attended" ? "bg-ok/15 text-ok" : l.state === "missed" ? "bg-bad/15 text-bad" : "bg-sunken text-muted"}`}>{l.state === "attended" ? "✓" : l.state === "missed" ? "✕" : l.lesson_no}</span>
                  <div className="min-w-0"><p className="text-sm font-medium">{l.title}{l.state === "missed" && <span className="ml-2 text-xs font-normal text-bad">Missed</span>}</p>{l.summary && <p className="text-sm text-muted">{l.summary}</p>}</div>
                </li>))}</ol>}
            </Card>; })}
        </section>)}

      {refunds.length > 0 && <section className="space-y-2"><h2 className="text-lg">Refunds</h2>
        {refunds.map((r) => <Card key={r.id} className="flex items-center justify-between py-3"><div><p className="num font-medium">{naira(r.amount)}</p><p className="text-sm text-muted">{new Date(r.created_at).toLocaleDateString()}</p></div>
          <Badge tone={r.status === "paid" ? "ok" : "warn"}>{r.status === "paid" ? "Sent" : "On its way"}</Badge></Card>)}</section>}

      <Sheet open={open} onClose={closeSheet} title={ok ? undefined : "Enter your class code"}>
        {ok ? (
          <div className="space-y-4 py-4 text-center"><div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-3xl text-ok">✓</div>
            <h2 className="text-xl">You're checked in</h2><p className="text-muted">Today's class pack is now unlocked.</p><Button className="w-full" onClick={closeSheet}>Done</Button></div>
        ) : (
          <div className="space-y-4">{scan ? <QrScanner onCode={(c) => { setCode(c.toUpperCase()); checkIn(c.toUpperCase()); }} onClose={() => setScan(false)} /> : <Button variant="secondary" className="w-full" onClick={() => setScan(true)}>📷 Scan the QR code</Button>}
            <p className="text-sm text-muted">Or type the 8-character code your instructor shows.</p>
            <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="A1B2C3D4" inputMode="text" autoCapitalize="characters"
              className="num h-14 w-full rounded-xl bg-sunken text-center text-2xl font-semibold tracking-[.3em] outline-none ring-accent/40 focus:ring-2" />
            <Err>{err}</Err><Button className="w-full" disabled={code.length < 8} onClick={() => checkIn()}>Check in</Button></div>)}
      </Sheet>
    </div>
  );
}
