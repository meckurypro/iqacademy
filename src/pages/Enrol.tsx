import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, friendly, naira } from "../lib/supabase";
import { Button, Card, Err, Skeleton, cx } from "../components/ui";
import { place, placeSub } from "../lib/centre";

type Centre = { id: string; name: string; address: string | null; city: string | null };
type Cohort = { id: string; name: string; start_date: string };
type Pack = { id: string; name: string; description: string | null; course_count: number; price_full: number; package_instalments: { number: number; label: string; amount: number; due_rule: string }[] };
type Course = { id: string; title: string; summary: string | null; sort_order: number };
type Pre = { course_id: string; prerequisite_id: string; group_no: number };
const STEPS = ["Centre", "Cohort", "Pack", "Courses", "Payment"];

export async function startPayment(instalmentId: string) {
  const { data, error } = await supabase.functions.invoke("paystack-init-payment", {
    body: { instalment_id: instalmentId, callback_url: `${location.origin}/pay/callback` },
  });
  if (error || !data?.authorization_url) throw new Error(data?.error ?? error?.message ?? "payment_failed");
  location.href = data.authorization_url;
}

// "Then ₦40,000 before course 2": the first instalment is the amount due now, so only the rest need spelling out.
const when = (i: { amount: number; label: string; due_rule: string }) => {
  const m = /^before_course_(\d)$/.exec(i.due_rule);
  return m ? `${naira(i.amount)} before course ${m[1]}` : `${naira(i.amount)} (${i.label})`;
};
const later = (inst: { amount: number; label: string; due_rule: string }[]) => (inst.length > 1 ? `Then ${inst.slice(1).map(when).join(" · ")}` : undefined);

function Option({ on, onClick, title, sub, right, locked }: { on?: boolean; onClick: () => void; title: string; sub?: string | null; right?: string; locked?: string }) {
  return (
    <button onClick={onClick} disabled={!!locked}
      className={cx("anim-fade flex w-full items-center gap-3 rounded-2xl p-4 text-left ring-1 transition active:scale-[.99] disabled:opacity-50",
        on ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
      <div className="min-w-0 flex-1"><p className="font-medium">{title}</p>
        {(locked || sub) && <p className="mt-0.5 text-sm text-muted">{locked ?? sub}</p>}</div>
      {right && <span className="num font-medium">{right}</span>}
      <span className={cx("grid h-5 w-5 place-items-center rounded-full text-[11px]", on ? "bg-accent text-accent-ink" : "ring-1 ring-line")}>{on && "✓"}</span>
    </button>
  );
}

export default function Enrol() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [centres, setCentres] = useState<Centre[]>();
  const [cohorts, setCohorts] = useState<Cohort[]>();
  const [packs, setPacks] = useState<Pack[]>();
  const [courses, setCourses] = useState<Course[]>();
  const [pres, setPres] = useState<Pre[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState({ centre: "", cohort: "", pack: "", courses: [] as string[], plan: "full" as "full" | "instalment" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");

  useEffect(() => {
    supabase.from("centres").select("id,name,address,city").eq("is_active", true).order("name").then((r) => setCentres((r.data as Centre[]) ?? []));
    supabase.from("packages").select("id,name,description,course_count,price_full,package_instalments(number,label,amount,due_rule)").eq("is_active", true).order("sort_order").then((r) => setPacks((r.data as Pack[]) ?? []));
    supabase.from("courses").select("id,title,summary,sort_order").eq("is_active", true).order("sort_order").then((r) => setCourses((r.data as Course[]) ?? []));
    supabase.from("course_prerequisites").select("course_id,prerequisite_id,group_no").then((r) => setPres((r.data as Pre[]) ?? []));
    supabase.from("v_student_progress").select("course_id").eq("course_status", "completed").then((r) => setDone(new Set((r.data ?? []).map((x: { course_id: string }) => x.course_id))));
  }, []);
  useEffect(() => {
    if (!sel.centre) return;
    setCohorts(undefined);
    supabase.from("cohorts").select("id,name,start_date").eq("centre_id", sel.centre).eq("status", "open").order("start_date").then((r) => setCohorts((r.data as Cohort[]) ?? []));
  }, [sel.centre]);

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
    setSel({ ...sel, courses: next });
  };
  const inst = useMemo(() => [...(pack?.package_instalments ?? [])].sort((a, b) => a.number - b.number), [pack]);

  const pay = async () => {
    setBusy(true); setErr("");
    try {
      const { data: id, error } = await supabase.rpc("create_enrolment", {
        p_centre_id: sel.centre, p_cohort_id: sel.cohort, p_package_id: sel.pack, p_plan: sel.plan, p_course_ids: sel.courses });
      if (error) throw error;
      const { data: rows } = await supabase.from("enrolment_instalments").select("id").eq("enrolment_id", id).eq("number", 1).single();
      await startPayment(rows!.id);
    } catch (e) { setErr(friendly(e)); setBusy(false); }
  };

  const can = [!!sel.centre, !!sel.cohort, !!sel.pack, !!pack && sel.courses.length === pack.course_count, true][step];
  const loading = (x: unknown) => x === undefined && <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  const dueNow = sel.plan === "full" ? pack?.price_full ?? 0 : inst[0]?.amount ?? 0;

  return (
    <div className="space-y-5 pb-28">
      <div>
        <div className="mb-3 flex gap-1.5">{STEPS.map((_, i) => <div key={i} className={cx("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-accent" : "bg-line")} />)}</div>
        <p className="text-sm text-muted">Step {step + 1} of {STEPS.length}</p>
        <h1 className="text-2xl">{["Where will you learn?", "Pick your start date", "Choose your pack", pack ? `Pick ${pack.course_count} courses` : "Pick your courses", "How would you like to pay?"][step]}</h1>
      </div>

      <div key={step} className="space-y-3">
        {step === 0 && (loading(centres) || (centres!.length ? centres!.map((c) => <Option key={c.id} on={sel.centre === c.id} onClick={() => setSel({ ...sel, centre: c.id, cohort: "" })} title={place(c)} sub={placeSub(c)} />) : <p className="text-muted">No centres are open yet.</p>))}
        {step === 1 && (loading(cohorts) || (cohorts!.length ? cohorts!.map((c) => <Option key={c.id} on={sel.cohort === c.id} onClick={() => setSel({ ...sel, cohort: c.id })} title={c.name} sub={`Starts ${new Date(c.start_date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`} />) : <p className="text-muted">No cohorts are open at this centre right now. Try another centre.</p>))}
        {step === 2 && (loading(packs) || packs!.map((p) => <Option key={p.id} on={sel.pack === p.id} onClick={() => setSel({ ...sel, pack: p.id, courses: [] })} title={p.name} sub={p.description} right={naira(p.price_full)} />))}
        {step === 3 && (loading(courses) || courses!.map((c) => {
          const m = !sel.courses.includes(c.id) ? missing(c, sel.courses) : null;
          const full = !!pack && sel.courses.length >= pack.course_count && !sel.courses.includes(c.id);
          return <Option key={c.id} on={sel.courses.includes(c.id)} onClick={() => toggle(c)} title={c.title} sub={c.summary} locked={m ? `Needs ${m} first` : full ? "Your pack is full" : undefined} />;
        }))}
        {step === 4 && pack && <>
          <Option on={sel.plan === "full"} onClick={() => setSel({ ...sel, plan: "full" })} title="Pay in full" sub="One payment, all set" right={naira(pack.price_full)} />
          {inst.length > 0 && <Option on={sel.plan === "instalment"} onClick={() => setSel({ ...sel, plan: "instalment" })} title="Pay in instalments" sub={later(inst)} right={naira(inst[0].amount)} />}
          <Card className="space-y-1 text-sm"><p className="font-medium">{pack.name}</p><p className="text-muted">{sel.courses.map(title).join(" + ")}</p></Card>
          <Err>{err}</Err>
        </>}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 bg-bg/80 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl gap-3">
          <Button variant="secondary" onClick={() => (step ? setStep(step - 1) : nav("/"))}>Back</Button>
          {step < 4 ? <Button className="flex-1" disabled={!can} onClick={() => setStep(step + 1)}>Continue</Button>
            : <Button className="flex-1" loading={busy} onClick={pay}>Pay {naira(dueNow)} now</Button>}
        </div>
      </div>
    </div>
  );
}
