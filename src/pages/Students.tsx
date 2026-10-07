// src/pages/Students.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase, naira, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useStaffCentres } from "../lib/useStaffCentres";
import { Avatar, Badge, Card, Empty, Err, PageHeader, Section, Skeleton, Stat, cx } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "info" }> = {
  active: { label: "Active", tone: "ok" }, pending_payment: { label: "Unpaid", tone: "warn" }, completed: { label: "Completed", tone: "info" },
};
const chip = (on: boolean) => cx("shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95", on ? "bg-accent text-accent-ink" : "bg-sunken");

// The centre's view of its students: who they are, what they are enrolled in, whether they are paid up and how often they attend.
// Contact details, birth dates, addresses and learning progress stay with IQ Academy; the database never sends them to the centre.
export default function Students() {
  const { shown, centres, sel, setSel, ids, isDirector } = useStaffCentres();
  const [rows, setRows] = useState<any[]>();
  const [err, setErr] = useState("");
  const [q, setQ] = useState(""); const [weeks, setWeeks] = useState(0); const [status, setStatus] = useState("all");

  useEffect(() => {
    if (!shown.length) { setRows(centres ? [] : undefined); return; }
    setRows(undefined); setErr("");
    Promise.all(shown.map((id) => supabase.rpc("centre_students", { p_centre_id: id }))).then((rs) => {
      const bad = rs.find((r) => r.error); if (bad?.error) setErr(friendly(bad.error));
      setRows(rs.flatMap((r, i) => ((r.data as any[]) ?? []).map((x) => ({ ...x, centre_id: shown[i] }))));
    });
  }, [shown, centres]);

  const name = (id: string) => { const c = centres?.find((x) => x.id === id); return c ? place(c) : ""; };
  const list = useMemo(() => (rows ?? []).filter((r) => {
    const t = q.trim().toLowerCase();
    return (!t || r.full_name?.toLowerCase().includes(t) || r.student_number?.toLowerCase().includes(t))
      && (!weeks || r.duration_weeks === weeks) && (status === "all" || r.status === status);
  }), [rows, q, weeks, status]);
  const count = (f: (r: any) => boolean) => (rows ?? []).filter(f).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Students" sub="Everyone enrolled at your centre" />
      {ids.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ id: "all", name: "All branches" }, ...(centres ?? []).map((c) => ({ id: c.id, name: place(c) }))].map((c) => (
          <button key={c.id} onClick={() => setSel(c.id)} className={chip(sel === c.id)}>{c.name}</button>))}</div>}
      <Err>{err}</Err>
      {!rows ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-40" /></div> : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Active" tone="ok" value={count((r) => r.status === "active")} />
          <Stat label="Unpaid" tone="warn" value={count((r) => r.status === "pending_payment")} />
          <Stat label="6-week bundle" value={count((r) => r.duration_weeks === 6)} />
          <Stat label="10-week bundle" value={count((r) => r.duration_weeks === 10)} />
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or registration number" className="h-12 w-full rounded-xl bg-surface px-4 ring-1 ring-line outline-none transition focus:ring-2 focus:ring-accent/60" />
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {([[0, "All bundles"], [6, "6 weeks"], [10, "10 weeks"]] as const).map(([w, l]) => <button key={w} onClick={() => setWeeks(w)} className={chip(weeks === w)}>{l}</button>)}
          <span className="w-2 shrink-0" />
          {([["all", "Any status"], ["active", "Active"], ["pending_payment", "Unpaid"], ["completed", "Completed"]] as const).map(([s, l]) => <button key={s} onClick={() => setStatus(s)} className={chip(status === s)}>{l}</button>)}
        </div>
        <Section title="Student list" aside={<span className="num">{list.length}</span>}>
          {list.length === 0 ? <Empty icon="users" title={rows.length ? "No one matches that." : "No students yet."} hint={rows.length ? undefined : "Students appear here when they register at your centre."} /> :
            <div className="grid gap-3 xl:grid-cols-2">{list.map((r) => { const s = STATUS[r.status] ?? { label: r.status, tone: "info" as const }; return (
              <Card key={r.enrolment_id} className="space-y-2 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={r.full_name ?? "?"} url={r.avatar_url} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.full_name}</p>
                    <p className="truncate text-sm text-muted"><span className="num">{r.student_number ?? "No number yet"}</span>{ids.length > 1 && sel === "all" ? ` · ${name(r.centre_id)}` : ""}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <p className="text-sm">{r.pack ?? "Bundle"}{r.duration_weeks ? ` · ${r.duration_weeks} weeks` : ""}</p>
                <p className="text-sm text-muted">{(r.courses ?? []).join(" · ")}</p>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted">Attended <span className="num font-medium text-ink">{r.attended}</span> of <span className="num">{r.total_sessions}</span> classes</span>
                  {isDirector && r.total_amount != null && <span className="text-muted"><span className="num font-medium text-ink">{naira(r.amount_paid)}</span> of <span className="num">{naira(r.total_amount)}</span> paid{r.balance > 0 ? ` · ${naira(r.balance)} left` : ""}</span>}
                </div>
              </Card>); })}</div>}
        </Section>
      </>}
    </div>
  );
}
