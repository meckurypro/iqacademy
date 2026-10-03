import { useCallback, useEffect, useState } from "react";
import { supabase, naira } from "../lib/supabase";
import { Badge, Button, Card, Err, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Payouts() {
  const [rows, setRows] = useState<any[]>(); const [busy, setBusy] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const load = useCallback(async () => { const { data } = await supabase.from("payouts").select("id,amount,status,reference,period_start,period_end,paid_at,failure_reason,centres(name)").order("created_at", { ascending: false }).limit(50); setRows(data ?? []); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (key: string, body: object) => {
    setBusy(key); setErr(""); setMsg("");
    const { data, error } = await supabase.functions.invoke("process-payouts", { body });
    setBusy(""); if (error || data?.error) setErr(data?.detail ?? data?.error ?? "Something went wrong.");
    else setMsg(data.message ?? (data.drafts_created !== undefined ? `${data.drafts_created} draft payout(s) prepared.` : "Done."));
    load();
  };
  const tone = (s: string) => (s === "paid" ? "ok" : s === "failed" ? "bad" : s === "processing" ? "warn" : "muted") as "ok" | "bad" | "warn" | "muted";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Payouts</h1><Button className="h-10" loading={busy === "d"} onClick={() => act("d", { action: "create_drafts" })}>Prepare payouts</Button></div>
      <p className="text-sm text-muted">Review each draft, then send it. Centres are paid their share of tuition straight to their bank account.</p>
      {msg && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{msg}</p>}<Err>{err}</Err>
      {!rows ? <Skeleton className="h-24" /> : rows.length === 0 ? <Card className="text-center text-muted">No payouts yet.</Card> : rows.map((p) => (
        <Card key={p.id} className="space-y-2"><div className="flex items-start justify-between"><div><p className="num text-xl font-semibold">{naira(p.amount)}</p><p className="text-sm text-muted">{p.centres?.name}</p></div><Badge tone={tone(p.status)}>{p.status}</Badge></div>
          {p.failure_reason && <p className="text-sm text-bad">{p.failure_reason}</p>}
          {p.status === "draft" && <div className="flex gap-2"><Button className="h-10 flex-1" loading={busy === p.id} onClick={() => { if (confirm(`Send ${naira(p.amount)} to ${p.centres?.name}?`)) act(p.id, { action: "send", payout_id: p.id }); }}>Send {naira(p.amount)}</Button>
            <Button variant="secondary" className="h-10" onClick={() => act("x" + p.id, { action: "cancel", payout_id: p.id })}>Cancel</Button></div>}</Card>))}
    </div>
  );
}
