// src/pages/Students.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase, naira, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useStaffCentres } from "../lib/useStaffCentres";
import { Avatar, Badge, Chip, ChipRow, Empty, Err, List, PageHeader, Section, Skeleton, StatStrip } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "info" }> = {
  active: { label: "Active", tone: "ok" }, pending_payment: { label: "Unpaid", tone: "warn" }, completed: { label: "Completed", tone: "info" },
};

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
    <div className="space-y-4">
      <PageHeader title="Students" sub="Everyone enrolled at your centre" />
      {ids.length > 1 && <ChipRow>
        {[{ id: "all", name: "All branches" }, ...(centres ?? []).map((c) => ({ id: c.id, name: place(c) }))].map((c) => (
          <Chip key={c.id} on={sel === c.id} onClick={() => setSel(c.id)}>{c.name}</Chip>))}</ChipRow>}
      <Err>{err}</Err>
      {!rows ? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-40" /></div> : <>
        <StatStrip items={[
          { label: "Active", value: count((r) => r.status === "active"), tone: "ok" },
          { label: "Unpaid", value: count((r) => r.status === "pending_payment"), tone: "warn" },
          { label: "6 weeks", value: count((r) => r.duration_weeks === 6) },
          { label: "10 weeks", value: count((r) => r.duration_weeks === 10) },
        ]} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or reg. number" className="h-10 w-full rounded-xl bg-surface px-3.5 text-[15px] ring-1 ring-line outline-none transition placeholder:text-muted/60 focus:ring-2 focus:ring-accent/60" />
        <ChipRow>
          {([[0, "All bundles"], [6, "6 weeks"], [10, "10 weeks"]] as const).map(([w, l]) => <Chip key={w} on={weeks === w} onClick={() => setWeeks(w)}>{l}</Chip>)}
          <span className="w-1 shrink-0" />
          {([["all", "Any status"], ["active", "Active"], ["pending_payment", "Unpaid"], ["completed", "Completed"]] as const).map(([s, l]) => <Chip key={s} on={status === s} onClick={() => setStatus(s)}>{l}</Chip>)}
        </ChipRow>
        <Section title="Student list" aside={<span className="num">{list.length}</span>}>
          {list.length === 0 ? <Empty icon="users" title={rows.length ? "No one matches that." : "No students yet."} hint={rows.length ? undefined : "Students appear here when they register at your centre."} /> :
            <List>{list.map((r) => { const s = STATUS[r.status] ?? { label: r.status, tone: "info" as const }; const pct = r.total_sessions ? Math.min(100, Math.round((r.attended / r.total_sessions) * 100)) : 0; return (
              <div key={r.enrolment_id} className="flex items-start gap-3 px-4 py-3">
                <Avatar name={r.full_name ?? "?"} url={r.avatar_url} size={36} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2"><p className="truncate font-medium leading-tight">{r.full_name}</p><Badge tone={s.tone}>{s.label}</Badge></div>
                  <p className="truncate text-[13px] text-muted"><span className="num">{r.student_number ?? "No number yet"}</span>{r.duration_weeks ? ` · ${r.duration_weeks} wk` : ""}{r.pack ? ` · ${r.pack}` : ""}{ids.length > 1 && sel === "all" ? ` · ${name(r.centre_id)}` : ""}</p>
                  {(r.courses ?? []).length > 0 && <p className="truncate text-xs text-muted">{(r.courses ?? []).join(" · ")}</p>}
                  <div className="flex items-center gap-2 pt-0.5">
                    <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-accent/80" style={{ width: `${pct}%` }} /></div>
                    <span className="num shrink-0 text-xs text-muted">{r.attended}/{r.total_sessions} classes</span>
                    {isDirector && r.total_amount != null && <span className="num ml-auto shrink-0 whitespace-nowrap text-xs text-muted">{r.balance > 0 ? `${naira(r.balance)} left` : "Paid in full"}</span>}
                  </div>
                </div>
              </div>); })}</List>}
        </Section>
      </>}
    </div>
  );
}
