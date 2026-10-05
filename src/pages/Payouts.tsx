import { useCallback, useEffect, useState } from "react";
import Place from "../components/Place";
import { placeLabel } from "../lib/centre";
import { supabase, naira, UserMessage } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Skeleton } from "../components/ui";
import { fmtDay } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Payouts() {
  const { run, confirm } = useFeedback();
  const [rows, setRows] = useState<any[]>(); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const load = useCallback(async () => { const { data } = await supabase.from("payouts").select("id,amount,status,reference,period_start,period_end,period_month,paid_at,failure_reason,centres(name,city,address)").order("created_at", { ascending: false }).limit(50); setRows(data ?? []); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (label: string, body: object) => {
    setErr(""); setMsg("");
    const r = await run(label, async () => {
      try {
        const { data, error } = await supabase.functions.invoke("process-payouts", { body });
        if (error || data?.error) throw new UserMessage(data?.detail ?? data?.error ?? "Something went wrong.");
        return data;
      } finally { await load(); }
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setMsg(r.data.message ?? (r.data.drafts_created !== undefined ? `${r.data.drafts_created} draft payout(s) prepared.` : "Done."));
  };
  const send = async (p: any) => { if (await confirm({ title: `Send ${naira(p.amount)} to ${p.centres ? placeLabel(p.centres) : "this centre"}?`, message: "The money is transferred to the centre's bank account. This can't be undone.", confirmLabel: "Send payout", danger: true })) act("Sending payout…", { action: "send", payout_id: p.id }); };
  const cancel = async (p: any) => { if (await confirm({ title: "Cancel this draft payout?", message: `The ${naira(p.amount)} draft for ${p.centres ? placeLabel(p.centres) : "this centre"} is discarded. The director can ask again.`, confirmLabel: "Cancel payout", cancelLabel: "Keep it", danger: true })) act("Cancelling payout…", { action: "cancel", payout_id: p.id }); };
  const tone = (s: string) => (s === "paid" ? "ok" : s === "failed" ? "bad" : s === "processing" ? "warn" : "muted") as "ok" | "bad" | "warn" | "muted";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Payouts</h1></div>
      <p className="text-sm text-muted">Directors ask to withdraw a month at a time. Review each request, then send it to the centre's bank account.</p>
      {msg && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{msg}</p>}<Err>{err}</Err>
      {!rows ? <Skeleton className="h-24" /> : rows.length === 0 ? <Card className="text-center text-muted">No payouts yet.</Card> : rows.map((p) => (
        <Card key={p.id} className="space-y-2"><div className="flex items-start justify-between"><div><p className="num text-xl font-semibold">{naira(p.amount)}</p><p className="text-sm text-muted">{p.centres && <Place centre={p.centres} nameOnly />}{p.period_month && ` · ${fmtDay(p.period_month, { month: "long", year: "numeric" })}`}</p></div><Badge tone={tone(p.status)}>{p.status}</Badge></div>
          {p.failure_reason && <p className="text-sm text-bad">{p.failure_reason}</p>}
          {p.status === "draft" && <div className="flex gap-2"><Button className="h-10 flex-1" onClick={() => send(p)}>Send {naira(p.amount)}</Button>
            <Button variant="secondary" className="h-10" onClick={() => cancel(p)}>Cancel</Button></div>}</Card>))}
    </div>
  );
}
