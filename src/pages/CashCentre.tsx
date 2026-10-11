// src/pages/CashCentre.tsx
// A centre's cash: record a student's cash payment, see what the centre is holding, and get it to IQ Academy
// either by bank transfer (upload the receipt, an admin approves) or by handing it to an admin, who types their PIN on this phone.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, naira, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useAuth } from "../lib/auth";
import { useStaffCentres } from "../lib/useStaffCentres";
import { useFeedback } from "../components/feedback";
import RecordCash from "../components/RecordCash";
import { BankCard, PickItems, ReceiptField, type Pickable } from "../components/CashParts";
import { PinInput, PIN_LENGTH } from "../components/PinInput";
import { Badge, Button, Card, Chip, ChipRow, Empty, Err, Field, List, PageHeader, Section, Sheet, Skeleton, Stat, type Tone } from "../components/ui";
import { HANDOVER_REPLY, LEG_LABEL, STAGE_LABEL, newRemittanceId, removeReceipt, uploadRemitReceipt, type CashStage, type CentreCash, type CentreRemittance, type FoundAdmin } from "../lib/cash";
import { fmtWhen } from "../lib/time";
import Icon from "../components/Icon";

const STAGE_TONE: Record<CashStage, Tone> = { at_centre: "warn", transfer_pending: "info", handover_pending: "info", with_admin: "ok", admin_transfer_pending: "ok", settled: "ok" };
const when = (d: string) => fmtWhen(d, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

type Resume = { id: string; amount: number; admin_name: string };

function toItems(d: CentreCash): Pickable[] {
  return d.collections.filter((c) => c.stage === "at_centre").map((c) => ({ id: c.payment_id, title: c.student_name, sub: c.reference, amount: c.amount, when: c.collected_at }));
}

function TransferSheet({ open, onClose, data, centreId, onDone }: { open: boolean; onClose: () => void; data: CentreCash; centreId: string; onDone: () => void }) {
  const { session } = useAuth(); const { run } = useFeedback();
  const items = useMemo(() => toItems(data), [data]);
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [file, setFile] = useState<File | null>(null); const [note, setNote] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { if (open) { setPicked(new Set(items.map((i) => i.id))); setFile(null); setNote(""); setErr(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = items.filter((i) => picked.has(i.id)).reduce((n, i) => n + i.amount, 0);
  const send = async () => {
    if (!file || !session || !picked.size) return;
    setErr("");
    const rid = newRemittanceId();
    const r = await run("Sending your receipt…", async () => {
      const up = await uploadRemitReceipt(session.user.id, rid, file);
      try {
        const { error } = await supabase.rpc("cash_remit_transfer", { p_remittance_id: rid, p_centre_id: centreId, p_payment_ids: [...picked], p_path: up.path, p_name: up.name, p_mime: up.mime, p_size: up.size, p_note: note.trim() || null });
        if (error) throw error;
      } catch (e) { await removeReceipt(up.path); throw e; }
    }, { success: "Sent. An admin will confirm it once the money shows in the account.", quiet: true });
    if (!r.ok) return setErr(r.message);
    onDone(); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Send cash by bank transfer">
      <div className="space-y-4">
        <p className="text-sm text-muted">1. Choose the cash you are sending. 2. Transfer exactly that amount to the academy account. 3. Upload the bank receipt.</p>
        <PickItems items={items} picked={picked} onChange={setPicked} />
        <BankCard bank={data.bank} title={`Transfer ${naira(total)} to`} />
        <ReceiptField file={file} setFile={setFile} note={note} setNote={setNote} />
        <Err>{err}</Err>
        <Button className="w-full" disabled={!file || !picked.size} onClick={send}>Send receipt for {naira(total)}</Button>
      </div>
    </Sheet>
  );
}

function HandoverSheet({ open, onClose, data, centreId, resume, onDone }: { open: boolean; onClose: () => void; data: CentreCash; centreId: string; resume: Resume | null; onDone: () => void }) {
  const { run, confirm } = useFeedback();
  const items = useMemo(() => toItems(data), [data]);
  const [stage, setStage] = useState<"admin" | "pin" | "done">("admin");
  const [q, setQ] = useState(""); const [admins, setAdmins] = useState<FoundAdmin[] | null>(null); const [admin, setAdmin] = useState<FoundAdmin | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [started, setStarted] = useState<Resume | null>(null);
  const [pin, setPin] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setQ(""); setAdmins(null); setAdmin(null); setPin(""); setErr(""); setPicked(new Set(items.map((i) => i.id)));
    if (resume) { setStarted(resume); setStage("pin"); } else { setStarted(null); setStage("admin"); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async () => {
    setErr(""); setBusy(true);
    const r = await supabase.rpc("cash_find_admin", { p_centre_id: centreId, p_query: q });
    setBusy(false);
    if (r.error) return setErr(friendly(r.error));
    setAdmins((r.data as FoundAdmin[]) ?? []);
  };
  const begin = async () => {
    if (!admin || !picked.size) return;
    setErr("");
    const r = await run("Starting the hand-over…", async () => {
      const { data: d, error } = await supabase.rpc("cash_start_handover", { p_centre_id: centreId, p_admin_id: admin.id, p_payment_ids: [...picked] });
      if (error) throw error;
      return d as { id: string; amount: number; admin_name: string };
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setStarted({ id: r.data.id, amount: r.data.amount, admin_name: r.data.admin_name }); setStage("pin"); onDone();
  };
  const check = async (v: string) => {
    if (!started || busy) return;
    setBusy(true); setErr("");
    const { data: res, error } = await supabase.rpc("cash_confirm_handover", { p_remittance_id: started.id, p_pin: v });
    setBusy(false);
    if (error) { setPin(""); return setErr(friendly(error)); }
    if (res === "ok") { setStage("done"); onDone(); return; }
    setPin(""); setErr(HANDOVER_REPLY[String(res)] ?? "Something went wrong. Please try again.");
    if (res === "handover_voided") onDone();
  };
  const cancel = async () => {
    if (!started) return;
    const yes = await confirm({ title: "Cancel this hand-over?", message: "The cash goes back on your list. Nothing has been handed over.", confirmLabel: "Cancel hand-over", cancelLabel: "Keep it", danger: true });
    if (!yes) return;
    const r = await run("Cancelling…", async () => { const { error } = await supabase.rpc("cash_cancel_remittance", { p_remittance_id: started.id }); if (error) throw error; }, { success: "Hand-over cancelled" });
    if (r.ok) { onDone(); onClose(); }
  };
  const total = items.filter((i) => picked.has(i.id)).reduce((n, i) => n + i.amount, 0);

  return (
    <Sheet open={open} onClose={onClose} title={stage === "done" ? "Cash handed over" : "Hand cash to an admin"}>
      <div className="space-y-4">
        {stage === "admin" && <>
          <p className="text-sm text-muted">Use this when an admin is at the centre to collect the cash. They count it, then type their own PIN on this phone to confirm.</p>
          <PickItems items={items} picked={picked} onChange={setPicked} />
          <div className="flex gap-2">
            <div className="min-w-0 flex-1"><Field label="Admin" value={q} onChange={(e) => { setQ(e.target.value); setAdmins(null); setAdmin(null); }} onKeyDown={(e) => e.key === "Enter" && q.trim().length >= 3 && search()} placeholder="Their email or name" autoComplete="off" /></div>
            <Button className="mt-[26px]" disabled={q.trim().length < 3} loading={busy} onClick={search}>Find</Button>
          </div>
          {admins && (admins.length === 0 ? <p className="text-sm text-muted">No admin matches that.</p> : admins.map((a) => (
            <button key={a.id} type="button" disabled={!a.has_pin} onClick={() => setAdmin(a)}
              className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-1 transition disabled:opacity-60 ${admin?.id === a.id ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line"}`}>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.full_name}</span><span className="block truncate text-sm text-muted">{a.has_pin ? a.email : "Hasn't set a hand-over PIN yet. Ask them to set it on their Cash page."}</span></span>
              {admin?.id === a.id && <Icon name="check" size={18} className="text-accent" />}
            </button>)))}
          <Err>{err}</Err>
          <Button className="w-full" disabled={!admin || !picked.size} onClick={begin}>Hand over {naira(total)}</Button>
        </>}
        {stage === "pin" && started && <>
          <Card className="space-y-1 text-center"><p className="text-sm text-muted">{started.admin_name} is receiving</p><p className="num text-3xl font-semibold">{naira(started.amount)}</p></Card>
          <p className="text-center text-sm text-muted">Hand over the cash. {started.admin_name.split(" ")[0]} counts it, then types their PIN here.</p>
          <PinInput value={pin} onChange={(v) => { setPin(v); setErr(""); }} autoFocus invalid={!!err} disabled={busy} onComplete={check} />
          <Err>{err}</Err>
          <Button variant="ghost" className="w-full" disabled={pin.length > 0 && pin.length < PIN_LENGTH} onClick={cancel}>Cancel hand-over</Button>
        </>}
        {stage === "done" && started && <div className="space-y-4 py-2 text-center">
          <div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div>
          <p className="text-lg font-semibold">{naira(started.amount)} handed to {started.admin_name}</p>
          <p className="text-sm text-muted">Your centre no longer holds this cash, and your share has been added to your balance.</p>
          <Button className="w-full" onClick={onClose}>Done</Button>
        </div>}
      </div>
    </Sheet>
  );
}

export default function CashCentre() {
  const { ids, centres, sel, setSel } = useStaffCentres();
  const { run, confirm } = useFeedback();
  const centreId = sel !== "all" ? sel : ids[0];
  const [data, setData] = useState<CentreCash | null>(); const [err, setErr] = useState("");
  const [rec, setRec] = useState(false); const [xfer, setXfer] = useState(false); const [hand, setHand] = useState(false); const [resume, setResume] = useState<Resume | null>(null);

  const load = useCallback(async () => {
    if (!centreId) return;
    const r = await supabase.rpc("cash_centre_summary", { p_centre_id: centreId });
    if (r.error) { setErr(friendly(r.error)); return setData(null); }
    setErr(""); setData(r.data as CentreCash);
  }, [centreId]);
  useEffect(() => { setData(undefined); load(); }, [load]);

  const cancel = async (r: CentreRemittance) => {
    const yes = await confirm({ title: "Cancel this?", message: "The cash goes back on your list.", confirmLabel: "Cancel it", cancelLabel: "Keep it", danger: true });
    if (!yes) return;
    const res = await run("Cancelling…", async () => {
      const { data: d, error } = await supabase.rpc("cash_cancel_remittance", { p_remittance_id: r.id }); if (error) throw error;
      await removeReceipt((d as { receipt_path: string | null })?.receipt_path);
    }, { success: "Cancelled" });
    if (res.ok) load();
  };

  if (centres && ids.length === 0) return <Empty icon="cash" title="No centre yet" hint="Cash is handled by the coordinator or director of a centre." />;
  const held = data?.totals.at_centre ?? 0;
  const waiting = (data?.remittances ?? []).filter((r) => r.status === "pending");
  const handled = (data?.remittances ?? []).filter((r) => r.status !== "pending").slice(0, 8);
  const centreName = data ? place(data.centre) : "";

  return (
    <div className="space-y-5">
      <PageHeader title="Cash" sub="Cash students pay at the centre" action={centreId ? <Button className="h-10 px-4 text-sm" onClick={() => setRec(true)}>Record cash</Button> : undefined} />
      {ids.length > 1 && <ChipRow>{(centres ?? []).map((c) => <Chip key={c.id} on={centreId === c.id} onClick={() => setSel(c.id)}>{place(c)}</Chip>)}</ChipRow>}
      <Err>{err}</Err>
      {data === undefined ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-32" /></div> : data && <>
        <div className="grid grid-cols-3 gap-2.5">
          <Stat compact tone="warn" label="You hold" value={naira(held)} sub="Owed to the academy" />
          <Stat compact tone="info" label="Being checked" value={naira(data.totals.in_review + data.totals.handover_pending)} sub="Sent, not confirmed" />
          <Stat compact tone="ok" label="Handed over" value={naira(data.totals.handed_over)} sub="All time" />
        </div>

        {held > 0 && <Section title="Send it to IQ Academy">
          <Card className="space-y-3">
            <p className="text-sm text-muted">Your centre's share of each payment is added to your balance once the cash has been handed over.</p>
            <div className="grid grid-cols-2 gap-2"><Button onClick={() => setXfer(true)}>Bank transfer</Button><Button variant="secondary" onClick={() => { setResume(null); setHand(true); }}>Hand to an admin</Button></div>
          </Card>
        </Section>}

        {waiting.length > 0 && <Section title="Waiting">
          <List>{waiting.map((r) => (
            <div key={r.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{r.leg === "handover" ? `Hand-over to ${r.to_admin_name ?? "an admin"}` : "Bank transfer sent"}</p><p className="text-sm text-muted">{r.reference} · {when(r.created_at)}</p></div><p className="num shrink-0 font-semibold">{naira(r.amount)}</p></div>
              <div className="flex items-center gap-2"><Badge tone="info">{r.leg === "handover" ? "Waiting for their PIN" : "Waiting for an admin to confirm"}</Badge>
                {r.leg === "handover" && <Button className="h-8 px-3 text-sm" onClick={() => { setResume({ id: r.id, amount: r.amount, admin_name: r.to_admin_name ?? "The admin" }); setHand(true); }}>Enter PIN</Button>}
                <button className="ml-auto text-sm text-muted underline decoration-line underline-offset-4" onClick={() => cancel(r)}>Cancel</button></div>
            </div>))}</List>
        </Section>}

        <Section title="Cash received" aside={<span className="num">{data.collections.length}</span>}>
          {data.collections.length === 0 ? <Empty icon="cash" title="No cash recorded yet" hint="When a student pays cash at the centre, tap Record cash." />
            : <List>{data.collections.slice(0, 25).map((c) => (
              <div key={c.payment_id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{c.student_name}</p><p className="truncate text-[13px] text-muted">{c.reference} · {when(c.collected_at)} · {c.collected_by}</p></div>
                <div className="shrink-0 text-right"><p className="num font-semibold">{naira(c.amount)}</p><Badge tone={STAGE_TONE[c.stage]}>{STAGE_LABEL[c.stage]}</Badge></div>
              </div>))}</List>}
        </Section>

        {handled.length > 0 && <Section title="Sent to IQ Academy">
          <List>{handled.map((r) => (
            <div key={r.id} className="space-y-1 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate font-medium">{LEG_LABEL[r.leg]}{r.to_admin_name ? ` · ${r.to_admin_name}` : ""}</p><p className="num shrink-0 font-semibold">{naira(r.amount)}</p></div>
              <div className="flex items-center justify-between gap-3"><p className="truncate text-[13px] text-muted">{r.reference} · {r.decided_at ? when(r.decided_at) : when(r.created_at)}</p><Badge tone={r.status === "approved" ? "ok" : r.status === "declined" ? "bad" : "muted"}>{r.status === "approved" ? (r.leg === "handover" ? "Handed over" : "Confirmed") : r.status === "declined" ? "Not confirmed" : "Cancelled"}</Badge></div>
              {r.status === "declined" && r.decision_note && <p className="text-sm text-bad">{r.decision_note}. The cash is back on your list.</p>}
            </div>))}</List>
        </Section>}

        <RecordCash open={rec} onClose={() => setRec(false)} centreId={centreId!} centreName={centreName} onDone={load} />
        <TransferSheet open={xfer} onClose={() => setXfer(false)} data={data} centreId={centreId!} onDone={load} />
        <HandoverSheet open={hand} onClose={() => { setHand(false); load(); }} data={data} centreId={centreId!} resume={resume} onDone={load} />
      </>}
    </div>
  );
}
