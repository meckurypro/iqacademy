import { useEffect, useMemo, useState } from "react";
import { supabase, naira } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Link } from "react-router-dom";
import { Badge, Card, Skeleton, cx } from "../components/ui";
import { Stat } from "./InstructorHome";

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const sum = (a: any[], k: string) => a.reduce((n, x) => n + Number(x?.[k] ?? 0), 0);

// One account, any number of branches: pick a branch, or see them all together.
export default function DirectorHome() {
  const { roles } = useAuth();
  const ids = useMemo(() => [...new Set(roles.filter((r) => r.role === "centre_director" && r.centre_id).map((r) => r.centre_id as string))], [roles]);
  const [sel, setSel] = useState<string>("all");
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [ds, setDs] = useState<any[]>();
  useEffect(() => {
    if (!ids.length) return; setDs(undefined);
    const m = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-01`;
    Promise.all(ids.map((id) => supabase.rpc("centre_dashboard", { p_centre_id: id, p_month: m }))).then((rs) => setDs(rs.map((r) => r.data).filter(Boolean)));
  }, [ids, month]);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  const view = useMemo(() => (ds ? (sel === "all" ? ds : ds.filter((d) => d.centre?.id === sel)) : []), [ds, sel]);
  const days = [1, 2, 3, 4, 5, 6, 7].map((n) => sum(view.flatMap((d) => (d.by_weekday ?? []).filter((x: any) => x.day_of_week === n)), "students"));
  const maxDay = Math.max(1, ...days);
  const courses = useMemo(() => { const m = new Map<string, any>(); view.forEach((d) => (d.by_course ?? []).forEach((c: any) => m.set(c.course_id, { ...c, students: (m.get(c.course_id)?.students ?? 0) + c.students }))); return [...m.values()].sort((a, b) => b.students - a.students); }, [view]);
  const balance = sum(view, "balance_owed");

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl">{ids.length > 1 ? "Your branches" : view[0]?.centre?.name ?? "Your centre"}</h1>
        <p className="text-muted">{view.length === 1 ? `Your share here: ${view[0].share_pct}% of student payments` : "Each branch has its own agreed share"}</p></div>

      {ids.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ id: "all", name: "All branches" }, ...(ds ?? []).map((d) => ({ id: d.centre?.id, name: d.centre?.name }))].map((c) => (
          <button key={c.id} onClick={() => setSel(c.id)} className={cx("shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95", sel === c.id ? "bg-accent text-accent-ink" : "bg-sunken")}>{c.name}</button>))}</div>}

      <div className="flex items-center justify-between rounded-2xl bg-surface px-2 py-1 ring-1 ring-line">
        <button onClick={() => shift(-1)} className="h-10 w-10 rounded-full hover:bg-sunken">‹</button>
        <p className="font-medium">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
        <button onClick={() => shift(1)} className="h-10 w-10 rounded-full hover:bg-sunken">›</button></div>

      {!ds ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : <>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Earned this month" value={naira(sum(view, "earned_month"))} />
          <Stat label="Refunds deducted" value={sum(view, "refunds_month") ? "−" + naira(sum(view, "refunds_month")) : naira(0)} sub="Student refunds reduce your share" />
          <Stat label={balance < 0 ? "To be offset" : "Waiting to be paid"} value={naira(Math.abs(balance))} sub={balance < 0 ? "Carried into your next payout" : "Paid out monthly"} />
          <Stat label="Active students" value={sum(view, "students_active")} sub={`${sum(view, "students_total")} all time`} />
        </div>

        {sel === "all" && ds.length > 1 && <section className="space-y-2"><h2 className="text-lg">By branch</h2>
          {ds.map((d) => <Card key={d.centre?.id} onClick={() => setSel(d.centre?.id)} className="flex items-center justify-between py-3">
            <div><p className="font-medium">{d.centre?.name}</p><p className="text-sm text-muted">{d.students_active} active · {d.share_pct}% share</p></div>
            <div className="text-right"><p className="num font-semibold">{naira(d.earnings_month)}</p><p className="text-xs text-muted">net this month</p></div></Card>)}</section>}

        <section className="space-y-2"><h2 className="text-lg">Students by day</h2>
          <Card className="flex h-36 items-end gap-2">{days.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1"><span className="num text-xs text-muted">{v || ""}</span>
              <div className="w-full rounded-t-lg bg-accent/80 transition-all duration-700" style={{ height: `${(v / maxDay) * 80}px`, minHeight: v ? 6 : 2, opacity: v ? 1 : .2 }} /><span className="text-xs text-muted">{DAYS[i + 1]}</span></div>))}</Card></section>

        <section className="space-y-2"><h2 className="text-lg">Students by course</h2>
          {courses.length === 0 ? <p className="text-muted">No active students yet.</p> : courses.map((c) => <Card key={c.course_id} className="flex justify-between py-3"><p>{c.title}</p><p className="num font-semibold">{c.students}</p></Card>)}</section>

        {view.some((d) => (d.recent_refunds ?? []).length > 0) && <section className="space-y-2"><h2 className="text-lg">Recent refund deductions</h2>
          {view.flatMap((d) => d.recent_refunds ?? []).sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5).map((r: any, i: number) => (
            <Card key={i} className="flex items-center justify-between py-3"><p className="text-sm text-muted">{new Date(r.created_at).toLocaleDateString()} · student refund</p><p className="num font-semibold text-bad">−{naira(r.share_deducted)}</p></Card>))}</section>}

        <Link to="/team"><Card onClick={() => {}} className="flex items-center justify-between"><div><p className="font-medium">My team</p><p className="text-sm text-muted">Add or remove your centre's coordinators</p></div><span className="text-muted">›</span></Card></Link>

        <section className="space-y-2"><h2 className="text-lg">Payouts</h2>
          {view.flatMap((d) => (d.recent_payouts ?? []).map((p: any) => ({ ...p, centre: d.centre?.name }))).sort((a, b) => String(b.paid_at ?? "").localeCompare(String(a.paid_at ?? ""))).slice(0, 8).map((p: any) => (
            <Card key={p.id} className="flex items-center justify-between py-3"><div><p className="num font-medium">{naira(p.amount)}</p><p className="text-sm text-muted">{ids.length > 1 ? `${p.centre} · ` : ""}{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : "Pending"}</p></div>
              <Badge tone={p.status === "paid" ? "ok" : p.status === "failed" ? "bad" : "warn"}>{p.status}</Badge></Card>))}
          {view.every((d) => (d.recent_payouts ?? []).length === 0) && <p className="text-muted">No payouts yet.</p>}</section>
      </>}
    </div>
  );
}
