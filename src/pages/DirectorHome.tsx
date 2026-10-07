import { useCallback, useEffect, useMemo, useState } from "react";
import { place } from "../lib/centre";
import Place from "../components/Place";
import { supabase, naira } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, List, NavRow, Section, Skeleton, Stat, cx } from "../components/ui";
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
    <div className="space-y-6">
      <div><h1 className="text-[26px] leading-tight">{ids.length > 1 ? "Your branches" : view[0]?.centre ? place(view[0].centre) : "Your centre"}</h1>
        {ids.length === 1 && view[0]?.centre && place(view[0].centre) !== view[0].centre.name && <p className="text-sm text-muted">{view[0].centre.name}</p>}
        <p className="text-muted">{view.length === 1 ? `Your share here: ${view[0].share_pct}% of student payments` : "Each branch has its own agreed share"}</p></div>

      {ids.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ id: "all", name: "All branches" }, ...(ds ?? []).map((d) => ({ id: d.centre?.id, name: d.centre ? place(d.centre) : "" }))].map((c) => (
          <button key={c.id} onClick={() => setSel(c.id)} className={cx("shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95", sel === c.id ? "bg-accent text-accent-ink" : "bg-sunken")}>{c.name}</button>))}</div>}

      {months.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {months.map((m) => (
          <button key={m} onClick={() => setMonth(m)} className={cx("shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95", month === m ? "bg-accent text-accent-ink" : "bg-sunken")}>
            {m === thisMonth ? "This month" : monthLabel(m)}</button>))}</div>}

      <div className="space-y-6">
      {!ds || !inc ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : <>
        <div className="grid grid-cols-2 gap-3">
          <Stat tone="ok" label={month === thisMonth ? "Earned this month" : `Earned in ${month ? monthLabel(month).split(" ")[0] : ""}`} value={naira(earned)} />
          <Stat tone="bad" label="Refunds deducted" value={refunds ? "−" + naira(refunds) : naira(0)} sub="Student refunds reduce your share" />
          <Stat tone="info" label={waiting < 0 ? "To be offset" : "Available"} value={naira(Math.abs(waiting))} sub={waiting < 0 ? "Refunds are higher than income" : "Yours to withdraw"} />
          <Stat label="Active students" value={sum(view, "students_active")} sub={`${sum(view, "students_total")} all time`} />
        </div>

        <Section title={month ? monthLabel(month) : "Income"}>
          {rows.map(({ c, m, d }) => {
            const po = m.payout; const label = ids.length > 1 && d?.centre ? place(d.centre) : "";
            return (
              <Card key={c.centre_id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">{label && <p className="font-semibold">{label}</p>}
                    <p className="num text-2xl font-semibold">{naira(m.available)}</p>
                    <p className="text-sm text-muted">{m.withdrawn ? `${naira(m.withdrawn)} already withdrawn` : "Available to withdraw"}</p></div>
                  {po && <Badge tone={po.status === "paid" ? "ok" : po.status === "failed" ? "bad" : "info"}>{po.status === "draft" ? "Requested" : po.status === "processing" ? "On its way" : po.status === "paid" ? "Paid" : po.status}</Badge>}
                </div>
                {po?.status === "draft"
                  ? <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted">Waiting for approval.</p><button className="text-sm font-medium text-accent" onClick={() => cancelReq(po.id)}>Cancel</button></div>
                  : po?.status === "processing" ? <p className="text-sm text-muted">Approved. It's on its way to your bank.</p>
                  : <>
                      <Button className="w-full" disabled={!m.can_withdraw} onClick={() => withdraw(c.centre_id, label, m)}>Withdraw {m.available > 0 ? naira(m.available) : ""}</Button>
                      <p className="text-sm text-muted">
                        {m.available <= 0 ? "Nothing to withdraw yet."
                          : !c.account?.ready ? "Add your bank details with an admin first."
                          : !m.can_withdraw ? `Opens ${niceDay(m.opens_on)}, when the month ends.`
                          : "You can also leave it here and withdraw later."}</p>
                    </>}
              </Card>);
          })}
        </Section>

        {sel === "all" && ds.length > 1 && <Section title={"By branch"}>
          {ds.map((d) => <Card key={d.centre?.id} onClick={() => setSel(d.centre?.id)} className="flex items-center justify-between py-3">
            <div><p className="font-semibold">{d.centre && <Place centre={d.centre} nameOnly />}</p><p className="text-sm text-muted">{d.students_active} active · {d.share_pct}% share</p></div>
            <div className="text-right"><p className="num font-semibold">{naira(netOf(d.centre?.id))}</p><p className="text-xs text-muted">{month === thisMonth ? "net this month" : "net"}</p></div></Card>)}</Section>}

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Section title={"Students by day"}>
          <Card className="flex h-36 items-end gap-2">{days.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1"><span className="num text-xs text-muted">{v || ""}</span>
              <div className="w-full rounded-t-lg bg-accent/80 transition-all duration-700" style={{ height: `${(v / maxDay) * 80}px`, minHeight: v ? 6 : 2, opacity: v ? 1 : .2 }} /><span className="text-xs text-muted">{DAYS[i + 1]}</span></div>))}</Card></Section>

        <Section title={"Students by course"}>
          {courses.length === 0 ? <p className="text-muted">No active students yet.</p> : courses.map((c) => <Card key={c.course_id} className="flex justify-between py-3"><p>{c.title}</p><p className="num font-semibold">{c.students}</p></Card>)}</Section>

        </div>

        {view.some((d) => (d.recent_refunds ?? []).length > 0) && <Section title={"Recent refund deductions"}>
          {view.flatMap((d) => d.recent_refunds ?? []).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5).map((r: any, i: number) => (
            <Card key={i} className="flex items-center justify-between py-3"><p className="text-sm text-muted">{fmtWhen(r.created_at, { dateStyle: "short" })} · student refund</p><p className="num font-semibold text-bad">−{naira(r.share_deducted)}</p></Card>))}</Section>}

        <List><NavRow to="/team" icon="userPlus" title="My team" hint="Add or remove your centre's coordinators" /></List>

        <Section title={"Payouts"}>
          {view.flatMap((d) => (d.recent_payouts ?? []).map((p: any) => ({ ...p, centre: d.centre ? place(d.centre) : "" }))).sort((a, b) => String(b.paid_at ?? "").localeCompare(String(a.paid_at ?? ""))).slice(0, 8).map((p: any) => (
            <Card key={p.id} className="flex items-center justify-between py-3"><div><p className="num font-medium">{naira(p.amount)}</p><p className="text-sm text-muted">{ids.length > 1 ? `${p.centre} · ` : ""}{p.paid_at ? fmtWhen(p.paid_at, { dateStyle: "short" }) : "Pending"}</p></div>
              <Badge tone={p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : "warn"}>{p.status}</Badge></Card>))}
          {view.every((d) => (d.recent_payouts ?? []).length === 0) && <p className="text-muted">No payouts yet.</p>}</Section>
      </>}
      </div>
    </div>
  );
}
