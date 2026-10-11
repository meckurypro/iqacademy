// src/pages/AdminHome.tsx
import { useEffect, useState } from "react";
import RunReminder from "../components/RunReminder";
import { supabase, naira } from "../lib/supabase";
import { List, NavRow, PageHeader, Skeleton, Stat, Main, Rail, Split } from "../components/ui";

export default function AdminHome() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [d, setD] = useState<any>();
  const [off, setOff] = useState<{ open: number; with_receipt: number }>({ open: 0, with_receipt: 0 });
  const [cash, setCash] = useState<{ to_review: number; holding: number }>({ to_review: 0, holding: 0 });
  useEffect(() => { supabase.rpc("admin_cash_counts").then((r) => r.data && setCash(r.data as { to_review: number; holding: number })); }, []);
  useEffect(() => { supabase.rpc("admin_overview").then((r) => setD(r.data ?? {})); supabase.rpc("offline_payment_counts").then((r) => r.data && setOff(r.data as { open: number; with_receipt: number })); }, []);
  if (!d) return <div className="space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  const st = d.enrolments_by_status ?? {};
  return (
    <div className="space-y-6">
      <PageHeader title="Overview" />
      <Split><Rail>
      {off.open > 0 && (
        <List><NavRow to="/offline-payments" icon="cash" tone="warn" title={`${off.open} offline ${off.open === 1 ? "payment" : "payments"} to review`} hint={`${off.with_receipt} with a receipt uploaded`} /></List>)}
      {(cash.to_review > 0 || cash.holding > 0) && (
        <List><NavRow to="/cash" icon="cash" tone="warn" title={cash.to_review > 0 ? `${cash.to_review} cash ${cash.to_review === 1 ? "transfer" : "transfers"} to review` : "You are holding cash"} hint={cash.holding > 0 ? `You hold ${naira(cash.holding)} from centres` : "Check the receipt, then approve"} /></List>)}
      <RunReminder />
      </Rail><Main>
      <div className="grid grid-cols-2 gap-3">
        <Stat tone="ok" label="Revenue this month" value={naira(d.revenue_this_month ?? 0)} />
        <Stat tone="warn" label="Outstanding" value={naira(d.outstanding_balances ?? 0)} />
        <Stat tone="info" label="Students" value={d.students_total ?? 0} sub={`${st.active ?? 0} active · ${st.pending_payment ?? 0} unpaid`} />
        <Stat label="Classes today" value={d.sessions_today ?? 0} />
      </div>
      <Stat label="Owed to centres" value={naira(d.owed_to_centres ?? 0)} />
      </Main></Split>
    </div>
  );
}
