import { useCallback, useEffect, useState } from "react";
import Place from "../components/Place";
import { placeLabel } from "../lib/centre";
import { supabase, naira, friendly, UserMessage } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton, cx } from "../components/ui";

import Icon from "../components/Icon";
import { fmtWhen } from "../lib/time";
/* eslint-disable @typescript-eslint/no-explicit-any */
const tone = (s: string) => (s === "succeeded" || s === "paid" ? "ok" : s === "failed" ? "bad" : s.includes("refund") || s === "processing" ? "warn" : "muted") as "ok" | "bad" | "warn" | "muted";
const sel = "h-12 w-full rounded-xl bg-sunken px-4 outline-none";

export default function Payments() {
  const { run, confirm } = useFeedback();
  const [tab, setTab] = useState<"payments" | "refunds">("payments");
  const [rows, setRows] = useState<any[]>(); const [refs, setRefs] = useState<any[]>(); const [q, setQ] = useState("");
  const [p, setP] = useState<any>(null); const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  const [f, setF] = useState({ amt: "", why: "", cancel: false, method: "paystack", bank: "", acct: "", note: "", accName: "" });
  const [err, setErr] = useState(""); const [done, setDone] = useState("");

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from("payments").select("id,reference,amount,refunded_amount,status,paid_at,provider,centres(name,city,address),students(profiles(full_name))").in("status", ["succeeded", "partially_refunded", "refunded"]).order("paid_at", { ascending: false }).limit(100),
      supabase.from("refunds").select("id,amount,status,method,reason,failure_reason,created_at,account_name,account_last4,bank_name,centres(name,city,address),students(profiles(full_name))").order("created_at", { ascending: false }).limit(50),
    ]);
    setRows(a.data ?? []); setRefs(b.data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);
  const name = (x: any) => x.students?.profiles?.full_name ?? "Unknown";
  const shown = (rows ?? []).filter((x) => !q.trim() || (name(x) + x.reference + (x.centres ? placeLabel(x.centres) : "")).toLowerCase().includes(q.trim().toLowerCase()));
  const left = p ? p.amount - p.refunded_amount : 0;
  const kobo = Math.round(Number(f.amt || 0) * 100);

  const open = async (x: any) => {
    setP(x); setErr(""); setDone(""); setF({ amt: String((x.amount - x.refunded_amount) / 100), why: "", cancel: x.refunded_amount === 0, method: "paystack", bank: "", acct: "", note: "", accName: "" });
    if (!banks.length) { const r = await supabase.functions.invoke("paystack-create-recipient", { body: { action: "list_banks" } }); setBanks(r.data?.banks ?? []); }
  };
  const verify = async () => {
    setErr("");
    const r = await run("Verifying account…", () => supabase.functions.invoke("paystack-create-recipient", { body: { action: "resolve", bank_code: f.bank, account_number: f.acct } }), { quiet: true });
    if (!r.ok) return setErr(r.message);
    r.data.data?.account_name ? setF({ ...f, accName: r.data.data.account_name }) : setErr("Couldn't find that account. Check the bank and number.");
  };
  const send = async () => {
    setErr("");
    const paystack = f.method === "paystack";
    const yes = await confirm({
      title: paystack ? `Send ${naira(kobo)} to ${f.accName}?` : `Record a manual refund of ${naira(kobo)}?`,
      message: `${paystack ? "The money leaves your Paystack balance straight away. " : ""}${f.cancel ? "Their enrolment will also be cancelled." : "Their enrolment stays active."} This can't be undone.`,
      confirmLabel: paystack ? "Send refund" : "Record refund", danger: true,
    });
    if (!yes) return;
    const r = await run(paystack ? "Sending refund…" : "Recording refund…", async () => {
      if (paystack) {
        const { data, error } = await supabase.functions.invoke("process-refund", { body: { payment_id: p.id, amount: kobo, reason: f.why || null, cancel_enrolment: f.cancel, bank_code: f.bank, account_number: f.acct } });
        if (error || data?.error) throw new UserMessage(data?.detail ?? (data?.error?.includes?.("invalid_refund_amount") ? "That's more than can still be refunded." : data?.error) ?? "Something went wrong.");
        await load();
        return data.message as string;
      }
      const bankName = banks.find((b) => b.code === f.bank)?.name ?? null;
      const { error } = await supabase.rpc("record_manual_refund", { p_payment_id: p.id, p_amount: kobo, p_reason: f.why || null, p_cancel_enrolment: f.cancel, p_note: f.note || null, p_bank_name: bankName, p_account_name: f.accName || null, p_account_last4: f.acct ? f.acct.slice(-4) : null });
      if (error) throw error.message.includes("invalid_refund_amount") ? new UserMessage("That's more than can still be refunded.") : error;
      await load();
      return "Refund recorded. The student and the centre have been updated.";
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setDone(r.data);
  };
  const ready = kobo > 0 && kobo <= left && (f.method === "manual" ? f.note.trim().length > 2 : !!f.accName);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Payments & refunds</h1>
      <div className="flex gap-1 rounded-2xl bg-sunken p-1">{(["payments", "refunds"] as const).map((t) => (
        <button key={t} onClick={() => setTab(t)} className={cx("h-10 flex-1 rounded-xl text-sm font-medium capitalize transition", tab === t ? "bg-surface shadow-card" : "text-muted")}>{t}</button>))}</div>

      {tab === "payments" && <>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by student, centre or reference" className="h-12 w-full rounded-2xl bg-surface px-4 shadow-card outline-none ring-1 ring-line focus:ring-2 focus:ring-accent/50" />
        {!rows ? <Skeleton className="h-20" /> : shown.length === 0 ? <Card className="text-center text-muted">No payments found.</Card> : shown.map((x) => (
          <Card key={x.id} onClick={() => open(x)} className="anim-fade flex items-center justify-between gap-3 py-3">
            <div className="min-w-0"><p className="truncate font-medium">{name(x)}</p><p className="truncate text-sm text-muted">{x.centres && <Place centre={x.centres} nameOnly />} · {x.paid_at ? fmtWhen(x.paid_at, { dateStyle: "short" }) : ""} · {x.provider}</p></div>
            <div className="text-right"><p className="num font-semibold">{naira(x.amount)}</p>{x.refunded_amount > 0 ? <Badge tone="warn">−{naira(x.refunded_amount)} refunded</Badge> : <Badge tone={tone(x.status)}>{x.status}</Badge>}</div></Card>))}</>}

      {tab === "refunds" && (!refs ? <Skeleton className="h-20" /> : refs.length === 0 ? <Card className="text-center text-muted">No refunds yet.</Card> : refs.map((r) => (
        <Card key={r.id} className="space-y-1 py-3"><div className="flex items-start justify-between"><div><p className="font-medium">{name(r)}</p><p className="text-sm text-muted">{r.centres && <Place centre={r.centres} nameOnly />} · {fmtWhen(r.created_at, { dateStyle: "short" })} · {r.method === "paystack" ? "Paystack" : "Manual"}</p></div>
          <div className="text-right"><p className="num font-semibold">{naira(r.amount)}</p><Badge tone={tone(r.status)}>{r.status}</Badge></div></div>
          {r.account_name && <p className="text-xs text-muted">{r.bank_name} ••{r.account_last4} · {r.account_name}</p>}
          {r.failure_reason && <p className="text-sm text-bad">{r.failure_reason}</p>}</Card>)))}

      <Sheet open={!!p} onClose={() => setP(null)} title="Refund a student">
        {p && (done ? <div className="space-y-4 py-4 text-center"><div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div><p>{done}</p><Button className="w-full" onClick={() => setP(null)}>Done</Button></div> :
          <div className="max-h-[75vh] space-y-4 overflow-y-auto">
            <div><p className="font-medium">{name(p)}</p><p className="text-sm text-muted">Paid {naira(p.amount)} · {p.centres && <Place centre={p.centres} nameOnly />}</p></div>
            {left <= 0 ? <p className="text-muted">This payment has already been fully refunded.</p> : <>
              <Field label={`Amount to refund (₦, up to ${left / 100})`} type="number" inputMode="decimal" min="1" max={left / 100} value={f.amt} onChange={(e) => setF({ ...f, amt: e.target.value })} />
              <Field label="Reason" value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} placeholder="Optional" />
              <label className="flex items-center gap-3 rounded-xl bg-sunken p-3 text-sm"><input type="checkbox" checked={f.cancel} onChange={(e) => setF({ ...f, cancel: e.target.checked })} className="h-5 w-5 accent-[rgb(var(--accent))]" />Also cancel their enrolment (removes access to classes)</label>
              <div className="grid grid-cols-2 gap-2">{[["paystack", "Pay with Paystack"], ["manual", "I paid manually"]].map(([m, l]) => (
                <button key={m} onClick={() => setF({ ...f, method: m })} className={cx("h-11 rounded-xl text-sm font-medium transition", f.method === m ? "bg-accent text-accent-ink" : "bg-sunken")}>{l}</button>))}</div>
              <p className="text-sm text-muted">Collect the student's bank details. {f.method === "manual" ? "Optional for manual refunds, but keep a note of how you paid." : "We verify the account name before any money moves."}</p>
              <select className={sel} value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value, accName: "" })}><option value="">{banks.length ? "Bank…" : "Loading banks…"}</option>{banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select>
              <Field label="Account number" inputMode="numeric" maxLength={10} value={f.acct} onChange={(e) => setF({ ...f, acct: e.target.value.replace(/\D/g, ""), accName: "" })} />
              {f.accName && <p className="flex items-center gap-2 rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok"><Icon name="check" size={16} className="shrink-0" />{f.accName}</p>}
              {f.method === "manual" && <Field label="How you paid" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. GTB transfer, ref 123456" />}
              <p className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">The centre's share of this refund is deducted from their next payout, and the student and centre are notified.</p>
              <Err>{err}</Err>
              {f.method === "paystack" && !f.accName ? <Button className="w-full" disabled={!f.bank || f.acct.length !== 10 || !(kobo > 0 && kobo <= left)} onClick={verify}>Verify account</Button>
                : <Button className="w-full" disabled={!ready} onClick={send}>{f.method === "paystack" ? `Send ${naira(kobo)} to ${f.accName.split(" ")[0]}` : `Record manual refund of ${naira(kobo)}`}</Button>}
            </>}
          </div>)}
      </Sheet>
    </div>
  );
}
