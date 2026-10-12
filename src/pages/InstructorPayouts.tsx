// src/pages/InstructorPayouts.tsx — the admin side of instructor earnings: review withdrawals, look at wallets and earnings, fix exceptions.
// Nobody edits a balance here. The only way to change one is a signed, reasoned adjustment (admin_adjust_instructor).
import { useCallback, useEffect, useState } from "react";
import { supabase, naira, UserMessage } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Empty, Err, Field, Section, Sheet, Skeleton } from "../components/ui";
import { fmtDay, fmtWhen } from "../lib/time";

/* eslint-disable @typescript-eslint/no-explicit-any */
const tone = (s: string) => (s === "paid" ? "ok" : s === "failed" || s === "rejected" ? "bad" : s === "processing" || s === "draft" ? "warn" : "muted") as "ok" | "bad" | "warn" | "muted";
const LABEL: Record<string, string> = { draft: "Needs review", processing: "Processing", paid: "Paid", failed: "Failed", rejected: "Rejected", cancelled: "Cancelled" };

export default function InstructorPayouts() {
  const { run, confirm } = useFeedback();
  const [configured, setConfigured] = useState<boolean>();
  const [wds, setWds] = useState<any[]>(); const [wallets, setWallets] = useState<any[]>(); const [ex, setEx] = useState<any>();
  const [q, setQ] = useState(""); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [rej, setRej] = useState<any>(null); const [why, setWhy] = useState("");
  const [who, setWho] = useState<any>(null); const [sheet, setSheet] = useState<any>(null); const [adj, setAdj] = useState({ amt: "", why: "", sign: 1 });
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [rows, setRows] = useState<any[]>(); const [notFound, setNotFound] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([supabase.rpc("admin_instructor_withdrawals"), supabase.rpc("admin_instructor_wallets", { p_search: q.trim() || null }), supabase.rpc("admin_instructor_exceptions")]);
    setWds((a.data as any[]) ?? []); setWallets((b.data as any[]) ?? []); setEx(c.data ?? null);
  }, [q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { supabase.functions.invoke("process-payouts", { body: { action: "status" } }).then((r) => setConfigured(r.data?.configured === true)); }, []);
  const loadRows = useCallback(async () => {
    const { data } = await supabase.rpc("admin_instructor_earnings", { p_from: from || null, p_to: to || null, p_instructor: who?.id ?? null, p_limit: 100, p_offset: 0 });
    setRows((data as any[]) ?? []);
  }, [from, to, who]);
  useEffect(() => { loadRows(); }, [loadRows]);

  const act = async (label: string, body: object, id?: string) => {
    setErr(""); setMsg("");
    const r = await run(label, async () => {
      try {
        const { data, error } = await supabase.functions.invoke("process-payouts", { body });
        if (error && !data) { let j: any = null; try { j = await (error as any).context.json(); } catch { /* not json */ } throw new UserMessage(j?.detail ?? j?.error ?? "Something went wrong."); }
        if (data?.error) throw new UserMessage(data.detail ?? data.error);
        return data;
      } finally { await load(); }
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    if (r.data?.status === "not_found" && id) setNotFound((n) => ({ ...n, [id]: true }));
    setMsg(r.data?.message ?? "Done.");
  };
  const send = async (x: any) => {
    if (x.name_match === false && !(await confirm({ title: "The account name doesn't match", message: `The bank account is in the name "${x.account_name}", which doesn't match the instructor's profile. Send anyway?`, confirmLabel: "Send anyway", danger: true }))) return;
    if (await confirm({ title: `Send ${naira(x.amount)} to ${x.instructor}?`, message: `It goes to ${x.bank_name} ••${x.account_last4} (${x.account_name}). This can't be undone.`, confirmLabel: "Send payout", danger: true })) act("Sending payout…", { action: "send_instructor", withdrawal_id: x.id });
  };
  const reject = async () => { const id = rej.id; setRej(null); await act("Rejecting…", { action: "reject_instructor", withdrawal_id: id, reason: why }); setWhy(""); };
  const openWho = (x: any) => { setWho(x); setSheet(x); setAdj({ amt: "", why: "", sign: 1 }); };
  const adjust = async () => {
    const kobo = Math.round(Number(adj.amt || 0) * 100) * adj.sign;
    if (!(await confirm({ title: `${kobo > 0 ? "Add" : "Deduct"} ${naira(Math.abs(kobo))}?`, message: `${sheet.name} is told about it. The reason is saved with your name.`, confirmLabel: "Record adjustment", danger: kobo < 0 }))) return;
    const r = await run("Recording…", async () => { const { error } = await supabase.rpc("admin_adjust_instructor", { p_instructor: sheet.id, p_amount: kobo, p_reason: adj.why }); if (error) throw error.message.includes("reason_required") ? new UserMessage("Give a reason of at least 5 characters.") : error; await load(); }, { success: "Adjustment recorded", quiet: true });
    if (!r.ok) return setErr(r.message); setSheet(null);
  };
  const postNow = (id: string) => run("Posting…", async () => { const { error } = await supabase.rpc("admin_post_session_earnings", { p_session_id: id }); if (error) throw error; await load(); }, { success: "Posted" });

  const attention = ex ? ["missing_posts", "no_instructor", "unfunded", "errors", "stuck_withdrawals", "negative_balances", "name_mismatch"].reduce((n, k) => n + (ex[k]?.length ?? 0), 0) : 0;

  return (
    <div className="space-y-5">
      {configured === false && <Card className="space-y-1 bg-warn/10 p-3.5"><p className="font-medium text-warn">Payouts are waiting for secure setup</p>
        <p className="text-[13px] leading-snug text-warn">You can review and reject requests. Sending is switched off until the Paystack secret key is stored as a Supabase secret (name: PAYSTACK_SECRET_KEY). Nothing is marked as sent until Paystack confirms it.</p></Card>}
      {msg && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{msg}</p>}<Err>{err}</Err>

      <Section title="Withdrawal requests">
        {!wds ? <Skeleton className="h-24" /> : wds.length === 0 ? <Empty title="No instructor withdrawals yet." /> : <div className="grid gap-3 lg:grid-cols-2">{wds.map((x) => (
          <Card key={x.id} className="space-y-2">
            <div className="flex items-start justify-between gap-3"><div><p className="num text-xl font-semibold">{naira(x.amount)}</p><p className="text-sm text-muted">{x.instructor} · {fmtWhen(x.created_at, { dateStyle: "medium" })} · through {fmtDay(x.eligible_through, { month: "long", year: "numeric" })}</p></div><Badge tone={tone(x.status)}>{LABEL[x.status] ?? x.status}</Badge></div>
            <p className="text-sm text-muted">{x.bank_name} ••{x.account_last4} · {x.account_name} {x.name_match === false && <Badge tone="bad">Name differs from profile</Badge>}</p>
            {x.reference && <p className="text-xs text-muted">Reference {x.reference}{x.paid_at ? ` · paid ${fmtWhen(x.paid_at, { dateStyle: "medium" })}` : ""}</p>}
            {x.reject_reason && <p className="text-sm text-bad">{x.reject_reason}</p>}{x.failure_reason && <p className="text-sm text-bad">{x.failure_reason}</p>}
            {x.status === "draft" && <div className="flex gap-2"><Button className="h-10 flex-1" disabled={configured !== true} onClick={() => send(x)}>Send {naira(x.amount)}</Button><Button variant="secondary" className="h-10" onClick={() => setRej(x)}>Reject</Button></div>}
            {x.status === "processing" && <div className="flex gap-2"><Button variant="secondary" className="h-10 flex-1" disabled={configured !== true} onClick={() => act("Checking with Paystack…", { action: "reconcile", reference: x.reference }, x.id)}>Check with Paystack</Button>
              {notFound[x.id] && <Button className="h-10" onClick={() => act("Re-sending…", { action: "retry_instructor", withdrawal_id: x.id })}>Retry send</Button>}</div>}
          </Card>))}</div>}
      </Section>

      <Section title="Needs attention" aside={<Badge tone={attention ? "warn" : "ok"}>{attention || "All clear"}</Badge>}>
        {ex && attention > 0 && <div className="space-y-2">
          {(ex.missing_posts ?? []).map((m: any) => <Card key={m.session_id} className="flex items-center justify-between gap-3 py-3"><div><p className="font-medium">Finished class not paid out</p><p className="text-sm text-muted">{m.course} · {fmtDay(m.day, { day: "numeric", month: "short" })}</p></div><Button className="h-9 text-sm" onClick={() => postNow(m.session_id)}>Post now</Button></Card>)}
          {(ex.no_instructor ?? []).map((m: any) => <Card key={m.session_id} className="py-3"><p className="font-medium">Finished class with no instructor</p><p className="text-sm text-muted">{m.course} · {fmtDay(m.day, { day: "numeric", month: "short" })}. Nobody earns until an instructor is set.</p></Card>)}
          {(ex.unfunded ?? []).length > 0 && <Card className="py-3"><p className="font-medium">{ex.unfunded.length} earning(s) waiting for student payment</p><p className="text-sm text-muted">{naira(ex.unfunded.reduce((n: number, u: any) => n + Number(u.amount), 0))} total. They join the balance when the student pays.</p></Card>}
          {(ex.errors ?? []).map((m: any, i: number) => <Card key={i} className="py-3"><p className="font-medium text-bad">Posting error</p><p className="text-sm text-muted">{m.error}</p></Card>)}
          {(ex.stuck_withdrawals ?? []).map((m: any) => <Card key={m.id} className="py-3"><p className="font-medium">Withdrawal processing for over 2 hours</p><p className="text-sm text-muted">{naira(m.amount)} · {m.reference}. Use "Check with Paystack" above.</p></Card>)}
          {(ex.negative_balances ?? []).map((m: any) => <Card key={m.instructor_id} className="py-3"><p className="font-medium text-bad">Negative balance</p><p className="text-sm text-muted">{naira(m.balance)}. It is offset by their next earnings.</p></Card>)}
          {(ex.name_mismatch ?? []).map((m: any) => <Card key={m.id} className="py-3"><p className="font-medium">Account name differs from profile</p><p className="text-sm text-muted">{naira(m.amount)} request to "{m.account_name}". Check before sending.</p></Card>)}
        </div>}
      </Section>

      <Section title="Instructor wallets">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="mb-2 h-12 w-full rounded-2xl bg-surface px-4 shadow-card outline-none ring-1 ring-line focus:ring-2 focus:ring-accent/50" />
        {!wallets ? <Skeleton className="h-20" /> : wallets.length === 0 ? <Empty title="No instructors found." /> : <div className="grid gap-2 lg:grid-cols-2">{wallets.map((x) => (
          <Card key={x.id} onClick={() => openWho(x)} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0"><p className="truncate font-medium">{x.name}</p><p className="truncate text-sm text-muted">All time {naira(x.lifetime)} · paid out {naira(x.paid_out)}{x.reserved > 0 ? ` · ${naira(x.reserved)} requested` : ""}{!x.has_account ? " · no bank account" : ""}</p></div>
            <div className="text-right"><p className="num font-semibold">{naira(x.balance)}</p>{x.unfunded > 0 && <Badge tone="warn">{naira(x.unfunded)} unfunded</Badge>}</div>
          </Card>))}</div>}
      </Section>

      <Section title="Earnings">
        <div className="mb-2 grid grid-cols-2 gap-2"><Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        {who && <p className="mb-2 text-sm text-muted">Showing {who.name}. <button className="text-accent" onClick={() => setWho(null)}>Show everyone</button></p>}
        {!rows ? <Skeleton className="h-16" /> : rows.length === 0 ? <Empty title="No earnings in this range." /> : <div className="space-y-2">{rows.map((r) => (
          <Card key={r.session_id + r.instructor_id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate font-medium">{r.course} · {r.centre}</p><p className="truncate text-sm text-muted">{r.instructor} · {fmtDay(r.day, { day: "numeric", month: "short" })} · {r.students} student{r.students === 1 ? "" : "s"} · {r.rate_bp / 100}%</p></div><p className="num shrink-0 font-semibold">{naira(r.amount)}</p></Card>))}</div>}
      </Section>

      <Sheet open={!!rej} onClose={() => setRej(null)} title="Reject this withdrawal">
        <div className="space-y-3"><p className="text-sm text-muted">{rej && `${naira(rej.amount)} goes back to ${rej.instructor}'s balance and they see your reason.`}</p>
          <Field label="Reason" value={why} onChange={(e) => setWhy(e.target.value)} /><Button className="w-full" disabled={why.trim().length < 3} onClick={reject}>Reject</Button></div>
      </Sheet>
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title={sheet?.name ?? ""}>
        {sheet && <div className="space-y-3"><p className="text-sm text-muted">Balance {naira(sheet.balance)}. Adjustments are the only way to change it and each one is recorded with your name and reason.</p>
          <div className="grid grid-cols-2 gap-2">{[["Add", 1], ["Deduct", -1]].map(([l, s]) => <button key={String(l)} onClick={() => setAdj({ ...adj, sign: s as number })} className={`h-10 rounded-xl text-sm font-medium ${adj.sign === s ? "bg-accent text-accent-ink" : "bg-sunken"}`}>{l}</button>)}</div>
          <Field label="Amount (₦)" type="number" inputMode="decimal" min="1" value={adj.amt} onChange={(e) => setAdj({ ...adj, amt: e.target.value })} /><Field label="Reason" value={adj.why} onChange={(e) => setAdj({ ...adj, why: e.target.value })} />
          <Button className="w-full" disabled={!(Number(adj.amt) > 0) || adj.why.trim().length < 5} onClick={adjust}>Record adjustment</Button>
          <p className="text-xs text-muted">Their earnings are listed under Earnings on this page.</p></div>}
      </Sheet>
    </div>
  );
}
