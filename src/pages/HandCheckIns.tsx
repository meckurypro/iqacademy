// src/pages/HandCheckIns.tsx — admin: every time someone was checked in by hand.
// Shows who did it and how (the student's PIN, or an admin's written reason), and which ones the student disputed, so misuse stands out.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Avatar, Badge, Card, cx, Empty, PageHeader, Skeleton } from "../components/ui";
import { fmtClock, fmtWhen } from "../lib/time";

type Row = { id: string; created_at: string; marker_id: string | null; marker_name: string; student_name: string; course_title: string | null; session_date: string | null;
  centre_name: string | null; method: "pin" | "admin_override"; override_reason: string | null; disputed: boolean };
const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"]] as const;

export default function HandCheckIns() {
  const [days, setDays] = useState<number>(30); const [rows, setRows] = useState<Row[] | null>(null); const [failed, setFailed] = useState(false);
  const [who, setWho] = useState<string | null>(null); const [only, setOnly] = useState<"all" | "disputed" | "override">("all");
  useEffect(() => {
    setRows(null); setFailed(false);
    supabase.rpc("admin_hand_check_ins", { p_days: days }).then((r) => { if (r.error) setFailed(true); else setRows((r.data as Row[]) ?? []); });
  }, [days]);

  const staff = useMemo(() => {
    const m = new Map<string, { id: string; name: string; total: number; overrides: number; disputed: number }>();
    for (const r of rows ?? []) {
      const k = r.marker_id ?? "none"; const e = m.get(k) ?? { id: k, name: r.marker_name, total: 0, overrides: 0, disputed: 0 };
      e.total++; if (r.method === "admin_override") e.overrides++; if (r.disputed) e.disputed++; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.disputed - a.disputed || b.total - a.total);
  }, [rows]);
  const shown = useMemo(() => (rows ?? []).filter((r) => (!who || (r.marker_id ?? "none") === who) && (only === "all" || (only === "disputed" ? r.disputed : r.method === "admin_override"))), [rows, who, only]);
  const disputed = rows?.filter((r) => r.disputed).length ?? 0; const overrides = rows?.filter((r) => r.method === "admin_override").length ?? 0;

  if (failed) return <Empty icon="alert" title="Couldn't load hand check-ins" hint="Check your connection and try again." />;
  return (
    <div className="space-y-5">
      <PageHeader title="Hand check-ins" sub="Students checked in without scanning. Each needs the student's PIN, or an admin's written reason." />

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]" role="tablist" aria-label="Period">
        {RANGES.map(([d, label]) => <button key={d} role="tab" aria-selected={days === d} onClick={() => setDays(d)}
          className={cx("shrink-0 rounded-full px-3.5 py-2 text-sm font-medium ring-1 transition active:scale-95", days === d ? "bg-accent/10 text-accent ring-accent/40" : "bg-surface text-muted ring-line")}>Last {label}</button>)}
      </div>

      {rows === null ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-32" /></div> : <>
        <div className="grid grid-cols-3 gap-3">
          {([["Total", rows.length, "text-ink", "all"], ["Admin overrides", overrides, "text-warn", "override"], ["Disputed", disputed, "text-bad", "disputed"]] as const).map(([label, n, tone, f]) => (
            <button key={label} onClick={() => setOnly(only === f ? "all" : f)} aria-pressed={only === f}
              className={cx("rounded-2xl bg-surface p-3.5 text-left shadow-card ring-1 transition active:scale-[.98]", only === f && f !== "all" ? "ring-2 ring-accent" : "ring-line")}>
              <p className={cx("num text-2xl font-semibold tracking-tight", n > 0 ? tone : "text-muted")}>{n}</p><p className="text-xs leading-tight text-muted">{label}</p></button>))}
        </div>

        {staff.length > 0 && <section className="space-y-2">
          <h2 className="px-1 text-sm font-semibold text-muted">By person {who && <button onClick={() => setWho(null)} className="ml-2 font-medium text-accent">Show everyone</button>}</h2>
          {staff.map((s) => (
            <Card key={s.id} onClick={() => setWho(who === s.id ? null : s.id)} className={cx("flex items-center gap-3 py-3", who === s.id && "ring-2 ring-accent")}>
              <Avatar name={s.name} size={36} />
              <div className="min-w-0 flex-1 leading-tight"><p className="truncate font-medium">{s.name}</p><p className="text-xs text-muted">{s.total} check-in{s.total === 1 ? "" : "s"}{s.overrides ? ` · ${s.overrides} override${s.overrides === 1 ? "" : "s"}` : ""}</p></div>
              {s.disputed > 0 && <Badge tone="bad">{s.disputed} disputed</Badge>}
            </Card>))}
        </section>}

        {shown.length === 0 ? <Empty icon="checkCircle" title={rows.length ? "Nothing matches" : "No hand check-ins"} hint={rows.length ? "Try another filter." : "Everyone in this period scanned the class code."} />
          : <section className="space-y-2">
            <h2 className="px-1 text-sm font-semibold text-muted">Check-ins</h2>
            {shown.map((r) => (
              <Card key={r.id} className={cx("space-y-1.5", r.disputed && "ring-bad/30")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 leading-tight"><p className="truncate font-medium">{r.student_name}</p>
                    <p className="truncate text-sm text-muted">{[r.course_title, r.centre_name].filter(Boolean).join(" · ")}</p></div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">{r.disputed && <Badge tone="bad">Disputed</Badge>}<Badge tone={r.method === "pin" ? "ok" : "warn"}>{r.method === "pin" ? "PIN" : "Admin override"}</Badge></div>
                </div>
                <p className="text-xs text-muted">By {r.marker_name} · {fmtWhen(r.created_at, { day: "numeric", month: "short" })}, {fmtClock(r.created_at)}</p>
                {r.override_reason && <p className="break-words rounded-xl bg-sunken px-3 py-2 text-sm leading-snug">{r.override_reason}</p>}
              </Card>))}
          </section>}
      </>}
    </div>
  );
}
