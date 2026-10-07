// src/pages/Statement.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, naira, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useStaffCentres } from "../lib/useStaffCentres";
import { Badge, Card, Empty, Err, PageHeader, Section, Skeleton, Stat, cx } from "../components/ui";
import { fmtDay, fmtWhen } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
const KIND: Record<string, string> = { earning: "Your share", refund_reversal: "Refund deducted", adjustment: "Adjustment", payout: "Withdrawal paid", payout_reversal: "Withdrawal returned" };
const chip = (on: boolean) => cx("shrink-0 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95", on ? "bg-accent text-accent-ink" : "bg-sunken");

// Line-by-line record of a month: the page to open when a figure needs checking. Payment references only, never student names.
export default function Statement() {
  const { ids, centres } = useStaffCentres();
  const [cid, setCid] = useState(""); const [months, setMonths] = useState<string[]>(); const [month, setMonth] = useState("");
  const [st, setSt] = useState<any>(); const [err, setErr] = useState("");
  const centre = cid || ids[0] || "";

  useEffect(() => {
    if (!centre) return; setMonths(undefined); setSt(undefined);
    supabase.rpc("centre_income_months", { p_centre_id: centre }).then((r) => {
      if (r.error) setErr(friendly(r.error));
      const ms = ((r.data as any)?.months ?? []).map((m: any) => m.month as string);
      setMonths(ms); setMonth(ms[0] ?? "");
    });
  }, [centre]);

  const load = useCallback(async () => {
    if (!centre || !month) return; setSt(undefined); setErr("");
    const { data, error } = await supabase.rpc("centre_statement", { p_centre_id: centre, p_month: month });
    if (error) setErr(friendly(error)); setSt(data ?? { lines: [] });
  }, [centre, month]);
  useEffect(() => { load(); }, [load]);

  const sum = useMemo(() => {
    const L: any[] = st?.lines ?? []; const by = (...k: string[]) => L.filter((l) => k.includes(l.entry_type)).reduce((n, l) => n + Number(l.amount), 0);
    return { earned: by("earning"), refunds: -by("refund_reversal"), adjust: by("adjustment"), paid: -by("payout", "payout_reversal"), balance: L.reduce((n, l) => n + Number(l.amount), 0) };
  }, [st]);
  const monthLabel = (m: string) => fmtDay(m, { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">
      <PageHeader title="Statements" sub="Every payment and deduction behind your balance" />
      {ids.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {(centres ?? []).map((c) => <button key={c.id} onClick={() => setCid(c.id)} className={chip(centre === c.id)}>{place(c)}</button>)}</div>}
      {months && months.length > 1 && <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {months.map((m) => <button key={m} onClick={() => setMonth(m)} className={chip(month === m)}>{monthLabel(m)}</button>)}</div>}
      <Err>{err}</Err>
      {!st ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-40" /></div> : <>
        <div className="grid grid-cols-2 gap-3">
          <Stat tone="ok" label="Your share" value={naira(sum.earned)} />
          <Stat tone="bad" label="Refunds deducted" value={sum.refunds ? "−" + naira(sum.refunds) : naira(0)} />
          <Stat label="Withdrawn" value={naira(sum.paid)} />
          <Stat tone="info" label="Balance" value={naira(sum.balance)} />
        </div>
        {st.closed
          ? <Card className="space-y-1"><div className="flex items-center justify-between"><p className="font-medium">Month closed</p><Badge tone="ok">Frozen</Badge></div>
              <p className="text-sm text-muted">Closed {fmtWhen(st.closed.created_at, { dateStyle: "medium" })} with {st.closed.entry_count} entries and a closing balance of {naira(st.closed.closing_balance)}. Reference <span className="num">{String(st.closed.checksum).slice(0, 10)}</span>. Raise any question about this month within 7 days of month end.</p></Card>
          : <p className="text-sm text-muted">This month is still open. It is frozen automatically on the 1st.</p>}
        <Section title="Line by line" aside={<span className="num">{(st.lines ?? []).length}</span>}>
          {(st.lines ?? []).length === 0 ? <Empty icon="receipt" title="No entries this month." /> : <div className="space-y-2">{(st.lines as any[]).map((l, i) => (
            <Card key={i} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0"><p className="truncate font-medium">{KIND[l.entry_type] ?? l.entry_type}</p>
                <p className="truncate text-sm text-muted">{fmtWhen(l.created_at, { dateStyle: "medium" })} · {l.description}</p>
                {l.base_amount != null && l.share_pct != null && <p className="text-xs text-muted">{Number(l.share_pct)}% of {naira(Math.abs(Number(l.base_amount)))}</p>}</div>
              <p className={cx("num shrink-0 font-semibold", Number(l.amount) < 0 && "text-bad")}>{Number(l.amount) < 0 ? "−" : ""}{naira(Math.abs(Number(l.amount)))}</p>
            </Card>))}</div>}
        </Section>
      </>}
    </div>
  );
}
