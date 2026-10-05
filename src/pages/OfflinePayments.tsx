import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase, naira } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useFeedback } from "../components/feedback";
import { place } from "../lib/centre";
import { receiptUrl, type OfflineDetails, type Receipt } from "../lib/offline";
import { Avatar, Badge, Button, Card, Field, Sheet, Skeleton, cx } from "../components/ui";

import Icon from "../components/Icon";
// Admin: offline payments waiting for review. Approve once the money has arrived (the student is notified and their
// classes unlock), decline with a reason (optionally purging the registration), or simply leave it until the money shows up.
type Row = {
  id: string; reference: string; status: "pending" | "succeeded" | "failed"; amount: number; created_at: string; updated_at: string;
  student_name: string; student_phone: string | null; student_email: string | null; centre_name: string; centre_city: string | null;
  package: string; plan: string; enrolment_status: string; instalment_number: number | null; instalment_label: string | null; instalments_total: number;
  courses: string[]; receipt: Receipt | null; student_note: string | null; failed_reason: string | null; admin_note: string | null;
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - +new Date(iso)) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); return d === 1 ? "yesterday" : `${d} days ago`;
};
const REASONS = ["Money not received", "Amount doesn't match", "Receipt unreadable"];

export default function OfflinePayments() {
  const { roles } = useAuth();
  const { run, confirm } = useFeedback();
  const isAdmin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const [tab, setTab] = useState<"open" | "handled">("open");
  const [rows, setRows] = useState<Row[]>();
  const [bank, setBank] = useState<OfflineDetails>({});
  const [editBank, setEditBank] = useState<OfflineDetails | null>(null);
  const [view, setView] = useState<{ row: Row; url: string | null } | null>(null);
  const [decl, setDecl] = useState<{ row: Row; reason: string; purge: boolean } | null>(null);
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(async () => {
    const [l, d] = await Promise.all([supabase.rpc("admin_offline_payments", { p_view: tab }), supabase.rpc("offline_payment_details")]);
    if (l.error) { setLoadErr("Couldn't load the list. Pull to refresh or try again."); setRows([]); return; }
    setLoadErr(""); setRows((l.data as Row[]) ?? []); setBank((d.data as OfflineDetails) ?? {});
  }, [tab]);
  useEffect(() => { if (isAdmin) { setRows(undefined); load(); } }, [load, isAdmin]);
  if (!isAdmin) return <Navigate to="/" replace />;

  const open = async (r: Row) => setView({ row: r, url: r.receipt ? await receiptUrl(r.receipt.path) : null });

  const approve = async (r: Row) => {
    const ok = await confirm({ title: `Confirm ${naira(r.amount)} received?`,
      message: `Only approve once the money from ${r.student_name} has reached you (reference ${r.reference}). They'll be told their payment was received and their classes unlock.`, confirmLabel: "Yes, approve" });
    if (!ok) return;
    const res = await run("Approving payment…", async () => {
      const { error } = await supabase.rpc("approve_offline_payment", { p_payment_id: r.id }); if (error) throw error;
      // Read it back: only call it approved if the payment really shows as paid.
      const back = await supabase.from("payments").select("status").eq("id", r.id).single();
      if (back.error || back.data?.status !== "succeeded") throw new Error("not_saved");
    }, { success: `Approved. ${r.student_name.split(" ")[0]} has been notified.` });
    if (res.ok) { setView(null); load(); }
  };

  const decline = async () => {
    if (!decl) return;
    const { row, reason, purge } = decl;
    const res = await run(purge ? "Declining and cancelling…" : "Declining…", async () => {
      const { data, error } = await supabase.rpc("decline_offline_payment", { p_payment_id: row.id, p_reason: reason, p_cancel_registration: purge });
      if (error) throw error;
      const path = (data as { receipt_path: string | null; cancelled: boolean }).receipt_path;
      if (purge && path) await supabase.storage.from("payment-receipts").remove([path]); // the receipt goes with the registration; best effort
    }, { success: purge ? "Declined and removed. The student has been told." : "Declined. The student has been told and can pay again." });
    if (res.ok) { setDecl(null); setView(null); load(); }
  };

  const saveBank = async () => {
    if (!editBank) return;
    const e = editBank;
    const res = await run("Saving payment details…", async () => {
      const { error } = await supabase.rpc("save_offline_payment_details", { p_bank_name: e.bank_name ?? "", p_account_name: e.account_name ?? "", p_account_number: e.account_number ?? "", p_instructions: e.instructions ?? "" });
      if (error) throw error;
      const back = await supabase.rpc("offline_payment_details");
      if ((back.data as OfflineDetails | null)?.account_number !== (e.account_number ?? "").replace(/\s/g, "")) throw new Error("not_saved");
    }, { success: "Saved. Students see these details when they pay offline." });
    if (res.ok) { setEditBank(null); load(); }
  };

  const pending = (rows ?? []).filter((r) => r.status === "pending");
  const withReceipt = pending.filter((r) => r.receipt).length;

  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl">Offline payments</h1>
        <p className="text-sm text-muted">Students who chose to pay by cash or transfer. Leave a payment here until the money arrives: nothing changes for the student until you approve or decline it.</p></div>

      <Card className="space-y-2">
        <div className="flex items-center justify-between gap-3"><p className="font-medium">Where students pay</p><button onClick={() => setEditBank({ ...bank })} className="text-sm text-accent">Edit</button></div>
        {bank.bank_name || bank.account_number ? (
          <p className="text-sm text-muted">{[bank.bank_name, bank.account_name].filter(Boolean).join(" · ")}{bank.account_number ? <> · <span className="num font-medium text-ink">{bank.account_number}</span></> : null}</p>
        ) : <p className="text-sm text-warn">No bank account set. Students will be told to pay at their centre. Add one so they can transfer.</p>}
      </Card>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
        {([["open", `To review${tab === "open" && rows ? ` (${pending.length})` : ""}`], ["handled", "Handled"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("h-10 rounded-lg text-sm font-medium transition", tab === k ? "bg-surface shadow-card" : "text-muted")}>{l}</button>))}
      </div>
      {tab === "open" && rows && pending.length > 0 && <p className="text-sm text-muted">{withReceipt} with a receipt · {pending.length - withReceipt} waiting for one. Newest receipts first.</p>}

      {loadErr && <p className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{loadErr}</p>}
      {!rows ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></> : rows.length === 0 ? (
        <Card className="space-y-1 p-8 text-center"><Icon name={tab === "open" ? "checkCircle" : "inbox"} size={36} className="mx-auto mb-1 text-muted" /><p className="font-medium">{tab === "open" ? "Nothing to review" : "Nothing handled in the last 30 days"}</p>
          {tab === "open" && <p className="text-sm text-muted">New offline payments will show up here.</p>}</Card>
      ) : rows.map((r) => (
        <Card key={r.id} className="space-y-3">
          <div className="flex items-start gap-3">
            <Avatar name={r.student_name} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2"><p className="truncate font-medium">{r.student_name}</p><p className="num shrink-0 font-semibold">{naira(r.amount)}</p></div>
              <p className="text-sm text-muted">{r.package}{r.courses.length ? ` · ${r.courses.join(" + ")}` : ""}</p>
              <p className="text-sm text-muted">{place({ name: r.centre_name, city: r.centre_city })} · {r.instalment_number ? `${r.instalments_total > 1 ? `Instalment ${r.instalment_number} of ${r.instalments_total}` : "Full payment"}` : "Payment"} · <span className="num">{r.reference}</span></p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {r.status === "pending" && (r.receipt ? <Badge tone="ok">Receipt uploaded {ago(r.receipt.uploaded_at)}</Badge> : <Badge tone="warn">No receipt yet · requested {ago(r.created_at)}</Badge>)}
            {r.status === "succeeded" && <Badge tone="ok">Approved {ago(r.updated_at)}</Badge>}
            {r.status === "failed" && <Badge tone="bad">Declined {ago(r.updated_at)}</Badge>}
            {r.status === "pending" && r.enrolment_status !== "pending_payment" && <Badge>Later instalment</Badge>}
            {(r.student_phone) && <a href={`tel:${r.student_phone}`} className="text-sm text-accent">{r.student_phone}</a>}
          </div>
          {r.student_note && <p className="rounded-xl bg-sunken px-3 py-2 text-sm">“{r.student_note}”</p>}
          {r.status === "failed" && r.failed_reason && <p className="text-sm text-muted">Reason: {r.failed_reason}</p>}
          {r.status === "pending" && (
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" className="h-11 px-2 text-sm" disabled={!r.receipt} onClick={() => open(r)}>Receipt</Button>
              <Button variant="secondary" className="h-11 px-2 text-sm" onClick={() => setDecl({ row: r, reason: "", purge: r.enrolment_status === "pending_payment" })}>Decline</Button>
              <Button className="h-11 px-2 text-sm" onClick={() => approve(r)}>Approve</Button>
            </div>)}
          {r.status !== "pending" && r.receipt && <button onClick={() => open(r)} className="text-left text-sm text-accent">View receipt</button>}
        </Card>))}

      <Sheet open={!!view} onClose={() => setView(null)} title={view ? `${view.row.student_name} · ${naira(view.row.amount)}` : ""}>
        {view && <div className="space-y-3">
          {view.url ? (view.row.receipt?.mime.startsWith("image/") ? <a href={view.url} target="_blank" rel="noreferrer"><img src={view.url} alt="Receipt" className="max-h-[60vh] w-full rounded-xl bg-sunken object-contain" /></a>
            : <a href={view.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl bg-sunken px-4 py-4 text-accent"><Icon name="file" size={18} className="shrink-0" /><span className="min-w-0 truncate">Open {view.row.receipt?.name}</span></a>) : <p className="text-muted">Couldn't load the receipt.</p>}
          <p className="text-sm text-muted">Reference <span className="num font-medium text-ink">{view.row.reference}</span>. Check it against your bank alert or cash book before approving.</p>
          {view.row.status === "pending" && <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => { const r = view.row; setView(null); setDecl({ row: r, reason: "", purge: r.enrolment_status === "pending_payment" }); }}>Decline</Button>
            <Button onClick={() => approve(view.row)}>Approve</Button></div>}
        </div>}
      </Sheet>

      <Sheet open={!!decl} onClose={() => setDecl(null)} title="Decline this payment">
        {decl && <div className="space-y-3">
          <p className="text-sm text-muted">{decl.row.student_name} · {naira(decl.row.amount)} · {decl.row.reference}. They'll get a notification with your reason.</p>
          <div className="flex flex-wrap gap-2">{REASONS.map((x) => <button key={x} onClick={() => setDecl({ ...decl, reason: x })} className={cx("rounded-full px-3 py-1.5 text-sm transition", decl.reason === x ? "bg-accent text-accent-ink" : "bg-sunken")}>{x}</button>)}</div>
          <Field label="Reason (shown to the student)" value={decl.reason} maxLength={300} onChange={(e) => setDecl({ ...decl, reason: e.target.value })} placeholder="e.g. We haven't received the transfer" />
          {decl.row.enrolment_status === "pending_payment" ? (
            <label className="flex items-start gap-3 rounded-xl bg-sunken p-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={decl.purge} onChange={(e) => setDecl({ ...decl, purge: e.target.checked })} />
              <span><span className="font-medium">Also remove their registration</span><span className="block text-muted">Cancels the unpaid registration and deletes the receipt, so they can register again from scratch. Leave unticked to let them pay again.</span></span>
            </label>) : <p className="rounded-xl bg-sunken p-3 text-sm text-muted">This student is already enrolled, so only this payment request is declined.</p>}
          <Button variant="danger" className="w-full" disabled={decl.reason.trim().length < 3} onClick={decline}>{decl.purge ? "Decline and remove registration" : "Decline payment"}</Button>
        </div>}
      </Sheet>

      <Sheet open={!!editBank} onClose={() => setEditBank(null)} title="Where students pay">
        {editBank && <div className="space-y-3">
          <Field label="Bank" value={editBank.bank_name ?? ""} maxLength={80} onChange={(e) => setEditBank({ ...editBank, bank_name: e.target.value })} placeholder="e.g. GTBank" />
          <Field label="Account name" value={editBank.account_name ?? ""} maxLength={120} onChange={(e) => setEditBank({ ...editBank, account_name: e.target.value })} />
          <Field label="Account number" inputMode="numeric" value={editBank.account_number ?? ""} maxLength={24} onChange={(e) => setEditBank({ ...editBank, account_number: e.target.value.replace(/[^\d ]/g, "") })} />
          <label className="block"><span className="mb-1.5 block text-sm text-muted">Instructions for students</span>
            <textarea value={editBank.instructions ?? ""} maxLength={600} onChange={(e) => setEditBank({ ...editBank, instructions: e.target.value })} className="min-h-[88px] w-full rounded-xl bg-sunken px-4 py-3 text-[15px] outline-none ring-accent/40 transition focus:ring-2" /></label>
          <Button className="w-full" onClick={saveBank}>Save</Button>
        </div>}
      </Sheet>
    </div>
  );
}
