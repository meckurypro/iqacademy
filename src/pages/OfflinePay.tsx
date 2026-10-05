import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { sleep } from "../lib/db";
import { useAuth } from "../lib/auth";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Skeleton } from "../components/ui";
import { startPayment } from "./Enrol";
import { receiptUrl, sendReceipt, type MyOffline, type OfflineDetails } from "../lib/offline";

import Icon from "../components/Icon";
// The student's offline payment: what to pay, where, the reference to quote, and a place to send the receipt.
// An admin confirms it once the money has arrived; then the usual "Payment received" notice arrives and classes unlock.
export default function OfflinePay() {
  const { id } = useParams();
  const nav = useNavigate();
  const { session } = useAuth();
  const { run, toast, confirm } = useFeedback();
  const [row, setRow] = useState<MyOffline | null | undefined>();
  const [bank, setBank] = useState<OfflineDetails>({});
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const pick = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [m, d] = await Promise.all([supabase.rpc("my_offline_payments"), supabase.rpc("offline_payment_details")]);
    const mine = ((m.data as MyOffline[]) ?? []).find((x) => x.id === id) ?? null;
    setRow(mine); setBank((d.data as OfflineDetails) ?? {});
    setPreview(mine?.receipt ? await receiptUrl(mine.receipt.path) : null);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`, "ok"); } catch { toast("Couldn't copy. Select the text and copy it.", "bad"); }
  };

  const send = async () => {
    if (!file || !row || !session) return;
    setErr("");
    const r = await run("Sending your receipt…", async () => { await sendReceipt(row.id, session.user.id, file, note); await load(); },
      { success: "Receipt sent. We'll confirm your payment soon.", quiet: true });
    if (!r.ok) return setErr(r.message);
    setFile(null); setNote("");
  };

  const payOnline = async () => {
    if (!row?.instalment_id) return;
    const ok = await confirm({ title: "Pay online instead?", message: "This offline request will be cancelled and you'll go to secure online payment.", confirmLabel: "Pay online" });
    if (!ok) return;
    setErr("");
    const r = await run("Opening secure payment…", async () => {
      const { error } = await supabase.rpc("cancel_offline_request", { p_payment_id: row.id }); if (error) throw error;
      await startPayment(row.instalment_id!); await sleep(10000);
    }, { quiet: true });
    if (!r.ok) setErr(r.message);
  };

  const cancel = async () => {
    if (!row) return;
    const wholeRegistration = row.enrolment_status === "pending_payment";
    const ok = await confirm({
      title: wholeRegistration ? "Cancel this registration?" : "Cancel this payment request?",
      message: wholeRegistration ? "Your registration will be cancelled so you can start again. If you've already paid, don't cancel: wait for us to confirm." : "You can start another payment from your home screen.",
      confirmLabel: wholeRegistration ? "Cancel registration" : "Cancel request", cancelLabel: "Keep it", danger: true });
    if (!ok) return;
    const r = await run("Cancelling…", async () => {
      const { error } = wholeRegistration ? await supabase.rpc("cancel_enrolment", { p_enrolment_id: row.enrolment_id, p_reason: "Cancelled by student (offline payment)" })
        : await supabase.rpc("cancel_offline_request", { p_payment_id: row.id });
      if (error) throw error;
    }, { success: wholeRegistration ? "Registration cancelled." : "Request cancelled." });
    if (r.ok) nav("/", { replace: true });
  };

  if (row === undefined) return <div className="space-y-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-32" /><Skeleton className="h-40" /></div>;
  if (row === null) return (
    <Card className="mx-auto mt-6 max-w-sm space-y-3 p-6 text-center">
      <h1 className="text-xl">Nothing waiting here</h1>
      <p className="text-muted">This payment has been confirmed, declined or cancelled. Your home screen has the latest.</p>
      <Link to="/"><Button className="w-full">Go home</Button></Link>
    </Card>);

  const has = bank.bank_name || bank.account_name || bank.account_number;
  const sent = !!row.receipt;
  return (
    <div className="space-y-5 pb-8">
      <div><p className="text-sm text-muted">Offline payment</p><h1 className="text-2xl">{sent ? "Receipt sent" : "Pay and send your receipt"}</h1></div>

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-sm text-muted">Amount to pay</p><p className="num text-3xl font-semibold">{naira(row.amount)}</p></div>
          <Badge tone={sent ? "ok" : "warn"}>{sent ? "Awaiting confirmation" : "Waiting for your payment"}</Badge>
        </div>
        <p className="text-sm text-muted">{row.package}{row.courses.length ? ` · ${row.courses.join(" + ")}` : ""}{row.instalment_label ? ` · ${row.instalment_label}` : ""}</p>
        <button onClick={() => copy(row.reference, "Reference")} className="flex w-full items-center justify-between rounded-xl bg-sunken px-4 py-3 text-left transition active:scale-[.99]">
          <span><span className="block text-xs text-muted">Your reference. Use it as the transfer narration.</span><span className="num text-lg font-semibold tracking-wide">{row.reference}</span></span>
          <span className="text-sm text-accent">Copy</span>
        </button>
      </Card>

      <Card className="space-y-3">
        <p className="font-medium">Where to pay</p>
        {has ? (
          <div className="space-y-2 text-sm">
            {bank.bank_name && <div className="flex justify-between gap-3"><span className="text-muted">Bank</span><span className="font-medium">{bank.bank_name}</span></div>}
            {bank.account_name && <div className="flex justify-between gap-3"><span className="text-muted">Account name</span><span className="text-right font-medium">{bank.account_name}</span></div>}
            {bank.account_number && <button onClick={() => copy(bank.account_number!, "Account number")} className="flex w-full items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-left">
              <span><span className="block text-xs text-muted">Account number</span><span className="num text-lg font-semibold tracking-wide">{bank.account_number}</span></span><span className="text-sm text-accent">Copy</span></button>}
          </div>) : <p className="text-sm text-muted">Pay at your centre's front desk, or ask the team for transfer details.</p>}
        {bank.instructions && <p className="text-sm text-muted">{bank.instructions}</p>}
      </Card>

      <Card className="space-y-3">
        <p className="font-medium">{sent ? "Your receipt" : "Send your receipt"}</p>
        {sent && row.receipt && <div className="space-y-2">
          {preview && row.receipt.mime.startsWith("image/") ? <a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt="Your receipt" className="max-h-64 w-full rounded-xl bg-sunken object-contain" /></a>
            : preview ? <a href={preview} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl bg-sunken px-4 py-3 text-sm text-accent"><Icon name="file" size={18} className="shrink-0" /><span className="min-w-0 truncate">{row.receipt.name}</span></a> : null}
          <p className="text-sm text-muted">Sent {new Date(row.receipt.uploaded_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. We'll notify you when it's confirmed.</p>
          {row.student_note && <p className="rounded-xl bg-sunken px-3 py-2 text-sm">{row.student_note}</p>}
        </div>}
        <input ref={pick} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(""); e.target.value = ""; }} />
        {file ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-sm"><span className="flex min-w-0 items-center gap-2"><Icon name={file.type === "application/pdf" ? "file" : "image"} size={18} className="shrink-0 text-muted" /><span className="truncate">{file.name}</span></span><button onClick={() => setFile(null)} className="text-muted">Remove</button></div>
            <label className="block"><span className="mb-1.5 block text-sm text-muted">Note for the team (optional)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Paid from GTB at 2pm, in the name of Ada" className="min-h-[72px] w-full rounded-xl bg-sunken px-4 py-3 text-[15px] outline-none ring-accent/40 transition focus:ring-2" /></label>
            <Button className="w-full" onClick={send}>{sent ? "Replace receipt" : "Send receipt"}</Button>
          </div>
        ) : <Button variant={sent ? "secondary" : "primary"} className="w-full" onClick={() => pick.current?.click()}>{sent ? "Replace receipt" : "Choose photo or PDF"}</Button>}
        <Err>{err}</Err>
        {!sent && <p className="text-sm text-muted">Paid in cash with no receipt? Just wait: the team can confirm it without one.</p>}
      </Card>

      <Card className="space-y-1 text-sm">
        <p className="font-medium">What happens next</p>
        <p className="text-muted">1. You pay the exact amount. 2. The team confirms it when the money arrives. 3. You get a notification and your classes unlock.</p>
      </Card>

      <div className="flex flex-col gap-2">
        {row.instalment_id && <Button variant="secondary" onClick={payOnline}>Pay online instead</Button>}
        <Button variant="ghost" onClick={cancel}>{row.enrolment_status === "pending_payment" ? "Cancel registration" : "Cancel this request"}</Button>
      </div>
    </div>
  );
}
