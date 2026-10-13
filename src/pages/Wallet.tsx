// src/pages/Wallet.tsx — an instructor's earnings wallet. It works exactly like a centre director's income: one record per month,
// a Withdraw button on each month once that month ends, older months stay withdrawable. All money maths happens in the database
// (instructor_wallet and friends); this page only shows what the database says and asks it to act.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, naira } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import BankAccountSheet from "../components/BankAccountSheet";
import { Badge, Button, Card, Chip, ChipRow, Empty, Err, PageHeader, Section, Sheet, Skeleton, Stat } from "../components/ui";
import { fmtDay, fmtWhen } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS: Record<string, [string, "ok" | "warn" | "bad" | "muted" | "info"]> = {
  draft: ["Requested", "info"], processing: ["On its way", "info"], paid: ["Paid", "ok"], failed: ["Didn't go through", "bad"], rejected: ["Not approved", "bad"], cancelled: ["Cancelled", "muted"],
};
const monthLabel = (m: string) => fmtDay(m, { month: "long", year: "numeric" });
const niceDay = (d: string) => fmtDay(d, { day: "numeric", month: "long" });

export default function Wallet() {
  const { run, confirm } = useFeedback();
  const [w, setW] = useState<any>(); const [earn, setEarn] = useState<any[]>(); const [wd, setWd] = useState<any[]>(); const [err, setErr] = useState("");
  const [month, setMonth] = useState(""); const [bank, setBank] = useState(false); const [cls, setCls] = useState<any>(null); const [lines, setLines] = useState<any[]>();

  const load = useCallback(async () => {
    setErr("");
    const [a, b, c] = await Promise.all([
      supabase.rpc("instructor_wallet"), supabase.rpc("instructor_earnings", { p_limit: 60, p_offset: 0 }),
      supabase.from("instructor_withdrawals").select("id,amount,status,created_at,paid_at,reject_reason,failure_reason,reference,eligible_through").order("created_at", { ascending: false }).limit(20),
    ]);
    if (a.error) { setErr(a.error.message.includes("forbidden") ? "The wallet is for instructors." : "Couldn't load your wallet. Pull down to try again."); setW(null); return; }
    setW(a.data); setEarn((b.data as any[]) ?? []); setWd(c.data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const f = () => document.visibilityState === "visible" && load(); document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, [load]);

  const thisMonth = w?.today ? String(w.today).slice(0, 7) + "-01" : "";
  const months: string[] = useMemo(() => (w?.months ?? []).map((m: any) => m.month as string), [w]);
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months.includes(thisMonth) ? thisMonth : months[0]); }, [months, month, thisMonth]);
  const m = (w?.months ?? []).find((x: any) => x.month === month);

  const withdraw = async () => {
    if (!(await confirm({ title: `Withdraw ${naira(m.available)}?`, message: `Your ${monthLabel(m.month)} earnings will be sent to your bank account once we approve it. You can cancel until then.`, confirmLabel: "Withdraw" }))) return;
    await run("Requesting…", async () => { const { error } = await supabase.rpc("request_instructor_withdrawal", { p_month: m.month }); if (error) throw error; await load(); }, { success: "Withdrawal requested" });
  };
  const cancel = async (id: string) => {
    if (!(await confirm({ title: "Cancel this withdrawal?", message: "The money stays in your balance. You can withdraw it again later.", confirmLabel: "Cancel request", cancelLabel: "Keep it" }))) return;
    await run("Cancelling…", async () => { const { error } = await supabase.rpc("cancel_instructor_withdrawal", { p_id: id }); if (error) throw error; await load(); }, { success: "Request cancelled" });
  };
  const openClass = async (e: any) => { setCls(e); setLines(undefined); const { data } = await supabase.rpc("instructor_earning_breakdown", { p_session_id: e.id }); setLines((data as any[]) ?? []); };

  if (w === undefined) return <div className="space-y-4"><PageHeader title="Wallet" /><Skeleton className="h-28" /><Skeleton className="h-40" /></div>;
  if (w === null) return <div className="space-y-4"><PageHeader title="Wallet" /><Err>{err}</Err></div>;
  const po = m?.withdrawal; const open = po && (po.status === "draft" || po.status === "processing");

  return (
    <div className="space-y-5">
      <PageHeader title="Wallet" sub="What you earn from the classes you teach" />
      {months.length > 1 && <ChipRow>{months.map((x) => <Chip key={x} on={month === x} onClick={() => setMonth(x)}>{x === thisMonth ? "This month" : monthLabel(x)}</Chip>)}</ChipRow>}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <Stat compact tone="ok" label={month === thisMonth ? "Earned this month" : `Earned in ${month ? monthLabel(month).split(" ")[0] : ""}`} value={naira(m?.earned ?? 0)} />
        <Stat compact tone="bad" label="Deducted" value={m?.reversals ? "−" + naira(m.reversals) : naira(0)} sub="Attendance changes" />
        <Stat compact tone="info" label={m && m.available < 0 ? "To be offset" : "Available"} value={naira(Math.abs(m?.available ?? 0))} sub={m && m.available < 0 ? "Deductions exceed earnings" : "Yours to withdraw"} />
        <Stat compact label="All time" value={naira(w.lifetime)} sub={`${naira(w.paid_out)} withdrawn`} />
      </div>
      {w.unfunded > 0 && <p className="rounded-xl bg-warn/10 px-3.5 py-2.5 text-[13px] leading-snug text-warn">{naira(w.unfunded)} is waiting for a student's next instalment. It joins your earnings automatically when they pay.</p>}

      {m && <Section title={monthLabel(m.month)}>
        <Card className="space-y-2.5 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><p className="num text-xl font-semibold">{naira(m.available)}</p>
              <p className="text-[13px] text-muted">{m.withdrawn ? `${naira(m.withdrawn)} already withdrawn` : "Available to withdraw"}</p></div>
            {po && <Badge tone={STATUS[po.status]?.[1] ?? "muted"}>{STATUS[po.status]?.[0] ?? po.status}</Badge>}
          </div>
          {po?.status === "draft"
            ? <div className="flex items-center justify-between gap-3"><p className="text-[13px] text-muted">Waiting for approval.</p><button className="text-sm font-medium text-accent" onClick={() => cancel(po.id)}>Cancel</button></div>
            : po?.status === "processing" ? <p className="text-[13px] text-muted">Approved. It's on its way to your bank.</p>
            : <>
                <Button className="h-10 w-full text-sm" disabled={!m.can_withdraw} onClick={withdraw}>Withdraw {m.available > 0 ? naira(m.available) : ""}</Button>
                <p className="text-[13px] text-muted">
                  {m.available <= 0 ? "Nothing to withdraw yet."
                    : !w.account?.ready ? <>Add your bank account to withdraw. <button className="font-medium text-accent" onClick={() => setBank(true)}>Add account</button></>
                    : w.min_payout > m.available ? `The smallest withdrawal is ${naira(w.min_payout)}.`
                    : !m.can_withdraw ? `Opens ${niceDay(m.opens_on)}, when the month ends.`
                    : "You can also leave it here and withdraw later."}</p>
              </>}
          {!open && w.account?.ready && <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5"><p className="min-w-0 truncate text-[13px] text-muted">{w.account.bank_name} ••{w.account.account_last4} · {w.account.account_name}</p><button className="shrink-0 text-sm font-medium text-accent" onClick={() => setBank(true)}>Change</button></div>}
        </Card>
      </Section>}

      <Section title="Earnings">
        {!earn ? <Skeleton className="h-20" /> : earn.length === 0 ? <Empty icon="receipt" title="No earnings yet." hint="Earnings appear here after a class you taught is finished and attendance is final." />
          : <div className="space-y-2">{earn.map((e) => e.kind === "class" ? (
            <Card key={e.id} onClick={() => openClass(e)} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0"><p className="truncate font-medium">{e.course}</p><p className="truncate text-sm text-muted">{e.centre}{e.city ? ` · ${e.city}` : ""} · {fmtDay(e.day, { day: "numeric", month: "short" })} · {e.students} student{e.students === 1 ? "" : "s"}</p></div>
              <p className="num shrink-0 font-semibold">{naira(e.amount)}</p>
            </Card>) : (
            <Card key={e.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0"><p className="font-medium">Adjustment</p><p className="text-sm text-muted">{e.note} · {fmtDay(e.day, { day: "numeric", month: "short" })}</p></div>
              <p className="num shrink-0 font-semibold">{e.amount < 0 ? "−" : ""}{naira(Math.abs(e.amount))}</p>
            </Card>))}</div>}
      </Section>

      <Section title="Withdrawals">
        {!wd ? <Skeleton className="h-16" /> : wd.length === 0 ? <Empty icon="receipt" title="No withdrawals yet." />
          : <div className="space-y-2">{wd.map((x) => (
            <Card key={x.id} className="space-y-1 py-3">
              <div className="flex items-start justify-between gap-3"><div><p className="num font-semibold">{naira(x.amount)}</p><p className="text-sm text-muted">{monthLabel(x.eligible_through)} · asked {fmtWhen(x.created_at, { dateStyle: "medium" })}</p></div><Badge tone={STATUS[x.status]?.[1] ?? "muted"}>{STATUS[x.status]?.[0] ?? x.status}</Badge></div>
              {x.reject_reason && <p className="text-sm text-bad">{x.reject_reason}</p>}
              {x.failure_reason && <p className="text-sm text-bad">{x.failure_reason}. The money is back in your balance.</p>}
              {x.status === "paid" && <p className="text-xs text-muted">Sent {x.paid_at ? fmtWhen(x.paid_at, { dateStyle: "medium" }) : ""} · reference {x.reference}</p>}
            </Card>))}</div>}
      </Section>

      <Sheet open={!!cls} onClose={() => setCls(null)} title={cls?.course ?? "Class earnings"}>
        {cls && <div className="max-h-[70vh] space-y-3 overflow-y-auto">
          <p className="text-sm text-muted">{cls.centre} · {fmtDay(cls.day, { day: "numeric", month: "long" })}</p>
          {!lines ? <Skeleton className="h-20" /> : lines.length === 0 ? <Empty title="No students counted." /> : lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-3.5 py-3">
              <div className="min-w-0"><p className="truncate font-medium">{l.name}</p><p className="text-[13px] text-muted">Class {l.lesson_no} of {l.classes} · {l.rate_bp / 100}% of {naira(Math.round(l.course_tuition / l.classes))}</p></div>
              <p className="num shrink-0 font-semibold">{naira(l.amount)}</p>
            </div>))}
          <div className="flex items-center justify-between border-t border-line pt-3"><p className="font-medium">Total</p><p className="num text-lg font-semibold">{naira(cls.amount)}</p></div>
        </div>}
      </Sheet>
      <BankAccountSheet open={bank} onClose={() => setBank(false)} target={{ kind: "instructor" }} onSaved={load} />
    </div>
  );
}
