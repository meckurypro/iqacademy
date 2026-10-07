// src/pages/DirectorHome.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { place } from "../lib/centre";
import Place from "../components/Place";
import { supabase, naira } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Chip, ChipRow, List, Section, Skeleton, Stat } from "../components/ui";
import { useFeedback } from "../components/feedback";
import { fmtDay, fmtWhen } from "../lib/time";
/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sum = (a: any[], k: string) => a.reduce((n, x) => n + Number(x?.[k] ?? 0), 0);

// One account, any number of branches: pick a branch, or see them all together.
export default function DirectorHome() {
  const { roles } = useAuth();
  const ids = useMemo(() => [...new Set(roles.filter((r) => r.role === "centre_director" && r.centre_id).map((r) => r.centre_id as string))], [roles]);
  const [sel, setSel] = useState<string>("all");
  const { run, confirm } = useFeedback();
  const [ds, setDs] = useState<any[]>();
  const [inc, setInc] = useState<any[]>();
  const [month, setMonth] = useState("");
  const load = useCallback(async () => {
    if (!ids.length) return;
    const [d, i] = await Promise.all([
      Promise.all(ids.map((id) => supabase.rpc("centre_dashboard", { p_centre_id: id }))),
      Promise.all(ids.map((id) => supabase.rpc("centre_income_months", { p_centre_id: id }))),
    ]);
    setDs(d.map((r) => r.data).filter(Boolean)); setInc(i.map((r) => r.data).filter(Boolean));
  }, [ids]);
  useEffect(() => { setDs(undefined); setInc(undefined); load(); }, [load]);

  // Months a director may see: this month, last month, and older ones only while money is still waiting there.
  const months = useMemo(() => [...new Set((inc ?? []).flatMap((c) => (c.months ?? []).map((m: any) => m.month as string)))].sort().reverse(), [inc]);
  const thisMonth = inc?.[0]?.today ? String(inc[0].today).slice(0, 7) + "-01" : "";
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months.includes(thisMonth) ? thisMonth : months[0]); }, [months, month, thisMonth]);
  const monthLabel = (m: string) => fmtDay(m, { month: "long", year: "numeric" });
  const niceDay = (d: string) => fmtDay(d, { day: "numeric", month: "long" });
  const rows = useMemo(() => (inc ?? []).filter((c) => sel === "all" || c.centre_id === sel)
    .map((c) => ({ c, m: (c.months ?? []).find((x: any) => x.month === month), d: (ds ?? []).find((x) => x.centre?.id === c.centre_id) })).filter((r) => r.m), [inc, ds, sel, month]);

  const netOf = (id?: string) => { const m = (inc ?? []).find((c) => c.centre_id === id)?.months?.find((x: any) => x.month === month); return m ? Number(m.earned) - Number(m.refunds) + Number(m.adjustments) : 0; };
  const withdraw = async (centreId: string, label: string, m: any) => {
    if (!(await confirm({ title: `Withdraw ${naira(m.available)}?`, message: `Your ${monthLabel(m.month)} share${label ? ` from ${label}` : ""} will be sent to your bank account once we approve it. You can cancel until then.`, confirmLabel: "Withdraw" }))) return;
    await run("Requesting…", async () => { const { error } = await supabase.rpc("request_withdrawal", { p_centre_id: centreId, p_month: m.month }); if (error) throw error; await load(); }, { success: "Withdrawal requested" });
  };
  const cancelReq = async (id: string) => {
    if (!(await confirm({ title: "Cancel this withdrawal?", message: "The money stays in your balance. You can withdraw it again later.", confirmLabel: "Cancel request", cancelLabel: "Keep it" }))) return;
    await run("Cancelling…", async () => { const { error } = await supabase.rpc("cancel_withdrawal", { p_payout_id: id }); if (error) throw error; await load(); }, { success: "Request cancelled" });
  };

  const view = useMemo(() => (ds ? (sel === "all" ? ds : ds.filter((d) => d.centre?.id === sel)) : []), [ds, sel]);
  const days = [1, 2, 3, 4, 5, 6, 7].map((n) => sum(view.flatMap((d) => (d.by_weekday ?? []).filter((x: any) => x.day_of_week === n)), "students"));
  const maxDay = Math.max(1, ...days);
  const courses = useMemo(() => { const m = new Map<string, any>(); view.forEach((d) => (d.by_course ?? []).forEach((c: any) => m.set(c.course_id, { ...c, students: (m.get(c.course_id)?.students ?? 0) + c.students }))); return [...m.values()].sort((a, b) => b.students - a.students); }, [view]);
  const earned = rows.reduce((n, r) => n + Number(r.m.earned), 0);
  const refunds = rows.reduce((n, r) => n + Number(r.m.refunds), 0);
  const waiting = rows.reduce((n, r) => n + Number(r.m.available), 0);

  return (
    <div className="space-y-5">
      <div className="min-w-0"><h1 className="truncate text-[26px] leading-tight">{ids.length > 1 ? "Your branches" : view[0]?.centre ? place(view[0].centre) : "Your centre"}</h1>
        {ids.length === 1 && view[0]?.centre && place(view[0].centre) !== view[0].centre.name && <p className="truncate text-sm text-muted">{view[0].centre.name}</p>}
        <p className="text-sm text-muted">{view.length === 1 ? `Your share here: ${view[0].share_pct}% of student payments` : "Each branch has its own agreed share"}</p></div>

      {ids.length > 1 && <ChipRow>
        {[{ id: "all", name: "All branches" }, ...(ds ?? []).map((d) => ({ id: d.centre?.id, name: d.centre ? place(d.centre) : "" }))].map((c) => (
          <Chip key={c.id} on={sel === c.id} onClick={() => setSel(c.id)}>{c.name}</Chip>))}</ChipRow>}

      {months.length > 1 && <ChipRow>
        {months.map((m) => <Chip key={m} on={month === m} onClick={() => setMonth(m)}>{m === thisMonth ? "This month" : monthLabel(m)}</Chip>)}</ChipRow>}

      <div className="space-y-5">
      {!ds || !inc ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : <>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Stat compact tone="ok" label={month === thisMonth ? "Earned this month" : `Earned in ${month ? monthLabel(month).split(" ")[0] : ""}`} value={naira(earned)} />
          <Stat compact tone="bad" label="Refunds deducted" value={refunds ? "−" + naira(refunds) : naira(0)} sub="Reduce your share" />
          <Stat compact tone="info" label={waiting < 0 ? "To be offset" : "Available"} value={naira(Math.abs(waiting))} sub={waiting < 0 ? "Refunds exceed income" : "Yours to withdraw"} />
          <Stat compact label="Active students" value={sum(view, "students_active")} sub={`${sum(view, "students_total")} all time`} />
        </div>

        <Section title={month ? monthLabel(month) : "Income"}>
          {rows.map(({ c, m, d }) => {
            const po = m.payout; const label = ids.length > 1 && d?.centre ? place(d.centre) : "";
            return (
              <Card key={c.centre_id} className="space-y-2.5 p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">{label && <p className="truncate text-sm font-semibold">{label}</p>}
                    <p className="num text-xl font-semibold">{naira(m.available)}</p>
                    <p className="text-[13px] text-muted">{m.withdrawn ? `${naira(m.withdrawn)} already withdrawn` : "Available to withdraw"}</p></div>
                  {po && <Badge tone={po.status === "paid" ? "ok" : po.status === "failed" ? "bad" : "info"}>{po.status === "draft" ? "Requested" : po.status === "processing" ? "On its way" : po.status === "paid" ? "Paid" : po.status}</Badge>}
                </div>
                {po?.status === "draft"
                  ? <div className="flex items-center justify-between gap-3"><p className="text-[13px] text-muted">Waiting for approval.</p><button className="text-sm font-medium text-accent" onClick={() => cancelReq(po.id)}>Cancel</button></div>
                  : po?.status === "processing" ? <p className="text-[13px] text-muted">Approved. It's on its way to your bank.</p>
                  : <>
                      <Button className="h-10 w-full text-sm" disabled={!m.can_withdraw} onClick={() => withdraw(c.centre_id, label, m)}>Withdraw {m.available > 0 ? naira(m.available) : ""}</Button>
                      <p className="text-[13px] text-muted">
                        {m.available <= 0 ? "Nothing to withdraw yet."
                          : !c.account?.ready ? "Add your bank details with an admin first."
                          : !m.can_withdraw ? `Opens ${niceDay(m.opens_on)}, when the month ends.`
                          : "You can also leave it here and withdraw later."}</p>
                    </>}
              </Card>);
          })}
        </Section>

        {sel === "all" && ds.length > 1 && <Section title="By branch">
          <List>{ds.map((d) => (
            <button key={d.centre?.id} onClick={() => setSel(d.centre?.id)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-sunken/60 active:bg-sunken">
              <div className="min-w-0"><p className="truncate font-medium">{d.centre && <Place centre={d.centre} nameOnly />}</p><p className="truncate text-[13px] text-muted">{d.students_active} active · {d.share_pct}% share</p></div>
              <div className="shrink-0 text-right"><p className="num font-semibold">{naira(netOf(d.centre?.id))}</p><p className="text-[11px] text-muted">{month === thisMonth ? "net this month" : "net"}</p></div></button>))}</List></Section>}

        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Section title="Average attendance by day">
          <Card className="flex h-28 items-end gap-2 p-3.5">{days.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1"><span className="num text-[11px] text-muted">{v || ""}</span>
              <div className="w-full rounded-t-lg bg-accent/80 transition-all duration-700" style={{ height: `${(v / maxDay) * 52}px`, minHeight: v ? 6 : 2, opacity: v ? 1 : .2 }} /><span className="text-[11px] text-muted">{DAYS[i + 1]}</span></div>))}</Card>
          <p className="text-xs text-muted">Average students present per class, last 8 weeks.{days.every((v) => !v) ? " No classes held yet." : ""}</p>
        </Section>

        <Section title="Students by course">
          {courses.length === 0 ? <p className="text-sm text-muted">No active students yet.</p>
            : <List>{courses.map((c) => <div key={c.course_id} className="flex items-center justify-between gap-3 px-4 py-2.5"><p className="min-w-0 truncate">{c.title}</p><p className="num shrink-0 font-semibold">{c.students}</p></div>)}</List>}</Section>

        </div>

        {view.some((d) => (d.recent_refunds ?? []).length > 0) && <Section title="Recent refund deductions">
          <List>{view.flatMap((d) => d.recent_refunds ?? []).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5).map((r: any, i: number) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-2.5"><p className="min-w-0 truncate text-sm text-muted">{fmtWhen(r.created_at, { dateStyle: "short" })} · student refund</p><p className="num shrink-0 font-semibold text-bad">−{naira(r.share_deducted)}</p></div>))}</List></Section>}

        <Section title="Payouts">
          {view.every((d) => (d.recent_payouts ?? []).length === 0) ? <p className="text-sm text-muted">No payouts yet.</p>
            : <List>{view.flatMap((d) => (d.recent_payouts ?? []).map((p: any) => ({ ...p, centre: d.centre ? place(d.centre) : "" }))).sort((a, b) => String(b.paid_at ?? "").localeCompare(String(a.paid_at ?? ""))).slice(0, 8).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5"><div className="min-w-0"><p className="num font-medium">{naira(p.amount)}</p><p className="truncate text-[13px] text-muted">{ids.length > 1 ? `${p.centre} · ` : ""}{p.paid_at ? fmtWhen(p.paid_at, { dateStyle: "short" }) : "Pending"}</p></div>
                <Badge tone={p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : "warn"}>{p.status}</Badge></div>))}</List>}</Section>
      </>}
      </div>
    </div>
  );
}
