// src/pages/CashAdmin.tsx
// Admins: cash that centres hold, transfers to review (approve once the money is in the academy account), cash an admin collected
// from centres, and the hand-over PIN a centre needs to hand cash to you. A super admin also reviews admins' own transfers.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, naira, friendly } from "../lib/supabase";
import { place } from "../lib/centre";
import { useAuth } from "../lib/auth";
import { useFeedback } from "../components/feedback";
import { BankCard, PickItems, ReceiptField, type Pickable } from "../components/CashParts";
import { ChangePinForm, PinSetup } from "../components/PinInput";
import { receiptUrl } from "../lib/offline";
import { LEG_LABEL, newRemittanceId, removeReceipt, uploadRemitReceipt, type AdminCash, type ReviewRow } from "../lib/cash";
import { Avatar, Badge, Button, Card, Empty, Err, Field, List, PageHeader, Section, Sheet, Skeleton, Stat, cx } from "../components/ui";
import { fmtWhen } from "../lib/time";
import Icon from "../components/Icon";

const when = (d: string) => fmtWhen(d, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const REASONS = ["Money not received", "Amount doesn't match", "Receipt unreadable"];

function AdminTransferSheet({ open, onClose, data, onDone }: { open: boolean; onClose: () => void; data: AdminCash; onDone: () => void }) {
  const { session } = useAuth(); const { run } = useFeedback();
  const items = useMemo<Pickable[]>(() => data.mine.items.map((i) => ({ id: i.payment_id, title: i.student_name, sub: `${i.centre_name} · ${i.reference}`, amount: i.amount, when: i.collected_at })), [data]);
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
        const { error } = await supabase.rpc("cash_remit_admin_transfer", { p_remittance_id: rid, p_payment_ids: [...picked], p_path: up.path, p_name: up.name, p_mime: up.mime, p_size: up.size, p_note: note.trim() || null });
        if (error) throw error;
      } catch (e) { await removeReceipt(up.path); throw e; }
    }, { success: "Sent. A super admin will confirm it.", quiet: true });
    if (!r.ok) return setErr(r.message);
    onDone(); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Send the cash you hold">
      <div className="space-y-4">
        <p className="text-sm text-muted">Transfer exactly what you are sending to the academy account, then upload the bank receipt. A super admin approves it.</p>
        <PickItems items={items} picked={picked} onChange={setPicked} />
        <BankCard bank={data.bank} title={`Transfer ${naira(total)} to`} />
        <ReceiptField file={file} setFile={setFile} note={note} setNote={setNote} />
        <Err>{err}</Err>
        <Button className="w-full" disabled={!file || !picked.size} onClick={send}>Send receipt for {naira(total)}</Button>
      </div>
    </Sheet>
  );
}

export default function CashAdmin() {
  const { run, confirm } = useFeedback();
  const [d, setD] = useState<AdminCash | null>(); const [loadErr, setLoadErr] = useState("");
  const [view, setView] = useState<{ r: ReviewRow; url: string | null } | null>(null);
  const [decl, setDecl] = useState<{ r: ReviewRow; reason: string } | null>(null);
  const [xfer, setXfer] = useState(false); const [pin, setPin] = useState(false);

  const load = useCallback(async () => {
    const r = await supabase.rpc("admin_cash_overview");
    if (r.error) { setLoadErr(friendly(r.error)); return setD(null); }
    setLoadErr(""); setD(r.data as AdminCash);
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = async (r: ReviewRow) => setView({ r, url: r.receipt ? await receiptUrl(r.receipt.path) : null });
  const approve = async (r: ReviewRow) => {
    const who = r.leg === "centre_transfer" ? `${r.centre_name ?? "the centre"}` : r.submitted_by_name;
    const yes = await confirm({ title: `Confirm ${naira(r.amount)} received?`, confirmLabel: "Yes, approve",
      message: `Approve only when ${naira(r.amount)} from ${who} is in the academy account (reference ${r.reference}). ${r.leg === "centre_transfer" ? "The centre's share of these payments is then added to its balance." : ""}` });
    if (!yes) return;
    const res = await run("Approving…", async () => { const { error } = await supabase.rpc("approve_cash_remittance", { p_remittance_id: r.id }); if (error) throw error; }, { success: "Approved" });
    if (res.ok) { setView(null); load(); }
  };
  const decline = async () => {
    if (!decl) return;
    const res = await run("Declining…", async () => { const { error } = await supabase.rpc("decline_cash_remittance", { p_remittance_id: decl.r.id, p_reason: decl.reason }); if (error) throw error; }, { success: "Declined. The sender has been told." });
    if (res.ok) { setDecl(null); setView(null); load(); }
  };

  if (d === undefined) return <div className="space-y-3"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>;
  if (d === null) return <Err>{loadErr || "Couldn't load cash."}</Err>;
  const mine = d.mine;
  return (
    <div className="space-y-5">
      <PageHeader title="Cash from centres" sub="Cash students paid at a centre, on its way to the academy account" />
      <div className="grid grid-cols-3 gap-2.5">
        <Stat compact tone="warn" label="With centres" value={naira(d.totals.at_centres)} />
        <Stat compact tone="info" label="With admins" value={naira(d.totals.with_admins)} />
        <Stat compact tone="ok" label="Received" value={naira(d.totals.settled)} />
      </div>

      <Section title="To review" aside={<span className="num">{d.reviews.length}</span>}>
        {d.reviews.length === 0 ? <Empty icon="checkCircle" title="Nothing to review" hint="Transfers with a receipt appear here." /> : d.reviews.map((r) => (
          <Card key={r.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{r.leg === "centre_transfer" ? place({ name: r.centre_name ?? "Centre", city: r.centre_city }) : `Admin: ${r.submitted_by_name}`}</p>
                <p className="text-sm text-muted">{LEG_LABEL[r.leg]} · {r.items.length} payment{r.items.length === 1 ? "" : "s"} · <span className="num">{r.reference}</span></p>
                {r.leg === "centre_transfer" && <p className="text-sm text-muted">Sent by {r.submitted_by_name} · {when(r.created_at)}</p>}</div>
              <p className="num shrink-0 text-lg font-semibold">{naira(r.amount)}</p>
            </div>
            {r.note && <p className="rounded-xl bg-sunken px-3 py-2 text-sm">“{r.note}”</p>}
            {r.can_act ? <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" className="h-11 px-2 text-sm" onClick={() => open(r)}>Receipt</Button>
              <Button variant="secondary" className="h-11 px-2 text-sm" onClick={() => setDecl({ r, reason: "" })}>Decline</Button>
              <Button className="h-11 px-2 text-sm" onClick={() => approve(r)}>Approve</Button></div>
              : <div className="flex items-center justify-between gap-3"><Badge tone="info">{r.leg === "admin_transfer" ? "Waiting for a super admin" : "Sent by you"}</Badge><Button variant="secondary" className="h-9 px-4 text-sm" onClick={() => open(r)}>Receipt</Button></div>}
          </Card>))}
      </Section>

      <Section title="Cash you hold">
        <Card className="space-y-3">
          <div className="flex items-start justify-between gap-3"><div><p className="num text-2xl font-semibold">{naira(mine.holding)}</p><p className="text-sm text-muted">collected from centres{mine.in_review > 0 ? ` · ${naira(mine.in_review)} under review` : ""}</p></div>
            <Button className="h-10 px-4 text-sm" disabled={mine.holding <= 0} onClick={() => setXfer(true)}>Send to academy</Button></div>
          {mine.items.length > 0 && <div className="divide-y divide-line rounded-2xl ring-1 ring-line">{mine.items.slice(0, 6).map((i) => (
            <div key={i.payment_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0 truncate">{i.student_name}<span className="text-muted"> · {i.centre_name}</span></span><span className="num shrink-0 font-medium">{naira(i.amount)}</span></div>))}
            {mine.items.length > 6 && <p className="px-3 py-2 text-sm text-muted">and {mine.items.length - 6} more</p>}</div>}
          {mine.incoming.map((i) => <p key={i.id} className="rounded-xl bg-info/10 px-3 py-2 text-sm text-info">{i.centre_name} is handing you {naira(i.amount)} ({i.reference}). Count it, then type your PIN on their phone.</p>)}
        </Card>
        <Card className="flex items-center gap-3">
          <Icon name="lock" size={22} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">Hand-over PIN</p><p className="text-sm text-muted">{mine.has_pin ? "Set. You type it on a coordinator's phone to confirm you received their cash." : "Not set. Set one so a centre can hand cash to you."}</p></div>
          <Button variant="secondary" className="h-9 px-4 text-sm" onClick={() => setPin(true)}>{mine.has_pin ? "Change" : "Set PIN"}</Button>
        </Card>
      </Section>

      {d.is_super && d.holders.length > 0 && <Section title="Admins holding cash">
        <List>{d.holders.map((h) => (
          <div key={h.admin_id} className="flex items-center gap-3 px-4 py-2.5"><Avatar name={h.name} size={32} /><p className="min-w-0 flex-1 truncate font-medium">{h.name}</p>
            <div className="text-right"><p className="num font-semibold">{naira(h.holding)}</p>{h.in_review > 0 && <p className="text-xs text-muted">{naira(h.in_review)} under review</p>}</div></div>))}</List>
      </Section>}

      <Section title="Centres holding cash">
        {d.centres.length === 0 ? <p className="text-sm text-muted">No centre is holding cash right now.</p> : <List>{d.centres.map((c) => (
          <div key={c.centre_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0"><p className="truncate font-medium">{place({ name: c.name, city: c.city })}</p><p className="truncate text-[13px] text-muted">{c.oldest ? `Oldest cash from ${fmtWhen(c.oldest, { day: "numeric", month: "short" })}` : "Nothing left to send"}{c.in_review + c.handover_pending > 0 ? ` · ${naira(c.in_review + c.handover_pending)} on its way` : ""}</p></div>
            <p className={cx("num shrink-0 font-semibold", c.at_centre > 0 && "text-warn")}>{naira(c.at_centre)}</p></div>))}</List>}
      </Section>

      {d.recent.length > 0 && <Section title="Recently handled">
        <List>{d.recent.slice(0, 10).map((r) => (
          <div key={r.id} className="space-y-0.5 px-4 py-2.5">
            <div className="flex items-center justify-between gap-3"><p className="min-w-0 truncate font-medium">{r.leg === "admin_transfer" ? `Admin: ${r.submitted_by_name}` : r.centre_name}{r.to_admin_name ? ` → ${r.to_admin_name}` : ""}</p><p className="num shrink-0 font-semibold">{naira(r.amount)}</p></div>
            <div className="flex items-center justify-between gap-3"><p className="truncate text-[13px] text-muted">{LEG_LABEL[r.leg]} · {r.reference}{r.decided_at ? ` · ${when(r.decided_at)}` : ""}</p><Badge tone={r.status === "approved" ? "ok" : r.status === "declined" ? "bad" : "muted"}>{r.status}</Badge></div>
            {r.status === "declined" && r.decision_note && <p className="text-sm text-muted">{r.decision_note}</p>}
          </div>))}</List>
      </Section>}

      <Sheet open={!!view} onClose={() => setView(null)} title={view ? `${naira(view.r.amount)} · ${view.r.reference}` : ""}>
        {view && <div className="space-y-3">
          {view.url ? (view.r.receipt?.mime.startsWith("image/") ? <a href={view.url} target="_blank" rel="noreferrer"><img src={view.url} alt="Receipt" className="max-h-[50vh] w-full rounded-xl bg-sunken object-contain" /></a>
            : <a href={view.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl bg-sunken px-4 py-4 text-accent"><Icon name="file" size={18} className="shrink-0" /><span className="min-w-0 truncate">Open {view.r.receipt?.name}</span></a>) : <p className="text-muted">Couldn't load the receipt.</p>}
          <div className="divide-y divide-line rounded-2xl ring-1 ring-line">{view.r.items.map((i) => (
            <div key={i.reference} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="min-w-0 truncate">{i.student_name}<span className="text-muted"> · {i.reference}</span></span><span className="num shrink-0 font-medium">{naira(i.amount)}</span></div>))}</div>
          <p className="text-sm text-muted">Check the amount against your bank alert before approving.</p>
          {view.r.can_act && <div className="grid grid-cols-2 gap-2"><Button variant="secondary" onClick={() => { const r = view.r; setView(null); setDecl({ r, reason: "" }); }}>Decline</Button><Button onClick={() => approve(view.r)}>Approve</Button></div>}
        </div>}
      </Sheet>

      <Sheet open={!!decl} onClose={() => setDecl(null)} title="Decline this transfer">
        {decl && <div className="space-y-3">
          <p className="text-sm text-muted">{naira(decl.r.amount)} · {decl.r.reference}. The sender is told why and the cash goes back on their list.</p>
          <div className="flex flex-wrap gap-2">{REASONS.map((x) => <button key={x} onClick={() => setDecl({ ...decl, reason: x })} className={cx("rounded-full px-3 py-1.5 text-sm transition", decl.reason === x ? "bg-accent text-accent-ink" : "bg-sunken")}>{x}</button>)}</div>
          <Field label="Reason (shown to the sender)" value={decl.reason} maxLength={300} onChange={(e) => setDecl({ ...decl, reason: e.target.value })} />
          <Button variant="danger" className="w-full" disabled={decl.reason.trim().length < 3} onClick={decline}>Decline transfer</Button>
        </div>}
      </Sheet>

      <AdminTransferSheet open={xfer} onClose={() => setXfer(false)} data={d} onDone={load} />
      <Sheet open={pin} onClose={() => setPin(false)} title={mine.has_pin ? "Change your hand-over PIN" : "Set your hand-over PIN"}>
        <p className="mb-4 text-sm text-muted">Only you should know it. Centres use it to hand you cash: you type it on their phone after counting.</p>
        {mine.has_pin ? <ChangePinForm staff onDone={() => { setPin(false); load(); }} /> : <PinSetup staff onDone={() => { setPin(false); load(); }} />}
      </Sheet>
    </div>
  );
}
