// src/components/RecordCash.tsx
// "The student is at the centre and has paid cash." A coordinator or director of the centre records it here, in four steps:
//   1. find the student's account (by email, name, phone or registration number)   2. what is it for: an unpaid instalment, or a new registration
//   3. count the cash and type the exact amount due                                  4. done: the student's classes unlock at once
// The cash is now held by the centre until it is sent to IQ Academy (see the Cash page).
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { supabase, naira, friendly } from "../lib/supabase";
import { toKobo, type CashDone, type CashOptions, type FoundStudent, type PayableEnrolment } from "../lib/cash";
import { useFeedback } from "./feedback";
import { Avatar, Button, Card, Err, Field, Sheet, Skeleton, cx } from "./ui";
import { fmtDay, today } from "../lib/time";
import Icon from "./Icon";

type Pack = { id: string; name: string; course_count: number; price_full: number; package_instalments: { number: number; label: string; amount: number; due_rule: string }[] };
type Course = { id: string; title: string; sort_order: number };
type Pre = { course_id: string; prerequisite_id: string; group_no: number };
type Target = { kind: "existing"; enrolment: PayableEnrolment } | { kind: "new"; pack: Pack; courseIds: string[]; plan: "full" | "instalment" };

const Row = ({ on, onClick, title, sub, right, disabled }: { on?: boolean; onClick: () => void; title: string; sub?: string; right?: string; disabled?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled} className={cx("flex w-full items-center gap-3 rounded-2xl p-3.5 text-left ring-1 transition active:scale-[.99] disabled:opacity-50", on ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
    <span className="min-w-0 flex-1"><span className="block font-medium leading-snug">{title}</span>{sub && <span className="mt-0.5 block text-sm text-muted">{sub}</span>}</span>
    {right && <span className="num shrink-0 font-semibold">{right}</span>}
  </button>
);

export default function RecordCash({ open, onClose, centreId, centreName, onDone }: { open: boolean; onClose: () => void; centreId: string; centreName: string; onDone: () => void }) {
  const { run, confirm } = useFeedback();
  const [step, setStep] = useState<"find" | "pick" | "new" | "amount" | "done">("find");
  const [q, setQ] = useState(""); const [found, setFound] = useState<FoundStudent[] | null>(null); const [busy, setBusy] = useState(false);
  const [student, setStudent] = useState<FoundStudent | null>(null); const [opts, setOpts] = useState<CashOptions | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [err, setErr] = useState(""); const [result, setResult] = useState<CashDone | null>(null);
  // new registration
  const [packs, setPacks] = useState<Pack[]>(); const [courses, setCourses] = useState<Course[]>(); const [pres, setPres] = useState<Pre[]>([]);
  const [sel, setSel] = useState({ pack: "", courses: [] as string[], plan: "full" as "full" | "instalment" });
  const [start, setStart] = useState<string | null | undefined>(); // when the first course starts at THIS centre (null: no classes yet)

  const reset = () => { setStep("find"); setQ(""); setFound(null); setStudent(null); setOpts(null); setTarget(null); setAmount(""); setNote(""); setErr(""); setResult(null); setSel({ pack: "", courses: [], plan: "full" }); setStart(undefined); };
  useEffect(() => { if (open) reset(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    setErr(""); setBusy(true);
    const r = await supabase.rpc("cash_find_student", { p_centre_id: centreId, p_query: q });
    setBusy(false);
    if (r.error) return setErr(friendly(r.error));
    setFound((r.data as FoundStudent[]) ?? []);
  };
  const choose = async (s: FoundStudent) => {
    setErr(""); setStudent(s); setOpts(null); setStep("pick");
    const r = await supabase.rpc("cash_student_options", { p_centre_id: centreId, p_student_id: s.id });
    if (r.error) { setErr(friendly(r.error)); return setStep("find"); }
    setOpts(r.data as CashOptions);
  };
  const toNew = async () => {
    setStep("new"); setErr("");
    if (packs) return;
    const [p, c, pr] = await Promise.all([
      supabase.from("packages").select("id,name,course_count,price_full,package_instalments(number,label,amount,due_rule)").eq("is_active", true).order("sort_order"),
      supabase.from("courses").select("id,title,sort_order").eq("is_active", true).order("sort_order"),
      supabase.from("course_prerequisites").select("course_id,prerequisite_id,group_no"),
    ]);
    setPacks((p.data as Pack[]) ?? []); setCourses((c.data as Course[]) ?? []); setPres((pr.data as Pre[]) ?? []);
  };

  const done = useMemo(() => new Set(opts?.completed_course_ids ?? []), [opts]);
  const pack = packs?.find((p) => p.id === sel.pack);
  const title = (id: string) => courses?.find((c) => c.id === id)?.title ?? "";
  // A course is open when every group of prerequisites has one the student finished or is taking in this same registration.
  const missing = (c: Course, chosen: string[]) => {
    const groups = new Map<number, string[]>();
    pres.filter((p) => p.course_id === c.id).forEach((p) => groups.set(p.group_no, [...(groups.get(p.group_no) ?? []), p.prerequisite_id]));
    for (const ids of groups.values()) if (!ids.some((i) => done.has(i) || chosen.includes(i))) return ids.map(title).join(" or ");
    return null;
  };
  const toggle = (c: Course) => {
    let next = sel.courses.includes(c.id) ? sel.courses.filter((x) => x !== c.id) : [...sel.courses, c.id];
    for (let i = 0; i < 4; i++) next = next.filter((id) => { const k = courses!.find((x) => x.id === id)!; return !missing(k, next.filter((y) => y !== id)); });
    setSel({ ...sel, courses: next }); setStart(undefined);
  };
  const ordered = useMemo(() => (courses ?? []).filter((c) => sel.courses.includes(c.id)), [courses, sel.courses]);
  const first = ordered[0];
  const full = !!pack && sel.courses.length === pack.course_count;
  useEffect(() => {
    if (!full || !first) return;
    setStart(undefined);
    supabase.rpc("centre_course_starts", { p_course_id: first.id }).then((r) => {
      const row = ((r.data as { centre_id: string; starts_on: string }[]) ?? []).find((x) => x.centre_id === centreId);
      setStart(row?.starts_on ?? null);
    });
  }, [full, first?.id, centreId]); // eslint-disable-line react-hooks/exhaustive-deps
  const inst = useMemo(() => [...(pack?.package_instalments ?? [])].sort((a, b) => a.number - b.number), [pack]);

  const due = !target ? 0 : target.kind === "existing" ? target.enrolment.next.amount : target.plan === "full" ? target.pack.price_full : (target.pack.package_instalments.find((i) => i.number === 1)?.amount ?? 0);
  const what = !target ? "" : target.kind === "existing" ? `${target.enrolment.package} · ${target.enrolment.next.label}` : `${target.pack.name} · ${target.plan === "full" ? "Full payment" : "First instalment"}`;
  const kobo = toKobo(amount);

  const record = async () => {
    if (!student || !target) return;
    const yes = await confirm({ title: "Is the cash in your hand?", confirmLabel: `Yes, record ${naira(due)}`, cancelLabel: "Not yet",
      message: `${student.full_name} · ${what}. Their classes unlock straight away. You'll hold this cash for IQ Academy until you send it from the Cash page.` });
    if (!yes) return;
    setErr("");
    const args: Record<string, unknown> = { p_centre_id: centreId, p_student_id: student.id, p_amount: kobo, p_note: note.trim() || null };
    if (target.kind === "existing") args.p_instalment_id = target.enrolment.next.id;
    else Object.assign(args, { p_package_id: target.pack.id, p_plan: target.plan, p_course_ids: target.courseIds });
    const r = await run("Recording the payment…", async () => { const { data, error } = await supabase.rpc("cash_record_payment", args); if (error) throw error; return data as CashDone; }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setResult(r.data); setStep("done"); onDone();
  };

  const back = () => { setErr(""); setStep(step === "amount" ? (target?.kind === "new" ? "new" : "pick") : step === "new" ? "pick" : "find"); };

  return (
    <Sheet open={open} onClose={onClose} title={step === "done" ? "Payment recorded" : "Record a cash payment"}>
      <div className="space-y-4">
        {step === "find" && <>
          <p className="text-sm text-muted">Find the student by email, name, phone number or registration number. They need an account first.</p>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1"><Field label="Student" value={q} onChange={(e) => { setQ(e.target.value); setFound(null); }} onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 3 && search()} placeholder="Email, name or phone" autoComplete="off" autoFocus /></div>
            <Button className="mt-[26px]" disabled={q.trim().length < 3} loading={busy} onClick={search}>Find</Button>
          </div>
          {found && found.map((s) => (
            <button key={s.id} type="button" onClick={() => choose(s)} className="flex w-full items-center gap-3 rounded-2xl bg-surface p-3 text-left ring-1 ring-line transition active:scale-[.99]">
              <Avatar name={s.full_name} size={40} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.full_name}</span><span className="block truncate text-sm text-muted">{[s.email, s.phone, s.student_number].filter(Boolean).join(" · ")}</span></span>
              <Icon name="chevronRight" size={16} className="shrink-0 text-muted" />
            </button>))}
          {found && found.length === 0 && (
            <Card className="space-y-3">
              <p className="font-medium">No account found</p>
              <p className="text-sm text-muted">Ask the student to create an account first: have them scan this code (or open <span className="font-medium text-ink">{location.origin}</span>), tap Create account and confirm their email. Then search again here.</p>
              <div className="mx-auto w-fit rounded-xl bg-white p-2"><QRCodeSVG value={location.origin} size={120} /></div>
            </Card>)}
          <Err>{err}</Err>
        </>}

        {step === "pick" && <>
          {!opts ? <div className="space-y-3"><Skeleton className="h-14" /><Skeleton className="h-20" /></div> : <>
            <div className="flex items-center gap-3"><Avatar name={opts.student.full_name} size={44} /><div className="min-w-0"><p className="truncate font-semibold">{opts.student.full_name}</p><p className="truncate text-sm text-muted">{[opts.student.email, opts.student.phone, opts.student.student_number].filter(Boolean).join(" · ")}</p></div></div>
            {opts.enrolments.length > 0 && <div className="space-y-2">
              <p className="text-sm font-medium text-muted">Unpaid at {centreName}</p>
              {opts.enrolments.map((e) => (
                <Row key={e.id} title={`${e.package} · ${e.next.label}`} sub={`${e.courses.join(" + ")}${e.next.claim ? (e.next.claim.has_receipt ? " · transfer receipt waiting for an admin" : " · transfer requested, this replaces it") : ""}`}
                  right={naira(e.next.amount)} disabled={!!e.next.claim?.has_receipt}
                  onClick={() => { setTarget({ kind: "existing", enrolment: e }); setAmount(""); setStep("amount"); }} />))}
            </div>}
            <Button variant={opts.enrolments.length ? "secondary" : "primary"} className="w-full" onClick={toNew}>Register them for a new pack</Button>
            {opts.open_transfer && opts.enrolments.length === 0 && <p className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">This student has an unpaid registration waiting for a bank transfer elsewhere. Ask them to cancel it from their home screen first.</p>}
          </>}
          <Err>{err}</Err>
          <Button variant="ghost" className="w-full" onClick={back}>Back</Button>
        </>}

        {step === "new" && student && <>
          <p className="text-sm text-muted">New registration for <span className="font-medium text-ink">{student.full_name}</span> at {centreName}.</p>
          {!packs || !courses ? <Skeleton className="h-28" /> : <>
            <div className="space-y-2">{packs.map((p) => <Row key={p.id} on={sel.pack === p.id} title={p.name} sub={`${p.course_count} courses`} right={naira(p.price_full)} onClick={() => { setSel({ pack: p.id, courses: [], plan: "full" }); setStart(undefined); }} />)}</div>
            {pack && <div className="space-y-2">
              <p className="text-sm font-medium text-muted">Pick {pack.course_count} courses</p>
              {courses.map((c) => {
                const m = !sel.courses.includes(c.id) ? missing(c, sel.courses) : null; const isFull = sel.courses.length >= pack.course_count && !sel.courses.includes(c.id);
                return <Row key={c.id} on={sel.courses.includes(c.id)} title={c.title} sub={m ? `Needs ${m} first` : isFull ? "The pack is full" : undefined} disabled={!!m || isFull} onClick={() => toggle(c)} />;
              })}
            </div>}
            {pack && full && <div className="space-y-2">
              {start === undefined ? <Skeleton className="h-10" /> : start === null
                ? <p className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">No classes are scheduled for {first?.title} at this centre yet, so they can't register here.</p>
                : <p className="text-sm text-muted">{first?.title} starts {start <= today() ? "today" : fmtDay(start, { day: "numeric", month: "long", year: "numeric" })}.</p>}
              <div className="grid grid-cols-2 gap-2">
                <Row on={sel.plan === "full"} title="Pay in full" right={naira(pack.price_full)} onClick={() => setSel({ ...sel, plan: "full" })} />
                <Row on={sel.plan === "instalment"} disabled={inst.length === 0} title="Instalments" right={inst[0] ? naira(inst[0].amount) : undefined} sub={inst.length ? `${inst.length} payments` : "Not offered"} onClick={() => setSel({ ...sel, plan: "instalment" })} />
              </div>
              <Button className="w-full" disabled={!start} onClick={() => { setTarget({ kind: "new", pack, courseIds: sel.courses, plan: sel.plan }); setAmount(""); setStep("amount"); }}>Continue</Button>
            </div>}
          </>}
          <Err>{err}</Err>
          <Button variant="ghost" className="w-full" onClick={back}>Back</Button>
        </>}

        {step === "amount" && student && target && <>
          <Card className="space-y-1">
            <p className="text-sm text-muted">{student.full_name}</p>
            <p className="text-sm text-muted">{what}</p>
            <p className="num text-3xl font-semibold">{naira(due)}</p>
            <p className="text-sm text-muted">due now</p>
          </Card>
          <Field label="Cash you counted (₦)" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.,]/g, "")); setErr(""); }} placeholder="Type the amount" autoFocus />
          {kobo > 0 && kobo !== due && <p className="text-sm text-bad">That isn't {naira(due)}. Part payments aren't accepted: collect the exact amount.</p>}
          <label className="block"><span className="mb-1.5 block text-sm text-muted">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. paid by the mother" className="h-11 w-full rounded-xl bg-surface px-4 text-[15px] outline-none ring-1 ring-line transition focus:ring-2 focus:ring-accent/60" /></label>
          <Err>{err}</Err>
          <Button className="w-full" disabled={kobo !== due || due <= 0} onClick={record}>Record {naira(due)} cash</Button>
          <Button variant="ghost" className="w-full" onClick={back}>Back</Button>
        </>}

        {step === "done" && result && <div className="space-y-4 py-2 text-center">
          <div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div>
          <div><p className="text-lg font-semibold">{naira(result.amount)} from {result.student_name}</p><p className="text-sm text-muted">{result.instalment_label}</p></div>
          <p className="rounded-xl bg-sunken px-4 py-3 text-sm">Give them this reference as their receipt<br /><span className="num text-lg font-semibold tracking-wide">{result.reference}</span></p>
          <p className="text-sm text-muted">{result.new_registration ? "They're registered and their classes are unlocked. " : "Their classes stay unlocked. "}{result.next ? `Next instalment: ${naira(result.next.amount)} (${result.next.label}).` : "Nothing more to pay."} You now hold this cash for IQ Academy.</p>
          <div className="grid grid-cols-2 gap-2"><Button variant="secondary" onClick={reset}>Record another</Button><Button onClick={onClose}>Done</Button></div>
        </div>}
      </div>
    </Sheet>
  );
}
