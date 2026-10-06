// src/pages/StudentHome.tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { sleep } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Err, PageHeader, Section, Sheet, Skeleton } from "../components/ui";
import { startPayment } from "./Enrol";
import QrScanner from "../components/QrScanner";
import CourseOutline from "../components/CourseOutline";
import MakeupCard from "../components/MakeupCard";
import EmergencyClassCard from "../components/EmergencyClassCard";
import ClassCountdown from "../components/ClassCountdown";
import CheckInVerdict from "../components/CheckInVerdict";
import type { Verdict } from "../lib/checkin";
import SoloCourses from "../components/SoloCourses";
import Place from "../components/Place";
import { placeLabel } from "../lib/centre";
import type { MyOffline } from "../lib/offline";

import Icon from "../components/Icon";
import { fmtDay, fmtWhen, today } from "../lib/time";
type Inst = { id: string; number: number; amount: number; status: string; label: string; due_date: string | null };
type Enr = { id: string; status: string; balance: number; total_amount: number; starts_on: string | null; packages: { name: string } | null; enrolment_courses: { sequence_no: number; courses: { title: string } | null }[]; centres: { name: string; city: string | null; address: string | null } | null; enrolment_instalments: Inst[] };
type Ref = { id: string; amount: number; status: string; created_at: string };
type Lesson = { enrolment_id: string; course_id: string; lesson_no: number; title: string; summary: string | null; state: "attended" | "missed" | "upcoming" };
type Prog = { enrolment_id: string; course_id: string; course_title: string; sessions_attended: number; sessions_needed: number; course_status: string };

export default function StudentHome() {
  const { name } = useAuth(); const { run, confirm } = useFeedback();
  const [refunds, setRefunds] = useState<Ref[]>([]); const [enr, setEnr] = useState<Enr[]>(); const [prog, setProg] = useState<Prog[]>([]); const [lessons, setLessons] = useState<Lesson[]>([]); const [openCourse, setOpenCourse] = useState("");
  const [claims, setClaims] = useState<MyOffline[]>([]); const nav = useNavigate();
  const [open, setOpen] = useState(false); const [code, setCode] = useState("");
  const [scan, setScan] = useState(false); const [err, setErr] = useState(""); const [verdict, setVerdict] = useState<Verdict | null>(null);

  const load = useCallback(async () => {
    supabase.from("refunds").select("id,amount,status,created_at").order("created_at", { ascending: false }).limit(5).then((r) => setRefunds((r.data as Ref[]) ?? []));
    supabase.rpc("my_offline_payments").then((r) => setClaims((r.data as MyOffline[]) ?? []));
    const [e, p, ls] = await Promise.all([
      supabase.from("enrolments").select("id,status,balance,total_amount,starts_on,packages(name),enrolment_courses(sequence_no,courses(title)),centres(name,city,address),enrolment_instalments(id,number,amount,status,label,due_date)").in("status", ["pending_payment", "active", "completed"]).order("created_at", { ascending: false }),
      supabase.from("v_student_progress").select("enrolment_id,course_id,course_title,sessions_attended,sessions_needed,course_status").eq("enrolment_status", "active"),
      supabase.from("v_lesson_progress").select("enrolment_id,course_id,lesson_no,title,summary,state").eq("enrolment_status", "active").order("lesson_no"),
    ]);
    setEnr((e.data as unknown as Enr[]) ?? []); setProg((p.data as Prog[]) ?? []); setLessons((ls.data as Lesson[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const checkIn = async (c: string = code) => {
    setErr(""); setScan(false);
    let v: Verdict | null = null;
    const r = await run("Checking you in…", async () => {
      const { data, error } = await supabase.rpc("check_in", { p_token: c.trim() }); if (error) throw error;
      v = data as Verdict; await load();
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);   // a wrong or expired code stays on the code screen
    setOpen(false); setVerdict(v);         // otherwise: a full-screen green or red answer
  };
  const pay = async (id: string) => {
    setErr("");
    // startPayment sends the browser to Paystack; the overlay stays up until the page actually leaves.
    const r = await run("Opening secure payment…", async () => { await startPayment(id); await sleep(10000); }, { quiet: true });
    if (!r.ok) setErr(r.message);
  };
  // Switching to Paystack closes the offline request first, so the same instalment can't be paid twice.
  const payOnlineInstead = async (claimId: string, instalmentId: string) => {
    const ok = await confirm({ title: "Pay online instead?", message: "Your offline request will be cancelled and you'll go to secure online payment.", confirmLabel: "Pay online" });
    if (!ok) return;
    setErr("");
    const r = await run("Opening secure payment…", async () => {
      const { error } = await supabase.rpc("cancel_offline_request", { p_payment_id: claimId }); if (error) throw error;
      await startPayment(instalmentId); await sleep(10000);
    }, { quiet: true });
    if (!r.ok) setErr(r.message);
  };
  const payOffline = async (instalmentId: string) => {
    setErr("");
    let paymentId = "";
    const r = await run("Saving…", async () => {
      const { data, error } = await supabase.rpc("request_offline_payment", { p_instalment_id: instalmentId }); if (error) throw error;
      paymentId = data as string;
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    nav(`/pay/offline/${paymentId}`);
  };
  // A saved but unpaid registration can be dropped so the student can pick a different pack, courses or centre.
  // Not offered once a receipt is under review: that money may already be on its way, so the team handles it.
  const cancelReg = async (id: string, hadRequest: boolean) => {
    setErr("");
    const yes = await confirm({ title: "Cancel this registration?", message: `Nothing has been charged.${hadRequest ? " Your offline payment request will be closed too." : ""} Your pack, courses and centre won't be kept, and you can register again whenever you're ready.`, confirmLabel: "Cancel registration", cancelLabel: "Keep it", danger: true });
    if (!yes) return;
    const r = await run("Cancelling…", async () => { const { error } = await supabase.rpc("cancel_enrolment", { p_enrolment_id: id, p_reason: "Cancelled by student" }); if (error) throw error; await load(); }, { success: "Registration cancelled" });
    if (!r.ok) setErr(r.message);
  };
  const closeSheet = () => { setOpen(false); setCode(""); setErr(""); setScan(false); };

  if (!enr) return <div className="space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-28" /></div>;
  const owing = enr.flatMap((e) => e.enrolment_instalments.filter((i) => i.status === "pending").sort((a, b) => a.number - b.number).slice(0, 1).map((i) => ({ e, i })));
  const d0 = (iso: string, o: Intl.DateTimeFormatOptions) => fmtDay(iso, o);
  const todayIso = today();
  // Where the student is registered: current registrations first, finished ones only if that is all there is
  const mine = enr.filter((e) => e.centres && e.status !== "completed"); const here = mine.length ? mine : enr.filter((e) => e.centres);
  const centreLabel = [...new Set(here.map((e) => placeLabel(e.centres!)))].join(", ");

  return (
    <div className="space-y-6">
      <PageHeader title={`Hi ${name.split(" ")[0]}`} />
      {centreLabel && <Link to="/profile" className="-mt-3 flex items-center gap-1.5 text-[15px] text-muted transition hover:text-ink"><Icon name="pin" size={15} /><span className="min-w-0 truncate">{centreLabel}</span></Link>}

      {enr.length === 0 && <CourseOutline />}

      {(enr ?? []).filter((e) => e.status === "active" && e.starts_on && e.starts_on > todayIso).map((e) => (
        <Card key={e.id} className="anim-rise space-y-1 border-l-4 border-l-info">
          <p className="text-sm font-medium text-info">Your first class</p>
          <p className="text-lg font-semibold">{d0(e.starts_on!, { weekday: "long", day: "numeric", month: "long" })}</p>
          <p className="text-sm text-muted">{e.enrolment_courses?.find((c) => c.sequence_no === 1)?.courses?.title}{e.centres && <> · <Place centre={e.centres} townOnly /></>}</p>
        </Card>))}

      {owing.map(({ e, i }) => {
        const claim = claims.find((c) => c.instalment_id === i.id);
        if (claim) return (
          <Card key={i.id} className="anim-rise space-y-3">
            <div className="flex items-center justify-between gap-3"><p className="font-medium">Offline payment</p><Badge tone={claim.receipt ? "info" : "warn"}>{claim.receipt ? "Awaiting confirmation" : "Receipt needed"}</Badge></div>
            <p className="text-sm text-muted">{naira(claim.amount)} · {claim.instalment_label ?? "Payment"} · reference <span className="num font-medium text-ink">{claim.reference}</span></p>
            <p className="text-sm text-muted">{claim.receipt ? "The team has your receipt and will confirm once the money arrives. You'll get a notification." : "Pay by cash or transfer, then send your receipt so we can confirm it."}</p>
            <div className="grid grid-cols-2 gap-2">
              <Link to={`/pay/offline/${claim.id}`}><Button className="w-full">{claim.receipt ? "View details" : "Send receipt"}</Button></Link>
              <Button variant="secondary" onClick={() => payOnlineInstead(claim.id, i.id)}>Pay online</Button>
            </div>
            {e.status === "pending_payment" && !claim.receipt && <button onClick={() => cancelReg(e.id, true)} className="mx-auto block text-sm text-muted underline decoration-line underline-offset-4 transition hover:text-ink">Cancel registration</button>}
          </Card>);
        return (
        <Card key={i.id} className="anim-rise space-y-3">
          <div className="flex items-center justify-between"><p className="font-semibold">{e.status === "pending_payment" ? "Finish your enrolment" : "Next instalment"}</p><span className="num text-lg font-semibold">{naira(i.amount)}</span></div>
          <p className="text-sm text-muted">{i.label}{e.centres && <> · <Place centre={e.centres} townOnly /></>}{e.status === "pending_payment" && e.starts_on ? ` · classes start ${d0(e.starts_on, { day: "numeric", month: "short" })}` : i.due_date && i.number > 1 ? ` · due ${d0(i.due_date, { day: "numeric", month: "short" })}` : ""}</p>
          {e.status === "pending_payment" && <p className="text-sm text-muted">{[e.packages?.name, [...e.enrolment_courses].sort((a, b) => a.sequence_no - b.sequence_no).map((c) => c.courses?.title).filter(Boolean).join(" + ")].filter(Boolean).join(" · ")}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => pay(i.id)}>Pay online</Button>
            <Button variant="secondary" onClick={() => payOffline(i.id)}>Pay offline</Button>
          </div>
          {e.status === "pending_payment" && <button onClick={() => cancelReg(e.id, false)} className="mx-auto block text-sm text-muted underline decoration-line underline-offset-4 transition hover:text-ink">Cancel registration</button>}
        </Card>); })}
      <Err>{!open && err}</Err>

      <EmergencyClassCard onCheckIn={() => setOpen(true)} refreshKey={verdict} />

      <ClassCountdown student onCheckIn={() => setOpen(true)} />

      {prog.length > 0 && (
        <Section title="Your progress">
          {prog.map((p, k) => { const pct = Math.min(100, Math.round((p.sessions_attended / Math.max(p.sessions_needed, 1)) * 100));
            const key = `${p.enrolment_id}:${p.course_id}`; const list = lessons.filter((l) => l.enrolment_id === p.enrolment_id && l.course_id === p.course_id); const isOpen = openCourse === key;
            return <Card key={k} className="space-y-3"><div className="flex items-baseline justify-between gap-3"><p className="font-medium">{p.course_title}</p><span className="num text-sm text-muted">{p.sessions_attended}/{p.sessions_needed} classes</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-sunken"><div className={`h-full rounded-full transition-all duration-700 ${pct >= 100 ? "bg-ok" : "bg-accent"}`} style={{ width: `${pct}%` }} /></div>
              {list.length > 0 && <button onClick={() => setOpenCourse(isOpen ? "" : key)} className="text-sm text-accent">{isOpen ? "Hide classes" : `See all ${list.length} classes`}</button>}
              {isOpen && <ol className="space-y-2 pt-1">{list.map((l) => (
                <li key={l.lesson_no} className="flex gap-3">
                  <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${l.state === "attended" ? "bg-ok/15 text-ok" : l.state === "missed" ? "bg-bad/15 text-bad" : "bg-sunken text-muted"}`}>{l.state === "attended" ? <Icon name="check" size={14} strokeWidth={2.5} /> : l.state === "missed" ? <Icon name="close" size={14} strokeWidth={2.5} /> : l.lesson_no}</span>
                  <div className="min-w-0"><p className="text-sm font-medium">{l.title}{l.state === "missed" && <span className="ml-2 text-xs font-normal text-bad">Missed</span>}</p>{l.summary && <p className="text-sm text-muted">{l.summary}</p>}</div>
                </li>))}</ol>}
            </Card>; })}
        </Section>)}

      <MakeupCard />

      {enr.length > 0 && <SoloCourses />}

      {refunds.length > 0 && <Section title="Refunds">
        {refunds.map((r) => <Card key={r.id} className="flex items-center justify-between py-3"><div><p className="num font-medium">{naira(r.amount)}</p><p className="text-sm text-muted">{fmtWhen(r.created_at, { dateStyle: "short" })}</p></div>
          <Badge tone={r.status === "paid" ? "ok" : "info"}>{r.status === "paid" ? "Sent" : "On its way"}</Badge></Card>)}</Section>}

      <Sheet open={open} onClose={closeSheet} title="Enter your class code">
        <div className="space-y-4">{scan ? <QrScanner onCode={(c) => { setCode(c.toUpperCase()); checkIn(c.toUpperCase()); }} onClose={() => setScan(false)} /> : <Button variant="secondary" className="w-full" onClick={() => setScan(true)}><span className="inline-flex items-center gap-2"><Icon name="scan" size={18} />Scan the QR code</span></Button>}
          <p className="text-sm text-muted">Or type the 8-character code shown at the centre.</p>
          <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="A1B2C3D4" inputMode="text" autoCapitalize="characters"
            className="num h-14 w-full rounded-xl bg-surface text-center text-2xl font-semibold tracking-[.3em] outline-none ring-1 ring-line transition focus:ring-2 focus:ring-accent/60" />
          <Err>{err}</Err><Button className="w-full" disabled={code.length < 8} onClick={() => checkIn()}>Check in</Button></div>
      </Sheet>
      {verdict && <CheckInVerdict v={verdict} onDone={() => { setVerdict(null); setCode(""); }} onRetry={() => { setVerdict(null); setCode(""); setOpen(true); }} />}
    </div>
  );
}
