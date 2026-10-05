import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { sleep } from "../lib/db";
import { startPayment } from "../lib/payment";
import { SoloSheet, useSoloOffers } from "../components/SoloCourses";
import { useFeedback } from "../components/feedback";
import { Button, Card, Err, Skeleton, cx } from "../components/ui";
import type { MyOffline } from "../lib/offline";
import { place, placeSub } from "../lib/centre";

import Icon from "../components/Icon";
import { fmtDay, today } from "../lib/time";
type Centre = { id: string; name: string; address: string | null; city: string | null };
type Start = { centre_id: string; starts_on: string };
type Pack = { id: string; name: string; description: string | null; course_count: number; price_full: number; package_instalments: { number: number; label: string; amount: number; due_rule: string }[] };
type Course = { id: string; title: string; summary: string | null; sort_order: number };
type Pre = { course_id: string; prerequisite_id: string; group_no: number };
const STEPS = ["Pack", "Courses", "Centre", "Payment"];

export { startPayment };

// "Then ₦40,000 before course 2": the first instalment is the amount due now, so only the rest need spelling out.
const when = (i: { amount: number; label: string; due_rule: string }) => {
  const m = /^before_course_(\d)$/.exec(i.due_rule);
  return m ? `${naira(i.amount)} before course ${m[1]}` : `${naira(i.amount)} (${i.label})`;
};
const later = (inst: { amount: number; label: string; due_rule: string }[]) => (inst.length > 1 ? `Then ${inst.slice(1).map(when).join(" · ")}` : undefined);

const startsLabel = (iso: string) => (iso <= today() ? "Starts today" : `Starts ${fmtDay(iso, { day: "numeric", month: "long", year: "numeric" })}`);

function Option({ on, onClick, title, sub, note, right, locked, strong }: { on?: boolean; onClick: () => void; title: string; sub?: string | null; note?: string; right?: string; locked?: string; strong?: boolean }) {
  return (
    <button onClick={onClick} disabled={!!locked}
      className={cx("anim-fade flex w-full items-center gap-3 rounded-2xl p-4 text-left ring-1 transition active:scale-[.99] disabled:opacity-50",
        on ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
      <div className="min-w-0 flex-1"><p className={strong ? "text-[17px] font-semibold leading-snug" : "font-medium"}>{title}</p>
        {(locked || sub) && <p className={cx("mt-0.5 text-muted", strong ? "text-[13px]" : "text-sm")}>{locked ?? sub}</p>}
        {note && !locked && <p className="mt-0.5 text-sm font-medium text-accent">{note}</p>}</div>
      {right && <span className="num font-medium">{right}</span>}
      <span className={cx("grid h-5 w-5 place-items-center rounded-full text-[11px]", on ? "bg-accent text-accent-ink" : "ring-1 ring-line")}>{on && <Icon name="check" size={12} strokeWidth={3} />}</span>
    </button>
  );
}

export default function Enrol() {
  const nav = useNavigate(); const { run } = useFeedback();
  const [step, setStep] = useState(0);
  const [centres, setCentres] = useState<Centre[]>();
  const [starts, setStarts] = useState<Map<string, string>>();
  const [packs, setPacks] = useState<Pack[]>();
  const [courses, setCourses] = useState<Course[]>();
  const [pres, setPres] = useState<Pre[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState({ pack: "", courses: [] as string[], centre: "", plan: "full" as "full" | "instalment" });
  const [method, setMethod] = useState<"online" | "offline">("online");
  const [claims, setClaims] = useState<MyOffline[]>();
  const [err, setErr] = useState("");
  const { offers: solo } = useSoloOffers(); const [soloOpen, setSoloOpen] = useState(false);

  useEffect(() => { supabase.rpc("my_offline_payments").then((r) => setClaims(((r.data as MyOffline[]) ?? []).filter((c) => c.enrolment_status === "pending_payment"))); }, []);
  useEffect(() => {
    supabase.from("centres").select("id,name,address,city").eq("is_active", true).order("name").then((r) => setCentres((r.data as Centre[]) ?? []));
    supabase.from("packages").select("id,name,description,course_count,price_full,package_instalments(number,label,amount,due_rule)").eq("is_active", true).order("sort_order").then((r) => setPacks((r.data as Pack[]) ?? []));
    supabase.from("courses").select("id,title,summary,sort_order").eq("is_active", true).order("sort_order").then((r) => setCourses((r.data as Course[]) ?? []));
    supabase.from("course_prerequisites").select("course_id,prerequisite_id,group_no").then((r) => setPres((r.data as Pre[]) ?? []));
    supabase.from("v_student_progress").select("course_id").eq("course_status", "completed").then((r) => setDone(new Set((r.data ?? []).map((x: { course_id: string }) => x.course_id))));
  }, []);
  // Instructors build each centre's timetable, so the date comes from the first course in the pack.
  const ordered = useMemo(() => (courses ?? []).filter((c) => sel.courses.includes(c.id)), [courses, sel.courses]);
  const first = ordered[0];
  useEffect(() => {
    if (step !== 2 || !first) return;
    setStarts(undefined);
    supabase.rpc("centre_course_starts", { p_course_id: first.id }).then((r) => setStarts(new Map(((r.data as Start[]) ?? []).map((x) => [x.centre_id, x.starts_on]))));
  }, [step, first?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pack = packs?.find((p) => p.id === sel.pack);
  const title = (id: string) => courses?.find((c) => c.id === id)?.title ?? "";

  // A course is available when every prerequisite group has a course that is completed or in this selection.
  const missing = (c: Course, chosen: string[]) => {
    const groups = new Map<number, string[]>();
    pres.filter((p) => p.course_id === c.id).forEach((p) => groups.set(p.group_no, [...(groups.get(p.group_no) ?? []), p.prerequisite_id]));
    for (const ids of groups.values()) if (!ids.some((i) => done.has(i) || chosen.includes(i))) return ids.map(title).join(" or ");
    return null;
  };
  const toggle = (c: Course) => {
    let next = sel.courses.includes(c.id) ? sel.courses.filter((x) => x !== c.id) : [...sel.courses, c.id];
    for (let i = 0; i < 4; i++) next = next.filter((id) => { const k = courses!.find((x) => x.id === id)!; return !missing(k, next.filter((y) => y !== id)); });
    setSel({ ...sel, courses: next, centre: "" });
  };
  const inst = useMemo(() => [...(pack?.package_instalments ?? [])].sort((a, b) => a.number - b.number), [pack]);

  const pay = async () => {
    setErr("");
    let offlineId: string | null = null;
    const r = await run(method === "offline" ? "Saving your registration…" : "Setting up your payment…", async () => {
      const { data: id, error } = await supabase.rpc("create_enrolment", {
        p_centre_id: sel.centre, p_package_id: sel.pack, p_plan: sel.plan, p_course_ids: sel.courses });
      if (error) throw error;
      const { data: rows } = await supabase.from("enrolment_instalments").select("id").eq("enrolment_id", id).eq("number", 1).single();
      if (method === "offline") {
        // Saved as a pending offline payment: nothing leaves the app, the student pays and sends a receipt.
        const o = await supabase.rpc("request_offline_payment", { p_instalment_id: rows!.id });
        if (o.error) throw o.error;
        offlineId = o.data as string;
        return;
      }
      await startPayment(rows!.id);
      await sleep(10000); // the browser is on its way to Paystack; keep the overlay up until it leaves
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    if (offlineId) nav(`/pay/offline/${offlineId}`, { replace: true });
  };

  const can = [!!sel.pack, !!pack && sel.courses.length === pack.course_count, !!sel.centre && !!starts?.has(sel.centre), true][step];
  const loading = (x: unknown) => x === undefined && <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  const dueNow = sel.plan === "full" ? pack?.price_full ?? 0 : inst[0]?.amount ?? 0;

  if (claims && claims.length > 0) {
    const c = claims[0];
    return (
      <div className="space-y-4">
        <h1 className="text-2xl">You have a registration waiting</h1>
        <Card className="space-y-3">
          <p className="text-sm text-muted">{c.package}{c.courses.length ? ` · ${c.courses.join(" + ")}` : ""}</p>
          <p className="num text-2xl font-semibold">{naira(c.amount)} <span className="text-base font-normal text-muted">offline</span></p>
          <p className="text-sm text-muted">{c.receipt ? "Your receipt is with the team, waiting for confirmation." : "Pay and send your receipt, or cancel this registration to start a new one."}</p>
          <Link to={`/pay/offline/${c.id}`}><Button className="w-full">Open payment details</Button></Link>
        </Card>
        <Button variant="secondary" className="w-full" onClick={() => nav("/")}>Back home</Button>
      </div>);
  }

  return (
    <div className="space-y-5 pb-32">
      <div>
        <div className="mb-3 flex gap-1.5">{STEPS.map((_, i) => <div key={i} className={cx("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-accent" : "bg-line")} />)}</div>
        <p className="text-sm text-muted">Step {step + 1} of {STEPS.length}</p>
        <h1 className="text-2xl">{["Choose your pack", pack ? `Pick ${pack.course_count} courses` : "Pick your courses", "Where will you learn?", "How would you like to pay?"][step]}</h1>
      </div>

      <div key={step} className="space-y-3">
        {step === 0 && (loading(packs) || packs!.map((p) => <Option key={p.id} on={sel.pack === p.id} onClick={() => setSel({ ...sel, pack: p.id, courses: [], centre: "" })} title={p.name} sub={p.description} right={naira(p.price_full)} />))}
        {step === 0 && packs && !!solo?.length && (
          <button onClick={() => setSoloOpen(true)} className="mx-auto flex items-center gap-1.5 pt-3 text-sm text-muted transition active:opacity-60">
            Need just one course? <span className="inline-flex items-center font-medium text-accent">Explore courses<Icon name="chevronRight" size={16} /></span>
          </button>)}
        {step === 1 && (loading(courses) || courses!.map((c) => {
          const m = !sel.courses.includes(c.id) ? missing(c, sel.courses) : null;
          const full = !!pack && sel.courses.length >= pack.course_count && !sel.courses.includes(c.id);
          return <Option key={c.id} on={sel.courses.includes(c.id)} onClick={() => toggle(c)} title={c.title} sub={c.summary} locked={m ? `Needs ${m} first` : full ? "Your pack is full" : undefined} />;
        }))}
        {step === 2 && (loading(centres && starts) || <>
          {first && <p className="text-sm text-muted">Dates show when <span className="font-medium text-ink">{first.title}</span>, your first course, starts at each location.</p>}
          {centres!.length ? [...centres!].sort((a, b) => (starts!.get(a.id) ?? "9").localeCompare(starts!.get(b.id) ?? "9") || place(a).localeCompare(place(b))).map((c) => {
            const d = starts!.get(c.id);
            return <Option key={c.id} strong on={sel.centre === c.id} onClick={() => setSel({ ...sel, centre: c.id })} title={place(c)} sub={placeSub(c)}
              note={d ? startsLabel(d) : undefined} locked={d ? undefined : "No classes scheduled yet"} />;
          }) : <p className="text-muted">No centres are open yet.</p>}
        </>)}
        {step === 3 && pack && <>
          <Option on={sel.plan === "full"} onClick={() => setSel({ ...sel, plan: "full" })} title="Pay in full" sub="One payment, all set" right={naira(pack.price_full)} />
          {inst.length > 0 && <Option on={sel.plan === "instalment"} onClick={() => setSel({ ...sel, plan: "instalment" })} title="Pay in instalments" sub={later(inst)} right={naira(inst[0].amount)} />}
          <p className="pt-2 text-sm font-medium text-muted">How will you pay?</p>
          <Option on={method === "online"} onClick={() => setMethod("online")} title="Pay online" sub="Card or bank transfer through Paystack. Confirmed straight away." />
          <Option on={method === "offline"} onClick={() => setMethod("offline")} title="Pay offline" sub="Cash or bank transfer. Send your receipt and the team confirms it once the money arrives." />
          <Card className="space-y-1 text-sm"><p className="font-medium">{pack.name}</p><p className="text-muted">{sel.courses.map(title).join(" + ")}</p></Card>
          <Err>{err}</Err>
        </>}
      </div>

      <div className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 bg-bg/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl gap-3">
          <Button variant="secondary" onClick={() => (step ? setStep(step - 1) : nav("/"))}>Back</Button>
          {step < 3 ? <Button className="flex-1" disabled={!can} onClick={() => setStep(step + 1)}>Continue</Button>
            : <Button className="flex-1" onClick={pay}>{method === "offline" ? `Continue · pay ${naira(dueNow)} offline` : `Pay ${naira(dueNow)} now`}</Button>}
        </div>
      </div>
      <SoloSheet open={soloOpen} onClose={() => setSoloOpen(false)} offers={solo} />
    </div>
  );
}
